// `publish-html.mjs watch` and scripts/responder.mjs against a local Worker
// with WAKE_SINK_KIND=none: the responder learns of comments only by polling.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ticketKind as workerKind } from '../src/wake.ts';
import { ACK, parseInterval, parseTicketArtifact, redact, ticketKind, verifySignature } from '../scripts/watch.mjs';
import { createArtifact, haveStockFossil, startWorker } from './helpers/worker.mjs';

const root = new URL('..', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'artifact-watch-'));
const noFossilPath = join(work, 'empty-bin');
mkdirSync(noFossilPath);
const needsFossil = { skip: !haveStockFossil && !process.env.CI && 'stock fossil is not installed' };
let worker;

before(async () => { worker = await startWorker(work, { WAKE_SINK_KIND: 'none' }); });
after(() => {
  worker?.stop();
  rmSync(work, { recursive: true, force: true });
});

/** Run a script; `input` is written to its stdin and closed. */
function run(script, args, { input = '', env = {}, path } = {}) {
  return new Promise(resolve => {
    const childEnv = { ...process.env, HOME: work, ...env };
    if (path !== undefined) {
      childEnv.PATH = path;
      delete childEnv.FOSSIL;
    }
    const child = spawn(process.execPath, [join(root, script), ...args], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => resolve({ code, stdout, stderr, lines: stdout.split('\n').filter(Boolean).map(l => JSON.parse(l)) }));
    child.stdin.end(input);
  });
}

const watch = (link, cache, ...rest) => run('scripts/publish-html.mjs', ['watch', link, '--once', '--cache', cache, ...rest.filter(x => typeof x === 'string')],
  rest.find(x => typeof x === 'object') ?? {});
const respond = (link, input, opts = {}) => run('scripts/responder.mjs', [link, '--cache', join(work, 'responder-cache'), ...(opts.args ?? [])], { input, ...opts });

const api = async (path, token, body) => {
  const res = await fetch(worker.base + path, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Token ${token}` }, body: body && JSON.stringify(body),
  });
  const json = await res.json();
  assert.ok(res.ok, JSON.stringify(json));
  return json;
};
const threads = async a => (await api(`/api/artifacts/${a.id}/tickets`, a.read)).tickets;
const comment = (a, token, body) => api(`/api/artifacts/${a.id}/tickets`, token, body);

/** Neither output names a token or a link that carries one. */
function quiet(r, a) {
  for (const t of [a.read, a.write, a.comment]) {
    assert.ok(!r.stdout.includes(t) && !r.stderr.includes(t), 'a token leaked into the output');
  }
}

// ─── Units ───────────────────────────────────────────────────────────────────

test('ticketKind matches the Worker\'s mapping', () => {
  for (const opens of [true, false]) {
    for (const fields of [{}, { status: 'Closed' }, { status: 'Open' }, { status: 'closed' }, { '+icomment': 'x' }]) {
      assert.equal(ticketKind(opens, fields), workerKind(opens, fields), JSON.stringify({ opens, fields }));
    }
  }
});

test('parseInterval: 5 seconds to an hour', () => {
  assert.equal(parseInterval('30s'), 30_000);
  assert.equal(parseInterval('5s'), 5_000);
  assert.equal(parseInterval('2m'), 120_000);
  assert.equal(parseInterval('1h'), 3_600_000);
  for (const bad of ['4s', '0s', '61m', '2h', '30', 's', '-5s', '1.5m', '30sec', '']) assert.throws(() => parseInterval(bad), bad);
});

test('parseTicketArtifact: the K, U, D and J cards, fossil-decoded', () => {
  const t = parseTicketArtifact('D 2026-10-26T16:46:03.641\nJ +icomment two\\swords\\nand\\\\more\nJ status Closed\nJ title\n'
    + `K ${'c'.repeat(40)}\nU comment-link\nZ ${'0'.repeat(32)}\n`);
  assert.deepEqual(t, {
    ticket: 'c'.repeat(40), author: 'comment-link', time: '2026-10-26T16:46:03.641Z',
    fields: { '+icomment': 'two words\nand\\more', status: 'Closed', title: '' },
  });
  for (const bad of ['', 'not a manifest', `D 2026-10-26T16:46:03\nU x\n`, `K short\nU x\nD 2026-10-26T16:46:03\n`]) {
    assert.equal(parseTicketArtifact(bad), null, bad);
  }
});

test('redact: no fragment and no credentials', () => {
  const tok = 'a'.repeat(64);
  assert.equal(redact(`https://h.example/v/abc#${tok}`), 'https://h.example/v/abc');
  assert.equal(redact(`https://editor:${tok}@h.example/r/abc`), 'https://h.example/r/abc');
  assert.equal(redact(`not a url ${tok}`), '<link>');
});

