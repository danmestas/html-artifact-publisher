/**
 * Blobs: images, video and other large or binary files, stored in R2 by their
 * SHA-256 (`b/<sha256>`), while the artifact's Fossil repository keeps a small
 * pointer file at the file's path (public/blobs.js). The Registry records which
 * artifacts point at which blobs; a blob is deleted with its last artifact.
 *
 * Pages load blobs through signed links, /b/<id>/<sha256>?exp=&sig=, minted
 * only for callers who can read the artifact. A link stays the same for a
 * day, so browsers can cache what it serves.
 *
 * Attachments on comment threads (tickets) that are too big for Fossil live
 * beside them at `attachments/<sha256>`, the layout Quarry RFC 0016 uses, so a
 * copy of that prefix moves them to a Quarry bucket. The repository keeps a
 * `quarry-attachment 1` stub naming them. The two formats stay apart: a
 * pointer stands in for a file in a check-in, a stub for an attachment.
 */

import { parsePointer } from '../public/blobs.js';
import { b64decode } from './util';

const SHA = /^[0-9a-f]{64}$/;
const DAY = 86400;
const enc = new TextEncoder();

/** Where in R2 bytes live: `b` for check-in files, `attachments` for attachments. */
export type Space = 'b' | 'attachments';
export const blobKey = (sha: string, space: Space = 'b') => `${space}/${sha}`;
export const isSha = (s: string) => SHA.test(s);

export interface BlobRef { sha256: string; size: number; type: string }

/** What an external reference names: a check-in file's blob, or an attachment's bytes. */
export type ExternalRef = (BlobRef & { kind: 'blob' }) | (BlobRef & { kind: 'attachment'; name: string });

// The stub go-libfossil writes for AttachmentAddExternal (Quarry RFC 0016).
const STUB = /^quarry-attachment 1\nsha256 ([0-9a-f]{64})\nsize (0|[1-9]\d{0,14})\ntype ([^\r\n]+)\nname ([^\r\n]+)\n?$/;

/**
 * The reference `text` is, when it is an `artifact-blob 1` pointer or a
 * `quarry-attachment 1` stub, else null. The one parser for both formats.
 */
export function externalRef(text: Uint8Array | string): ExternalRef | null {
  if (text.length > 1024) return null; // a stub is at most 1 KiB, a pointer under 300 bytes
  const pointer = parsePointer(text);
  if (pointer) return { kind: 'blob', ...pointer };
  const m = STUB.exec(typeof text === 'string' ? text : new TextDecoder().decode(text));
  return m ? { kind: 'attachment', sha256: m[1]!, size: Number(m[2]), type: m[3]!, name: m[4]! } : null;
}

