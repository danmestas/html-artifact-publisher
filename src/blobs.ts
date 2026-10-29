/**
 * Blobs: images, video and other large or binary files, stored in R2 by their
 * SHA-256 (`b/<sha256>`), while the artifact's Fossil repository keeps a small
 * pointer file at the file's path (public/blobs.js). The Registry records which
 * artifacts point at which blobs; a blob is deleted with its last artifact.
 *
 * Pages load blobs through signed links, /b/<id>/<sha256>?exp=&sig=, minted
 * only for callers who can read the artifact. A link stays the same for a
 * day, so browsers can cache what it serves.
 */

import { parsePointer } from '../public/blobs.js';
import { b64decode } from './util';

const SHA = /^[0-9a-f]{64}$/;
const DAY = 86400;
const enc = new TextEncoder();

export const blobKey = (sha: string) => `b/${sha}`;
export const isSha = (s: string) => SHA.test(s);

export interface BlobRef { sha256: string; size: number; type: string }

/** The pointer files among `files` (path -> base64), by path. */
export function pointersIn(files: Record<string, string>): Record<string, BlobRef> {
  const out: Record<string, BlobRef> = {};
  for (const [path, data] of Object.entries(files)) {
    if (data.length > 400) continue; // a pointer is under 300 bytes
    const p = parsePointer(b64decode(data));
    if (p) out[path] = p;
  }
  return out;
}

/**
 * Paths whose pointer the caller may not use: R2 doesn't have the blob (or has
 * it at another size), or it isn't in `allowed` (see Registry.allowedBlobs).
 */
export async function missingBlobs(env: Env, pointers: Record<string, BlobRef>, allowed: string[]): Promise<string[]> {
  const ok = new Set(allowed);
  const missing: string[] = [];
  await Promise.all(Object.entries(pointers).map(async ([path, p]) => {
    if (!ok.has(p.sha256)) { missing.push(path); return; }
    const head = await env.BLOBS.head(blobKey(p.sha256));
    if (!head || head.size !== p.size) missing.push(path);
  }));
  return missing.sort();
}

// ─── Upload ──────────────────────────────────────────────────────────────────

export interface Uploader {
  /** HEAD: has this caller already proven it holds these bytes? */
  known(): Promise<boolean>;
  /** Called once the bytes are verified. */
  record(): Promise<void>;
}

/**
 * Store the request body as blob `sha`. Bytes already stored are uploaded and
 * hashed again anyway, without being written: that is how a caller proves it
 * has them, rather than just their hash. New bytes are staged under tmp/,
 * hashed as they stream in, and copied to their name only once they match it.
 * Nothing an upload sends ever replaces or removes a stored object.
 */
