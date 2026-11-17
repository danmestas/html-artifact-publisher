import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, freePort } from './helpers/worker.mjs';

const exec = promisify(execFile);
const work = mkdtempSync(join(tmpdir(), 'publisher-expiration-'));
let app;
before(async () => {
  const port = await freePort();
  app = await startWorker(work, { OWNER_EMAIL: 'owner@example.com', APP_ORIGIN: `http://127.0.0.1:${port}`, TEST_MAIL_TRANSPORT: 'loopback' }, { port });
});
after(() => { app?.stop(); rmSync(work, { recursive: true, force: true }); });

async function request(path, { auth = `Bearer ${app.owner}`, method = 'GET', body, origin } = {}) {
  return fetch(app.base + path, {
    method, headers: { Authorization: auth, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function create(auth) {
  const r = await request('/api/artifacts', { auth, method: 'POST', body: { title: 'Expiration test', ttlSeconds: 3600, files: { 'index.html': Buffer.from('<!doctype html><html><body>Review</body></html>').toString('base64') } } });
  assert.equal(r.status, 201);
  return r.json();
}
const manage = (a, body, opts = {}) => request(`/api/artifacts/${a.id}/manage`, { method: 'PATCH', body, ...opts });
const info = async a => (await request(`/api/artifacts/${a.id}`)).json();
async function cli(a, ttl, overrides = {}) {
  try {
    const r = await exec(process.execPath, ['scripts/publish-html.mjs', 'expire', a.editUrl, ttl, '--json'], {
      cwd: new URL('..', import.meta.url), timeout: 30000,
      env: { ...process.env, HTML_PUBLISHER_URL: app.base, HTML_PUBLISHER_TOKEN: app.owner, ...overrides },
    });
    return { code: 0, ...r };
  } catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
}

test('legacy instance automation changes only expiration, preserving content and links', async () => {
  const a = await create();
  const before = await info(a);
  const cleared = await manage(a, { expiresAt: null });
  assert.equal(cleared.status, 200);
  const current = await info(a);
  assert.equal(current.expiresAt, null);
  assert.equal(current.tip, before.tip);
  assert.equal(current.readToken, before.readToken);
  const future = new Date(Date.now() + 86400000).toISOString();
  assert.equal((await manage(a, { expiresAt: future })).status, 200);
  assert.equal(Date.parse((await info(a)).expiresAt), Math.floor(Date.parse(future) / 1000) * 1000);
  for (const body of [{ title: 'No' }, { expiresAt: null, archived: true }, { expiresAt: null, ownerId: 'other' }]) {
    assert.equal((await manage(a, body)).status, 403, 'legacy expiration authorization must not grant other management actions');
  }
});

test('expiration automation rejects link credentials, bad dates, bad bearer, and cross-origin mutation', async () => {
  const a = await create();
  assert.equal((await manage(a, { expiresAt: null }, { auth: `Token ${new URL(a.editUrl).hash.slice(1)}` })).status, 401);
  assert.equal((await manage(a, { expiresAt: null }, { auth: 'Bearer invalid' })).status, 401);
  assert.equal((await manage(a, { expiresAt: 'yesterday' })).status, 400);
  assert.equal((await manage(a, { expiresAt: null }, { origin: 'https://elsewhere.example' })).status, 403);
  assert.notEqual((await info(a)).expiresAt, null);
});

test('legacy expiration treats malformed or oversized JSON as invalid input, not missing authority', async () => {
  const a = await create();
  const original = (await info(a)).expiresAt;
  for (const body of ['{invalid', JSON.stringify({ expiresAt: null, padding: 'x'.repeat(20000) })]) {
    const response = await fetch(`${app.base}/api/artifacts/${a.id}/manage`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${app.owner}`, 'Content-Type': 'application/json' }, body,
    });
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  assert.equal((await info(a)).expiresAt, original);
});

test('legacy automation cannot revive an artifact past its deadline', async () => {
  const created = await request('/api/artifacts', { method: 'POST', body: { title: 'Short lived', ttlSeconds: 1, files: { 'index.html': Buffer.from('<!doctype html><html></html>').toString('base64') } } });
  assert.equal(created.status, 201);
  const a = await created.json();
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(a.expiresAt) - Date.now()) + 1000));
  assert.equal((await manage(a, { expiresAt: null })).status, 404);
  assert.equal((await request(`/api/artifacts/${a.id}`)).status, 404);
});

test('expire CLI keeps the original read link, reports the deadline, and leaves history alone', async () => {
  const a = await create();
  const result = await cli(a, 'never');
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.viewerUrl, a.viewerUrl);
  assert.equal(out.expiresAt, null);
  assert.equal(out.linkVerified, true);
  assert.equal(out.expirationPending, false);
  assert.equal((await info(a)).tip, a.tip);
  const bounded = await cli({ ...a, editUrl: a.viewerUrl }, '6h');
  assert.equal(bounded.code, 0, bounded.stderr);
  assert.ok(Math.abs(Date.parse(JSON.parse(bounded.stdout).expiresAt) - Date.now() - 21600000) < 5000);
});

test('expire CLI uses an account-backed owner credential and rejects it after revocation', async () => {
  const login = await (await request('/api/auth/request', { method: 'POST', body: { email: 'owner@example.com' } })).json();
  const verified = await request('/api/auth/verify', { method: 'POST', body: { token: new URL(login.loginUrl).hash.slice(7) } });
  const cookie = verified.headers.get('Set-Cookie').split(';')[0];
  const credentialResponse = await fetch(app.base + '/api/credentials', {
    method: 'POST', headers: { Cookie: cookie, Origin: app.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Expiration automation' }),
  });
  assert.equal(credentialResponse.status, 201);
  const credential = await credentialResponse.json();
  const a = await create(`Bearer ${credential.token}`);
  const changed = await cli(a, 'never', { HTML_PUBLISHER_TOKEN: credential.token });
  assert.equal(changed.code, 0, changed.stderr);
  assert.equal((await info(a)).expiresAt, null);
  assert.equal((await request(`/api/credentials/${credential.id}`, { auth: `Bearer ${credential.token}`, method: 'DELETE' })).status, 200);
  const revoked = await cli(a, '6h', { HTML_PUBLISHER_TOKEN: credential.token });
  assert.notEqual(revoked.code, 0);
  assert.equal((await info(a)).expiresAt, null);
});

test('expire CLI reports a durable deadline with a still-pending library projection', async () => {
  const pending = await startWorker(join(work, 'pending'), { TEST_EXPIRATION_FAULT: 'throw', TEST_EXPIRATION_RETRY_MS: '500' });
  try {
    const response = await fetch(pending.base + '/api/artifacts', {
      method: 'POST', headers: { Authorization: `Bearer ${pending.owner}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Pending projection', ttlSeconds: 3600, files: { 'index.html': Buffer.from('<!doctype html><html></html>').toString('base64') } }),
    });
    assert.equal(response.status, 201);
    const a = await response.json();
    const result = await cli(a, 'never', { HTML_PUBLISHER_URL: pending.base, HTML_PUBLISHER_TOKEN: pending.owner });
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.expirationPending, true);
    assert.equal(out.expiresAt, null);
    assert.equal(out.viewerUrl, a.viewerUrl);
    assert.equal(out.linkVerified, true);
  } finally { pending.stop(); }
});

test('expire CLI validates TTL and configured origin before sending the owner credential', async () => {
  const a = await create();
  for (const ttl of ['0d', '-1h', '1x', '999999999999999999999d']) {
    assert.notEqual((await cli(a, ttl)).code, 0);
  }
  for (const configured of ['http://127.0.0.1:1', app.base + '/nested', app.base + '/?scope=other', app.base + '/#other']) {
    const result = await cli(a, 'never', { HTML_PUBLISHER_URL: configured });
    assert.notEqual(result.code, 0, 'non-root or mismatched publisher URLs must be rejected before mutation');
    assert.match(result.stderr, /origin|HTML_PUBLISHER_URL/i);
  }
  assert.notEqual((await info(a)).expiresAt, null);
});
