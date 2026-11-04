// Expiration is owned by the Repo, which projects it to the Registry row the
// library filters on. These tests inject a failure into the projection and
// prove the Repo's own alarm converges the two stores without help, including
// when the Registry still carries an older, shorter deadline.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, freePort } from './helpers/worker.mjs';

const work = mkdtempSync(join(tmpdir(), 'artifact-expiration-convergence-'));
after(() => rmSync(work, { recursive: true, force: true }));

/**
 * A Worker with its own state and a signed-in instance owner. Sessions are
 * used rather than the bearer token because only an account may manage an
 * artifact, and the sign-in transport needs the Worker's own port as origin.
 */
async function withWorker(vars, body) {
  const dir = mkdtempSync(join(work, 'state-'));
  const port = await freePort();
  const app = await startWorker(
    dir,
    { ...vars, OWNER_EMAIL: 'owner@example.com', APP_ORIGIN: `http://127.0.0.1:${port}`, TEST_MAIL_TRANSPORT: 'loopback', TEST_EXPIRATION_STATE: '1' },
    { port },
  );
  const send = async (path, { method = 'GET', body: b } = {}, cookie = '') => {
    const res = await fetch(app.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: app.base, ...(cookie ? { Cookie: cookie } : {}) },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* no body */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  try {
    const requested = await send('/api/auth/request', { method: 'POST', body: { email: 'owner@example.com' } });
    assert.ok(requested.json?.loginUrl, requested.text);
    const token = new URL(requested.json.loginUrl).hash.slice(7);
    const verified = await send('/api/auth/verify', { method: 'POST', body: { token } });
    assert.equal(verified.status, 200, verified.text);
    const cookie = verified.headers.get('Set-Cookie').split(';')[0];
    const call = (path, opts) => send(path, opts, cookie);
    await body({ base: app.base, owner: app.owner }, call);
  } finally { app.stop(); }
}

/** Create an artifact owned by the signed-in account; `ttlSeconds` sets both stores. */
async function create(call, { title, ttlSeconds }) {
  const res = await call('/api/artifacts', {
    method: 'POST',
    body: { title, ...(ttlSeconds === undefined ? {} : { ttlSeconds }), files: { 'index.html': Buffer.from(`<p>${title}</p>`).toString('base64') } },
  });
  assert.equal(res.status, 201, res.text);
  return res.json;
}

const seconds = s => Math.floor(Date.now() / 1000) + s;
const iso = sec => new Date(sec * 1000).toISOString();
const setExpiration = (call, a, expiresAt) => call(`/api/artifacts/${a.id}/manage`, { method: 'PATCH', body: { expiresAt } });
const libraryEntry = async (call, id) => (await call('/api/library?view=all')).json?.artifacts?.find(x => x.id === id);

/** The Registry deadline the library filters on, in unix seconds. */
async function registryDeadline(call, id) {
  const entry = await libraryEntry(call, id);
  return entry && entry.expiresAt != null ? Date.parse(entry.expiresAt) / 1000 : null;
}

/** Poll the library until it reports `want` (unix seconds, or null), or give up. */
async function waitForDeadline(call, id, want) {
  for (let i = 0; i < 40; i++) {
    if ((await registryDeadline(call, id)) === want) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

test('a failed projection is retried by the Repo alarm and converges', async () => {
  await withWorker({ TEST_EXPIRATION_FAULT: 'fail-once', TEST_EXPIRATION_RETRY_MS: '500' }, async (w, call) => {
    const a = await create(call, { title: 'Never' });
    const deadline = seconds(3600);
    const res = await setExpiration(call, a, iso(deadline));
    assert.equal(res.status, 202, 'the caller is told the projection is still pending, not that it succeeded');
    assert.equal(res.json.expirationPending, true);
    assert.notEqual(await registryDeadline(call, a.id), deadline, 'the library has not accepted the new deadline yet');
    // No further request touches the artifact: only the Repo's own alarm runs.
    assert.equal(await waitForDeadline(call, a.id, deadline), true, 'the retry alarm projected the pending deadline');
    assert.equal((await call(`/api/artifacts/${a.id}`)).status, 200);
  });
});

test('clearing an expiration also clears an old, shorter Registry deadline', async () => {
  // The artifact is created with a short deadline, then cleared in the Repo
  // while its projection fails: the library must stop treating it as expiring
  // instead of hiding it when the old deadline passes.
  await withWorker({ TEST_EXPIRATION_FAULT: 'fail-once', TEST_EXPIRATION_RETRY_MS: '500' }, async (w, call) => {
    const a = await create(call, { title: 'Short then cleared', ttlSeconds: 6 });
    const oldDeadline = Date.parse(a.expiresAt) / 1000;
    assert.equal(await registryDeadline(call, a.id), oldDeadline);
    const res = await setExpiration(call, a, null);
    assert.equal(res.status, 202, 'the clear is durable in the Repo but not yet projected');
    assert.equal(await waitForDeadline(call, a.id, null), true, 'the cleared expiration reached the library');
    // Past the point the old deadline would have hidden it, the artifact is live.
    await new Promise(r => setTimeout(r, Math.max(0, (oldDeadline - Math.floor(Date.now() / 1000) + 2) * 1000)));
    assert.ok(await libraryEntry(call, a.id), 'the artifact is still listed after the old deadline');
    assert.equal((await call(`/api/artifacts/${a.id}`)).status, 200);
  });
});

test('a failed projection does not outlive an artifact deleted meanwhile', async () => {
  // A projection must never reinsert a row the library already removed.
  await withWorker({ TEST_EXPIRATION_FAULT: 'throw', TEST_EXPIRATION_RETRY_MS: '500' }, async (w, call) => {
    const a = await create(call, { title: 'Deleted' });
    assert.equal((await setExpiration(call, a, iso(seconds(3600)))).status, 202);
    assert.equal((await call(`/api/artifacts/${a.id}`, { method: 'DELETE' })).status, 204);
    await new Promise(r => setTimeout(r, 3000));
    assert.equal(await libraryEntry(call, a.id), undefined, 'the deleted artifact is not resurrected by a retry');
    assert.equal((await call(`/api/artifacts/${a.id}`)).status, 404);
  });
});

test('the retry alarm is armed before the Registry is asked', async () => {
  // The request dies after the intent is durable and the alarm is armed but
  // before the Registry is ever asked. Only the Retry-armed-before-projection
  // order leaves a wake behind; arming after the call would leave the intent
  // pending forever with nothing to run it.
  await withWorker({ TEST_EXPIRATION_FAULT: 'crash-before-projection', TEST_EXPIRATION_RETRY_MS: '500' }, async (w, call) => {
    const a = await create(call, { title: 'Armed first' });
    const deadline = seconds(3600);
    const crashed = await setExpiration(call, a, iso(deadline));
    assert.ok(crashed.status >= 500, 'the request itself does not claim success');
    assert.equal(await waitForDeadline(call, a.id, deadline), true, 'the Repo alarm alone projected the pending deadline');
    assert.equal((await call(`/api/artifacts/${a.id}/expiration-state`)).json.pending, false, 'the confirmed ack then clears the retry');
  });
});

test('a management request after the deadline does not revive the artifact', async () => {
  // The request is authorized while the artifact is live but reaches the Repo
  // after its deadline, ahead of the alarm. Without the in-transaction expiry
  // check it would write a new expiration onto an expired repository.
  await withWorker({ TEST_EXPIRATION_SETTLE_MS: '6000', TEST_EXPIRATION_ALARM_HOLD_MS: '15000' }, async (w, call) => {
    const a = await create(call, { title: 'Just expired', ttlSeconds: 3 });
    // Issued while live; the Repo looks at the row six seconds later.
    const late = await setExpiration(call, a, iso(seconds(3600)));
    assert.equal(late.status, 404, 'an expired repository is reported not found, not revived');
    assert.equal((await call(`/api/artifacts/${a.id}`)).status, 404);
  });
});

test('a committed projection whose reply is lost converges on retry, once audited', async () => {
  // Distinct from failing before the write: the Registry holds the new
  // revision, but the Repo never hears so. The retry of the SAME revision must
  // be acknowledged idempotently, or a never-expiring artifact would retry
  // forever.
  await withWorker({ TEST_EXPIRATION_FAULT: 'drop-ack-once', TEST_EXPIRATION_RETRY_MS: '500' }, async (w, call) => {
    const a = await create(call, { title: 'Lost ack' });
    const cleared = await setExpiration(call, a, null);
    assert.equal(cleared.status, 202, 'the caller is told the reply was not confirmed');
    let state;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      state = (await call(`/api/artifacts/${a.id}/expiration-state`)).json;
      if (!state.pending) break;
    }
    assert.equal(state.pending, false, 'the same-revision retry is acknowledged and nothing stays pending');
    assert.equal(state.alarmAt, null, 'a never-expiring artifact ends with no alarm at all');
    const events = (await call('/api/admin/activity?limit=100')).json.events.filter(e => e.artifactId === a.id && e.action === 'expiration');
    assert.equal(events.length, 1, 'the lost acknowledgement did not duplicate the audit');
  });
});

test('a newer intent is not undone by an older projection', async () => {
  await withWorker({ TEST_EXPIRATION_RETRY_MS: '500' }, async (w, call) => {
    const a = await create(call, { title: 'Ordering' });
    const first = seconds(1800), second = seconds(7200);
    assert.equal((await setExpiration(call, a, iso(first))).status, 200);
    assert.equal((await setExpiration(call, a, iso(second))).status, 200);
    assert.equal(await registryDeadline(call, a.id), second, 'the later intent wins');
    await new Promise(r => setTimeout(r, 2000));
    assert.equal(await registryDeadline(call, a.id), second, 'an idle retry leaves the later intent alone');
  });
});

test('a delayed older projection cannot overwrite a newer intent', async () => {
  // The first projection is held inside the Repo between reading intent 1 and
  // sending it, while intent 2 is accepted and projected ahead of it. Only the
  // revision CAS stops the older ack from restoring the older deadline.
  await withWorker({ TEST_EXPIRATION_RETRY_MS: '500', TEST_EXPIRATION_HOLD_REVISION: '1', TEST_EXPIRATION_HOLD_MS: '2500' }, async (w, call) => {
    const a = await create(call, { title: 'Reordered' });
    const first = seconds(1800), second = seconds(7200);
    const slow = setExpiration(call, a, iso(first));
    await new Promise(r => setTimeout(r, 500));
    const fast = await setExpiration(call, a, iso(second));
    assert.equal(fast.status, 200, 'the newer intent projects while the older call is still held');
    assert.equal(await registryDeadline(call, a.id), second);
    const held = await slow;
    assert.equal(held.status, 200, 'the held call succeeds once the newer intent already has its ack');
    assert.equal(await registryDeadline(call, a.id), second, 'the delayed older ack does not restore the earlier deadline');
    await new Promise(r => setTimeout(r, 2000));
    assert.equal(await registryDeadline(call, a.id), second, 'no later retry restores it either');
  });
});

test('a retried projection audits the expiration once; a combined request audits both', async () => {
  await withWorker({ TEST_EXPIRATION_FAULT: 'fail-once', TEST_EXPIRATION_RETRY_MS: '500' }, async (w, call) => {
    const a = await create(call, { title: 'Audited' });
    const deadline = seconds(3600);
    // One request changing two things must audit both, and the retry of the
    // failed expiration projection must not write a second expiration entry.
    const res = await call(`/api/artifacts/${a.id}/manage`, { method: 'PATCH', body: { title: 'Renamed', expiresAt: iso(deadline) } });
    assert.equal(res.status, 202, res.text);
    assert.equal(await waitForDeadline(call, a.id, deadline), true);
    await new Promise(r => setTimeout(r, 2000));
    const events = (await call('/api/admin/activity?limit=100')).json.events.filter(e => e.artifactId === a.id);
    assert.equal(events.filter(e => e.action === 'expiration').length, 1, 'the expiration is audited exactly once');
    assert.equal(events.filter(e => e.action === 'rename').length, 1, 'the rename is not lost to the expiration');
  });
});
