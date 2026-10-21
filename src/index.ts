/**
 * html-artifact-publisher — Cloudflare Worker
 *
 * Every artifact is a Fossil repository held by its own SQLite-backed
 * Durable Object (src/repo.ts). go-libfossil runs inside the object as wasm
 * (fossil/, src/fossil.ts); the Registry object (src/registry.ts) lists them.
 *
 * Access: the owner's bearer token, or an artifact's read or write token,
 * sent as `Authorization: Token <t>`. Links carry the token in the fragment:
 *   /v/<id>#<readToken>      read link
 *   /v/<id>#<writeToken>     edit link
 *   ...@<check-in>           that check-in instead of the tip
 *
 * Routes:
 *   GET    /healthz
 *   POST   /api/artifacts                    Create (owner)
 *   GET    /api/artifacts                    List (owner)
 *   GET    /api/artifacts/:id                Tip, title, timeline (read)
 *   PUT    /api/artifacts/:id                New check-in; `parent` must be the tip (write)
 *   DELETE /api/artifacts/:id                Delete (write)
 *   GET    /api/artifacts/:id/bundle?at=     Every file of a check-in (read)
 *   GET    /api/artifacts/:id/files/<path>   One file (read)
 *   GET    /api/artifacts/:id/data[/<name>]  Page data (read)
 *   PUT    /api/artifacts/:id/data/<name>    Page data (write)
 *   POST   /r/:id                            Fossil sync: `fossil clone https://editor:<writeToken>@host/r/<id>`
 *   GET    /v/:id                            Viewer
 */

import { Repo } from './repo';
import { accountRoutes, artifactCaller, csrf, identity, readBody } from './accounts';
import { Registry } from './registry';
import type { FossilReply } from './fossil';
import { b64decode, b64encode, clampTtl, genId, genToken, isoOrNull } from './util';

export { Repo, Registry };

// ─── Responses ───────────────────────────────────────────────────────────────

function secHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), microphone=(), payment=()',
  };
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Wake',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(), ...secHeaders() },
  });
}

const STATUS: Record<string, number> = {
  bad_request: 400, forbidden: 403, not_found: 404, conflict: 409, unchanged: 409, too_large: 413, aborted: 500, internal: 500,
};

/** A Fossil reply as an HTTP response: the result, or the error with its status. */
function reply(r: FossilReply<unknown>): Response {
  if (r.ok) return json(r.result);
  return json({ error: r.error, code: r.code }, STATUS[r.code ?? 'internal'] ?? 500);
}

// ─── Requests ────────────────────────────────────────────────────────────────

/** The JSON body, or null when it is missing, malformed or over MAX_PAYLOAD_BYTES. */
async function body<T>(req: Request, env: Env): Promise<T | null> {
  return await readBody(req, parseInt(env.MAX_PAYLOAD_BYTES, 10)) as T | null;
}

function registry(env: Env) {
  return env.REGISTRY.getByName('registry');
}

function repo(env: Env, id: string) {
  return env.REPO.getByName(id);
}

/** Validate a files object: { "path": "base64" }. */
function validFiles(files: unknown): files is Record<string, string> {
  if (!files || typeof files !== 'object') return false;
  return Object.entries(files).every(([k, v]) =>
    typeof v === 'string' && /^[^\0\\]{1,255}$/.test(k) && !k.startsWith('/') && !k.split('/').includes('..'));
}

// ─── Agent wake (notify) ─────────────────────────────────────────────────────
//
// A write carrying `X-Wake: <kind>` (e.g. "comment") tells the agent the
// artifact changed. Only ids reach notify; the agent reads the change itself.
// Best-effort; never fails the write.

function wake(env: Env, ctx: ExecutionContext, req: Request, id: string, tip: string): void {
  const kind = (req.headers.get('X-Wake') ?? '').replace(/[^a-z-]/g, '').slice(0, 32);
  const base: string = env.NOTIFY_URL, agent: string = env.NOTIFY_AGENT, subscriber: string = env.NOTIFY_SUBSCRIBER;
  if (!kind || !base || !agent || !env.NOTIFY_API_KEY) return;
  ctx.waitUntil(
    fetch(`${base.replace(/\/$/, '')}/v1/inbox/conversations/${encodeURIComponent(agent)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${env.NOTIFY_API_KEY}`,
        'Idempotency-Key': `${id}-${tip.slice(0, 32)}`,
      },
      body: JSON.stringify({
        subscriberId: subscriber || 'html-artifact-publisher',
        conversationId: `artifact-${id}`,
        text: `Artifact ${id} has a new ${kind} at check-in ${tip.slice(0, 10)}. Pull it to read it.`,
      }),
    }).catch(() => undefined),
  );
}

