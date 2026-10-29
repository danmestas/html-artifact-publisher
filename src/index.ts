/**
 * html-artifact-publisher — Cloudflare Worker
 *
 * Every artifact is a Fossil repository held by its own SQLite-backed
 * Durable Object (src/repo.ts). go-libfossil runs inside the object as wasm
 * (fossil/, src/fossil.ts); the Registry object (src/registry.ts) lists them.
 *
 * Access: the owner's bearer token, or an artifact's read, comment or write
 * token, sent as `Authorization: Token <t>`. Links carry the token in the fragment:
 *   /v/<id>#<readToken>      read link
 *   /v/<id>#<commentToken>   comment link: read, and comment
 *   /v/<id>#<writeToken>     edit link
 *   ...@<check-in>           that check-in instead of the tip
 *
 * Routes:
 *   GET    /healthz
 *   POST   /api/artifacts                    Create (owner)
 *   GET    /api/artifacts                    List (owner)
 *   GET    /api/artifacts/:id                Tip, title, timeline, attached responder (read)
 *   PUT    /api/artifacts/:id                New check-in; `parent` must be the tip (write)
 *   DELETE /api/artifacts/:id                Delete (write)
 *   GET    /api/artifacts/:id/bundle?at=     Every file of a check-in (read)
 *   GET    /api/artifacts/:id/files/<path>   One file (read); a blob's pointer file, for blobs
 *   PUT    /api/artifacts/:id/blobs/:sha256  Upload a blob before committing its pointer (write)
 *   PUT    /api/blobs/:sha256                Upload a blob for a new artifact (owner or account)
 *   GET    /b/:id/:sha256?exp=&sig=          A blob, through a signed link from the bundle
 *   GET    /api/artifacts/:id/data[/<name>]  Page data (read)
 *   PUT    /api/artifacts/:id/data/<name>    Page data (write)
 *   GET    /api/artifacts/:id/tickets?limit= The newest-changed threads with their changes (read)
 *   POST   /api/artifacts/:id/tickets        Open, reply to, resolve or reopen a thread (comment)
 *   GET    /api/artifacts/:id/attachments?target=<ticket>    A thread's attachments, with signed links (read)
 *   PUT    /api/artifacts/:id/attachments/:sha256            Upload an attachment's bytes to R2 (comment)
 *   POST   /api/artifacts/:id/attachments    Attach text, or bytes uploaded with PUT, to a thread (comment)
 *   DELETE /api/artifacts/:id/attachments    Remove a thread's attachment; its bytes stay (comment)
 *   GET    /a/:id?target=&name=&exp=&sig=    An attachment, through a signed link from the list
 *   GET    /api/artifacts/:id/timeline?since=<hash>&type=t   Entries that arrived after <hash> (read)
 *   POST   /r/:id                            Fossil sync: `fossil clone https://editor:<writeToken>@host/r/<id>`
 *   GET    /v/:id                            Viewer
 */

import { Repo } from './repo';
import { preview } from './preview';
import { publicationRoutes } from './publications';
import { accountRoutes, artifactCaller, csrf, identity, readBody } from './accounts';
import { Registry, testHooks } from './registry';
import {
  attachmentLink, blobKey, blobLinks, externalRef, getBlob, isSha, missingBlobs, pointersIn, putBlob,
  serveAttachmentBytes, serveExternalAttachment, verifyAttachmentLink,
} from './blobs';
import { BLOB_THRESHOLD, typeOf } from '../public/blobs.js';
import type { FossilReply } from './fossil';
import { b64decode, b64encode, clampTtl, genId, genToken, isoOrNull, sha256hex } from './util';
import { ATTACHED_FILE, attachedFrom } from './attached';
import { ticketAuthor } from './ticket-author';
import type { Caller, Role } from './repo';
import { TICKET_BODY, ticketChange } from './ticket-body';
import { ticketKind, wake, wakeKind, type WakeKind } from './wake';

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
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
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
  bad_request: 400, forbidden: 403, not_found: 404, conflict: 409, unchanged: 409, too_large: 413, quota: 413, aborted: 500, internal: 500,
};

