#!/usr/bin/env node
// responder.mjs — the reference responder: what a session or a service that
// answers comments imitates. It knows no agent. For each new comment or reply
// it is told about, it replies "Received, working on it." on that thread.
//
//   node scripts/publish-html.mjs watch <link> | node scripts/responder.mjs <link>
//   WAKE_SINK_SECRET=… WAKE_SIGNATURE='sha256=…' node scripts/responder.mjs <link> < body.json
//
// Input, on stdin:
//   - JSON lines from `watch` ({artifact, ticket, change, kind, …}), or unsigned
//     wake payloads one per line; it answers each and exits when stdin ends.
//   - With WAKE_SINK_SECRET set: exactly one wake body from the webhook sink,
//     whose X-Signature value comes in --signature or WAKE_SIGNATURE. It checks
//     the HMAC over the exact bytes before reading them and exits 2, having done
//     nothing, when it does not match or is missing.
//
// The reply goes through the ticket API with the link's token: it works with a
// comment link (which has no Fossil login to push with) and an edit link alike,
// and needs no fossil binary. Before replying it reads the thread: it never
// answers its own reply text (the loop guard) and never answers a change that
// already has a reply of its own after it (a redelivery, a restart).
//
// With an edit link and a fossil binary it sets attached.json when it starts and
// removes it when it stops (stdin ends, SIGINT, SIGTERM), each with a Fossil
// mtime later than the one before, so a set and a clear within one second still
// land in order. Ticket text is data: it is never passed to a shell.

import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACK, apiGet, artifactDir, cacheRoot, changeText, ensureClone, fossil, fossilBinary, openLink, syncUrl, verifySignature,
} from './watch.mjs';

const HELP = `
Usage:
  node scripts/responder.mjs <edit-or-comment-url> [--name <text>] [--contact <text>] [--cache <dir>] [--signature sha256=<hex>]

Reads JSON lines from \`publish-html.mjs watch\` (or wake payloads) on stdin and
replies "${ACK}" to each new comment and reply. With WAKE_SINK_SECRET set, stdin
is one signed wake body; its X-Signature comes from --signature or WAKE_SIGNATURE.
Prints {"artifact","ticket","change","reply"} for each reply it posts.
`;

const MAX_BODY = 65_536;
const MAX_LINE = 1 << 20;
const THREADS_LIMIT = 200;
const ATTACHED = 'attached.json';

const args = process.argv.slice(2);
const flagValue = flag => {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
};
const withValues = new Set(['--name', '--contact', '--cache', '--signature']);
const positional = args.filter((a, i) => !a.startsWith('-') && !withValues.has(args[i - 1]));

const log = msg => process.stderr.write(`responder: ${msg}\n`);
function die(msg, code = 1) {
  log(msg);
  process.exit(code);
}

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (!positional[0]) die('usage: responder.mjs <edit-or-comment-url> (see --help)', 2);

// One line of 1 to `max` code points, as attached.json requires, or a usage error.
function oneLine(value, max, what) {
  const s = String(value).trim();
  if (!s || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(s) || Array.from(s).length > max) die(`${what} must be one line of 1 to ${max} characters`, 2);
  return s;
}
const name = oneLine(flagValue('--name') ?? 'reference responder', 100, '--name');
const contact = flagValue('--contact') === undefined ? null : oneLine(flagValue('--contact'), 200, '--contact');
const secret = process.env.WAKE_SINK_SECRET ?? '';
const signature = flagValue('--signature') ?? process.env.WAKE_SIGNATURE ?? '';
if (signature && !secret) die('a signature needs WAKE_SINK_SECRET to check it', 2);

let link;
try {
  link = await openLink(positional[0]);
} catch (e) {
  die(e.message);
}
if (link.role === 'read') die('this is a read link; replying needs the comment or the edit link');
const dir = artifactDir(cacheRoot(flagValue('--cache')), link.id);

// ─── Input ───────────────────────────────────────────────────────────────────

async function readBody() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BODY) die(`the wake body is over ${MAX_BODY} bytes; nothing done`, 2);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