test('verifySignature: HMAC-SHA256 of the exact bytes', () => {
  const body = Buffer.from('{"artifact":"a"}');
  const good = `sha256=${createHmac('sha256', 's3').update(body).digest('hex')}`;
  assert.equal(verifySignature('s3', body, good), true);
  assert.equal(verifySignature('s4', body, good), false);
  assert.equal(verifySignature('s3', Buffer.from('{"artifact":"b"}'), good), false);
  for (const bad of ['', undefined, good.slice(7), good.toUpperCase(), `${good}0`, 'sha1=00']) assert.equal(verifySignature('s3', body, bad), false, String(bad));
});

// ─── Against the Worker ──────────────────────────────────────────────────────

test('none sink: comment, watch prints it, the responder replies once and never to itself', async () => {
  const a = await createArtifact(worker.base, worker.owner, '<h1 id="intro">hello</h1>');
  const cache = join(work, 'cache-a');
  const start = await watch(a.commentUrl, cache);
  assert.equal(start.code, 0, start.stderr);
  assert.equal(start.stdout, '', 'the first run starts now');
  const first = await comment(a, a.comment, { text: 'Please shorten the heading.\n$(touch pwned) `id`', anchor: 'intro' });

  const w1 = await watch(a.commentUrl, cache);
  assert.equal(w1.code, 0, w1.stderr);
  quiet(w1, a);
  assert.equal(w1.lines.length, 1, w1.stdout);
  const [line] = w1.lines;
  assert.deepEqual(Object.keys(line), ['artifact', 'ticket', 'change', 'kind', 'author', 'text', 'time']);
  assert.equal(line.artifact, a.id);
  assert.equal(line.ticket, first.ticketUuid);
  assert.equal(line.change, first.artifact);
  assert.equal(line.kind, 'comment');
  assert.equal(line.author, 'comment-link');
  assert.equal(line.text, 'Please shorten the heading.\n$(touch pwned) `id`');
  assert.match(line.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(existsSync(join(cache, a.id, 'repo.fossil')), false, 'a comment link has no fossil login: HTTP only');
  assert.equal(existsSync(join(cache, a.id, 'watch.json')), true);

  const r1 = await respond(a.commentUrl, w1.stdout);
  assert.equal(r1.code, 0, r1.stderr);
  quiet(r1, a);
  assert.equal(r1.lines.length, 1, r1.stdout);
  assert.deepEqual(Object.keys(r1.lines[0]), ['artifact', 'ticket', 'change', 'reply']);
  assert.equal(r1.lines[0].change, first.artifact);
  assert.equal(existsSync(join(root, 'pwned')) || existsSync(join(work, 'pwned')), false, 'ticket text is never run');
  let [t] = await threads(a);
  assert.deepEqual(t.changes.map(c => [c.user, c.comment]), [['comment-link', ''], ['comment-link', ACK]]);
  assert.equal(t.changes[1].artifact, r1.lines[0].reply);

  // The next pass prints only the responder's own reply; fed back, it is ignored.
  const w2 = await watch(a.commentUrl, cache);
  assert.equal(w2.code, 0, w2.stderr);
  assert.deepEqual(w2.lines.map(l => [l.kind, l.author, l.text, l.change]), [['reply', 'comment-link', ACK, r1.lines[0].reply]]);
  const r2 = await respond(a.commentUrl, w2.stdout);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(r2.stdout, '', 'no reply to its own reply');
  // The first comment again (a redelivery, a restart): already acknowledged.
  const r3 = await respond(a.commentUrl, w1.stdout);
  assert.equal(r3.code, 0, r3.stderr);
  assert.equal(r3.stdout, '');
  [t] = await threads(a);
  assert.equal(t.changes.length, 2);

  // A resolve is printed and not answered; a later reader reply is.
  await comment(a, a.comment, { ticketUuid: first.ticketUuid, status: 'Closed' });
  await comment(a, a.comment, { ticketUuid: first.ticketUuid, text: 'One more thing.' });
  const w3 = await watch(a.commentUrl, cache);
  assert.deepEqual(w3.lines.map(l => [l.kind, l.text]), [['resolve', ''], ['reply', 'One more thing.']]);
  const r4 = await respond(a.commentUrl, w3.stdout);
  assert.equal(r4.code, 0, r4.stderr);
  assert.equal(r4.lines.length, 1);
  [t] = await threads(a);
  assert.deepEqual(t.changes.map(c => c.comment), ['', ACK, '', 'One more thing.', ACK]);

  // A read link cannot reply.
  const r5 = await respond(a.viewerUrl, w1.stdout);
  assert.notEqual(r5.code, 0);
  quiet(r5, a);
});

test('watch: HTTP without a fossil binary, a clone with one, the same lines; restarts never re-emit', async () => {
  const a = await createArtifact(worker.base, worker.owner, '<p>parity</p>');
  const one = await comment(a, a.comment, { text: 'First' });
  await comment(a, a.write, { ticketUuid: one.ticketUuid, text: 'Answered' });
  await comment(a, a.comment, { ticketUuid: one.ticketUuid, status: 'Closed' });
  await comment(a, a.comment, { ticketUuid: one.ticketUuid, status: 'Open' });
  const two = await comment(a, a.comment, { text: 'Second thread' });

  const httpCache = join(work, 'cache-http');
  // The first run starts now: the comments already there are history, kept for --since.
  const start = await watch(a.editUrl, httpCache, { path: noFossilPath });
  assert.equal(start.code, 0, start.stderr);
  assert.equal(start.stdout, '');
  assert.ok(JSON.parse(readFileSync(join(httpCache, a.id, 'watch.json'), 'utf8')).http, 'the start is saved');
  const http = await watch(a.editUrl, httpCache, '--since', a.tip, { path: noFossilPath });
  assert.equal(http.code, 0, http.stderr);
  quiet(http, a);
  assert.deepEqual(http.lines.map(l => [l.kind, l.author, l.text]), [
    ['comment', 'comment-link', 'First'], ['reply', 'edit-link', 'Answered'], ['resolve', 'comment-link', ''],
    ['reply', 'comment-link', ''], ['comment', 'comment-link', 'Second thread'],
  ]);
  assert.equal(http.lines.at(-1).ticket, two.ticketUuid);
  assert.equal(existsSync(join(httpCache, a.id, 'repo.fossil')), false, 'no fossil on PATH: no clone');

  // Restarted: nothing new, nothing printed; then only what is new.
  const again = await watch(a.editUrl, httpCache, { path: noFossilPath });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, '');
  const three = await comment(a, a.comment, { text: 'Third' });
  const next = await watch(a.editUrl, httpCache, { path: noFossilPath });
  assert.deepEqual(next.lines.map(l => l.change), [three.artifact]);
  // --since replays from a given artifact.
  const replay = await watch(a.editUrl, httpCache, '--since', two.artifact, { path: noFossilPath });
  assert.deepEqual(replay.lines.map(l => l.change), [three.artifact]);
  const bad = await watch(a.editUrl, httpCache, '--since', 'nothex', { path: noFossilPath });
  assert.notEqual(bad.code, 0);

  if (!haveStockFossil) return;
  const fossilCache = join(work, 'cache-fossil');
  const fossilStart = await watch(a.editUrl, fossilCache);
  assert.equal(fossilStart.code, 0, fossilStart.stderr);
  assert.equal(fossilStart.stdout, '', 'the first run starts now on this path too');
  const viaFossil = await watch(a.editUrl, fossilCache, '--since', a.tip);
  assert.equal(viaFossil.code, 0, viaFossil.stderr);
  quiet(viaFossil, a);
  assert.ok(existsSync(join(fossilCache, a.id, 'repo.fossil')), 'a fossil binary: pulled into the cache');
  assert.deepEqual(viaFossil.lines, [...http.lines, ...next.lines], 'both paths print the same lines');
  const quietAgain = await watch(a.editUrl, fossilCache);
  assert.equal(quietAgain.code, 0, quietAgain.stderr);
  assert.equal(quietAgain.stdout, '');
  const four = await comment(a, a.comment, { text: 'Fourth' });
  const pulled = await watch(a.editUrl, fossilCache);
  assert.deepEqual(pulled.lines.map(l => [l.change, l.kind, l.text]), [[four.artifact, 'comment', 'Fourth']]);
});