/** A Fossil reply as an HTTP response: the result, or the error with its status. */
function reply(r: FossilReply<unknown>): Response {
  if (r.ok) return json(r.result);
  return json({ error: r.error, code: r.code }, STATUS[r.code ?? 'internal'] ?? 500);
}

function missingReply(paths: string[]): Response {
  return json({ error: `upload these files before committing them: ${paths.join(', ')}`, code: 'missing_blob', missing: paths }, 400);
}

type Actor = Awaited<ReturnType<typeof identity>>;
/** Who an upload counts for: the instance owner's bearer token, or an account. */
const principal = (actor: Actor) => (actor.user ? `user:${actor.user.id}` : 'owner');
/** Uploads a commit to artifact `id` may use: its edit link's, and the caller's own. */
const uploaders = (id: string, actor: Actor) => [`artifact:${id}`, ...(actor.legacy || actor.user ? [principal(actor)] : [])];

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...corsHeaders(), ...secHeaders() })) out.headers.set(k, v);
  return out;
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

// ─── Wake on X-Wake ──────────────────────────────────────────────────────────
//
// A write carrying `X-Wake: <kind>` (comment, reply, resolve or publish) tells
// the configured wake sink (src/wake.ts) the artifact changed. Runs after the
// response; never fails or delays the write.

function wakeOnHeader(env: Env, ctx: ExecutionContext, req: Request, id: string, tip: string, author: string): void {
  const kind = wakeKind(req.headers.get('X-Wake'));
  if (kind) ctx.waitUntil(wake(env, { artifact: id, checkin: tip, ticket: null, author, kind }));
}

// A ticket change wakes the sink whether it came through the API or a fossil
// push. `checkin` is the change's own artifact hash, so the idempotency key
// `<artifact>-<hash>` names the change, not the page: the same change seen
// twice carries the same key, and the receiver drops the second.
function wakeOnTicket(env: Env, ctx: ExecutionContext, id: string, ticket: string, change: string, author: string, kind: WakeKind): void {
  ctx.waitUntil(wake(env, { artifact: id, checkin: change, ticket, author, kind }));
}

/** The author a ticket or attachment change records: from the credential, never the body. */
function changeAuthor(role: Role | null, actor: Actor): string {
  return ticketAuthor(role === 'comment' ? { kind: 'comment' }
    : actor.user ? { kind: 'account', name: actor.user.name }
    : actor.legacy ? { kind: 'owner' } : { kind: 'edit' });
}

// ─── Attachments ─────────────────────────────────────────────────────────────

/** An attachment as the engine lists it (fossil/attachments.go). */
interface AttachmentRow {
  name: string; size: number; external: boolean; sha256?: string; type?: string;
  user: string; time: string; comment: string; data?: string;
}

const TICKET = /^[0-9a-f]{4,64}$/;
/** Attachment uploads per artifact in 15 minutes; a client address may make four times as many. */
const ATTACHMENT_PUTS = 60;
/** How long an upload may wait to be attached before its bytes are swept. */
const UNATTACHED_UPLOAD_TTL = 24 * 3600;
const MEDIA_TYPE = /^[\w.+-]{1,64}\/[\w.+-]{1,128}$/;
const ATTACHMENT_BODY = 'Body must be JSON with target (a thread\'s ticket id) and name, plus content (text up to 256 KB) or sha256, size and type of bytes uploaded with PUT …/attachments/<sha256>';

/** A bare file name an A card can carry: no directory, no control characters. */
const validName = (n: unknown): n is string =>
  typeof n === 'string' && n.length > 0 && n.length <= 200 && n !== '.' && n !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(n);