let stopping = false, input = null;
function onSignal() {
  if (stopping) process.exit(130);
  stopping = true;
  input?.close();
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

let events;
if (secret) {
  const body = await readBody();
  if (!verifySignature(secret, body, signature)) die('the signature does not match the body; nothing done', 2);
  events = [body.toString('utf8')];
} else {
  input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  events = input[Symbol.asyncIterator](); // now, so no line arrives before anyone reads
}

// ─── attached.json ───────────────────────────────────────────────────────────

const nowSec = () => Math.floor(Date.now() / 1000);
const stamp = sec => new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ');

// Fossil keeps the unversioned file with the newest mtime, counted in whole
// seconds. Each write here is at least a second after the last one the
// repository holds, so a set never loses to an earlier clear, nor a clear to
// the set before it, however quickly they follow each other.
function attach() {
  const bin = link.role === 'write' ? fossilBinary() : null;
  if (!bin) {
    log('attached.json not set: it needs the edit link and a fossil binary');
    return null;
  }
  try {
    const url = syncUrl(link);
    const run = (...a) => fossil(bin, a, link.token);
    const repo = ensureClone(bin, link, dir, 'responder.fossil');
    run('uv', 'sync', url, '-R', repo);
    const held = Number(run('sql', '-R', repo, `SELECT coalesce(max(mtime), 0) FROM unversioned WHERE name = '${ATTACHED}'`).trim()) || 0;
    const setAt = Math.max(nowSec(), held + 1);
    const file = join(dir, ATTACHED);
    writeFileSync(file, `${JSON.stringify({ responder: name, since: new Date().toISOString(), ...(contact ? { contact } : {}) })}\n`, { mode: 0o600 });
    run('uv', 'add', file, '--as', ATTACHED, '--mtime', stamp(setAt), '-R', repo);
    run('uv', 'sync', url, '-R', repo);
    return () => {
      run('uv', 'rm', ATTACHED, '--mtime', stamp(Math.max(nowSec(), setAt + 1)), '-R', repo);
      run('uv', 'sync', url, '-R', repo);
    };
  } catch (e) {
    log(`attached.json not set: ${e.message}`);
    return null;
  }
}

// ─── Replies ─────────────────────────────────────────────────────────────────

const isAck = text => String(text ?? '').trim() === ACK;
const short = hash => hash.slice(0, 12);

/** A watch line or a wake payload as {artifact, ticket, change, kind}, or null. */
function eventOf(raw) {
  let e;
  try { e = JSON.parse(raw); } catch { return null; }
  if (!e || typeof e !== 'object') return null;
  const change = e.change ?? e.checkin;
  if (typeof e.artifact !== 'string' || typeof e.ticket !== 'string' || !/^[0-9a-f]{40}$/.test(e.ticket)
    || typeof change !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(change)) return null;
  return { artifact: e.artifact, ticket: e.ticket, change, kind: e.kind };
}

async function handle(raw) {
  if (raw.length > MAX_LINE) return log('skipped an oversized line');
  if (!raw.trim()) return;
  const ev = eventOf(raw);
  if (!ev) return log('skipped a line that is not a ticket change');
  if (ev.artifact !== link.id) return log(`skipped ${short(ev.change)}: another artifact`);
  if (ev.kind !== 'comment' && ev.kind !== 'reply') return log(`skipped ${short(ev.change)}: ${String(ev.kind).slice(0, 20)}`);
  // Read the thread from the Worker, not the event: the event says only where to look.
  const { tickets } = await apiGet(link, `/tickets?limit=${THREADS_LIMIT}`);
  const thread = tickets.find(t => t.uuid === ev.ticket);
  const i = thread ? thread.changes.findIndex(c => c.artifact === ev.change) : -1;
  if (i < 0) return log(`skipped ${short(ev.change)}: not in the newest ${THREADS_LIMIT} threads`);
  if (isAck(changeText(i === 0, thread.changes[i].fields ?? {}))) return log(`skipped ${short(ev.change)}: its own reply`);
  if (thread.changes.slice(i + 1).some(c => isAck(c.comment))) return log(`skipped ${short(ev.change)}: already acknowledged`);
  const r = await link.art.comment({ ticketUuid: thread.uuid, text: ACK });
  await new Promise(resolve => process.stdout.write(`${JSON.stringify({ artifact: link.id, ticket: thread.uuid, change: ev.change, reply: r.artifact })}\n`, resolve));
}

const detach = attach();
let failed = false;
try {
  for await (const raw of stopping ? [] : events) {
    try {
      await handle(raw);
    } catch (e) {
      failed = true;
      log(`could not reply: ${e.message}`);
    }
    if (stopping) break;
  }
} finally {
  try {
    detach?.();
  } catch (e) {
    failed = true;
    log(`attached.json not cleared: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
