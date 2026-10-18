/**
 * html-artifact-publisher — Cloudflare Worker
 *
 * An artifact is an encrypted Fossil repository: versions are check-ins,
 * multi-file pages are check-ins with several files, page data and uploads
 * are unversioned files. Fossil runs in the browser and the CLI (wasm, see
 * public/lib/fossil.js); this Worker never sees plaintext and only stores
 * bytes with a compare-and-swap.
 *
 * Routes:
 *   GET    /healthz                Health probe
 *   POST   /api/artifacts          Create artifact            (Bearer)
 *   GET    /api/artifacts          List artifacts             (Bearer)
 *   GET    /a/:idOrSlug            Encrypted bytes + ETag     (no auth — ciphertext only)
 *   HEAD   /a/:idOrSlug            ETag only (watching for new versions)
 *   PUT    /a/:id                  Replace bytes; If-Match required (Bearer or X-Write-Token)
 *   DELETE /a/:id                  Delete artifact            (Bearer or X-Write-Token)
 *   GET    /v/:idOrSlug            Viewer shell (static asset, served with a fresh CSP nonce)
 *   *                              Static assets (viewer, fossil.wasm.gz)
 *
 * Stored bytes : iv[12] || AES-256-GCM(gzip(.fossil file)), split into D1 rows
 * Links        : /v/<id>#<key>  (read)   /v/<id>#<key>.<writeToken>  (edit)
 */

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** 21-char URL-safe random ID (nanoid alphabet, crypto-random). */
function genId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  return Array.from(bytes, b => chars[b & 63]!).join('');
}

/** 32-byte random hex token. */
function genToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of arbitrary bytes, returned as lowercase hex. */
async function sha256hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

/** Timing-safe string equality for tokens and digests. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Clamp ttlSeconds into [0, maxTtl].
 * Returns defaultTtl when input is absent/invalid, null for "no expiry" (0).
 */
function clampTtl(ttlSeconds: number | undefined, defaultTtl: number, maxTtl: number): number | null {
  if (ttlSeconds == null || !Number.isFinite(ttlSeconds)) return defaultTtl;
  const v = Math.min(Math.max(Math.floor(ttlSeconds), 0), maxTtl);
  return v === 0 ? null : v;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function isoOrNull(sec: number | null): string | null {
  return sec != null ? new Date(sec * 1000).toISOString() : null;
}

/** Security headers applied to all responses. */
function secHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), microphone=(), payment=()',
  };
}

/** CORS headers for the API and the byte store. */
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, If-Match, If-None-Match, X-Write-Token, X-Title, X-Source-Name, X-TTL-Seconds, X-Slug, X-Wake',
    'Access-Control-Expose-Headers': 'ETag, X-Artifact-Id',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonRes(data: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...secHeaders(), ...extra },
  });
}

function isBearer(req: Request, expected: string): boolean {
  const auth = req.headers.get('Authorization') ?? '';
  return auth.startsWith('Bearer ') && timingSafeEqual(auth.slice(7).trim(), expected);
}