async function handleAttachments(req: Request, env: Env, id: string, rest: string, who: Caller, actor: Actor): Promise<Response | null> {
  const stub = repo(env, id), method = req.method;
  const upload = /^\/attachments\/([^/]+)$/.exec(rest);
  if (upload && (method === 'PUT' || method === 'HEAD')) {
    const role = await stub.role(who);
    if (role !== 'comment' && role !== 'write') return json({ error: 'the comment link is required to attach files' }, 403);
    const sha = upload[1]!, reg = registry(env);
    const uploader = {
      known: async () => (await reg.allowedAttachments(id, [sha])).length > 0,
      busy: () => reg.deletingObject(blobKey(sha, 'attachments')),
      record: () => reg.recordUpload(sha, `attachment:${id}`, blobKey(sha, 'attachments')),
    };
    if (method === 'HEAD' || !isSha(sha)) return withCors(await putBlob(req, env, sha, uploader, 'attachments'));
    const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
    const allowed = await reg.rate([`attachment-put:${id}`], ATTACHMENT_PUTS, 900) &&
      await reg.rate([`attachment-put-ip:${await sha256hex(ip)}`], ATTACHMENT_PUTS * 4, 900);
    if (!allowed) {
      return json({ error: 'too many uploads: wait a few minutes', code: 'rate_limited' }, 429);
    }
    // Register what the current attachments name first, as the list does: a stub
    // pushed from a clone may name an upload not yet attached through the API.
    const current = await currentExternals(stub, who);
    if (current) {
      await reg.refAttachments(id, await reg.allowedAttachments(id, current));
      await reg.sweepAttachmentUploads(id, UNATTACHED_UPLOAD_TTL, current);
    }
    const length = Number(req.headers.get('Content-Length') ?? NaN);
    const quota = parseInt(env.MAX_ATTACHMENT_BYTES, 10);
    let reserved = false;
    if (Number.isSafeInteger(length) && length >= 0) {
      const held = await reg.reserveAttachment(id, sha, length, quota);
      if (held === 'over') return json({ error: `this artifact's attachments may hold at most ${quota} bytes`, code: 'quota' }, 413);
      reserved = held === 'reserved';
    }
    const res = await putBlob(req, env, sha, uploader, 'attachments');
    if (!res.ok && reserved) await reg.releaseAttachment(id, sha);
    return withCors(res);
  }
  if (rest !== '/attachments') return null;

  /** The thread `target` names, as a reply when it is not a thread of this artifact. */
  const thread = async (target: string): Promise<Response | null> => {
    const known = (await stub.op(who, { op: 'ticketChanges', ticketUuid: target })) as FossilReply<unknown>;
    return known.ok ? null : reply(known);
  };

  if (method === 'GET') {
    const target = new URL(req.url).searchParams.get('target') ?? '';
    if (!TICKET.test(target)) return json({ error: 'target must be a thread\'s ticket id' }, 400);
    // Only threads: attachments on wiki pages or tech notes pushed from a clone stay out of reach.
    const notThread = await thread(target);
    if (notThread) return notThread;
    const r = (await stub.op(who, { op: 'attachList', target })) as FossilReply<{ attachments: AttachmentRow[] }>;
    if (!r.ok || !r.result) return reply(r);
    const reg = registry(env);
    // Stubs pushed with fossil never came through POST: link only bytes this
    // artifact already names or that were uploaded to it.
    const shas = r.result.attachments.flatMap(a => (a.external && a.sha256 ? [a.sha256] : []));
    const { refs: allowed } = await reg.refAttachments(id, await reg.allowedAttachments(id, shas));
    const attachments = await Promise.all(r.result.attachments.map(async a => {
      let missing = a.size < 0;
      if (a.external) {
        const head = a.sha256 && allowed.includes(a.sha256) ? await env.BLOBS.head(blobKey(a.sha256, 'attachments')) : null;
        missing = !head || head.size !== a.size;
      }
      return {
        name: a.name, size: a.size, type: a.external && a.type ? a.type : typeOf(a.name), external: a.external,
        ...(a.external ? { sha256: a.sha256 } : {}), user: a.user, time: a.time,
        ...(missing ? { missing: true } : { url: await attachmentLink(env, id, target, a.name) }),
      };
    }));
    return json({ attachments });
  }

  if (method === 'POST' || method === 'DELETE') {
    const b = await readBody(req, 2_000_000);
    if (!b || typeof b.target !== 'string' || !TICKET.test(b.target) || !validName(b.name)) return json({ error: ATTACHMENT_BODY }, 400);
    const notThread = await thread(b.target);
    if (notThread) return notThread;
    const role = await stub.role(who);
    const user = changeAuthor(role, actor);
    // Comment links share one identity: each may change only what comment links attached.
    const guard = role === 'comment' ? user : '';
    // After a change, stop counting and keep only the R2 bytes the current attachments name.
    const done = async (r: FossilReply<unknown>, status: number) => {
      if (!r.ok) return reply(r);
      // The mark comes before the read: a ref made or confirmed after it may name bytes the read missed.
      const mark = await registry(env).attachmentMark();
      const current = await currentExternals(stub, who);
      const pause = testHooks(env).pause;
      if (pause > 0) await new Promise(res => setTimeout(res, pause));
      if (current) await registry(env).reconcileAttachments(id, current, mark);
      return json(r.result, status);
    };
    if (method === 'DELETE') return done((await stub.op(who, { op: 'attachDelete', target: b.target, name: b.name, user, guard })) as FossilReply<unknown>, 200);

    const comment = typeof b.comment === 'string' ? b.comment.slice(0, 1000) : '';
    const maxCount = parseInt(env.MAX_ATTACHMENTS, 10);
    if (typeof b.content === 'string') {
      const bytes = new TextEncoder().encode(b.content);
      if (bytes.length > BLOB_THRESHOLD) return json({ error: `content is over ${BLOB_THRESHOLD} bytes: upload it with PUT …/attachments/<sha256> and attach it by sha256`, code: 'too_large' }, 413);
      if (externalRef(bytes)) return json({ error: 'content is a pointer or an attachment stub; attach bytes by sha256 instead', code: 'bad_request' }, 400);
      return done((await stub.op(who, { op: 'attachAdd', target: b.target, name: b.name, data: b64encode(bytes), user, comment, guard, maxCount })) as FossilReply<unknown>, 201);
    }
    const { sha256, size, type } = b;
    const max = parseInt(env.MAX_BLOB_BYTES, 10);
    if (typeof sha256 !== 'string' || !isSha(sha256) || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > max ||
        typeof type !== 'string' || !MEDIA_TYPE.test(type)) return json({ error: ATTACHMENT_BODY }, 400);
    const reg = registry(env);
    // Record the reference, pending, before checking R2 and writing: no other artifact's deletion
    // removes the bytes mid-attach, and no reconcile drops them before the write is visible.
    // Bytes being deleted are not referenced, and so count as missing.
    const { refs, added } = await reg.refAttachments(id, await reg.allowedAttachments(id, [sha256]), true);
    const kept = refs.filter(sha => !added.includes(sha));
    const head = refs.length ? await env.BLOBS.head(blobKey(sha256, 'attachments')) : null;
    if (!head || head.size !== size) {
      await reg.unrefAttachments(id, added);
      await reg.confirmAttachments(id, kept);
      return json({ error: `upload the bytes with PUT …/attachments/${sha256} before attaching them`, code: 'missing_blob' }, 400);
    }
    const r = (await stub.op(who, { op: 'attachAddExternal', target: b.target, name: b.name, sha256, size, type, user, comment, guard, maxCount })) as FossilReply<unknown>;
    if (r.ok) await reg.confirmAttachments(id, refs);
    else { await reg.unrefAttachments(id, added); await reg.confirmAttachments(id, kept); }
    return done(r, 201);
  }
  return null;
}