// ─── Handlers ────────────────────────────────────────────────────────────────

interface CreateBody {
  title?: string;
  slug?: string;
  ttlSeconds?: number | null;
  message?: string;
  user?: string;
  files?: Record<string, string>;
}

async function handleCreate(req: Request, env: Env): Promise<Response> {
  const actor = await identity(req, env);
  if (!actor.legacy && !actor.user) return json({ error: 'Unauthorized' }, 401);
  const b = await body<CreateBody>(req, env);
  if (!b || !validFiles(b.files) || !Object.keys(b.files).length) {
    return json({ error: 'Body must be JSON with files: { "index.html": "<base64>", ... }' }, 400);
  }
  if (b.slug != null && !/^[a-z0-9-]{1,64}$/.test(b.slug)) {
    return json({ error: 'slug must be 1-64 chars: lowercase letters, digits, hyphens' }, 400);
  }
  const title = String(b.title ?? '').slice(0, 300) || 'Untitled';
  const ttl = b.ttlSeconds === null ? null : clampTtl(b.ttlSeconds, parseInt(env.DEFAULT_TTL_SECONDS, 10), parseInt(env.MAX_TTL_SECONDS, 10));
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = ttl != null ? now + ttl : null;
  const id = genId();
  const readToken = genToken();
  const writeToken = genToken();

  if (!(await registry(env).add({ id, slug: b.slug ?? null, title, createdAt: now, updatedAt: now, expiresAt, tip: '', ownerId: actor.user?.id ?? 'instance-owner' }))) {
    return json({ error: 'Slug already in use' }, 409);
  }
  const r = await repo(env, id).create({
    id, title, expiresAt, readToken, writeToken,
    user: String(b.user ?? 'owner').slice(0, 64), message: String(b.message ?? 'Publish').slice(0, 1000), files: b.files,
  });
  if (!r.ok || !r.result) {
    await registry(env).remove(id);
    return reply(r);
  }
  await registry(env).touch(id, r.result.tip);
  await registry(env).audit(actor.user?.id ?? 'instance-owner', 'publish', id, title);

  const origin = new URL(req.url).origin;
  const page = `${origin}/v/${b.slug ?? id}`;
  return json({
    id,
    tip: r.result.tip,
    viewerUrl: actor.explicit ? `${page}#${readToken}` : page,
    ...(actor.explicit ? { editUrl: `${page}#${writeToken}`, cloneUrl: `${origin.replace('://', `://editor:${writeToken}@`)}/r/${id}` } : {}),
    expiresAt: isoOrNull(expiresAt),
  }, 201);
}

async function handleList(req: Request, env: Env): Promise<Response> {
  const actor = await identity(req, env);
  if (!actor.legacy && !actor.user) return json({ error: 'Unauthorized' }, 401);
  const limit = Math.min(Math.max(parseInt(new URL(req.url).searchParams.get('limit') ?? '50', 10) || 50, 1), 200);
  const origin = new URL(req.url).origin;
  const entries = actor.legacy ? await registry(env).list(limit) : (await registry(env).library(actor.user!, { admin: false, view: 'all', status: 'active', cursor: '', q: '', ownerId: '', limit })).artifacts;
  const artifacts = entries.map(e => ({
    id: e.id, title: e.title, tip: e.tip,
    createdAt: isoOrNull(e.createdAt), updatedAt: isoOrNull(e.updatedAt), expiresAt: isoOrNull(e.expiresAt),
    viewerUrl: `${origin}/v/${e.slug ?? e.id}`,
  }));
  return json({ artifacts });
}

interface UpdateBody {
  parent?: string;
  message?: string;
  user?: string;
  title?: string;
  files?: Record<string, string>;
}

async function handleArtifact(req: Request, env: Env, ctx: ExecutionContext, id: string, rest: string): Promise<Response> {
  const who = await artifactCaller(req, env, id);
  const actor = await identity(req, env);
  const entry = await registry(env).get(id);
  const canManage = actor.legacy || !!(actor.user && (actor.user.role === 'owner' || entry?.ownerId === actor.user.id));
  const stub = repo(env, id);
  const url = new URL(req.url);
  const at = url.searchParams.get('at') ?? '';
  const method = req.method;

  if (rest === '') {
    if (method === 'GET') {
      if (url.searchParams.has('tip')) return reply(await stub.op(who, { op: 'tip' }));
      const r = (await stub.op(who, { op: 'info' })) as FossilReply<Record<string, unknown>>;
      if (!r.ok) return reply(r);
      const [meta, role, readToken] = await Promise.all([stub.info(), stub.role(who), stub.readToken(who)]);
      return json({
        id, title: meta?.title, role, expiresAt: isoOrNull(meta?.expiresAt ?? null), ...r.result, canManage,
        ...(readToken ? { readToken } : {}),
      });
    }
    if (method === 'PUT') {
      const b = await body<UpdateBody>(req, env);
      if (!b || !validFiles(b.files) || typeof b.parent !== 'string' || !b.parent) {
        return json({ error: 'Body must be JSON with parent (the check-in you started from) and files' }, 400);
      }
      if (b.title !== undefined && actor.user && !canManage) return json({ error: 'Artifact owner required to rename' }, 403);
      const r = (await stub.op(who, {
        op: 'commit', parent: b.parent, files: b.files,
        comment: String(b.message ?? 'Update').slice(0, 1000), user: String(b.user ?? 'web').slice(0, 64),
      })) as FossilReply<{ tip: string }>;
      if (!r.ok || !r.result) return reply(r);
      const title = typeof b.title === 'string' ? b.title.slice(0, 300) : undefined;
      if (title) await stub.rename(title);
      await registry(env).touch(id, r.result.tip, title);
      wake(env, ctx, req, id, r.result.tip);
      return json(r.result);
    }
    if (method === 'DELETE') {
      if ((await stub.role(who)) !== 'write') return json({ error: 'Unauthorized' }, 401);
      if (actor.user && !canManage) return json({ error: 'Artifact owner required' }, 403);
      await Promise.all([stub.destroy(), registry(env).remove(id)]);
      await registry(env).audit(actor.user?.id ?? 'instance-owner', 'delete', id, entry?.title);
      return new Response(null, { status: 204, headers: { ...corsHeaders(), ...secHeaders() } });
    }
  }

  if (rest === '/bundle' && method === 'GET') return reply(await stub.op(who, { op: 'bundle', at }));

  if (rest.startsWith('/files/') && method === 'GET') {
    const path = decodeURIComponent(rest.slice('/files/'.length));
    const r = (await stub.op(who, { op: 'raw', path, at })) as FossilReply<{ data: string; checkin: string }>;
    if (!r.ok || !r.result) return reply(r);
    return new Response(b64decode(r.result.data), {
      headers: { 'Content-Type': 'application/octet-stream', 'X-Checkin': r.result.checkin, 'Cache-Control': 'no-store', ...corsHeaders(), ...secHeaders() },
    });
  }

  if (rest === '/data' && method === 'GET') {
    const r = (await stub.op(who, { op: 'uvList' })) as FossilReply<string[]>;
    return r.ok ? json((r.result ?? []).filter(n => n.startsWith('data/')).map(n => n.slice(5))) : reply(r);
  }
  const data = /^\/data\/([A-Za-z0-9._-]{1,100})$/.exec(rest);
  if (data) {
    const name = `data/${data[1]}`;
    if (method === 'GET') {
      const r = (await stub.op(who, { op: 'uvGet', name })) as FossilReply<{ data: string | null }>;
      if (!r.ok || !r.result) return reply(r);
      if (r.result.data == null) return json(null);
      return new Response(b64decode(r.result.data), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(), ...secHeaders() },
      });
    }
    if (method === 'PUT') {
      const maxBytes = Number.parseInt(env.MAX_PAYLOAD_BYTES, 10);
      const reader = req.body?.getReader();
      let text = '', bytes = 0;
      const decoder = new TextDecoder();
      if (!reader) return json({ error: 'Page data must be JSON' }, 400);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > maxBytes) { await reader.cancel(); return json({ error: 'Page data too large' }, 413); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      try { JSON.parse(text); } catch { return json({ error: 'Page data must be JSON' }, 400); }
      const r = await stub.op(who, { op: 'uvSet', name, data: b64encode(new TextEncoder().encode(text)) });
      return reply(r);
    }
  }
  return json({ error: 'Not Found' }, 404);
}

