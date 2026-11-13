// Guest discussion: a view-link reader (or an account with read access) can
// identify with a display name and post shared, thread-visible discussion
// without being elevated to the comment or write role. A real Wrangler
// fixture; all mail stays in loopback transport, and the wake sink is a local
// webhook that records each delivery so "guest discussion wakes nobody" can be
// observed rather than assumed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const port = 23000 + Math.floor(Math.random() * 1500);
const base = `http://127.0.0.1:${port}`;
const work = mkdtempSync(join(tmpdir(), 'artifact-guest-'));
const legacy = 'guest-legacy-owner';
const wakeSecret = 'guest-wake-secret';
const wakes = [];
const hook = createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => { wakes.push({ headers: req.headers, body }); res.writeHead(204).end(); });
});
let server, startupLog = '';
const b64 = s => Buffer.from(s).toString('base64');
const tokenOf = url => url?.split('#')[1];

async function api(path, { method = 'GET', cookies = [], bearer, token, body, origin = base, clientIP } = {}) {
  const headers = {};
  if (clientIP) headers['CF-Connecting-IP'] = clientIP;
  if (origin !== null) headers.Origin = origin;
  if (cookies.length) headers.Cookie = cookies.join('; ');
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (token) headers.Authorization = `Token ${token}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* no body */ }
  return {
    status: res.status, json, text, headers: res.headers,
    setCookies: res.headers.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []),
  };
}

async function login(email) {
  const r = await api('/api/auth/request', { method: 'POST', body: { email } });
  assert.ok(r.json?.loginUrl, r.text);
  const token = new URL(r.json.loginUrl).hash.slice(7);
  const v = await api('/api/auth/verify', { method: 'POST', body: { token } });
  assert.equal(v.status, 200, v.text);
  return { cookie: v.setCookies[0].split(';')[0], user: v.json.user };
}
async function invite(owner, email) {
  const r = await api('/api/invitations', { method: 'POST', cookies: [owner.cookie], body: { email, name: email.split('@')[0] } });
  assert.equal(r.status, 200, r.text);
  const token = new URL(r.json.loginUrl).hash.slice(7);
  const v = await api('/api/auth/verify', { method: 'POST', body: { token } });
  assert.equal(v.status, 200, v.text);
  return { cookie: v.setCookies[0].split(';')[0], user: v.json.user };
}
async function create(auth = { bearer: legacy }, extra = {}) {
  const r = await api('/api/artifacts', {
    method: 'POST', ...auth,
    body: { title: 'Guest discussion fixture', ttlSeconds: null, files: { 'index.html': b64('<h1>Guest</h1>') }, ...extra },
  });
  assert.equal(r.status, 201, r.text);
  return { ...r.json, read: tokenOf(r.json.viewerUrl), write: tokenOf(r.json.editUrl), comment: tokenOf(r.json.commentUrl) };
}
const guestCookie = res => {
  const set = res.setCookies.find(c => c.startsWith('hap_guest='));
  assert.ok(set, `no guest cookie: ${JSON.stringify(res.setCookies)}`);
  return set.split(';')[0];
};
const guestToken = res => guestCookie(res).slice('hap_guest='.length);
const health = async () => (await fetch(base + '/healthz')).ok;

if (process.env.GUEST_BROWSER_QA === '1') test('real browser: guest comments are shared and private identity stays private', { timeout: 180000 }, async () => {
  const a = await create();
  const { guestDiscussionQA } = await import('./guest-discussion-browser.mjs');
  await guestDiscussionQA({ base, artifact: a, api });
});

before(async () => {
  await new Promise(resolve => hook.listen(0, '127.0.0.1', resolve));
  server = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--port', String(port), '--inspector-port', '0', '--ip', '127.0.0.1',
    '--persist-to', join(work, 'state'), '--var', `BEARER_TOKEN:${legacy}`, '--var', 'OWNER_EMAIL:owner@example.com',
    '--var', `APP_ORIGIN:${base}`, '--var', 'TEST_MAIL_TRANSPORT:loopback',
    '--var', 'TEST_EXPIRATION_ALARM_HOLD_MS:5000', '--var', 'TEST_EXPIRATION_FAULT:throw',
    '--var', 'TEST_EXPIRATION_RETRY_MS:10000',
    '--var', 'WAKE_SINK_KIND:webhook', '--var', `WAKE_SINK_URL:http://127.0.0.1:${hook.address().port}/wake`,
    '--var', `WAKE_SINK_SECRET:${wakeSecret}`, '--show-interactive-dev-session=false'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  server.stdout.on('data', d => { startupLog += d; });
  server.stderr.on('data', d => { startupLog += d; });
  for (let i = 0; i < 120; i++) {
    try { if (await health()) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Wrangler failed to start: ${startupLog}`);
});
after(() => {
  if (server) try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
  hook.close();
  rmSync(work, { recursive: true, force: true });
});

test('a view-link reader identifies, discusses, and gains no comment or write power', async () => {
  const a = await create();
  const path = `/api/artifacts/${a.id}`;

  // Reading the profile never creates one, and never sets a cookie.
  const before0 = await api(`${path}/guest`, { token: a.read });
  assert.equal(before0.status, 200, before0.text);
  assert.deepEqual(before0.json, { guest: null, canComment: true, canManage: false });
  assert.equal(before0.setCookies.length, 0, 'GET must not create a guest');
  assert.equal((await api(`${path}/guest`, { token: 'f'.repeat(64) })).status, 404, 'the guest route requires read authority');

  // A read link cannot post until it has identified.
  wakes.length = 0;
  const anonymous = await api(`${path}/tickets`, { method: 'POST', token: a.read, body: { text: 'Anyone here?' } });
  assert.equal(anonymous.status, 403, anonymous.text);
  assert.match(anonymous.json.error, /identify/i);

  const created = await api(`${path}/guest`, { method: 'PUT', token: a.read, body: { name: '', email: '' } });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.json.guest.name, 'Guest');
  assert.equal(created.json.guest.email, '');
  assert.ok(!('claimedAccountId' in created.json.guest));
  const token = guestToken(created);
  assert.match(token, /^[a-f0-9]{64}$/);
  const setCookie = created.setCookies[0];
  assert.match(setCookie, /^hap_guest=[a-f0-9]{64}/);
  assert.match(setCookie, /Path=\/api\/artifacts\//);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=2592000/);
  assert.doesNotMatch(setCookie, /Secure/, 'local HTTP does not set Secure; HTTPS does');
  const guest = guestCookie(created);

  const updated = await api(`${path}/guest`, { method: 'PUT', token: a.read, cookies: [guest], body: { name: 'Rae', email: 'rae@example.com' } });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.json.guest.id, created.json.guest.id, 'the same cookie keeps one identity');
  assert.equal(updated.json.guest.name, 'Rae');
  assert.equal(updated.json.guest.email, 'rae@example.com');
  assert.equal(updated.setCookies.length, 0, 'an existing identity keeps its cookie');

  const mine = await api(`${path}/guest`, { token: a.read, cookies: [guest] });
  assert.deepEqual(mine.json.guest, { id: created.json.guest.id, name: 'Rae', email: 'rae@example.com' });
  assert.doesNotMatch(JSON.stringify(mine.json), /[a-f0-9]{64}/, 'no raw token or hash leaves the server');

  const opened = await api(`${path}/tickets`, { method: 'POST', token: a.read, cookies: [guest], body: { text: 'The chart is confusing\nmore detail', anchor: 'intro' } });
  assert.equal(opened.status, 201, opened.text);
  const replied = await api(`${path}/tickets`, { method: 'POST', token: a.read, cookies: [guest], body: { ticketUuid: opened.json.ticketUuid, text: 'Clarified above' } });
  assert.equal(replied.status, 200, replied.text);

  const listed = await api(`${path}/tickets`, { token: a.read });
  assert.equal(listed.json.guestDiscussion, true);
  const thread = listed.json.tickets.find(t => t.uuid === opened.json.ticketUuid);
  assert.deepEqual(thread.changes.map(c => ({ authority: c.fields.authority, intent: c.fields.intent, guest: c.fields.guest })),
    [0, 1].map(() => ({ authority: 'view', intent: 'comment', guest: created.json.guest.id })));
  assert.deepEqual(thread.changes.map(c => c.user), ['Rae (guest)', 'Rae (guest)']);
  assert.equal(thread.changes[0].fields.severity, 'guest-discussion', 'server-selected discussion marker');
  assert.equal(thread.changes[1].fields.severity, 'guest-discussion');
  assert.equal(thread.changes[0].fields.type, 'Comment');
  assert.equal(thread.changes[0].fields.title, 'The chart is confusing');
  assert.equal(thread.changes[0].fields.subsystem, 'intro');
  assert.equal(thread.changes[0].fields.comment, 'The chart is confusing\nmore detail');
  assert.equal(thread.changes[1].comment, 'Clarified above');
  assert.ok(!listed.text.includes('rae@example.com'), 'the private email is never in ticket data');
  assert.ok(!listed.text.includes(token), 'the guest token is never in ticket data');

  // No status, responder or field authority.
  assert.equal((await api(`${path}/tickets`, { method: 'POST', token: a.read, cookies: [guest], body: { ticketUuid: opened.json.ticketUuid, status: 'Closed' } })).status, 403);
  assert.equal((await api(`${path}/tickets`, { method: 'POST', token: a.read, cookies: [guest], body: { text: 'x', asResponder: true } })).status, 403);
  assert.equal((await api(`${path}/tickets`, { method: 'POST', token: a.read, cookies: [guest], body: { text: 'x', fields: { title: 'y' } } })).status, 400);

  // Existing read-role denials are unchanged by having a profile.
  const update = { parent: a.tip, files: { 'index.html': b64('<h1>No</h1>') } };
  assert.equal((await api(path, { method: 'PUT', token: a.read, cookies: [guest], body: update })).status, 403);
  assert.equal((await api(`${path}/data/x`, { method: 'PUT', token: a.read, cookies: [guest], body: { n: 1 } })).status, 403);
  assert.equal((await api(path, { method: 'DELETE', token: a.read, cookies: [guest] })).status, 401);
  assert.equal((await api(`${path}/attachments`, { method: 'POST', token: a.read, cookies: [guest], body: { target: opened.json.ticketUuid, name: 'x.txt', content: 'x' } })).status, 403);

  // A cookie the server never issued proves nothing and aliases nobody.
  const spoof = `hap_guest=${'a'.repeat(64)}`;
  assert.equal((await api(`${path}/guest`, { token: a.read, cookies: [spoof] })).json.guest, null);
  assert.equal((await api(`${path}/tickets`, { method: 'POST', token: a.read, cookies: [spoof], body: { text: 'spoofed' } })).status, 403);
  const spoofed = await api(`${path}/guest`, { method: 'PUT', token: a.read, cookies: [spoof], body: { name: 'Spoof' } });
  assert.equal(spoofed.status, 200, spoofed.text);
  assert.notEqual(spoofed.json.guest.id, created.json.guest.id, 'a different token is a different guest');

  // Ordinary discussion wakes no agent; the owner's comment still does.
  await new Promise(r => setTimeout(r, 500));
  assert.equal(wakes.length, 0, 'guest discussion wakes nobody');
  assert.equal((await api(`${path}/tickets`, { method: 'POST', token: a.comment, body: { text: 'Owner reply' } })).status, 201);
  for (let i = 0; i < 50 && !wakes.length; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(wakes.length, 1, 'an owner comment still wakes the sink');
  assert.equal(JSON.parse(wakes[0].body).kind, 'comment');

  // Capability flags: readers may discuss, only comment/write roles moderate.
  const pick = json => ({ role: json.role, canComment: json.canComment, canModerate: json.canModerate, guestDiscussion: json.guestDiscussion, canManage: json.canManage });
  assert.deepEqual(pick((await api(path, { token: a.read })).json), { role: 'read', canComment: true, canModerate: false, guestDiscussion: true, canManage: false });
  assert.deepEqual(pick((await api(path, { token: a.comment })).json), { role: 'comment', canComment: true, canModerate: true, guestDiscussion: true, canManage: false });
  assert.deepEqual(pick((await api(path, { token: a.write })).json), { role: 'write', canComment: true, canModerate: true, guestDiscussion: true, canManage: false });
  assert.deepEqual(pick((await api(path, { bearer: legacy })).json), { role: 'write', canComment: true, canModerate: true, guestDiscussion: true, canManage: true });
});

test('owners review, block, claim and upgrade guests; named editors cannot', async () => {
  const owner = await login('owner@example.com');
  const member = await invite(owner, 'member@example.com');
  const second = await invite(owner, 'second@example.com');
  const a = await create();
  const path = `/api/artifacts/${a.id}`;
  assert.equal((await api(`${path}/sharing`, { method: 'PUT', cookies: [owner.cookie], body: { userId: member.user.id, permission: 'read' } })).status, 200);

  // A read-role account also identifies before discussing.
  const guestRes = await api(`${path}/guest`, { method: 'PUT', cookies: [member.cookie], body: { name: 'Member Rae', email: 'member@example.com' } });
  assert.equal(guestRes.status, 200, guestRes.text);
  const memberGuest = guestCookie(guestRes);
  const memberGuestId = guestRes.json.guest.id;
  assert.equal((await api(`${path}/tickets`, { method: 'POST', cookies: [member.cookie], body: { text: 'From a read-role account' } })).status, 403, 'profile first, then post');
  const memberPost = await api(`${path}/tickets`, { method: 'POST', cookies: [member.cookie, memberGuest], body: { text: 'From a read-role account' } });
  assert.equal(memberPost.status, 201, memberPost.text);

  const readInfo = await api(path, { cookies: [member.cookie] });
  assert.equal(readInfo.json.role, 'read');
  assert.equal(readInfo.json.canComment, true);
  assert.equal(readInfo.json.canModerate, false);

  // Management is the owner's alone: not a read link, comment link, write
  // link, or a named editor.
  assert.equal((await api(`${path}/guests`, { token: a.read })).status, 403);
  assert.equal((await api(`${path}/guests`, { token: a.comment })).status, 403);
  assert.equal((await api(`${path}/guests`, { token: a.write })).status, 403);
  assert.equal((await api(`${path}/sharing`, { method: 'PUT', cookies: [owner.cookie], body: { userId: second.user.id, permission: 'write' } })).status, 200);
  assert.equal((await api(`${path}/guests`, { cookies: [second.cookie] })).status, 403, 'a named editor is not the owner');
  const listing = await api(`${path}/guests`, { bearer: legacy });
  assert.equal(listing.status, 200, listing.text);
  assert.deepEqual(listing.json.guests.map(g => [g.id, g.name, g.email, g.blocked, g.claimedAccountId, g.permission]),
    [[memberGuestId, 'Member Rae', 'member@example.com', false, null, null]]);
  assert.equal(listing.json.nextCursor, null);

  // Pagination never silently truncates.
  for (const [name, cookie] of [['Ana', `hap_guest=${'b'.repeat(64)}`], ['Ben', `hap_guest=${'c'.repeat(64)}`], ['Cara', `hap_guest=${'d'.repeat(64)}`]]) {
    assert.equal((await api(`${path}/guest`, { method: 'PUT', token: a.read, cookies: [cookie], body: { name } })).status, 200);
  }
  const firstPage = await api(`${path}/guests?limit=2`, { bearer: legacy });
  assert.equal(firstPage.status, 200, firstPage.text);
  assert.equal(firstPage.json.guests.length, 2);
  assert.ok(firstPage.json.nextCursor, 'more guests are announced');
  const secondPage = await api(`${path}/guests?limit=2&cursor=${encodeURIComponent(firstPage.json.nextCursor)}`, { bearer: legacy });
  assert.equal(secondPage.json.guests.length, 2);
  assert.equal(secondPage.json.nextCursor, null);
  assert.equal((await api(`${path}/guests?limit=0`, { bearer: legacy })).status, 400);
  assert.equal((await api(`${path}/guests?limit=101`, { bearer: legacy })).status, 400);
  const cara = [...firstPage.json.guests, ...secondPage.json.guests].find(g => g.name === 'Cara');

  // Blocking is effective at once, and only the owner may do it.
  assert.equal((await api(`${path}/guests/${memberGuestId}`, { method: 'PATCH', cookies: [second.cookie], body: { blocked: true } })).status, 403);
  assert.equal((await api(`${path}/guests/${memberGuestId}`, { method: 'PATCH', bearer: legacy, body: { blocked: 'yes' } })).status, 400);
  assert.equal((await api(`${path}/guests/${memberGuestId}`, { method: 'PATCH', bearer: legacy, body: { blocked: true, permission: 'write' } })).status, 400);
  assert.equal((await api(`${path}/guests/not-a-guest`, { method: 'PATCH', bearer: legacy, body: { blocked: true } })).status, 404);
  assert.deepEqual((await api(`${path}/guests/${memberGuestId}`, { method: 'PATCH', bearer: legacy, body: { blocked: true } })).json, { ok: true });
  assert.equal((await api(`${path}/guest`, { cookies: [member.cookie, memberGuest] })).json.canComment, false, 'blocked identity is not offered a composer');
  const blocked = await api(`${path}/tickets`, { method: 'POST', cookies: [member.cookie, memberGuest], body: { text: 'still here?' } });
  assert.equal(blocked.status, 403, blocked.text);
  assert.match(blocked.json.error, /blocked/i);
  assert.equal((await api(`${path}/guests/${memberGuestId}`, { method: 'PATCH', bearer: legacy, body: { blocked: false } })).status, 200);
  assert.equal((await api(`${path}/tickets`, { method: 'POST', cookies: [member.cookie, memberGuest], body: { text: 'back' } })).status, 201);

  // Claiming proves both: the artifact credential and an active account
  // session, with the identity read from the cookie rather than the header.
  const post = (extra = {}) => api(`${path}/guest/claim`, { method: 'POST', token: a.read, cookies: [memberGuest], body: {}, ...extra });
  assert.equal((await post()).status, 401, 'a guest cookie alone is not a sign-in');
  assert.equal((await post({ cookies: [member.cookie] })).status, 403, 'an account alone has no guest to claim');
  // An account read grant authorizes the artifact on its own, so the
  // credential-required case needs an artifact the account cannot read.
  const unshared = await create();
  assert.equal((await api(`/api/artifacts/${unshared.id}/guest/claim`, { method: 'POST', cookies: [member.cookie, memberGuest], body: {} })).status, 404, 'the artifact credential is required');
  assert.equal((await api(`${path}/guest/claim`, { method: 'POST', token: a.read, cookies: [member.cookie, memberGuest], body: { userId: member.user.id } })).status, 400, 'the body is empty');
  assert.deepEqual((await post({ cookies: [member.cookie, memberGuest] })).json, { ok: true });
  const claimed = (await api(`${path}/guests`, { bearer: legacy })).json.guests.find(g => g.id === memberGuestId);
  assert.equal(claimed.claimedAccountId, member.user.id);
  assert.equal(claimed.claimedAccountName, 'member');
  assert.equal(claimed.claimedAccountEmail, 'member@example.com');
  assert.equal(claimed.permission, null, 'a claim is a request for review, not a grant');

  // Upgrade: only a preclaimed, still-active account, only by the owner.
  const upgrade = (id, body, extra = {}) => api(`${path}/guests/${id}/upgrade`, { method: 'POST', bearer: legacy, body, ...extra });
  assert.equal((await upgrade(cara.id, { permission: 'read' })).status, 400, 'an unclaimed guest cannot be upgraded');
  assert.equal((await upgrade(memberGuestId, { permission: 'admin' })).status, 400);
  assert.equal((await upgrade(memberGuestId, { permission: 'write', userId: member.user.id })).status, 400);
  assert.equal((await upgrade(memberGuestId, { permission: 'read' }, { bearer: undefined, cookies: [second.cookie] })).status, 403);
  assert.deepEqual((await upgrade(memberGuestId, { permission: 'write' })).json, { ok: true });
  assert.equal((await api(`${path}/guests`, { bearer: legacy })).json.guests.find(g => g.id === memberGuestId).permission, 'write');
  const memberInfo = await api(path, { cookies: [member.cookie] });
  assert.equal(memberInfo.json.role, 'write', 'the verified account now holds the granted role');
  assert.equal(memberInfo.json.canManage, false, 'but not ownership');
  const commit = { parent: a.tip, files: { 'index.html': b64('<h1>Edited by a verified account</h1>') } };
  assert.equal((await api(path, { method: 'PUT', cookies: [member.cookie], body: commit })).status, 200);
  assert.ok((await api('/api/admin/activity', { cookies: [owner.cookie] })).json.events.some(e => e.action === 'guest_upgrade'), 'the grant is audited');

  // Browser reuse must not rewrite a claim the owner already reviewed.
  const relinked = await post({ cookies: [second.cookie, memberGuest] });
  assert.equal(relinked.status, 409, 'another account cannot replace an existing claimant');
  assert.equal((await api(`${path}/guests`, { bearer: legacy })).json.guests.find(g => g.id === memberGuestId).claimedAccountId, member.user.id);
  assert.deepEqual((await post({ cookies: [member.cookie, memberGuest] })).json, { ok: true }, 'same-account claims remain idempotent');

  // A different cookie cannot claim the upgraded profile or borrow its role.
  const other = `hap_guest=${'e'.repeat(64)}`;
  assert.equal((await api(`${path}/guest/claim`, { method: 'POST', token: a.read, cookies: [second.cookie, other], body: {} })).status, 403);
  assert.equal((await api(`${path}/tickets`, { method: 'POST', token: a.read, cookies: [other], body: { text: 'borrowed?' } })).status, 403);

  // Ownership transfer changes who may review guests immediately.
  const own = await create({ cookies: [second.cookie] }, { title: 'Transferred guests' });
  assert.equal((await api(`/api/artifacts/${own.id}/guests`, { cookies: [second.cookie] })).status, 200);
  assert.equal((await api(`/api/artifacts/${own.id}/manage`, { method: 'PATCH', cookies: [owner.cookie], body: { ownerId: member.user.id } })).status, 200);
  assert.equal((await api(`/api/artifacts/${own.id}/guests`, { cookies: [second.cookie] })).status, 403, 'the former owner may no longer read guests');
  assert.equal((await api(`/api/artifacts/${own.id}/guests`, { cookies: [member.cookie] })).status, 200, 'the new owner may');
});

test('private participants become unavailable at expiry, before alarm cleanup', async () => {
  const owner = await login('owner@example.com');
  const a = await create();
  const path = `/api/artifacts/${a.id}`;
  const identified = await api(`${path}/guest`, { method: 'PUT', token: a.read, body: { name: 'Expiring guest', email: 'expires@example.com' } });
  assert.equal(identified.status, 200);
  const guestId = identified.json.guest.id;
  assert.equal((await api(`${path}/guests`, { bearer: legacy })).status, 200);
  // Leave Registry's projection stale while the authoritative Repo deadline passes.
  const expiresAt = new Date(Date.now() + 2000).toISOString();
  assert.equal((await api(`${path}/manage`, { method: 'PATCH', cookies: [owner.cookie], body: { expiresAt } })).status, 202);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expiresAt) - Date.now()) + 100));
  assert.equal((await api(`${path}/guests`, { bearer: legacy })).status, 404);
  assert.equal((await api(`${path}/guests/${guestId}`, { method: 'PATCH', bearer: legacy, body: { blocked: true } })).status, 404);
});

test('guest posting is rate limited per identity, artifact and client address', async () => {
  // Each scenario owns its client address; opt-in browser posts must not spend this quota.
  const rateApi = (path, options) => api(path, { ...options, clientIP: '192.0.2.101' });
  const a = await create();
  const path = `/api/artifacts/${a.id}`;
  const first = await rateApi(`${path}/guest`, { method: 'PUT', token: a.read, body: { name: 'Burst' } });
  assert.equal(first.status, 200, first.text);
  const cookie = guestCookie(first);
  const post = text => rateApi(`${path}/tickets`, { method: 'POST', token: a.read, cookies: [cookie], body: { text } });
  for (let i = 0; i < 10; i++) assert.equal((await post(`burst ${i}`)).status, 201, `post ${i}`);
  const denied = await post('over the line');
  assert.equal(denied.status, 429, denied.text);
  assert.equal(denied.json.code, 'rate_limited');
  const retryAfter = Number(denied.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 300, `Retry-After: ${denied.headers.get('retry-after')}`);
  assert.equal((await api(`${path}/tickets`, { token: a.read })).json.tickets.length, 10, 'a refused post writes nothing');

  // Concurrent submissions cannot slip past the identity quota.
  const second = await rateApi(`${path}/guest`, { method: 'PUT', token: a.read, body: { name: 'Race' } });
  assert.equal(second.status, 200, second.text);
  const raceCookie = guestCookie(second);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => rateApi(`${path}/tickets`, {
    method: 'POST', token: a.read, cookies: [raceCookie], body: { text: `race ${i}` },
  })));
  assert.equal(results.filter(r => r.status === 201).length, 10, 'exactly the quota was admitted');
  assert.ok(results.filter(r => r.status === 429).length === 2, JSON.stringify(results.map(r => r.status)));
});