/** The R2 bytes the repository's current attachments name, or null when it cannot say. */
async function currentExternals(stub: ReturnType<typeof repo>, who: Caller): Promise<string[] | null> {
  const r = (await stub.op(who, { op: 'attachExternals' })) as FossilReply<{ sha256: string[] }>;
  return r.ok && r.result ? r.result.sha256 : null;
}

/** GET /a/:id — an attachment through a signed link. */
async function handleAttachmentLink(req: Request, env: Env, key: string): Promise<Response> {
  const denied = () => json({ error: 'this link has expired or is invalid' }, 403);
  const id = await registry(env).resolve(key);
  if (!id || id !== key) return denied();
  const link = await verifyAttachmentLink(env, id, new URL(req.url));
  if (!link) return denied();
  // The signature proves a reader of this artifact minted the link.
  const r = (await repo(env, id).op({ owner: true, token: '' }, { op: 'attachRead', target: link.target, name: link.name })) as FossilReply<AttachmentRow>;
  if (!r.ok || !r.result) return json({ error: 'not found' }, 404);
  const a = r.result;
  if (a.external) {
    if (!a.sha256 || !(await registry(env).hasAttachment(id, a.sha256))) return denied();
    return serveExternalAttachment(req, env, a.sha256, a.name, a.type ?? 'application/octet-stream', link.maxAge);
  }
  return serveAttachmentBytes(b64decode(a.data ?? ''), a.name, typeOf(a.name), link.maxAge);
}

