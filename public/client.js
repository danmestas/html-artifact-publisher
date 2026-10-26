// client.js — the artifact HTTP API, shared by the viewer (browser) and the
// CLI (Node). Files travel as base64; this module takes and returns bytes.
// Images and other binary or large files go to R2 first (blobs.js); the
// check-in holds a pointer file in their place.
//
//   const art = new Artifact(origin, id, token);
//   const { tip } = await art.info();
//   await art.publish(tip, { 'index.html': bytes }, 'Fix the totals');  // throws ConflictError if tip moved

import { isBlob, parsePointer, pointerFor } from './blobs.js';

const enc = new TextEncoder();

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `request failed (HTTP ${status})`);
    Object.assign(this, { name: 'ApiError', status, code: body?.code ?? '' });
  }
}

/** The artifact changed since the check-in an edit was based on. */
export class ConflictError extends ApiError {
  constructor(status, body) {
    super(status, body);
    this.name = 'ConflictError';
  }
}

export function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(s) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

/** { path: bytes | string } -> { path: base64 } */
export function encodeFiles(files) {
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, toBase64(v instanceof Uint8Array ? v : enc.encode(String(v)))]));
}

const asBytes = v => (v instanceof Uint8Array ? v : enc.encode(String(v)));

/**
 * Upload each file that should be a blob to `uploadBase`/<sha256> (skipping
 * ones the server already has) and return the files with pointers in their place.
 * `onUpload(path)` is called before each upload.
 */
export async function withBlobs(files, uploadBase, auth, onUpload) {
  const out = {};
  for (const [path, value] of Object.entries(files)) {
    const bytes = asBytes(value);
    if (!isBlob(path, bytes) || parsePointer(bytes)) { out[path] = bytes; continue; }
    const pointer = await pointerFor(path, bytes);
    const url = `${uploadBase}/${pointer.blob.sha256}`;
    const headers = auth ? { Authorization: auth } : {};
    const known = await fetch(url, { method: 'HEAD', headers, cache: 'no-store' });
    if (known.status !== 200) {
      onUpload?.(path);
      const res = await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': pointer.blob.type }, body: bytes });
      if (!res.ok) throw new ApiError(res.status, { error: `could not upload ${path}: ${(await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`}` });
    }
    out[path] = pointer.bytes;
  }
  return out;
}

/**
 * The files chosen in a browser file input, as { path: bytes }. A folder keeps
 * its layout, without the folder's own name; hidden files (.DS_Store, .git/…) are left out.
 */
export async function readFileList(list) {
  const out = {};
  for (const file of list) {
    const path = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
    if (!path || /(^|\/)\./.test(path)) continue;
    out[path] = new Uint8Array(await file.arrayBuffer());
  }
  return out;
}

async function call(url, { method = 'GET', auth = '', body, raw = false } = {}) {
  const headers = {};
  if (auth) headers.Authorization = auth;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new (res.status === 409 && err.code === 'conflict' ? ConflictError : ApiError)(res.status, err);
  }
  if (res.status === 204) return null;
  return raw ? new Uint8Array(await res.arrayBuffer()) : res.json();
}

/** Parse a link fragment: #<token>[@<check-in>] */
export function parseFragment(hash) {
  const [token, at = ''] = hash.replace(/^#/, '').split('@');
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('the link has no access token: it must end in #<token>');
  return { token, at: decodeURIComponent(at) };
}

export function fragment({ token, at = '' }) {
  return '#' + token + (at ? '@' + encodeURIComponent(at) : '');
}

export class Artifact {
  constructor(origin, id, token) {
    Object.assign(this, { origin, id, auth: token ? `Token ${token}` : '', base: `${origin}/api/artifacts/${encodeURIComponent(id)}` });
  }

  /** { id, title, role, tip, timeline, expiresAt } */
  info() { return call(this.base, { auth: this.auth }); }
  async tip() { return (await call(`${this.base}?tip`, { auth: this.auth })).tip; }

  /**
   * Every file of a check-in ('' = tip): { checkin, files: { path: bytes }, missing, blobs }.
   * A blob's entry in `files` is its pointer; `blobs[path]` has { sha256, size, type, url },
   * where `url` (relative to the origin) is a signed link to the real bytes.
   */
  async bundle(at = '') {
    const b = await call(`${this.base}/bundle?at=${encodeURIComponent(at)}`, { auth: this.auth });
    return { ...b, files: Object.fromEntries(Object.entries(b.files).map(([k, v]) => [k, fromBase64(v)])) };
  }

  file(path, at = '') {
    return call(`${this.base}/files/${encodeURIComponent(path)}?at=${encodeURIComponent(at)}`, { auth: this.auth, raw: true });
  }

  /** The real bytes of a blob, from its entry in bundle().blobs. */
  async blob(entry) {
    const res = await fetch(new URL(entry.url, this.origin), { cache: 'no-store' });
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
    return new Uint8Array(await res.arrayBuffer());
  }

  /** A new check-in on top of `parent`, which must still be the tip. Returns { tip, parent }. */
  async publish(parent, files, message, { title, user } = {}) {
    const stored = await withBlobs(files, `${this.base}/blobs`, this.auth);
    return call(this.base, { method: 'PUT', auth: this.auth, body: { parent, files: encodeFiles(stored), message, title, user } });
  }

  remove() { return call(this.base, { method: 'DELETE', auth: this.auth }); }

  /** Comment threads: { tickets: [{ uuid, status, changed, fields, changes }] }. */
  tickets() { return call(`${this.base}/tickets`, { auth: this.auth }); }
  /** Open a thread ({ text, anchor? }) or change one ({ ticketUuid, text?, status? }). */
  comment(change) { return call(`${this.base}/tickets`, { method: 'POST', auth: this.auth, body: change }); }

  dataList() { return call(`${this.base}/data`, { auth: this.auth }); }
  /** The value stored under `name`, or null. */
  dataGet(name) { return call(`${this.base}/data/${encodeURIComponent(name)}`, { auth: this.auth }); }
  async dataSet(name, value) {
    const res = await fetch(`${this.base}/data/${encodeURIComponent(name)}`, {
      method: 'PUT', headers: { ...(this.auth ? { Authorization: this.auth } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    });
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  }
}

/** Owner calls, with the bearer token. */
export async function createArtifact(origin, bearer, { title, slug, ttlSeconds, message, user, files }) {
  const stored = await withBlobs(files, `${origin}/api/blobs`, `Bearer ${bearer}`);
  return call(`${origin}/api/artifacts`, {
    method: 'POST', auth: `Bearer ${bearer}`, body: { title, slug, ttlSeconds, message, user, files: encodeFiles(stored) },
  });
}

export function listArtifacts(origin, bearer) {
  return call(`${origin}/api/artifacts`, { auth: `Bearer ${bearer}` });
}
