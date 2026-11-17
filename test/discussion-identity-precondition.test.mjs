import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, createArtifact, freePort } from './helpers/worker.mjs';

test('captured discussion identity rejects account and guest switches before any mutation', { timeout: 120000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'hap-discussion-precondition-'));
  let worker;
  try {
    const port = await freePort();
    worker = await startWorker(work, { OWNER_EMAIL: 'owner@example.com', TEST_MAIL_TRANSPORT: 'loopback', APP_ORIGIN: `http://127.0.0.1:${port}` }, { port });
    const authRequest = async (path, body, cookie) => {
      const response = await fetch(`${worker.base}${path}`, { method: 'POST', headers: { Origin: worker.base, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, json: await response.json(), cookie: response.headers.getSetCookie().find(c => c.startsWith('artifact_session='))?.split(';')[0] };
    };
    const verify = async issued => {
      assert.equal(issued.status, 200);
      assert.ok(typeof issued.json.loginUrl === 'string', 'isolated loopback account challenge available');
      const token = new URL(issued.json.loginUrl).hash.slice(7);
      const verified = await authRequest('/api/auth/verify', { token });
      assert.equal(verified.status, 200);
      assert.ok(verified.cookie, 'account has a private session');
      return verified.cookie;
    };
    const accountA = await verify(await authRequest('/api/auth/request', { email: 'owner@example.com' }));
    const accountB = await verify(await authRequest('/api/invitations', { email: 'member@example.com', name: 'Member' }, accountA));
    const a = await createArtifact(worker.base, worker.owner, '<h1>Captured identities</h1>');
    const api = async (suffix, { method = 'GET', body, cookie, token = a.read, expectedIdentity } = {}) => {
      const headers = { Origin: worker.base, Authorization: `Token ${token}`, ...(cookie ? { Cookie: cookie } : {}) };
      if (expectedIdentity !== undefined) headers['X-Comment-Identity'] = expectedIdentity;
      const response = await fetch(`${worker.base}/api/artifacts/${a.id}${suffix}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, json: await response.json(), cookie: response.headers.getSetCookie().find(c => c.startsWith('hap_guest='))?.split(';')[0] };
    };
    const viewerA = (await api('/tickets?identity=account', { cookie: accountA })).json.viewer;
    const viewerB = (await api('/tickets?identity=account', { cookie: accountB })).json.viewer;
    assert.notEqual(viewerA.key, viewerB.key);
    const stalePost = await api('/tickets', { method: 'POST', cookie: accountB, expectedIdentity: viewerA.key, body: { text: 'Draft captured under A', identity: 'account' } });
    assert.equal(stalePost.status, 409);
    assert.equal(stalePost.json.code, 'identity_changed');
    assert.equal((await api('/tickets')).json.tickets.length, 0);
    const posted = await api('/tickets', { method: 'POST', cookie: accountB, expectedIdentity: viewerB.key, body: { text: 'Draft deliberately bound to B', identity: 'account' } });
    assert.equal(posted.status, 201);
    const { ticketUuid, artifact } = posted.json;
    const messagePath = `/tickets/${ticketUuid}/messages/${artifact}`;
    const staleEdit = await api(messagePath, { method: 'PATCH', cookie: accountB, expectedIdentity: viewerA.key, body: { text: 'Stale correction', identity: 'account' } });
    assert.equal(staleEdit.status, 409);
    assert.equal(staleEdit.json.code, 'identity_changed');
    let current = (await api(`/tickets?thread=${ticketUuid}&identity=account`, { cookie: accountB })).json.tickets[0];
    assert.equal(current.changes[0].text, 'Draft deliberately bound to B');
    assert.equal(current.changes[0].history.length, 1);
    assert.equal(current.changes[0].fields.authority, 'view', 'precondition never upgrades the read capability');
    const corrected = await api(messagePath, { method: 'PATCH', cookie: accountB, expectedIdentity: viewerB.key, body: { text: 'Corrected under B', identity: 'account' } });
    assert.equal(corrected.status, 200);
    // Independent activity makes B unread; the stale view must neither mark read nor follow.
    assert.equal((await api('/tickets', { method: 'POST', token: a.write, body: { ticketUuid, text: 'New independent activity' } })).status, 200);
    current = (await api(`/tickets?thread=${ticketUuid}&identity=account`, { cookie: accountB })).json.tickets[0];
    assert.equal(current.unread, true);
    assert.equal(current.following, false);
    const viewPath = `/tickets/${ticketUuid}/view`;
    const staleView = await api(viewPath, { method: 'PUT', cookie: accountB, expectedIdentity: viewerA.key, body: { readThrough: current.lastChange, following: true, identity: 'account' } });
    assert.equal(staleView.status, 409);
    assert.equal(staleView.json.code, 'identity_changed');
    current = (await api(`/tickets?thread=${ticketUuid}&identity=account`, { cookie: accountB })).json.tickets[0];
    assert.equal(current.unread, true);
    assert.equal(current.following, false);
    assert.equal((await api(viewPath, { method: 'PUT', cookie: accountB, expectedIdentity: viewerB.key, body: { readThrough: current.lastChange, following: true, identity: 'account' } })).status, 200);
    current = (await api(`/tickets?thread=${ticketUuid}&identity=account`, { cookie: accountB })).json.tickets[0];
    assert.equal(current.unread, false);
    assert.equal(current.following, true);
    assert.equal(current.changes.length, 2, 'stale mutations create no extra messages; the one correction remains folded into history');
    assert.equal(current.changes[0].history.length, 2, 'only the correctly bound correction was stored');
    assert.equal((await api('/tickets', { method: 'POST', cookie: accountB, expectedIdentity: viewerB.key, body: { ticketUuid, status: 'Closed', identity: 'account' } })).status, 403);
    assert.equal((await api('/tickets', { method: 'POST', cookie: accountB, expectedIdentity: viewerB.key, body: { text: 'Header cannot select an account', identity: 'guest' } })).status, 409);
    for (const [suffix, method, body] of [['/tickets', 'POST', { text: 'Invalid header' }], [messagePath, 'PATCH', { text: 'Invalid header' }], [viewPath, 'PUT', { following: false }]]) {
      for (const expectedIdentity of ['not-an-identity', 'account:' + 'x'.repeat(129)]) assert.equal((await api(suffix, { method, body, cookie: accountB, expectedIdentity })).status, 400);
    }
    const guestA = await api('/guest', { method: 'PUT', body: { name: 'Guest A' } });
    const guestB = await api('/guest', { method: 'PUT', body: { name: 'Guest B' } });
    assert.ok(guestA.cookie && guestB.cookie);
    const guestKeyA = (await api('/tickets', { cookie: guestA.cookie })).json.viewer.key;
    const guestKeyB = (await api('/tickets', { cookie: guestB.cookie })).json.viewer.key;
    assert.equal((await api('/tickets', { method: 'POST', cookie: guestB.cookie, expectedIdentity: guestKeyA, body: { text: 'Captured guest A draft' } })).status, 409);
    assert.equal((await api('/tickets', { method: 'POST', cookie: guestB.cookie, expectedIdentity: guestKeyB, body: { text: 'Deliberate guest B draft' } })).status, 201);
    assert.equal((await api('/tickets', { method: 'POST', token: a.write, body: { text: 'Legacy client without precondition' } })).status, 201);
    const followedByB = await api('/tickets?filter=following&identity=account', { cookie: accountB });
    assert.equal(followedByB.status, 200);
    assert.deepEqual(followedByB.json.tickets.map(t => t.uuid), [ticketUuid], 'following filter excludes every unfollowed discussion');
    assert.equal(followedByB.json.viewer.key, viewerB.key);
    const followedByA = await api('/tickets?filter=following&identity=account', { cookie: accountA });
    assert.equal(followedByA.status, 200);
    assert.deepEqual(followedByA.json.tickets, [], 'another account cannot see B\'s private follows');
    const guestFollows = await api('/tickets?filter=following', { cookie: guestB.cookie });
    assert.equal(guestFollows.status, 200);
    assert.deepEqual(guestFollows.json.tickets, [], 'guest follow state is separate from account follow state');
  } finally {
    worker?.stop();
    rmSync(work, { recursive: true, force: true });
  }
});