// ─── Handlers ────────────────────────────────────────────────────────────────

import { validIcon, ICON_NAMES } from '../public/icons.js';

interface CreateBody {
  icon?: string | null;
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
  if (!validIcon(b.icon)) return json({ error: `icon must be null or one of: ${ICON_NAMES.join(', ')}` }, 400);
  const pointers = pointersIn(b.files);
  const shas = Object.values(pointers).map(p => p.sha256);
  const missing = await missingBlobs(env, pointers, await registry(env).allowedBlobs('', [principal(actor)], shas));
  if (missing.length) return missingReply(missing);
  const title = String(b.title ?? '').slice(0, 300) || 'Untitled';
  const ttl = b.ttlSeconds === null ? null : clampTtl(b.ttlSeconds, parseInt(env.DEFAULT_TTL_SECONDS, 10), parseInt(env.MAX_TTL_SECONDS, 10));
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = ttl != null ? now + ttl : null;
  const id = genId();
  const readToken = genToken();
  const writeToken = genToken();

  if (!(await registry(env).add({ id, slug: b.slug ?? null, title, createdAt: now, updatedAt: now, expiresAt, tip: '', ownerId: actor.user?.id ?? 'instance-owner', icon: b.icon ?? 'document' }))) {
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
  await registry(env).consumeUploads(principal(actor), await registry(env).refBlobs(id, shas));
  await registry(env).audit(actor.user?.id ?? 'instance-owner', 'publish', id, title);

  const origin = new URL(req.url).origin;
  const page = `${origin}/v/${b.slug ?? id}`;
  return json({
    id,
    tip: r.result.tip,
    viewerUrl: actor.explicit ? `${page}#${readToken}` : page,
    ...(actor.explicit ? {
      editUrl: `${page}#${writeToken}`,
      commentUrl: `${page}#${await repo(env, id).commentToken({ owner: true, token: '' })}`,
      cloneUrl: `${origin.replace('://', `://editor:${writeToken}@`)}/r/${id}`,
    } : {}),
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
    id: e.id, title: e.title, tip: e.tip, icon: e.icon ?? 'document',
    createdAt: isoOrNull(e.createdAt), updatedAt: isoOrNull(e.updatedAt), expiresAt: isoOrNull(e.expiresAt),
    viewerUrl: `${origin}/v/${e.slug ?? e.id}`,
  }));
  return json({ artifacts });
}

