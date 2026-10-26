// watch.mjs — the comment feed a responder reads: every ticket change that
// arrived since the last one seen, as one JSON line each. Used by
// `publish-html.mjs watch` and scripts/responder.mjs.
//
// With a fossil binary and a link that has a Fossil login (the edit or read
// link), it pulls the artifact's repository into a cache directory and reads
// the new ticket artifacts there. Otherwise (no binary, or a comment link,
// which has no login) it asks the Worker: GET …/timeline?since=&type=t, then
// GET …/tickets. Both print the same lines.
//
// Nothing here prints a token or a link that carries one; Fossil's own
// messages are scrubbed before they are shown.

import { spawnSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Artifact, parseFragment } from '../public/client.js';

/** The reference responder's reply, and its loop guard: it never answers this text. */
export const ACK = 'Received, working on it.';
/** The most lines one pass prints; the next pass carries on from the last. */
export const WATCH_MAX_ITEMS = 100;
const INTERVAL_MIN_MS = 5_000;
const INTERVAL_MAX_MS = 3_600_000;
const THREADS_LIMIT = 200; // the most GET …/tickets returns
const HTTP_TIMEOUT_MS = 30_000;
const FOSSIL_TIMEOUT_MS = 120_000;
const HASH = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const TICKET = /^[0-9a-f]{40}$/;

/** `30s`, `5m`, `1h` as milliseconds, 5 seconds to an hour; throws otherwise. */
export function parseInterval(raw) {
  const m = /^(\d{1,7})(s|m|h)$/.exec(String(raw));
  const ms = m ? Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[m[2]] : NaN;
  if (!(ms >= INTERVAL_MIN_MS && ms <= INTERVAL_MAX_MS)) {
    throw new Error(`--interval must be 5s to 1h, such as 30s or 5m (got ${JSON.stringify(String(raw).slice(0, 20))})`);
  }
  return ms;
}

/** The same mapping as ticketKind in src/wake.ts: the API, a push and watch agree. */
export function ticketKind(opens, fields) {
  return opens ? 'comment' : fields.status === 'Closed' ? 'resolve' : 'reply';
}

/** What a change says: the opening text for the change that opens a thread, else its remark. */
export function changeText(opens, fields) {
  return (opens ? fields.comment : fields.icomment || fields['+icomment']) ?? '';
}

const ESCAPES = { s: ' ', n: '\n', t: '\t', r: '\r', v: '\v', f: '\f', 0: '\0', '\\': '\\' };
const defossilize = s => s.replace(/\\(.)/gs, (_, c) => ESCAPES[c] ?? c);

/** A ticket change artifact's K, U, D and J cards, or null when it is not one. */
export function parseTicketArtifact(text) {
  let ticket = '', author = null, time = null;
  const fields = {};
  for (const line of String(text).split('\n')) {
    const card = line[0], rest = line.slice(2);
    if (line[1] !== ' ') continue;
    if (card === 'K' && TICKET.test(rest)) ticket = rest;
    else if (card === 'U') author = defossilize(rest);
    else if (card === 'D' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?$/.test(rest)) time = new Date(`${rest}Z`).toISOString();
    else if (card === 'J') {
      const sp = rest.indexOf(' ');
      fields[sp < 0 ? rest : rest.slice(0, sp)] = sp < 0 ? '' : defossilize(rest.slice(sp + 1));
    }
  }
  return ticket && author !== null && time ? { ticket, author, time, fields } : null;
}

/** A link fit to print: no fragment, no credentials. */
export function redact(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return '<link>';
  }
}

/** Whether `header` is `sha256=<hex HMAC-SHA256 of body keyed by secret>`; constant time. */
export function verifySignature(secret, body, header) {
  const m = typeof header === 'string' ? /^sha256=([0-9a-f]{64})$/.exec(header) : null;
  if (!secret || !m) return false;
  const want = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(want, Buffer.from(m[1], 'hex'));
}

/** The cache root: --cache, HTML_PUBLISHER_CACHE, or ~/.cache/html-artifact-publisher. */
export function cacheRoot(flag) {
  return flag || process.env.HTML_PUBLISHER_CACHE
    || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'html-artifact-publisher');
}