test('watch: polls on an interval and stops cleanly on SIGINT', async () => {
  const a = await createArtifact(worker.base, worker.owner, '<p>loop</p>');
  await comment(a, a.comment, { text: 'History' });
  const child = spawn(process.execPath, [join(root, 'scripts/publish-html.mjs'), 'watch', a.commentUrl, '--interval', '5s', '--cache', join(work, 'cache-loop')],
    { env: { ...process.env, HOME: work }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const exited = new Promise(r => child.on('close', (code, signal) => r({ code, signal })));
  for (let i = 0; i < 100 && !existsSync(join(work, 'cache-loop', a.id, 'watch.json')); i++) await new Promise(r => setTimeout(r, 100));
  await comment(a, a.comment, { text: 'Polled' });
  for (let i = 0; i < 100 && !out.includes('\n'); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(JSON.parse(out.trim()).text, 'Polled');
  const second = await comment(a, a.comment, { text: 'Polled later' });
  for (let i = 0; i < 150 && out.trim().split('\n').length < 2; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(JSON.parse(out.trim().split('\n')[1]).change, second.artifact);
  const t0 = Date.now();
  child.kill('SIGINT');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.ok(Date.now() - t0 < 3000, 'does not wait out the interval');
  const bad = await run('scripts/publish-html.mjs', ['watch', a.commentUrl, '--interval', '1s']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /interval/);
});

test('watch: a state file from the other path, or an older one, is never misread; switching paths neither repeats nor skips', needsFossil, async () => {
  const a = await createArtifact(worker.base, worker.owner, '<p>switch</p>');
  const cache = join(work, 'cache-switch');
  const state = () => JSON.parse(readFileSync(join(cache, a.id, 'watch.json'), 'utf8'));
  const viaFossil = () => watch(a.editUrl, cache);
  const viaHttp = () => watch(a.editUrl, cache, { path: noFossilPath });
  const changes = r => { assert.equal(r.code, 0, r.stderr); return r.lines.map(l => l.change); };

  await comment(a, a.comment, { text: 'Before anyone watched' });
  assert.deepEqual(changes(await viaFossil()), [], 'starts now');
  assert.equal(state().http, null);
  assert.match(state().fossil, /^[0-9a-f]{64}$/);
  const c1 = await comment(a, a.comment, { text: 'one' });
  assert.deepEqual(changes(await viaFossil()), [c1.artifact]);

  // No fossil binary now: the HTTP path has no position of its own.
  const c2 = await comment(a, a.comment, { text: 'two' });
  assert.deepEqual(changes(await viaHttp()), [c2.artifact]);
  const c3 = await comment(a, a.comment, { ticketUuid: c1.ticketUuid, text: 'three' });
  assert.deepEqual(changes(await viaHttp()), [c3.artifact]);
  assert.ok(state().fossil && state().http, 'one position per path');

  // Back to the clone, whose own position is older: what HTTP printed is not printed again.
  const c4 = await comment(a, a.comment, { text: 'four' });
  assert.deepEqual(changes(await viaFossil()), [c4.artifact]);
  const c5 = await comment(a, a.comment, { text: 'five' });
  assert.deepEqual(changes(await viaHttp()), [c5.artifact]);
  assert.deepEqual(changes(await viaFossil()), []);

  // A state file in the old shape is not a position on either path: a fresh start.
  const old = join(work, 'cache-old');
  mkdirSync(join(old, a.id), { recursive: true });
  writeFileSync(join(old, a.id, 'watch.json'), JSON.stringify({ last: c1.artifact }));
  const fresh = await watch(a.editUrl, old, { path: noFossilPath });
  assert.deepEqual(changes(fresh), []);
  const c6 = await comment(a, a.comment, { text: 'six' });
  assert.deepEqual(changes(await watch(a.editUrl, old, { path: noFossilPath })), [c6.artifact]);
});

test('responder: attached.json while it runs, cleared on exit and on SIGTERM, even within one second', needsFossil, async () => {
  const a = await createArtifact(worker.base, worker.owner, '<p>attached</p>');
  const attached = async () => (await api(`/api/artifacts/${a.id}`, a.read)).attached;
  const cache = join(work, 'cache-attached');
  const start = () => {
    const child = spawn(process.execPath, [join(root, 'scripts/responder.mjs'), a.editUrl, '--cache', cache, '--name', 'test responder', '--contact', 'ops@example.com'],
      { env: { ...process.env, HOME: work }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    const exited = new Promise(r => child.on('close', code => r({ code, stderr })));
    return { child, exited };
  };
  const until = async (want, what) => {
    for (let i = 0; i < 300; i++) {
      if (want(await attached())) return;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.fail(`attached.json never ${what}`);
  };

  assert.equal(await attached(), null);
  for (const stop of ['eof', 'SIGTERM', 'SIGINT']) {
    const { child, exited } = start();
    await until(f => f?.responder === 'test responder', `set (${stop})`);
    const flag = await attached();
    assert.equal(flag.contact, 'ops@example.com');
    assert.ok(Date.parse(flag.since) <= Date.now());
    if (stop === 'eof') child.stdin.end(); else child.kill(stop);
    const { code, stderr } = await exited;
    assert.equal(code, 0, stderr);
    assert.ok(![a.read, a.write, a.comment].some(t => stderr.includes(t)), 'a token leaked into the log');
    assert.equal(await attached(), null, `cleared (${stop})`);
  }
  // Set and cleared within the same second, twice: the clear still wins, and the next set too.
  for (let i = 0; i < 2; i++) {
    const r = await respond(a.editUrl, '', { args: ['--name', 'quick'] });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await attached(), null, `quick run ${i}`);
  }
  const { child, exited } = start();
  await until(f => f?.responder === 'test responder', 'set after quick runs');
  child.stdin.end();
  await exited;
  assert.equal(await attached(), null);
});