interface UpdateBody {
  icon?: string | null;
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
      const [meta, role, readToken, commentToken, flag] = await Promise.all([
        stub.info(), stub.role(who), stub.readToken(who), stub.commentToken(who),
        stub.op(who, { op: 'uvGet', name: ATTACHED_FILE }) as Promise<FossilReply<{ data: string | null }>>,
      ]);
      return json({
        id, title: meta?.title, icon: entry?.icon ?? 'document', role, expiresAt: isoOrNull(meta?.expiresAt ?? null), ...r.result, canManage,
        attached: attachedFrom(flag.ok ? flag.result?.data : null),
        ...(readToken ? { readToken } : {}), ...(commentToken ? { commentToken } : {}),
      });
    }
    if (method === 'PUT') {
      const b = await body<UpdateBody>(req, env);
      if (!b || !validFiles(b.files) || typeof b.parent !== 'string' || !b.parent) {
        return json({ error: 'Body must be JSON with parent (the check-in you started from) and files' }, 400);
      }
      if (b.title !== undefined && actor.user && !canManage) return json({ error: 'Artifact owner required to rename' }, 403);
      if ((await stub.role(who)) !== 'write') return reply(await stub.op(who, { op: 'commit' }));
      if (!validIcon(b.icon)) return json({ error: `icon must be null or one of: ${ICON_NAMES.join(', ')}` }, 400);
      const pointers = pointersIn(b.files);
      // Record the references before checking R2, so no other artifact's deletion removes these blobs mid-commit.
      // Blobs being deleted are not referenced, and so count as missing.
      const allowed = await registry(env).refBlobs(id, await registry(env).allowedBlobs(id, uploaders(id, actor), Object.values(pointers).map(p => p.sha256)));
      const missing = await missingBlobs(env, pointers, allowed);
      if (missing.length) return missingReply(missing);
      const user = String(b.user ?? 'web').slice(0, 64);
      const r = (await stub.op(who, {
        op: 'commit', parent: b.parent, files: b.files, comment: String(b.message ?? 'Update').slice(0, 1000), user,
      })) as FossilReply<{ tip: string }>;
      const title = typeof b.title === 'string' ? b.title.slice(0, 300) : undefined;
      if (r.code === 'unchanged' && r.result?.tip && b.icon !== undefined && (b.icon ?? 'document') !== (entry?.icon ?? 'document')) {
        if (title) await stub.rename(title);
        await registry(env).touch(id, undefined, title, b.icon);
        return json({ tip: r.result.tip, parent: r.result.tip });
      }
      if (!r.ok || !r.result) return reply(r);
      if (title) await stub.rename(title);
      await registry(env).touch(id, r.result.tip, title, b.icon);
      if (actor.legacy || actor.user) await registry(env).consumeUploads(principal(actor), allowed);
      wakeOnHeader(env, ctx, req, id, r.result.tip, user);
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

  if (rest === '/bundle' && method === 'GET') {
    const r = (await stub.op(who, { op: 'bundle', at })) as FossilReply<{ files: Record<string, string> }>;
    if (!r.ok || !r.result) return reply(r);
    const pointers = pointersIn(r.result.files);
    // Pointers pushed with fossil never passed through a commit here: link only
    // blobs this artifact already uses or that were uploaded with its edit link.
    const allowed = await registry(env).refBlobs(id, await registry(env).allowedBlobs(id, [`artifact:${id}`], Object.values(pointers).map(p => p.sha256)));
    const linked = Object.fromEntries(Object.entries(pointers).filter(([, p]) => allowed.includes(p.sha256)));
    const missing = [...(r.result as { missing?: string[] }).missing ?? [], ...Object.keys(pointers).filter(path => !(path in linked))];
    return json({ ...r.result, missing, blobs: await blobLinks(env, id, linked) });
  }

  const blob = /^\/blobs\/([^/]+)$/.exec(rest);
  if (blob && (method === 'PUT' || method === 'HEAD')) {
    if ((await stub.role(who)) !== 'write') return json({ error: 'the edit link is required to upload files' }, 403);
    const sha = blob[1]!, reg = registry(env);
    return withCors(await putBlob(req, env, sha, {
      known: async () => (await reg.allowedBlobs(id, uploaders(id, actor), [sha])).length > 0,
      busy: () => reg.deletingObject(blobKey(sha)),
      record: () => reg.recordUpload(sha, `artifact:${id}`),
    }));
  }

  if (rest.startsWith('/files/') && method === 'GET') {
    const path = decodeURIComponent(rest.slice('/files/'.length));
    const r = (await stub.op(who, { op: 'raw', path, at })) as FossilReply<{ data: string; checkin: string }>;
    if (!r.ok || !r.result) return reply(r);
    return new Response(b64decode(r.result.data), {
      headers: { 'Content-Type': 'application/octet-stream', 'X-Checkin': r.result.checkin, 'Cache-Control': 'no-store', ...corsHeaders(), ...secHeaders() },
    });
  }

  if (rest === '/tickets' && method === 'GET') {
    // One engine call however many tickets there are: a comment link can add
    // tickets, and none can be deleted.
    const limit = url.searchParams.get('limit') ?? '100';
    if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 200) return json({ error: 'limit must be 1 to 200' }, 400);
    return reply(await stub.op(who, { op: 'ticketThreads', limit: Number(limit) }));
  }
  if (rest === '/tickets' && method === 'POST') {
    const b = await readBody(req, 65536);
    const change = b && ticketChange(b);
    if (!change) return json({ error: TICKET_BODY }, 400);
    const user = changeAuthor(await stub.role(who), actor);
    if (!change.ticketUuid) {
      const r = (await stub.op(who, { op: 'ticketAdd', fields: change.fields, user, comment: '' })) as FossilReply<{ ticketUuid: string; artifact: string }>;
      if (!r.ok || !r.result) return reply(r);
      wakeOnTicket(env, ctx, id, r.result.ticketUuid, r.result.artifact, user, 'comment');
      return json(r.result, 201);
    }
    const known = (await stub.op(who, { op: 'ticketChanges', ticketUuid: change.ticketUuid })) as FossilReply<unknown[]>;
    if (!known.ok) return reply(known);
    const r = (await stub.op(who, { op: 'ticketSet', ticketUuid: change.ticketUuid, fields: change.fields, user, comment: change.comment })) as FossilReply<{ artifact: string }>;
    if (!r.ok || !r.result) return reply(r);
    wakeOnTicket(env, ctx, id, change.ticketUuid, r.result.artifact, user, ticketKind(false, change.fields));
    return json({ ticketUuid: change.ticketUuid, ...r.result });
  }
  const attachments = await handleAttachments(req, env, id, rest, who, actor);
  if (attachments) return attachments;
  if (rest === '/timeline' && method === 'GET') {
    const since = url.searchParams.get('since') ?? '';
    const types = url.searchParams.getAll('type');
    if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(since) || types.length > 8 || types.some(t => !/^(ci|e|f|g|t|w)$/.test(t))) {
      return json({ error: 'since must be a full artifact hash; type may be ci, e, f, g, t or w' }, 400);
    }
    const r = (await stub.op(who, { op: 'timelineSince', hash: since, types })) as FossilReply<unknown[]>;
    return r.ok ? json({ timeline: r.result }) : reply(r);
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

