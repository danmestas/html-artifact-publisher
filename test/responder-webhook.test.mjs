// The webhook sink pointed at scripts/wake-listener.mjs, which pipes each
// verified wake to scripts/responder.mjs: a comment is answered with no polling.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACK } from '../scripts/watch.mjs';
import { createArtifact, haveStockFossil, startWorker } from './helpers/worker.mjs';

const root = new URL('..', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'artifact-webhook-'));
const secret = 'webhook-test-secret';
const listenPort = 22000 + Math.floor(Math.random() * 2000);
const sign = body => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
let worker;

before(async () => {
  worker = await startWorker(work, {
    WAKE_SINK_KIND: 'webhook', WAKE_SINK_URL: `http://127.0.0.1:${listenPort}/wake`, WAKE_SINK_SECRET: secret,
  });
});
after(() => {
  worker?.stop();
  rmSync(work, { recursive: true, force: true });
});

const api = async (path, token, body) => {
  const res = await fetch(worker.base + path, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Token ${token}` }, body: body && JSON.stringify(body),
  });
  const json = await res.json();
  assert.ok(res.ok, JSON.stringify(json));
  return json;
};

function listen(link) {
  const child = spawn(process.execPath, [join(root, 'scripts/wake-listener.mjs'), '--port', String(listenPort), '--',
    process.execPath, join(root, 'scripts/responder.mjs'), link, '--cache', join(work, 'cache')],
  { env: { ...process.env, HOME: work, WAKE_SINK_SECRET: secret }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', d => { out.stdout += d; });
  child.stderr.on('data', d => { out.stderr += d; });
  const exited = new Promise(r => child.on('close', code => r(code)));
  return { child, out, exited };
}

async function until(fn, what, tries = 400) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const post = (body, headers = {}) => fetch(`http://127.0.0.1:${listenPort}/wake`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
});

test('webhook: a comment is answered with no polling, and the reply wakes nothing more', { skip: !haveStockFossil && !process.env.CI && 'stock fossil is not installed' }, async () => {
  const a = await createArtifact(worker.base, worker.owner, '<p>webhook</p>');
  const l = listen(a.editUrl);
  await until(() => l.out.stdout.includes('listening on'), 'the listener');
  try {
    const first = await api(`/api/artifacts/${a.id}/tickets`, a.comment, { text: 'Is anyone there?' });
    const changes = async () => (await api(`/api/artifacts/${a.id}/tickets`, a.read)).tickets[0].changes;
    await until(async () => (await changes()).length >= 2, 'the reply');
    // The reply's own wake runs the responder once more, which leaves it alone.
    await until(() => (l.out.stderr.match(/ exit 0$/gm) ?? []).length >= 2, 'two responder runs', 600);
    await new Promise(r => setTimeout(r, 1500));
    const got = await changes();
    assert.deepEqual(got.map(c => [c.user, c.comment]), [['comment-link', ''], ['edit-link', ACK]]);
    assert.match(l.out.stdout, new RegExp(`"change":"${first.artifact}"`));
    assert.equal((await api(`/api/artifacts/${a.id}`, a.read)).attached, null, 'cleared after each run');

    // Only signed, bounded, new wakes run the responder.
    const body = JSON.stringify({ artifact: a.id, checkin: first.artifact, ticket: first.ticketUuid, author: 'comment-link', kind: 'comment' });
    assert.equal((await post(body)).status, 401, 'unsigned');
    assert.equal((await post(body, { 'X-Signature': sign(`${body} `) })).status, 401, 'signed for other bytes');
    assert.equal((await post('x'.repeat(70_000), { 'X-Signature': sign('x'.repeat(70_000)) })).status, 413);
    assert.equal((await post(body, { 'X-Signature': sign(body), 'Idempotency-Key': `${a.id}-${first.artifact}` })).status, 200, 'a key already handled');
    assert.equal((await fetch(`http://127.0.0.1:${listenPort}/wake`)).status, 405);
    await new Promise(r => setTimeout(r, 500));
    assert.equal((l.out.stderr.match(/ exit /gm) ?? []).length, 2, 'none of them ran the responder');

    // The responder checks the signature itself too.
    const forged = await new Promise(resolve => {
      const child = spawn(process.execPath, [join(root, 'scripts/responder.mjs'), a.editUrl, '--cache', join(work, 'cache')],
        { env: { ...process.env, HOME: work, WAKE_SINK_SECRET: secret, WAKE_SIGNATURE: sign('other') }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', code => resolve({ code, stderr }));
      child.stdin.end(body);
    });
    assert.equal(forged.code, 2, forged.stderr);
    assert.match(forged.stderr, /signature/);
    assert.equal((await changes()).length, 2);

    for (const t of [a.read, a.write, a.comment]) assert.ok(!l.out.stdout.includes(t) && !l.out.stderr.includes(t), 'a token leaked');
  } finally {
    l.child.kill('SIGTERM');
    assert.equal(await l.exited, 0);
  }
});