/** This artifact's directory in the cache, private to the user. */
export function artifactDir(root, id) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Open an artifact link: its origin, real id (a slug resolves), token and the
 * role the token holds. Throws with a message that never shows the token.
 */
export async function openLink(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('not a URL (expected https://<host>/v/<id>#<token>)'); }
  const m = /^\/v\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
  if (!m) throw new Error(`not an artifact link (expected /v/<id>#<token>): ${redact(raw)}`);
  const { token } = parseFragment(url.hash);
  const info = await new Artifact(url.origin, m[1], token).info();
  return { origin: url.origin, id: info.id, token, role: info.role, timeline: info.timeline ?? [], art: new Artifact(url.origin, info.id, token) };
}

/** GET a path under the artifact's API with the link's token. */
export async function apiGet(link, path) {
  const res = await fetch(`${link.origin}/api/artifacts/${link.id}${path}`, {
    headers: { Authorization: `Token ${link.token}` }, cache: 'no-store', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path.split('?')[0]} answered ${res.status}${body?.error ? `: ${String(body.error).slice(0, 200)}` : ''}`);
  return body;
}

/** The fossil binary (FOSSIL, else `fossil` on PATH), or null when there is none. */
export function fossilBinary() {
  const bin = process.env.FOSSIL || 'fossil';
  const r = spawnSync(bin, ['version'], { stdio: 'ignore', timeout: 10_000 });
  return r.error || r.status !== 0 ? null : bin;
}

/** The Fossil sync URL for the link's login (edit: editor, read: viewer), or null for a comment link. */
export function syncUrl(link) {
  const login = { write: 'editor', read: 'viewer' }[link.role];
  if (!login) return null;
  const u = new URL(link.origin);
  u.username = login;
  u.password = link.token;
  u.pathname = `/r/${link.id}`;
  return u.toString();
}

/** Run fossil; its output, or an error whose message has the token scrubbed out. Never a shell. */
export function fossil(bin, args, token) {
  const r = spawnSync(bin, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: FOSSIL_TIMEOUT_MS, maxBuffer: 64 << 20,
  });
  if (!r.error && r.status === 0) return r.stdout;
  const msg = (`${r.stderr ?? ''}${r.stdout ?? ''}`.trim() || r.error?.message || `exit ${r.status}`).split(token).join('<token>');
  throw new Error(`fossil ${args[0]} failed: ${msg.slice(0, 500)}`);
}

/** A clone of the link's repository in `dir`, made on first use; its path. */
export function ensureClone(bin, link, dir, name) {
  const repo = join(dir, name);
  if (!existsSync(repo)) {
    // Cloned under a temporary name, so an interrupted clone is never mistaken for a repository.
    const tmp = `${repo}.${process.pid}.tmp`;
    fossil(bin, ['clone', syncUrl(link), tmp], link.token);
    renameSync(tmp, repo);
  }
  return repo;
}

/** The last change watch printed for this artifact, or null. */
export function loadState(dir) {
  try {
    const { last } = JSON.parse(readFileSync(join(dir, 'watch.json'), 'utf8'));
    return HASH.test(last) ? last : null;
  } catch {
    return null;
  }
}

function saveState(dir, last) {
  const tmp = join(dir, `watch.json.${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify({ last })}\n`, { mode: 0o600 });
  renameSync(tmp, join(dir, 'watch.json'));
}

// Ticket changes that arrived after `since` (all when null), oldest first, in
// the clone's own arrival order: by receipt, then rid, as the Worker orders them.
function viaFossil(bin, link, repo, since, max) {
  fossil(bin, ['pull', syncUrl(link), '-R', repo], link.token);
  const after = since ? `(coalesce(b.rcvid, 0), b.rid) > (SELECT coalesce(rcvid, 0), rid FROM blob WHERE uuid = '${since}')` : '1';
  const sql = `SELECT json_object(
    'known', ${since ? `(SELECT count(*) FROM blob WHERE uuid = '${since}' AND size >= 0)` : 1},
    'items', json((SELECT json_group_array(json_object('hash', uuid, 'content', CAST(content(uuid) AS TEXT), 'opens', opens)) FROM (
      SELECT b.uuid AS uuid, (SELECT x.rid FROM tagxref x WHERE x.tagid = tx.tagid ORDER BY x.mtime, x.rid LIMIT 1) = b.rid AS opens
      FROM event e JOIN blob b ON b.rid = e.objid JOIN tagxref tx ON tx.rid = b.rid
      JOIN tag t ON t.tagid = tx.tagid AND t.tagname GLOB 'tkt-*'
      WHERE e.type = 't' AND ${after} ORDER BY coalesce(b.rcvid, 0), b.rid LIMIT ${max}))))`;
  const { known, items } = JSON.parse(fossil(bin, ['sql', '-R', repo, sql], link.token).trim());
  if (!known) throw new Error(`the repository has no artifact ${since.slice(0, 12)}…`);
  return items.map(it => {
    const t = parseTicketArtifact(it.content);
    if (!t) return { change: it.hash, missing: true };
    const opens = !!it.opens;
    return { change: it.hash, ticket: t.ticket, kind: ticketKind(opens, t.fields), author: t.author, text: changeText(opens, t.fields), time: t.time };
  });
}

// The same, from the Worker. With no `since`, the first check-in is the start:
// every ticket arrived after it.
async function viaHttp(link, since, max) {
  const from = since ?? link.timeline.at(-1)?.uuid;
  if (!from) return [];
  const { timeline } = await apiGet(link, `/timeline?since=${from}&type=t`);
  const entries = timeline.slice().reverse().slice(0, max);
  if (!entries.length) return [];
  const { tickets } = await apiGet(link, `/tickets?limit=${THREADS_LIMIT}`);
  const byChange = new Map();
  for (const t of tickets) t.changes.forEach((c, i) => byChange.set(c.artifact, { t, c, i }));
  return entries.map(e => {
    const hit = byChange.get(e.uuid);
    if (!hit) return { change: e.uuid, missing: true };
    const { t, c, i } = hit, fields = c.fields ?? {};
    return {
      change: c.artifact, ticket: t.uuid, kind: ticketKind(i === 0, fields), author: c.user,
      text: changeText(i === 0, fields), time: new Date(c.time).toISOString(),
    };
  });
}

/**
 * `watch`: print each new ticket change as a JSON line, keep the last one
 * printed in <cache>/<id>/watch.json, and repeat every `interval` until
 * SIGINT or SIGTERM (or once). Resolves when it stops; rejects on a bad
 * argument, and on any failure when `once`.
 */
export async function runWatch({ rawUrl, since, interval = '30s', once = false, cache, log = m => process.stderr.write(`watch: ${m}\n`) }) {
  if (since !== undefined && !HASH.test(since)) throw new Error('--since must be a full artifact hash (40 or 64 hex digits)');
  const intervalMs = parseInterval(interval);
  const link = await openLink(rawUrl);
  const dir = artifactDir(cacheRoot(cache), link.id);
  const bin = syncUrl(link) ? fossilBinary() : null;
  let last = since ?? loadState(dir);
  let stopping = false, wake = () => {};
  const stop = () => { stopping = true; wake(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdout.on('error', stop); // the reader went away
  const print = line => new Promise(resolve => process.stdout.write(`${JSON.stringify(line)}\n`, resolve));
  try {
    while (!stopping) {
      let n = 0;
      try {
        const items = bin
          ? viaFossil(bin, link, ensureClone(bin, link, dir, 'repo.fossil'), last, WATCH_MAX_ITEMS)
          : await viaHttp(link, last, WATCH_MAX_ITEMS);
        for (const it of items) {
          if (it.missing) log(`skipped ${it.change.slice(0, 12)}: not a ticket change this link can read`);
          else await print({ artifact: link.id, ticket: it.ticket, change: it.change, kind: it.kind, author: it.author, text: it.text, time: it.time });
          last = it.change;
          saveState(dir, last);
          n++;
        }
      } catch (e) {
        if (once) throw e;
        log(e.message);
      }
      if (once || stopping) break;
      // A full pass means more are waiting: carry on at once.
      if (n < WATCH_MAX_ITEMS) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, intervalMs);
          wake = () => { clearTimeout(timer); resolve(); };
        });
      }
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
