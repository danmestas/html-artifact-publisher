// client.js — the Worker's byte store as seen from the viewer and the CLI:
// open an artifact from its link, change it in Fossil, save it back.
//
//   const art = await Artifact.open(base, id, link.key, link.write, fossil);
//   fossil.commit({ 'index.html': bytes }, 'msg', 'user');
//   await art.save();            // throws ConflictError if someone saved first
//
// The open repository is the wasm's single in-memory repository; Artifact
// tracks which stored version (etag) it was read from.

import { seal, unseal } from './vault.js';

export class ConflictError extends Error {
  constructor() {
    super('someone else saved this artifact since it was opened; reload and try again');
    this.name = 'ConflictError';
  }
}

export class Artifact {
  constructor(base, id, key, write, fossil, auth = {}) {
    Object.assign(this, { base, id, key, write, fossil, auth, etag: '' });
  }

  static async open(base, idOrSlug, key, write, fossil, auth = {}) {
    const art = new Artifact(base, idOrSlug, key, write, fossil, auth);
    await art.reload();
    return art;
  }

  /** Load the newest stored version into the wasm repository. */
  async reload() {
    const res = await fetch(`${this.base}/a/${this.id}`, { cache: 'no-store' });
    if (res.status === 404) throw new Error('artifact not found or expired');
    if (!res.ok) throw new Error(`could not load the artifact (HTTP ${res.status})`);
    this.id = res.headers.get('X-Artifact-Id') || this.id;
    this.etag = unquote(res.headers.get('ETag'));
    this.fossil.open(await unseal(this.key, new Uint8Array(await res.arrayBuffer())));
  }

  /** True when a version newer than the one loaded has been saved. */
  async changed() {
    const res = await fetch(`${this.base}/a/${this.id}`, {
      method: 'HEAD', cache: 'no-store', headers: { 'If-None-Match': `"${this.etag}"` },
    });
    return res.status === 200;
  }

  canWrite() {
    return Boolean(this.write || this.auth.bearer);
  }

  /**
   * Store the open repository as the next version. `wake` (e.g. "comment")
   * asks the Worker to tell the agent; `title` renames the artifact.
   */
  async save({ wake = '', title } = {}) {
    if (!this.canWrite()) throw new Error('this link is read-only; an edit link is needed to save');
    const headers = { 'Content-Type': 'application/octet-stream', 'If-Match': `"${this.etag}"` };
    if (this.write) headers['X-Write-Token'] = this.write;
    if (this.auth.bearer) headers.Authorization = `Bearer ${this.auth.bearer}`;
    if (wake) headers['X-Wake'] = wake;
    if (title != null) headers['X-Title'] = encodeURIComponent(title);
    const res = await fetch(`${this.base}/a/${this.id}`, {
      method: 'PUT', headers, body: await seal(this.key, this.fossil.export()),
    });
    if (res.status === 412) throw new ConflictError();
    if (!res.ok) throw new Error(`save failed (HTTP ${res.status}): ${await res.text()}`);
    this.etag = unquote(res.headers.get('ETag')) || (await res.json()).etag;
  }
}

/**
 * Create a new artifact from the open repository. Returns the stored id,
 * etag and the write token for its edit link.
 */
export async function createArtifact(base, bearer, key, fossil, { title = '', sourceName = '', ttlSeconds, slug } = {}) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    Authorization: `Bearer ${bearer}`,
    'X-Title': encodeURIComponent(title),
    'X-Source-Name': encodeURIComponent(sourceName),
  };
  if (ttlSeconds != null) headers['X-TTL-Seconds'] = String(ttlSeconds);
  if (slug) headers['X-Slug'] = slug;
  const res = await fetch(`${base}/api/artifacts`, {
    method: 'POST', headers, body: await seal(key, fossil.export()),
  });
  if (!res.ok) throw new Error(`publish failed (HTTP ${res.status}): ${await res.text()}`);
  return res.json();
}

function unquote(h) {
  return (h ?? '').trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}