/**
 * Fossil's sync protocol (application/x-fossil). A push that stored ticket
 * changes wakes the sink once for each, as the ticket API does; a clone, a
 * pull, or a push of artifacts the repository already had stores nothing and
 * wakes nobody.
 */
async function handleSync(req: Request, env: Env, ctx: ExecutionContext, id: string): Promise<Response> {
  const type = (req.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/x-fossil') return new Response('send sync requests as application/x-fossil\n', { status: 415 });
  const cookie = (req.headers.get('Cookie') ?? '').match(/(?:^|;\s*)x-f-l-c=([^;]*)/)?.[1] ?? '';
  const r = await repo(env, id).sync(new Uint8Array(await req.arrayBuffer()), cookie);
  if (r.code === 'not_found') return new Response('not found\n', { status: 404 });
  // Anything that failed was rolled back; tell the client so it stops.
  if (!r.ok || !r.result) return errorReply(r.error ?? 'sync failed');
  for (const t of r.result.tickets ?? []) wakeOnTicket(env, ctx, id, t.ticket, t.change, t.author, t.kind);
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
  // Pages may load blobs (images, media, fonts) through signed links, and nothing else.
  const blobs = `${new URL(req.url).origin}/b/`;
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
        // Pages may compile their own WebAssembly (sql.js, image codecs, ...). It
        // gains them no network access: everything else here still applies.
        `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
        `style-src 'self' 'nonce-${nonce}'`,
        "style-src-attr 'unsafe-inline'",
        `img-src data: blob: ${blobs}`,
        `font-src data: blob: ${blobs}`,
        `media-src data: blob: ${blobs}`,
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
    const publicationResponse = await publicationRoutes(req, env);
    if (publicationResponse) return withCors(publicationResponse);
    if (method === 'GET' && (path === '/' || path === '/login')) {
      const shell = await env.ASSETS.fetch(new URL('/index.html', req.url));
      return new Response(shell.body, { status: shell.status, headers: { ...secHeaders(), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } });
    }

    const newBlob = /^\/api\/blobs\/([^/]+)$/.exec(path);
    if (newBlob && (method === 'PUT' || method === 'HEAD')) {
      const actor = await identity(req, env);
      if (!actor.legacy && !actor.user) return json({ error: 'Unauthorized' }, 401);
      const sha = newBlob[1]!, reg = registry(env), who = principal(actor);
      if (method === 'PUT') await reg.sweepBlobUploads(who);
      return withCors(await putBlob(req, env, sha, {
        known: async () => (await reg.allowedBlobs('', [who], [sha])).length > 0,
        busy: () => reg.deletingObject(blobKey(sha)),
        record: () => reg.recordUpload(sha, who),
      }));
    }

    const blobLink = /^\/b\/([A-Za-z0-9_-]{1,64})\/([0-9a-f]{64})$/.exec(path);
    if (blobLink && (method === 'GET' || method === 'HEAD')) {
      const reg = registry(env);
      return getBlob(req, env, blobLink[1]!, blobLink[2]!, async (id, sha) => (await reg.resolve(id)) === id && reg.hasBlob(id, sha));
    }

    const attachmentGet = /^\/a\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (attachmentGet && (method === 'GET' || method === 'HEAD')) return handleAttachmentLink(req, env, attachmentGet[1]!);

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

    const staticPreview = /^\/p\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (staticPreview && method === 'GET') {
      const id = await registry(env).resolve(staticPreview[1]!);
      if (!id) return new Response('Preview unavailable', { status: 404 });
      return preview(req, env, id);
    }

    const sync = /^\/r\/([A-Za-z0-9_-]{1,64})\/?$/.exec(path);
    if (sync) {
      if (method !== 'POST') return Response.redirect(new URL(`/v/${sync[1]}`, req.url).toString(), 302);
      const id = await registry(env).resolve(sync[1]!);
      if (!id) return new Response('not found\n', { status: 404 });
      return handleSync(req, env, ctx, id);
    }

    if (method === 'GET' && /^\/v\/[A-Za-z0-9_-]{1,64}$/.test(path)) return handleViewer(req, env);

    return env.ASSETS.fetch(req);
  },
};