/** Fossil's sync protocol (application/x-fossil). */
async function handleSync(req: Request, env: Env, id: string): Promise<Response> {
  const type = (req.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/x-fossil') return new Response('send sync requests as application/x-fossil\n', { status: 415 });
  const cookie = (req.headers.get('Cookie') ?? '').match(/(?:^|;\s*)x-f-l-c=([^;]*)/)?.[1] ?? '';
  const r = await repo(env, id).sync(new Uint8Array(await req.arrayBuffer()), cookie);
  if (r.code === 'not_found') return new Response('not found\n', { status: 404 });
  // Anything that failed was rolled back; tell the client so it stops.
  if (!r.ok || !r.result) return errorReply(r.error ?? 'sync failed');
  return new Response(b64decode(r.result.data), { headers: { 'Content-Type': 'application/x-fossil', 'Cache-Control': 'no-store' } });
}

/**
 * A sync reply holding one error card: a 4-byte big-endian length of the
 * uncompressed body, then the body zlib-compressed (Fossil sync protocol §4.1).
 */
async function errorReply(message: string): Promise<Response> {
  const fossilized = message.replace(/\\/g, '\\\\').replace(/ /g, '\\s').replace(/\n/g, '\\n');
  const text = new TextEncoder().encode(`error ${fossilized}\n`);
  const z = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const out = new Uint8Array(4 + z.length);
  new DataView(out.buffer).setUint32(0, text.length);
  out.set(z, 4);
  return new Response(out, { headers: { 'Content-Type': 'application/x-fossil', 'Cache-Control': 'no-store' } });
}

/**
 * The viewer shell is a static asset, served here so each response gets a
 * fresh CSP nonce. The page renders in a sandboxed blob: iframe that inherits
 * this CSP: only nonce-stamped scripts and styles run, nothing connects out.
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
        `script-src 'self' 'nonce-${nonce}'`,
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
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === 'OPTIONS' && path.startsWith('/api/')) return new Response(null, { status: 204, headers: corsHeaders() });
    if (method === 'GET' && path === '/healthz') return json({ status: 'ok', ts: Date.now() });

    if (path.startsWith('/api/') && !csrf(req)) return json({ error: 'Matching Origin required' }, 403);
    const accountResponse = await accountRoutes(req, env);
    if (accountResponse) return accountResponse;
    if (method === 'GET' && (path === '/' || path === '/login')) {
      const shell = await env.ASSETS.fetch(new URL('/index.html', req.url));
      return new Response(shell.body, { status: shell.status, headers: { ...secHeaders(), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } });
    }

    if (path === '/api/artifacts') {
      if (method === 'POST') return handleCreate(req, env);
      if (method === 'GET') return handleList(req, env);
      return json({ error: 'Method Not Allowed' }, 405);
    }

    const api = /^\/api\/artifacts\/([A-Za-z0-9_-]{1,64})(\/.*)?$/.exec(path);
    if (api) {
      const id = await registry(env).resolve(api[1]!);
      if (!id) return json({ error: 'not found', code: 'not_found' }, 404);
      return handleArtifact(req, env, ctx, id, api[2] ?? '');
    }

    const sync = /^\/r\/([A-Za-z0-9_-]{1,64})\/?$/.exec(path);
    if (sync) {
      if (method !== 'POST') return Response.redirect(new URL(`/v/${sync[1]}`, req.url).toString(), 302);
      const id = await registry(env).resolve(sync[1]!);
      if (!id) return new Response('not found\n', { status: 404 });
      return handleSync(req, env, id);
    }

    if (method === 'GET' && /^\/v\/[A-Za-z0-9_-]{1,64}$/.test(path)) return handleViewer(req, env);

    return env.ASSETS.fetch(req);
  },
};
