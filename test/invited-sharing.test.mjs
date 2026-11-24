import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, freePort } from './helpers/worker.mjs';

const work = mkdtempSync(join(tmpdir(), 'hap-invited-sharing-'));
let worker, owner, creator;
async function api(path, { method = 'GET', cookie, token, body } = {}) {
  const response = await fetch(worker.base + path, {
    method, headers: { Origin: worker.base, ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Token ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function accept(invitation) {
  const result = await api('/api/auth/verify', { method: 'POST', body: { token: new URL(invitation.json.loginUrl).hash.slice(7) } });
  assert.equal(result.status, 200, 'invitation can be accepted');
  return { ...result, user: result.json.user };
}
async function invite(email) {
  const invitation = await api('/api/invitations', { method: 'POST', cookie: owner.cookie, body: { email, name: email.split('@')[0] } });
  assert.equal(invitation.status, 200);
  const people = await api('/api/people', { cookie: owner.cookie });
  return { ...invitation, user: people.json.users.find(u => u.email === email) };
}
async function artifact() {
  const result = await api('/api/artifacts', { method: 'POST', cookie: creator.cookie,
    body: { title: 'Invited sharing', ttlSeconds: null, files: { 'index.html': Buffer.from('<h1>Private</h1>').toString('base64') } } });
  assert.equal(result.status, 201);
  return `/api/artifacts/${result.json.id}`;
}
before(async () => {
  const port = await freePort();
  worker = await startWorker(work, { OWNER_EMAIL: 'owner@example.com', APP_ORIGIN: `http://127.0.0.1:${port}`, TEST_MAIL_TRANSPORT: 'loopback' }, { port });
  owner = await accept(await api('/api/auth/request', { method: 'POST', body: { email: 'owner@example.com' } }));
  creator = await accept(await invite('creator@example.com'));
});
after(() => { worker?.stop(); rmSync(work, { recursive: true, force: true }); });

test('pending access can be removed, and a withdrawn invitation never carries access into a new invitation', async () => {
  const path = await artifact();
  const pending = await invite('withdraw-pending@example.com');
  const grant = permission => api(path + '/sharing', { method: 'PUT', cookie: creator.cookie, body: { userId: pending.user.id, permission } });
  assert.equal((await grant('read')).status, 200);
  assert.equal((await grant(null)).status, 200, 'pending named access can be removed before acceptance');
  assert.ok(!(await api(path + '/sharing', { cookie: creator.cookie })).json.grants.some(g => g.userId === pending.user.id));
  assert.equal((await grant('write')).status, 200);
  assert.equal((await api(path + '/manage', { method: 'PATCH', cookie: owner.cookie, body: { ownerId: pending.user.id } })).status, 400, 'invited people cannot own artifacts before signing in');
  assert.equal((await api(`/api/people/${pending.user.id}`, { method: 'DELETE', cookie: owner.cookie })).status, 200);
  assert.ok(!(await api(path + '/sharing', { cookie: creator.cookie })).json.grants.some(g => g.userId === pending.user.id));
  assert.equal((await api('/api/auth/verify', { method: 'POST', body: { token: new URL(pending.json.loginUrl).hash.slice(7) } })).status, 401);
  const replacement = await invite('withdraw-pending@example.com');
  assert.notEqual(replacement.user.id, pending.user.id);
  const signedIn = await accept(replacement);
  assert.equal((await api(path, { cookie: signedIn.cookie })).status, 404, 'a new invitation does not resurrect a withdrawn grant');
});

test('suspended people cannot receive new access, but their existing grant can be revoked', async () => {
  const path = await artifact();
  const pending = await invite('suspend-pending@example.com');
  assert.equal((await api(path + '/sharing', { method: 'PUT', cookie: creator.cookie, body: { userId: pending.user.id, permission: 'read' } })).status, 200);
  await api(`/api/people/${pending.user.id}`, { method: 'PATCH', cookie: owner.cookie, body: { status: 'disabled' } });
  const candidates = (await api(path + '/sharing', { cookie: creator.cookie })).json.users;
  assert.ok(!candidates.some(u => u.id === pending.user.id));
  assert.equal((await api(path + '/sharing', { method: 'PUT', cookie: creator.cookie, body: { userId: pending.user.id, permission: 'write' } })).status, 400);
  assert.equal((await api(path + '/sharing', { method: 'PUT', cookie: creator.cookie, body: { userId: pending.user.id, permission: null } })).status, 200);
});

if (process.env.INVITED_SHARING_BROWSER_QA === '1') test('real browser: pending invitees can be added from viewer Share and library Manage access', async () => {
  const { browserDriver } = await import('./library-browser.mjs');
  const { run, evaluate } = browserDriver('invited-sharing-' + process.pid, { asyncCommands: true });
  const path = await artifact();
  const id = path.split('/').at(-1);
  const pending = await invite('browser-pending@example.com');
  const open = async url => {
    await run('open', url);
    const tabs = JSON.parse(await run('--json', 'tab', 'list')).data.tabs;
    const tab = tabs.find(t => t.url === url);
    assert.ok(tab, 'fixture tab exists');
    await run('--pin-tab', 'tab', tab.tabId);
  };
  try {
    await run('cookies', 'set', 'artifact_session', creator.cookie.split('=')[1], '--url', worker.base, '--httpOnly', '--sameSite', 'Lax');
    await open(worker.base + '/v/' + id);
    await run('wait', '#bar:not([hidden])');
    await run('click', '#shareBtn');
    await run('wait', '--fn', `[...document.getElementById('peoplePick').options].some(o => o.value === ${JSON.stringify(pending.user.id)})`);
    assert.equal(await evaluate(`[...document.getElementById('peoplePick').options].find(o => o.value === ${JSON.stringify(pending.user.id)}).textContent.includes('Invited')`), true);
    await run('select', '#peoplePick', pending.user.id);
    await run('select', '#peoplePermission', 'read');
    await run('click', '#peopleForm [type=submit]');
    await run('wait', '--fn', `document.getElementById('peopleList').textContent.includes('waiting for sign-in')`);
    let saved = (await api(path + '/sharing', { cookie: creator.cookie })).json.grants;
    assert.equal(saved.find(g => g.userId === pending.user.id).permission, 'read');
    await run('click', '#peopleList .remove');
    await run('wait', '--fn', `document.querySelectorAll('#peopleList .person-row').length === 0`);
    await open(worker.base + '/?view=mine');
    await run('wait', '.artifact-title');
    await evaluate(`[...document.querySelectorAll('.artifact-title')].find(a => new URL(a.href).pathname === ${JSON.stringify('/v/' + id)}).closest('article,tr').querySelector('.artifact-menu').click()`);
    await run('find', 'role', 'button', 'click', '--name', 'Manage access');
    await run('wait', '#share-person');
    assert.equal(await evaluate(`[...document.getElementById('share-person').options].find(o => o.value === ${JSON.stringify(pending.user.id)}).textContent.includes('Invited')`), true);
    await run('select', '#share-person', pending.user.id);
    await run('select', '#share-permission', 'write');
    await run('click', '#dialog-body button[type=submit]');
    await run('wait', '--fn', `!document.getElementById('dialog').open`);
    saved = (await api(path + '/sharing', { cookie: creator.cookie })).json.grants;
    assert.equal(saved.find(g => g.userId === pending.user.id).permission, 'write');
    assert.equal(saved.find(g => g.userId === pending.user.id).status, 'invited', 'both sharing surfaces work before acceptance');
  } finally { try { await run('close'); } catch { /* Worker cleanup still proceeds */ } }
});

test('owners can assign view or edit access before acceptance; only verified sign-in makes it usable', async () => {
  const path = await artifact();
  for (const permission of ['read', 'write']) {
    const pending = await invite(`pending-${permission}@example.com`);
    const sharing = await api(path + '/sharing', { cookie: creator.cookie });
    assert.ok(sharing.json.users.some(u => u.id === pending.user.id), 'newly invited person is immediately available in sharing');
    assert.equal(sharing.json.users.find(u => u.id === pending.user.id).status, 'invited');
    const granted = await api(path + '/sharing', { method: 'PUT', cookie: creator.cookie, body: { userId: pending.user.id, permission } });
    assert.equal(granted.status, 200);
    const saved = (await api(path + '/sharing', { cookie: creator.cookie })).json.grants.find(g => g.userId === pending.user.id);
    assert.equal(saved.permission, permission);
    assert.equal(saved.status, 'invited');
    assert.equal((await api('/api/people', { cookie: owner.cookie })).json.users.find(u => u.id === pending.user.id).status, 'invited', 'granting access does not accept the invitation');
    assert.equal((await api(path)).status, 404, 'an assigned grant does not permit anonymous access');
    assert.equal((await api(path, { token: new URL(pending.json.loginUrl).hash.slice(7) })).status, 404, 'an invitation is not an artifact capability');
    const signedIn = await accept(pending);
    const info = await api(path, { cookie: signedIn.cookie });
    assert.equal(info.status, 200);
    assert.equal(info.json.role, permission);
    assert.equal(info.json.canManage, false);
    assert.equal(info.json.readToken, undefined);
    const changed = await api(path, { method: 'PUT', cookie: signedIn.cookie,
      body: { parent: info.json.tip, files: { 'index.html': Buffer.from(`<h1>Changed by ${permission}</h1>`).toString('base64') } } });
    assert.equal(changed.status, permission === 'write' ? 200 : 403);
  }
});