/** ETag header value (quoted) <-> stored etag. */
const quote = (etag: string) => `"${etag}"`;
const unquote = (h: string | null) => (h ?? '').trim().replace(/^W\//, '').replace(/^"|"$/g, '');

// ─── Store: artifacts in D1 ──────────────────────────────────────────────────
//
// One `artifacts` row per artifact and its bytes in `chunks` rows (a D1 row
// tops out near 2 MB). A write is one D1 batch, which runs as a transaction:
// the UPDATE claims the new etag only if the old one still matches, and the
// chunk statements run only if that claim landed, so a lost race changes
// nothing. Expired artifacts read as absent and are swept on the next create.

const CHUNK_BYTES = 1024 * 1024;

interface ArtifactRow {
  id: string;
  slug: string | null;
  title: string;
  source_name: string;
  etag: string;
  size: number;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  write_hash: string;
}

const LIVE = '(expires_at IS NULL OR expires_at > ?)';

function chunkStatements(db: D1Database, id: string, etag: string, bytes: Uint8Array): D1PreparedStatement[] {
  const owned = `EXISTS (SELECT 1 FROM artifacts WHERE id = ? AND etag = ?)`;
  const stmts = [db.prepare(`DELETE FROM chunks WHERE id = ? AND ${owned}`).bind(id, id, etag)];
  for (let off = 0, n = 0; off < bytes.length || n === 0; off += CHUNK_BYTES, n++) {
    stmts.push(
      db.prepare(`INSERT INTO chunks (id, n, data) SELECT ?, ?, ? WHERE ${owned}`)
        .bind(id, n, bytes.slice(off, off + CHUNK_BYTES).buffer, id, etag),
    );
  }
  return stmts;
}

async function findRow(db: D1Database, idOrSlug: string): Promise<ArtifactRow | null> {
  return db
    .prepare(`SELECT * FROM artifacts WHERE (id = ? OR slug = ?) AND ${LIVE} LIMIT 1`)
    .bind(idOrSlug, idOrSlug, nowSec())
    .first<ArtifactRow>();
}

async function readBytes(db: D1Database, id: string, size: number): Promise<Uint8Array> {
  const { results } = await db
    .prepare('SELECT data FROM chunks WHERE id = ? ORDER BY n')
    .bind(id)
    .all<{ data: ArrayBuffer | number[] }>();
  const out = new Uint8Array(size);
  let off = 0;
  for (const r of results) {
    const part = r.data instanceof ArrayBuffer ? new Uint8Array(r.data) : Uint8Array.from(r.data);
    out.set(part, off);
    off += part.length;
  }
  return out;
}

/** Can this request write artifact `row`? Owner bearer, or its write token. */
async function canWrite(req: Request, env: Env, row: ArtifactRow): Promise<boolean> {
  if (isBearer(req, env.BEARER_TOKEN)) return true;
  const token = req.headers.get('X-Write-Token');
  if (!token) return false;
  return timingSafeEqual(await sha256hex(new TextEncoder().encode(token)), row.write_hash);
}

async function readBody(req: Request, env: Env): Promise<Uint8Array | Response> {
  const max = parseInt(env.MAX_PAYLOAD_BYTES, 10);
  if (Number(req.headers.get('Content-Length') ?? 0) > max) {
    return jsonRes({ error: `Payload exceeds maximum size of ${max} bytes` }, 413);
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > max) return jsonRes({ error: `Payload exceeds maximum size of ${max} bytes` }, 413);
  if (bytes.length < 13) return jsonRes({ error: 'Body must be iv[12] || AES-GCM ciphertext' }, 400);
  return bytes;
}

// ─── Agent wake (notify) ─────────────────────────────────────────────────────
//
// A write carrying `X-Wake: <kind>` (e.g. "comment") tells the agent the
// artifact changed. Only ids reach notify, never content: the agent holds the
// link and reads the change itself. Best-effort; never fails the write.

function wake(env: Env, ctx: ExecutionContext, req: Request, id: string, etag: string): void {
  const kind = (req.headers.get('X-Wake') ?? '').replace(/[^a-z-]/g, '').slice(0, 32);
  // The vars default to "" in wrangler.jsonc; widen them from their literal types.
  const base: string = env.NOTIFY_URL, agent: string = env.NOTIFY_AGENT, subscriber: string = env.NOTIFY_SUBSCRIBER;
  if (!kind || !base || !agent || !env.NOTIFY_API_KEY) return;
  const url = `${base.replace(/\/$/, '')}/v1/inbox/conversations/${encodeURIComponent(agent)}/messages`;
  ctx.waitUntil(
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${env.NOTIFY_API_KEY}`,
        'Idempotency-Key': `${id}-${etag}`.slice(0, 64),
      },
      body: JSON.stringify({
        subscriberId: subscriber || 'html-artifact-publisher',
        conversationId: `artifact-${id}`,
        text: `Artifact ${id} has a new ${kind} (etag ${etag}). Open its link to read it.`,
      }),
    }).catch(() => undefined),
  );
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleCreate(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isBearer(req, env.BEARER_TOKEN)) return jsonRes({ error: 'Unauthorized' }, 401);

  const slug = req.headers.get('X-Slug');
  if (slug != null && !/^[a-z0-9-]{1,64}$/.test(slug)) {
    return jsonRes({ error: 'slug must be 1-64 chars: lowercase letters, digits, hyphens' }, 400);
  }
  const body = await readBody(req, env);
  if (body instanceof Response) return body;

  const title = decodeURIComponent(req.headers.get('X-Title') ?? '').slice(0, 300);
  const sourceName = decodeURIComponent(req.headers.get('X-Source-Name') ?? '').slice(0, 300);
  const ttlHeader = req.headers.get('X-TTL-Seconds');
  const ttl = clampTtl(
    ttlHeader == null ? undefined : Number(ttlHeader),
    parseInt(env.DEFAULT_TTL_SECONDS, 10),
    parseInt(env.MAX_TTL_SECONDS, 10),
  );
  const now = nowSec();
  const expiresAt = ttl != null ? now + ttl : null;

  const id = genId();
  const etag = genToken().slice(0, 32);
  const writeToken = genToken();
  const writeHash = await sha256hex(new TextEncoder().encode(writeToken));
  const db = env.DB;

  // Sweep expired artifacts first, so an expired slug can be reused.
  const expired = `SELECT id FROM artifacts WHERE expires_at IS NOT NULL AND expires_at <= ?`;
  try {
    await db.batch([
      db.prepare(`DELETE FROM chunks WHERE id IN (${expired})`).bind(now),
      db.prepare(`DELETE FROM artifacts WHERE id IN (${expired})`).bind(now),
      db.prepare(
        `INSERT INTO artifacts (id, slug, title, source_name, etag, size, created_at, updated_at, expires_at, write_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, slug, title, sourceName, etag, body.length, now, now, expiresAt, writeHash),
      ...chunkStatements(db, id, etag, body),
    ]);
  } catch (err) {
    if (String(err).includes('UNIQUE')) return jsonRes({ error: 'Slug already in use' }, 409);
    throw err;
  }
  wake(env, ctx, req, id, etag);

  return jsonRes(
    {
      id,
      etag,
      writeToken,
      viewerUrl: `${env.PUBLIC_BASE_URL}/v/${slug ?? id}`,
      expiresAt: isoOrNull(expiresAt),
    },
    201,
    { ETag: quote(etag) },
  );
}

