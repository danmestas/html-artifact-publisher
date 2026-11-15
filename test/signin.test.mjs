import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startWorker, freePort } from './helpers/worker.mjs';

async function withAuth(body) {
  const work = mkdtempSync(join(tmpdir(), 'hap-signin-'));
  let worker;
  try {
    const launch = async () => {
      const port = await freePort();
      worker = await startWorker(work, { OWNER_EMAIL: 'owner@example.com', APP_ORIGIN: `http://127.0.0.1:${port}`, TEST_MAIL_TRANSPORT: 'loopback' }, { port });
    };
    await launch();
    const api = async (path, data, cookie, method) => {
      const response = await fetch(worker.base + path, {
        method: method ?? (data === undefined ? 'GET' : 'POST'),
        headers: { Origin: worker.base, ...(cookie ? { Cookie: cookie } : {}) },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      return { response, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const request = async (extra = {}) => {
      const challenge = randomBytes(32).toString('hex');
      const result = await api('/api/auth/request', { email: 'owner@example.com', challenge, ...extra });
      assert.equal(result.response.status, 200);
      return { ...result.data, challenge };
    };
    // Advance deadlines only in this test's disposable database; assertions
    // still use the HTTP API, without a production clock override.
    const expire = statement => {
      const state = join(work, 'state');
      for (const file of readdirSync(state, { recursive: true })) {
        if (!String(file).endsWith('.sqlite')) continue;
        const db = new DatabaseSync(join(state, String(file)));
        try {
          db.exec('PRAGMA busy_timeout=5000');
          if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='logins'").get()) { db.exec(statement); return; }
        } finally { db.close(); }
      }
      throw new Error('Disposable Registry database not found');
    };
    const restartLegacy = async () => {
      const oldBase = worker.base;
      worker.stop();
      let stopped = false;
      for (let i = 0; i < 50; i++) {
        try { await fetch(oldBase + '/healthz', { signal: AbortSignal.timeout(250) }); }
        catch { stopped = true; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(stopped, 'old disposable Worker stopped before schema fixture');
      expire(`DROP INDEX logins_challenge;
        ALTER TABLE logins DROP COLUMN return_to;
        ALTER TABLE logins DROP COLUMN challenge_hash;
        ALTER TABLE logins DROP COLUMN code_hash;
        ALTER TABLE logins DROP COLUMN code_expires;
        ALTER TABLE logins DROP COLUMN code_attempts;
        ALTER TABLE sessions DROP COLUMN authenticated_at;
        ALTER TABLE sessions DROP COLUMN remembered;`);
      await launch();
    };
    await body({ api, request, expire, restartLegacy, base: worker.base });
  } finally { worker?.stop(); rmSync(work, { recursive: true, force: true }); }
}

const tokenOf = login => new URL(login.loginUrl).hash.slice(7);
test('an old remembered session must reauthenticate before creating credentials, but may still read and sign out', async () => {
  await withAuth(async ({ api, request, expire }) => {
    const login = await request();
    const confirmed = await api('/api/auth/verify', { token: tokenOf(login), rememberDevice: true });
    const initial = await api('/api/credentials', { name: 'Fresh sign-in' }, confirmed.cookie);
    assert.equal(initial.response.status, 201, 'a fresh authentication may create a credential');
    expire('UPDATE sessions SET authenticated_at=0');
    assert.equal((await api('/api/session', undefined, confirmed.cookie)).data.user.email, 'owner@example.com');
    const blocked = await api('/api/credentials', { name: 'Needs reauthentication' }, confirmed.cookie);
    assert.equal(blocked.response.status, 403);
    assert.equal(blocked.data.reauthRequired, true);
    assert.equal((await api('/api/credentials', undefined, confirmed.cookie)).data.credentials.length, 1, 'the blocked action made no change');
    assert.equal((await api(`/api/credentials/${initial.data.id}`, undefined, confirmed.cookie, 'DELETE')).response.status, 200, 'revoking a credential remains immediately available');
    const again = await request();
    const renewed = await api('/api/auth/verify', { challenge: again.challenge, code: again.loginCode, rememberDevice: true }, confirmed.cookie);
    assert.equal(renewed.response.status, 200);
    assert.equal((await api('/api/session', undefined, confirmed.cookie)).data.user, null, 'reauthentication revokes the overwritten browser session');
    assert.equal((await api('/api/credentials', { name: 'After reauthentication' }, renewed.cookie)).response.status, 201);
    await api('/api/auth/logout', {}, renewed.cookie);
    assert.equal((await api('/api/session', undefined, renewed.cookie)).data.user, null);
  });
});
test('old remembered sessions cannot increase named access or transfer ownership, but may revoke access', async () => {
  await withAuth(async ({ api, request, expire }) => {
    const login = await request();
    const owner = await api('/api/auth/verify', { token: tokenOf(login), rememberDevice: true });
    const members = [];
    for (const email of ['first@example.com', 'second@example.com']) {
      const invited = await api('/api/invitations', { email }, owner.cookie);
      const member = await api('/api/auth/verify', { token: new URL(invited.data.loginUrl).hash.slice(7) });
      members.push(member);
    }
    const artifact = await api('/api/artifacts', { title: 'Security fixture', ttlSeconds: null, files: { 'index.html': Buffer.from('<h1>Private</h1>').toString('base64') } }, owner.cookie);
    assert.equal(artifact.response.status, 201);
    const path = `/api/artifacts/${artifact.data.id}`;
    await api(path + '/sharing', { userId: members[0].data.user.id, permission: 'read' }, owner.cookie, 'PUT');
    const guest = await api(path + '/guest', { name: 'Claimed guest' }, members[0].cookie, 'PUT');
    assert.equal(guest.response.status, 200);
    assert.equal((await api(path + '/guest/claim', {}, members[0].cookie + '; ' + guest.cookie)).response.status, 200);
    expire('UPDATE sessions SET authenticated_at=0');
    const upgrade = await api(path + `/guests/${guest.data.guest.id}/upgrade`, { permission: 'write' }, owner.cookie);
    assert.equal(upgrade.response.status, 403);
    assert.equal(upgrade.data.reauthRequired, true, 'guest upgrades cannot bypass fresh-authentication requirements');
    assert.equal((await api(path, undefined, members[0].cookie)).data.role, 'read');
    const grant = await api(path + '/sharing', { userId: members[1].data.user.id, permission: 'write' }, owner.cookie, 'PUT');
    assert.equal(grant.response.status, 403);
    assert.equal(grant.data.reauthRequired, true);
    assert.equal((await api(path, undefined, members[1].cookie)).response.status, 404, 'a blocked grant never became access');
    const transfer = await api(path + '/manage', { ownerId: members[1].data.user.id }, owner.cookie, 'PATCH');
    assert.equal(transfer.response.status, 403);
    assert.equal(transfer.data.reauthRequired, true);
    assert.equal((await api('/api/invitations', { email: 'blocked@example.com' }, owner.cookie)).response.status, 403);
    assert.equal((await api(path + '/sharing', { userId: members[0].data.user.id, permission: null }, owner.cookie, 'PUT')).response.status, 200, 'removing a grant never needs another email');
    assert.equal((await api(`/api/people/${members[1].data.user.id}`, { status: 'disabled' }, owner.cookie, 'PATCH')).response.status, 200, 'suspending an account remains immediate');
    assert.equal((await api('/api/session', undefined, members[1].cookie)).data.user, null, 'suspension revokes existing sessions');
    const reactivate = await api(`/api/people/${members[1].data.user.id}`, { status: 'active' }, owner.cookie, 'PATCH');
    assert.equal(reactivate.response.status, 403);
    assert.equal(reactivate.data.reauthRequired, true);
  });
});

test('default sessions and valid personal credentials keep existing behavior; withdrawal remains immediate', async () => {
  await withAuth(async ({ api, request, expire, base }) => {
    const login = await request();
    const normal = await api('/api/auth/verify', { token: tokenOf(login) });
    const pending = await api('/api/invitations', { email: 'withdraw@example.com' }, normal.cookie);
    assert.equal(pending.response.status, 200);
    const listing = await api('/api/people', undefined, normal.cookie);
    const pendingId = listing.data.users.find(u => u.email === 'withdraw@example.com').id;
    const credential = await api('/api/credentials', { name: 'Existing CLI' }, normal.cookie);
    expire('UPDATE sessions SET authenticated_at=0');
    assert.equal((await api('/api/credentials', { name: 'Normal session unchanged' }, normal.cookie)).response.status, 201);
    const cli = await fetch(base + '/api/credentials', {
      method: 'POST', headers: { Origin: base, Authorization: `Bearer ${credential.data.token}` }, body: JSON.stringify({ name: 'Explicit credential unchanged' }),
    });
    assert.equal(cli.status, 201);
    await cli.arrayBuffer();
    const remembered = await request();
    const longSession = await api('/api/auth/verify', { token: tokenOf(remembered), rememberDevice: true });
    expire('UPDATE sessions SET authenticated_at=0');
    assert.equal((await api(`/api/people/${pendingId}`, undefined, longSession.cookie, 'DELETE')).response.status, 200);
    const forged = await fetch(base + '/api/credentials', {
      method: 'POST', headers: { Origin: base, Cookie: longSession.cookie, Authorization: 'Bearer invalid' }, body: JSON.stringify({ name: 'Must not fall back to cookie' }),
    });
    assert.equal(forged.status, 401, 'a fake explicit credential cannot bypass the remembered-session gate');
    await forged.arrayBuffer();
  });
});

test('a pre-change database preserves its existing sessions and outstanding email links', async () => {
  await withAuth(async ({ api, request, restartLegacy }) => {
    const first = await request();
    const session = await api('/api/auth/verify', { token: tokenOf(first) });
    const pending = await request();
    await restartLegacy();
    assert.equal((await api('/api/session', undefined, session.cookie)).data.user.email, 'owner@example.com');
    const confirmed = await api('/api/auth/verify', { token: tokenOf(pending) });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.data.returnTo, '/');
    assert.match(confirmed.response.headers.get('set-cookie'), /Max-Age=604800(?:;|$)/);
    assert.equal((await api('/api/auth/verify', { token: tokenOf(pending) })).response.status, 401);
  });
});

test('suspension revokes remembered sessions and pending codes, and reactivation restores neither', async () => {
  await withAuth(async ({ api, request }) => {
    const ownerLogin = await request();
    const owner = await api('/api/auth/verify', { token: tokenOf(ownerLogin) });
    const invited = await api('/api/invitations', { email: 'remembered@example.com' }, owner.cookie);
    const member = await api('/api/auth/verify', { token: new URL(invited.data.loginUrl).hash.slice(7), rememberDevice: true });
    const pending = await request({ email: 'remembered@example.com' });
    assert.equal((await api(`/api/people/${member.data.user.id}`, { status: 'disabled' }, owner.cookie, 'PATCH')).response.status, 200);
    assert.equal((await api('/api/session', undefined, member.cookie)).data.user, null);
    assert.equal((await api('/api/auth/verify', { challenge: pending.challenge, code: pending.loginCode })).response.status, 401);
    assert.equal((await api('/api/auth/verify', { token: tokenOf(pending) })).response.status, 401);
    await api(`/api/people/${member.data.user.id}`, { status: 'active' }, owner.cookie, 'PATCH');
    assert.equal((await api('/api/session', undefined, member.cookie)).data.user, null);
    assert.equal((await api('/api/auth/verify', { challenge: pending.challenge, code: pending.loginCode })).response.status, 401);
  });
});

test('codes allow at most five guesses, and unknown challenges have the same refusal', async () => {
  await withAuth(async ({ api, request }) => {
    const login = await request();
    const wrong = String((Number(login.loginCode) + 1) % 100000000).padStart(8, '0');
    const guesses = await Promise.all(Array.from({ length: 7 }, () => api('/api/auth/verify', { challenge: login.challenge, code: wrong })));
    assert.ok(guesses.every(r => r.response.status === 401));
    const exhausted = await api('/api/auth/verify', { challenge: login.challenge, code: login.loginCode });
    assert.equal(exhausted.response.status, 401, 'a correct code is refused after five failures');
    const unknown = await api('/api/auth/verify', { challenge: randomBytes(32).toString('hex'), code: wrong });
    assert.deepEqual(unknown.data, exhausted.data, 'refusals disclose neither account nor challenge state');
    assert.equal((await api('/api/auth/verify', { token: tokenOf(login) })).response.status, 200, 'a failed code does not burn the high-entropy email link');
  });
});

test('code and link race to one session; opening a mail link never consumes it', async () => {
  await withAuth(async ({ api, request }) => {
    const login = await request();
    assert.equal((await fetch(login.loginUrl)).status, 200, 'a mail scanner may open the shell');
    const outcomes = await Promise.all([
      api('/api/auth/verify', { token: tokenOf(login) }),
      api('/api/auth/verify', { challenge: login.challenge, code: login.loginCode }),
    ]);
    assert.deepEqual(outcomes.map(r => r.response.status).sort(), [200, 401]);
  });
});

test('codes expire separately after ten minutes while the hour-long link remains valid', async () => {
  await withAuth(async ({ api, request, expire }) => {
    const login = await request();
    expire('UPDATE logins SET code_expires=0');
    assert.equal((await api('/api/auth/verify', { challenge: login.challenge, code: login.loginCode })).response.status, 401);
    assert.equal((await api('/api/auth/verify', { token: tokenOf(login) })).response.status, 200);
  });
});

test('remembered server sessions outlive seven days but expire at thirty days', async () => {
  await withAuth(async ({ api, request, expire }) => {
    const normal = await request();
    const first = await api('/api/auth/verify', { token: tokenOf(normal) });
    const remembered = await request();
    const second = await api('/api/auth/verify', { challenge: remembered.challenge, code: remembered.loginCode, rememberDevice: true });
    expire('UPDATE sessions SET expires=expires-8*24*3600');
    assert.equal((await api('/api/session', undefined, first.cookie)).data.user, null);
    assert.equal((await api('/api/session', undefined, second.cookie)).data.user.email, 'owner@example.com');
    expire('UPDATE sessions SET expires=expires-23*24*3600');
    assert.equal((await api('/api/session', undefined, second.cookie)).data.user, null);
  });
});

test('return destinations are sanitized at issuance and cannot be changed at confirmation', async () => {
  await withAuth(async ({ api, request }) => {
    for (const destination of ['https://evil.example/path', '//evil.example', '/v/artifact?token=private-capability#private-capability']) {
      const login = await request({ returnTo: destination });
      assert.ok(!login.loginUrl.includes('private-capability') && !login.loginUrl.includes('evil.example'));
      const result = await api('/api/auth/verify', { token: tokenOf(login), returnTo: 'https://evil.example' });
      assert.equal(result.response.status, 200);
      assert.equal(result.data.returnTo, destination.startsWith('/v/') ? '/v/artifact' : '/');
    }
  });
});

test('unknown accounts stay generic; invalid remember choices and mixed credentials do not consume links', async () => {
  await withAuth(async ({ api, request }) => {
    const unknown = await api('/api/auth/request', { email: 'unknown@example.com', challenge: randomBytes(32).toString('hex') });
    assert.deepEqual(unknown.data, { ok: true });
    const login = await request();
    assert.equal((await api('/api/auth/verify', { token: tokenOf(login), rememberDevice: 'true' })).response.status, 400);
    assert.equal((await api('/api/auth/verify', { token: tokenOf(login), challenge: login.challenge, code: login.loginCode })).response.status, 401);
    assert.equal((await api('/api/auth/verify', { token: tokenOf(login) })).response.status, 200);
  });
});
test('an email code completes sign-in in the original browser and consumes the email link too', async () => {
  await withAuth(async ({ api, request }) => {
    const login = await request({ returnTo: '/v/code-target' });
    assert.ok(typeof login.loginCode === 'string' && /^\d{8}$/.test(login.loginCode), 'loopback mail contains an eight-digit alternative code');
    const confirmed = await api('/api/auth/verify', { challenge: login.challenge, code: login.loginCode });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.data.returnTo, '/v/code-target');
    assert.match(confirmed.response.headers.get('set-cookie'), /Max-Age=604800(?:;|$)/);
    assert.equal((await api('/api/auth/verify', { token: tokenOf(login) })).response.status, 401, 'code and link share one consumption');
    assert.equal((await api('/api/auth/verify', { challenge: login.challenge, code: login.loginCode })).response.status, 401, 'code cannot be replayed');
  });
});
test('email confirmation returns to the artifact/version across tabs and remembers only with explicit consent', async () => {
  await withAuth(async ({ api, request }) => {
    const login = await request({ returnTo: '/v/the-artifact#@abcdef123456' });
    const confirmed = await api('/api/auth/verify', { token: tokenOf(login), rememberDevice: true });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.data.returnTo, '/v/the-artifact#@abcdef123456');
    assert.match(confirmed.response.headers.get('set-cookie'), /Max-Age=2592000(?:;|$)/);
    assert.equal((await api('/api/session', undefined, confirmed.cookie)).data.user.email, 'owner@example.com');
    await api('/api/auth/logout', {}, confirmed.cookie);
    assert.equal((await api('/api/session', undefined, confirmed.cookie)).data.user, null);
  });
});
