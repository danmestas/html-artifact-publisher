// client.js — the artifact HTTP API, shared by the viewer (browser) and the
// CLI (Node). Files travel as base64; this module takes and returns bytes.
//
//   const art = new Artifact(origin, id, token);
//   const { tip } = await art.info();
//   await art.publish(tip, { 'index.html': bytes }, 'Fix the totals');  // throws ConflictError if tip moved

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

  /** Every file of a check-in ('' = tip): { checkin, files: { path: bytes }, missing } */
  async bundle(at = '') {
    const b = await call(`${this.base}/bundle?at=${encodeURIComponent(at)}`, { auth: this.auth });
    return { ...b, files: Object.fromEntries(Object.entries(b.files).map(([k, v]) => [k, fromBase64(v)])) };
  }

  file(path, at = '') {
    return call(`${this.base}/files/${encodeURIComponent(path)}?at=${encodeURIComponent(at)}`, { auth: this.auth, raw: true });
  }

  /** A new check-in on top of `parent`, which must still be the tip. Returns { tip, parent }. */
  publish(parent, files, message, { title, user } = {}) {
    return call(this.base, { method: 'PUT', auth: this.auth, body: { parent, files: encodeFiles(files), message, title, user } });
  }

  remove() { return call(this.base, { method: 'DELETE', auth: this.auth }); }

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
export function createArtifact(origin, bearer, { title, slug, ttlSeconds, message, user, files }) {
  return call(`${origin}/api/artifacts`, {
    method: 'POST', auth: `Bearer ${bearer}`, body: { title, slug, ttlSeconds, message, user, files: encodeFiles(files) },
  });
}

export function listArtifacts(origin, bearer) {
  return call(`${origin}/api/artifacts`, { auth: `Bearer ${bearer}` });
}