async function handleList(req: Request, env: Env): Promise<Response> {
  if (!isBearer(req, env.BEARER_TOKEN)) return jsonRes({ error: 'Unauthorized' }, 401);

  const rawLimit = new URL(req.url).searchParams.get('limit');
  const limit = Math.min(Math.max(parseInt(rawLimit ?? '50', 10) || 50, 1), 200);
  const { results } = await env.DB
    .prepare(
      `SELECT id, slug, title, source_name, size, created_at, updated_at, expires_at
         FROM artifacts WHERE ${LIVE} ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(nowSec(), limit)
    .all<ArtifactRow>();

  const artifacts = results.map(r => ({
    id: r.id,
    title: r.title,
    sourceName: r.source_name,
    size: r.size,
    createdAt: isoOrNull(r.created_at),
    updatedAt: isoOrNull(r.updated_at),
    expiresAt: isoOrNull(r.expires_at),
    viewerUrl: `${env.PUBLIC_BASE_URL}/v/${r.slug ?? r.id}`,
  }));
  return jsonRes({ artifacts });
}

async function handleGet(req: Request, env: Env, idOrSlug: string): Promise<Response> {
  const row = await findRow(env.DB, idOrSlug);
  if (!row) return new Response('Not Found', { status: 404, headers: { ...corsHeaders(), ...secHeaders() } });

  const headers = {
    'Cache-Control': 'private, no-cache',
    ETag: quote(row.etag),
    'X-Artifact-Id': row.id,
    ...corsHeaders(),
    ...secHeaders(),
  };
  if (unquote(req.headers.get('If-None-Match')) === row.etag) {
    return new Response(null, { status: 304, headers });
  }
  if (req.method === 'HEAD') return new Response(null, { headers });

  return new Response(await readBytes(env.DB, row.id, row.size), {
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
  });
}

async function handlePut(req: Request, env: Env, ctx: ExecutionContext, id: string): Promise<Response> {
  const row = await findRow(env.DB, id);
  if (!row || row.id !== id) return jsonRes({ error: 'Not Found' }, 404);
  if (!(await canWrite(req, env, row))) return jsonRes({ error: 'Unauthorized' }, 401);

  const ifMatch = unquote(req.headers.get('If-Match'));
  if (!ifMatch) return jsonRes({ error: 'If-Match is required: send the ETag you last read' }, 428);

  const body = await readBody(req, env);
  if (body instanceof Response) return body;
  const titleHeader = req.headers.get('X-Title');
  const title = titleHeader != null ? decodeURIComponent(titleHeader).slice(0, 300) : null;

  const etag = genToken().slice(0, 32);
  const db = env.DB;
  const [claim] = await db.batch([
    db.prepare(
      `UPDATE artifacts SET etag = ?, size = ?, updated_at = ?, title = COALESCE(?, title)
        WHERE id = ? AND etag = ?`,
    ).bind(etag, body.length, nowSec(), title, id, ifMatch),
    ...chunkStatements(db, id, etag, body),
  ]);
  if (!claim || claim.meta.changes !== 1) {
    const current = await findRow(db, id);
    return jsonRes(
      { error: 'Conflict: the artifact changed since you read it', etag: current?.etag ?? null },
      412,
      current ? { ETag: quote(current.etag) } : {},
    );
  }
  wake(env, ctx, req, id, etag);
  return jsonRes({ id, etag }, 200, { ETag: quote(etag) });
}

async function handleDelete(req: Request, env: Env, id: string): Promise<Response> {
  const row = await findRow(env.DB, id);
  // Unknown and unauthorized answer the same, so ids cannot be probed.
  if (!row || row.id !== id || !(await canWrite(req, env, row))) {
    return jsonRes({ error: 'Unauthorized' }, 401);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chunks WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM artifacts WHERE id = ?').bind(id),
  ]);
  return new Response(null, { status: 204, headers: { ...corsHeaders(), ...secHeaders() } });
}

/**
 * The viewer shell is a static asset; it is served here so each response gets
 * a fresh CSP nonce. The decrypted page renders in a sandboxed blob: iframe,
 * which inherits this CSP: the shell stamps the nonce onto the page's inline
 * and bundled <script>/<style> tags, and nothing else can load or connect out.
 */
async function handleViewer(req: Request, env: Env): Promise<Response> {
  const shell = await env.ASSETS.fetch(new URL('/viewer', req.url));
  if (!shell.ok) return shell;

  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const page = new HTMLRewriter()
    .on('meta[name="artifact-nonce"]', { element: el => void el.setAttribute('content', nonce) })
    .transform(shell);

  return new Response(page.body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
        `style-src 'self' 'nonce-${nonce}'`,
        "style-src-attr 'unsafe-inline'",
        'img-src data: blob:',
        'font-src data: blob:',
        'media-src data: blob:',
        "connect-src 'self'",
        'frame-src blob:',
        "object-src 'none'",
        "base-uri 'none'",
      ].join('; '),
      ...secHeaders(),
    },
  });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(req.url).pathname;
    const method = req.method;

    if (method === 'OPTIONS' && (path.startsWith('/api/') || path.startsWith('/a/'))) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (method === 'GET' && path === '/healthz') {
      return jsonRes({ status: 'ok', ts: Date.now() });
    }

    if (path === '/api/artifacts') {
      if (method === 'POST') return handleCreate(req, env, ctx);
      if (method === 'GET') return handleList(req, env);
      return jsonRes({ error: 'Method Not Allowed' }, 405);
    }

    const a = /^\/a\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (a) {
      if (method === 'GET' || method === 'HEAD') return handleGet(req, env, a[1]!);
      if (method === 'PUT') return handlePut(req, env, ctx, a[1]!);
      if (method === 'DELETE') return handleDelete(req, env, a[1]!);
      return jsonRes({ error: 'Method Not Allowed' }, 405);
    }

    if (method === 'GET' && /^\/v\/[A-Za-z0-9_-]{1,64}$/.test(path)) {
      return handleViewer(req, env);
    }

    return env.ASSETS.fetch(req);
  },
};