export async function putBlob(req: Request, env: Env, sha: string, who: Uploader): Promise<Response> {
  if (!isSha(sha)) return text(400, 'blob name must be a lowercase SHA-256');
  const key = blobKey(sha);
  if (req.method === 'HEAD') {
    const known = (await who.known()) && !!(await env.BLOBS.head(key));
    return new Response(null, { status: known ? 200 : 404 });
  }
  const length = Number(req.headers.get('Content-Length') ?? NaN);
  const max = parseInt(env.MAX_BLOB_BYTES, 10);
  if (!Number.isSafeInteger(length) || length < 0) return text(411, 'Content-Length is required');
  if (length > max) return text(413, `file is too large: at most ${max} bytes`);
  if (!req.body) return text(400, 'empty body');
  const existing = await env.BLOBS.head(key);
  const digest = new crypto.DigestStream('SHA-256');
  if (existing) {
    // Stored bytes were verified when they arrived: other bytes cannot be these.
    if (existing.size !== length) return text(400, `the bytes don't match their name: ${sha} is ${existing.size} bytes`);
    try { await req.body.pipeTo(digest); } catch { return text(400, 'upload did not complete'); }
    const actual = hex(new Uint8Array(await digest.digest));
    if (actual !== sha) return text(400, `the bytes don't match their name: they hash to ${actual}`);
    await who.record();
    return Response.json({ sha256: sha, size: length, stored: false });
  }

  const staged = `tmp/${crypto.randomUUID()}`;
  const [toR2, toHash] = req.body.tee();
  const hashed = toHash.pipeTo(digest);
  const sized = new FixedLengthStream(length);
  const piped = toR2.pipeTo(sized.writable);
  const type = (req.headers.get('Content-Type') ?? '').split(';')[0]!.trim().slice(0, 128) || 'application/octet-stream';
  try {
    await Promise.all([hashed, piped, env.BLOBS.put(staged, sized.readable, { httpMetadata: { contentType: type } })]);
  } catch {
    await env.BLOBS.delete(staged);
    return text(400, 'upload did not complete');
  }
  const actual = hex(new Uint8Array(await digest.digest));
  if (actual !== sha) {
    await env.BLOBS.delete(staged);
    return text(400, `the bytes don't match their name: they hash to ${actual}`);
  }
  // Verified: copy them to their name. A concurrent upload that got there first
  // wrote these same bytes, so writing them again changes nothing.
  try {
    const object = await env.BLOBS.get(staged);
    if (!object) return text(500, 'the upload was lost before it could be stored');
    const copy = new FixedLengthStream(object.size);
    await Promise.all([object.body.pipeTo(copy.writable), env.BLOBS.put(key, copy.readable, { httpMetadata: { contentType: type } })]);
  } finally {
    await env.BLOBS.delete(staged);
  }
  await who.record();
  return Response.json({ sha256: sha, size: length, stored: true }, { status: 201 });
}

// ─── Signed links ────────────────────────────────────────────────────────────

/** HMAC key for links, derived from the instance secret so no new secret is needed. */
async function linkKey(env: Env): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(env.BEARER_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', base, enc.encode('blob-links-v1'));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const message = (id: string, sha: string, exp: number) => enc.encode(`${id}/${sha}/${exp}`);

/**
 * Links expire at the end of the next UTC day: the same link all day, so a
 * browser's cached copy keeps working, and never valid for more than 48 hours.
 */
export async function blobLinks(env: Env, id: string, pointers: Record<string, BlobRef>): Promise<Record<string, BlobRef & { url: string }>> {
  if (!Object.keys(pointers).length) return {};
  const exp = (Math.floor(Date.now() / 1000 / DAY) + 2) * DAY;
  const key = await linkKey(env);
  const out: Record<string, BlobRef & { url: string }> = {};
  for (const [path, p] of Object.entries(pointers)) {
    const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, message(id, p.sha256, exp))));
    out[path] = { ...p, url: `/b/${id}/${p.sha256}?exp=${exp}&sig=${sig}` };
  }
  return out;
}

/** GET /b/:id/:sha — stream a blob for a valid, unexpired link. Supports Range. */
export async function getBlob(req: Request, env: Env, id: string, sha: string, referenced: (id: string, sha: string) => Promise<boolean>): Promise<Response> {
  const url = new URL(req.url);
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') ?? '';
  const now = Math.floor(Date.now() / 1000);
  if (!isSha(sha) || !Number.isSafeInteger(exp) || exp <= now || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return text(403, 'this link has expired or is invalid');
  const ok = await crypto.subtle.verify('HMAC', await linkKey(env), b64urlDecode(sig), message(id, sha, exp));
  if (!ok || !(await referenced(id, sha))) return text(403, 'this link has expired or is invalid');

  const object = await env.BLOBS.get(blobKey(sha), { range: req.headers, onlyIf: req.headers });
  if (!object) return text(404, 'not found');
  const headers = new Headers({
    'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    'Cache-Control': `private, max-age=${Math.min(exp - now, DAY)}`,
    ETag: object.httpEtag,
    'Accept-Ranges': 'bytes',
    // An SVG or HTML blob opened on its own can't run scripts or load anything.
    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (!('body' in object)) return new Response(null, { status: 304, headers });
  const range = object.range as { offset?: number; length?: number } | undefined;
  if (req.headers.has('Range') && range && range.offset !== undefined) {
    const length = range.length ?? object.size - range.offset;
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + length - 1}/${object.size}`);
    headers.set('Content-Length', String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { headers });
}

function text(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));
