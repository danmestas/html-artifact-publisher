import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACK } from '../scripts/watch.mjs';
import { startWorker, createArtifact } from './helpers/worker.mjs';

const root = new URL('..', import.meta.url).pathname;
function cli(work, script, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, script), ...args], { cwd: root, env: { ...process.env, HOME: work, WAKE_SINK_SECRET: '', WAKE_SIGNATURE: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end(input);
  });
}
function quiet(result, tokens) {
  assert.equal(tokens.some(token => result.stdout.includes(token) || result.stderr.includes(token)), false, 'consumer output must not contain a capability');
}

test('public watch traverses more than32 threads and responder opens an older exact target without duplicate replies', { timeout: 120000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'hap-discussion-consumers-'));
  let worker;
  try {
    worker = await startWorker(work, { WAKE_SINK_KIND: 'none' });
    const a = await createArtifact(worker.base, worker.owner, '<h1>Consumer pagination</h1>');
    const headers = { Authorization: `Token ${a.comment}` };
    const opened = [];
    for (let i = 0; i < 40; i++) {
      const response = await fetch(`${worker.base}/api/artifacts/${a.id}/tickets`, { method: 'POST', headers, body: JSON.stringify({ text: `Discussion ${i}` }) });
      assert.equal(response.status, 201);
      opened.push(await response.json());
    }
    const cache = join(work, 'watch-cache');
    const watchArgs = ['watch', a.commentUrl, '--once', '--cache', cache];
    const watched = await cli(work, 'scripts/publish-html.mjs', [...watchArgs, '--since', a.tip]);
    quiet(watched, [a.read, a.write, a.comment]);
    assert.equal(watched.code, 0, watched.stderr);
    const events = watched.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(events.length, 40, 'HTTP watch follows bounded cohorts rather than silently dropping older events');
    assert.deepEqual(events.map(event => event.change), opened.map(change => change.artifact));
    const again = await cli(work, 'scripts/publish-html.mjs', watchArgs);
    quiet(again, [a.read, a.write, a.comment]);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.stdout, '', 'pagination preserves persisted watch deduplication');
    const responseArgs = [a.commentUrl, '--cache', join(work, 'responder-cache')];
    const responded = await cli(work, 'scripts/responder.mjs', responseArgs, JSON.stringify(events[0]) + '\n');
    quiet(responded, [a.read, a.write, a.comment]);
    assert.equal(responded.code, 0, responded.stderr);
    const replies = responded.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(replies.length, 1, 'older target beyond the initial32 must be opened exactly');
    assert.equal(replies[0].ticket, opened[0].ticketUuid);
    const repeated = await cli(work, 'scripts/responder.mjs', responseArgs, JSON.stringify(events[0]) + '\n');
    quiet(repeated, [a.read, a.write, a.comment]);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.equal(repeated.stdout, '', 'exact lookup preserves the already-acknowledged guard');
    const threadResponse = await fetch(`${worker.base}/api/artifacts/${a.id}/tickets?thread=${opened[0].ticketUuid}`, { headers });
    assert.equal(threadResponse.status, 200);
    const thread = (await threadResponse.json()).tickets[0];
    assert.equal(thread.changes.length, 2);
    assert.equal(thread.changes[1].comment, ACK);
    const missing = await cli(work, 'scripts/responder.mjs', responseArgs, JSON.stringify({ ...events[0], ticket: 'f'.repeat(40) }) + '\n');
    quiet(missing, [a.read, a.write, a.comment]);
    assert.equal(missing.code, 0, 'an unknown target is still skipped rather than replied to');
    assert.equal(missing.stdout, '');
  } finally {
    worker?.stop();
    rmSync(work, { recursive: true, force: true });
  }
});

test('public HTTP watch reports oversized history explicitly and never follows its resume cursor automatically', { timeout: 60000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'hap-discussion-consumer-error-'));
  const token = 'b'.repeat(64), tip = 'a'.repeat(64), change = 'c'.repeat(64);
  const paths = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.test');
    paths.push(url.pathname + url.search);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/timeline')) return res.end(JSON.stringify({ timeline: [{ uuid: change }] }));
    if (url.pathname.endsWith('/tickets')) { res.statusCode = 413; return res.end(JSON.stringify({ error: 'Oversized discussion', code: 'discussion_too_large', ticketUuid: 'd'.repeat(40), ref: 1, resumeCursor: 'must-not-auto-follow' })); }
    res.end(JSON.stringify({ id: 'fixture', role: 'comment', timeline: [{ uuid: tip }] }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const link = `http://127.0.0.1:${server.address().port}/v/fixture#${token}`;
    const result = await cli(work, 'scripts/publish-html.mjs', ['watch', link, '--once', '--since', tip, '--cache', join(work, 'cache')]);
    quiet(result, [token]);
    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes('413'));
    assert.equal(result.stdout, '');
    assert.equal(paths.filter(path => path.startsWith('/api/artifacts/fixture/tickets')).length, 1);
    assert.equal(paths.some(path => path.includes('must-not-auto-follow')), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  }
});

test('public HTTP watch rejects malformed/repeating cursors and stops at200 pagination requests explicitly', { timeout: 60000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'hap-discussion-consumer-bounds-'));
  const token = 'b'.repeat(64), tip = 'a'.repeat(64), change = 'c'.repeat(64);
  let mode = 'malformed', requests = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.test');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/timeline')) return res.end(JSON.stringify({ timeline: [{ uuid: change }] }));
    if (url.pathname.endsWith('/tickets')) {
      requests++;
      return res.end(JSON.stringify({ tickets: [], nextCursor: mode === 'malformed' ? false : mode === 'repeated' ? 'same-cursor' : `cursor-${requests}` }));
    }
    res.end(JSON.stringify({ id: 'fixture', role: 'comment', timeline: [{ uuid: tip }] }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const link = `http://127.0.0.1:${server.address().port}/v/fixture#${token}`;
    for (const [scenario, expectedRequests, message] of [['malformed', 1, 'pagination did not advance'], ['repeated', 2, 'pagination did not advance'], ['unbounded', 200, 'pagination exceeded its bounded scan']]) {
      mode = scenario;
      requests = 0;
      const result = await cli(work, 'scripts/publish-html.mjs', ['watch', link, '--once', '--since', tip, '--cache', join(work, scenario)]);
      quiet(result, [token]);
      assert.notEqual(result.code, 0, `${scenario} pagination must fail explicitly`);
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.includes(message));
      assert.equal(requests, expectedRequests);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  }
});