/** The pointer files among `files` (path -> base64), by path. */
export function pointersIn(files: Record<string, string>): Record<string, BlobRef> {
  const out: Record<string, BlobRef> = {};
  for (const [path, data] of Object.entries(files)) {
    if (data.length > 400) continue; // a pointer is under 300 bytes
    const ref = externalRef(b64decode(data));
    if (ref?.kind === 'blob') out[path] = { sha256: ref.sha256, size: ref.size, type: ref.type };
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
  /** Whether the stored object is being deleted: an upload must wait until it is gone. */
  busy(): Promise<boolean>;
  /** Called once the bytes are verified; false when they are being deleted. */
  record(): Promise<boolean>;
}

/**
 * Store the request body as blob `sha`. Bytes already stored are uploaded and
 * hashed again anyway, without being written: that is how a caller proves it
 * has them, rather than just their hash. New bytes are staged under tmp/,
 * hashed as they stream in, and copied to their name only once they match it.
 * Nothing an upload sends ever replaces or removes a stored object.
 */
export async function putBlob(req: Request, env: Env, sha: string, who: Uploader, space: Space = 'b'): Promise<Response> {
  if (!isSha(sha)) return text(400, 'blob name must be a lowercase SHA-256');
  const key = blobKey(sha, space);
  if (req.method === 'HEAD') {
    const known = (await who.known()) && !!(await env.BLOBS.head(key));
    return new Response(null, { status: known ? 200 : 404 });
  }
  const length = Number(req.headers.get('Content-Length') ?? NaN);
  const max = parseInt(env.MAX_BLOB_BYTES, 10);
  if (!Number.isSafeInteger(length) || length < 0) return text(411, 'Content-Length is required');
  if (length > max) return text(413, `file is too large: at most ${max} bytes`);
  if (!req.body) return text(400, 'empty body');
  if (await who.busy()) return text(409, BUSY);
  const existing = await env.BLOBS.head(key);
  const digest = new crypto.DigestStream('SHA-256');
  if (existing) {
    // Stored bytes were verified when they arrived: other bytes cannot be these.
    if (existing.size !== length) return text(400, `the bytes don't match their name: ${sha} is ${existing.size} bytes`);
    try { await req.body.pipeTo(digest); } catch { return text(400, 'upload did not complete'); }
    const actual = hex(new Uint8Array(await digest.digest));
    if (actual !== sha) return text(400, `the bytes don't match their name: they hash to ${actual}`);
    if (!(await who.record())) return text(409, BUSY);
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
  if (!(await who.record())) return text(409, BUSY);
  return Response.json({ sha256: sha, size: length, stored: true }, { status: 201 });
}

// ─── Signed links ────────────────────────────────────────────────────────────

/** HMAC key for links, derived from the instance secret so no new secret is needed. */
async function linkKey(env: Env, label = 'blob-links-v1'): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(env.BEARER_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', base, enc.encode(label));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const message = (id: string, sha: string, exp: number) => enc.encode(`${id}/${sha}/${exp}`);

/**
 * Links expire at the end of the next UTC day: the same link all day, so a
 * browser's cached copy keeps working, and never valid for more than 48 hours.
 */
const linkExpiry = () => (Math.floor(Date.now() / 1000 / DAY) + 2) * DAY;

export async function blobLinks(env: Env, id: string, pointers: Record<string, BlobRef>): Promise<Record<string, BlobRef & { url: string }>> {
  if (!Object.keys(pointers).length) return {};
  const exp = linkExpiry();
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
  return serveObject(req, env, blobKey(sha), Math.min(exp - now, DAY));
}

/** Stream R2 object `key`, cacheable for `maxAge` seconds. Supports Range. */
async function serveObject(req: Request, env: Env, key: string, maxAge: number, extra: Record<string, string> = {}): Promise<Response> {
  const object = await env.BLOBS.get(key, { range: req.headers, onlyIf: req.headers });
  if (!object) return text(404, 'not found');
  const headers = new Headers({
    'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    'Cache-Control': `private, max-age=${maxAge}`,
    ETag: object.httpEtag,
    'Accept-Ranges': 'bytes',
    ...SANDBOXED,
    ...extra,
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

// An SVG or HTML file opened on its own can't run scripts or load anything.
const SANDBOXED = {
  'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// ─── Attachment links ────────────────────────────────────────────────────────

// Types an attachment link serves inline; everything else downloads. Never SVG:
// it is script on whatever origin shows it.
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const attachmentMessage = (id: string, target: string, name: string, exp: number) => enc.encode(`${id}\n${target}\n${name}\n${exp}`);

/**
 * A signed link to a thread's current attachment `name`, for a caller who can
 * read the artifact: /a/<id>?target=&name=&exp=&sig=. It names the attachment,
 * not its bytes, and expires like a blob link.
 */
export async function attachmentLink(env: Env, id: string, target: string, name: string): Promise<string> {
  const exp = linkExpiry();
  const key = await linkKey(env, 'attachment-links-v1');
  const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, attachmentMessage(id, target, name, exp))));
  const q = new URLSearchParams({ target, name, exp: String(exp), sig });
  return `/a/${id}?${q}`;
}

/** The attachment a valid, unexpired link names, and how long it stays valid; null otherwise. */
export async function verifyAttachmentLink(env: Env, id: string, url: URL): Promise<{ target: string; name: string; maxAge: number } | null> {
  const target = url.searchParams.get('target') ?? '', name = url.searchParams.get('name') ?? '';
  const exp = Number(url.searchParams.get('exp'));
  const sig = url.searchParams.get('sig') ?? '';
  const now = Math.floor(Date.now() / 1000);
  if (!target || !name || !Number.isSafeInteger(exp) || exp <= now || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  const ok = await crypto.subtle.verify('HMAC', await linkKey(env, 'attachment-links-v1'), b64urlDecode(sig), attachmentMessage(id, target, name, exp));
  return ok ? { target, name, maxAge: Math.min(exp - now, DAY) } : null;
}

/** Headers for an attachment's bytes: sandboxed, and a download unless it is an image type safe to show. */
function attachmentHeaders(name: string, type: string): Record<string, string> {
  const safe = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const disposition = INLINE.has(type) ? 'inline' : 'attachment';
  return { 'Content-Type': type, 'Content-Disposition': `${disposition}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`, ...SANDBOXED };
}

/** An attachment kept in R2, for a link verified with verifyAttachmentLink. */
export function serveExternalAttachment(req: Request, env: Env, sha: string, name: string, type: string, maxAge: number): Promise<Response> {
  return serveObject(req, env, blobKey(sha, 'attachments'), maxAge, attachmentHeaders(name, type));
}

/** A regular attachment's bytes, read from the repository. */
export function serveAttachmentBytes(bytes: Uint8Array, name: string, type: string, maxAge: number): Response {
  return new Response(bytes, { headers: { ...attachmentHeaders(name, type), 'Cache-Control': `private, max-age=${maxAge}`, 'Content-Length': String(bytes.length) } });
}

const BUSY = 'these bytes are being deleted: upload them again in a moment';

function text(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0));
