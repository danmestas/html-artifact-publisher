import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, freePort } from './helpers/worker.mjs';

const work = mkdtempSync(join(tmpdir(), 'hap-compact-library-'));
let worker, owner, creator;
async function api(path, { method = 'GET', cookie, bearer, token, body } = {}) {
  const response = await fetch(worker.base + path, {
    method, headers: { Origin: worker.base, ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(token ? { Authorization: `Token ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function accept(invitation) {
  const result = await api('/api/auth/verify', { method: 'POST', body: { token: new URL(invitation.json.loginUrl).hash.slice(7) } });
  assert.equal(result.status, 200);
  return { cookie: result.cookie, user: result.json.user };
}
async function invite(email, name) {
  const invitation = await api('/api/invitations', { method: 'POST', cookie: owner.cookie, body: { email, name } });
  assert.equal(invitation.status, 200);
  const people = await api('/api/people', { cookie: owner.cookie });
  return { ...invitation, user: people.json.users.find(user => user.email === email) };
}
async function create(title, extra = {}, account = creator) {
  const result = await api('/api/artifacts', { method: 'POST', cookie: account.cookie, bearer: account.bearer,
    body: { title, ttlSeconds: null, files: { 'index.html': Buffer.from('<h1>Compact library searchablebody</h1>').toString('base64') }, ...extra } });
  assert.equal(result.status, 201);
  return result.json;
}
async function grant(artifact, person, permission) {
  const result = await api(`/api/artifacts/${artifact.id}/sharing`, { method: 'PUT', cookie: creator.cookie, body: { userId: person.user.id, permission } });
  assert.equal(result.status, 200);
}
async function libraryRow(artifact, account = creator) {
  const result = await api('/api/library', { cookie: account.cookie });
  assert.equal(result.status, 200);
  return result.json.artifacts.find(row => row.id === artifact.id);
}
before(async () => {
  const port = await freePort();
  worker = await startWorker(work, { OWNER_EMAIL: 'owner@example.com', APP_ORIGIN: `http://127.0.0.1:${port}`, TEST_MAIL_TRANSPORT: 'loopback' }, { port });
  owner = await accept(await api('/api/auth/request', { method: 'POST', body: { email: 'owner@example.com' } }));
  creator = await accept(await invite('creator@example.com', 'Creator'));
});
after(() => { worker?.stop(); rmSync(work, { recursive: true, force: true }); });

test('a cookie-authenticated creator sees a literal bounded summary even when no named grants exist', async () => {
  const artifact = await create('Summary private');
  const row = await libraryRow(artifact);
  assert.equal(row.canManage, true);
  assert.deepEqual(row.sharingSummary, { activeCount: 0, pendingCount: 0, people: [] });
  assert.deepEqual(Object.keys(row.sharingSummary).sort(), ['activeCount', 'pendingCount', 'people']);
});

test('summaries use live grant status and at most three stable active display labels, never pending identities', async () => {
  const artifact = await create('Summary shared');
  const active = [];
  for (const name of ['Delta', 'Bravo', 'Charlie', 'Alpha']) {
    const person = await accept(await invite(`${name.toLowerCase()}@example.com`, name));
    active.push(person);
    await grant(artifact, person, name === 'Bravo' ? 'write' : 'read');
  }
  const pending = await invite('pending-secret@example.com', 'Pending secret');
  await grant(artifact, pending, 'write');
  let row = await libraryRow(artifact);
  assert.deepEqual(row.sharingSummary, { activeCount: 4, pendingCount: 1, people: ['Alpha', 'Bravo', 'Charlie'] });
  assert.deepEqual((await libraryRow(artifact, owner)).sharingSummary, row.sharingSummary);
  assert.equal(JSON.stringify(row.sharingSummary).includes('Pending secret'), false);
  assert.deepEqual((await libraryRow(artifact)).sharingSummary, row.sharingSummary, 'preview order is stable');
  for (const person of active) {
    const shared = await libraryRow(artifact, person);
    assert.equal(shared.canManage, false);
    assert.equal(Object.hasOwn(shared, 'sharingSummary'), false, 'readers and editors cannot see recipient metadata');
    assert.equal((await api(`/api/artifacts/${artifact.id}/sharing`, { cookie: person.cookie })).status, 403, 'exact detail keeps the existing sharing guard');
  }
  const outsider = await accept(await invite('outsider@example.com', 'Outsider'));
  assert.equal(await libraryRow(artifact, outsider), undefined);
  assert.equal((await api(`/api/artifacts/${artifact.id}`, { cookie: outsider.cookie })).status, 404);
  assert.equal((await api(`/api/people/${active[3].user.id}`, { method: 'PATCH', cookie: owner.cookie, body: { status: 'disabled' } })).status, 200);
  row = await libraryRow(artifact);
  assert.deepEqual(row.sharingSummary, { activeCount: 3, pendingCount: 1, people: ['Bravo', 'Charlie', 'Delta'] });
  assert.equal((await api(`/api/artifacts/${artifact.id}`, { cookie: active[3].cookie })).status, 404);
  await grant(artifact, active[1], null);
  assert.deepEqual((await libraryRow(artifact)).sharingSummary, { activeCount: 2, pendingCount: 1, people: ['Charlie', 'Delta'] });
  const accepted = await accept(pending);
  assert.deepEqual((await libraryRow(artifact)).sharingSummary, { activeCount: 3, pendingCount: 0, people: ['Charlie', 'Delta', 'Pending secret'] });
  assert.equal((await api(`/api/artifacts/${artifact.id}`, { cookie: accepted.cookie })).json.role, 'write', 'accepted grants remain usable');
  await grant(artifact, accepted, null);
  assert.equal((await api(`/api/artifacts/${artifact.id}`, { cookie: accepted.cookie })).status, 404);
  assert.deepEqual((await libraryRow(artifact)).sharingSummary, { activeCount: 2, pendingCount: 0, people: ['Charlie', 'Delta'] });
});

test('active people without a safe display name get a neutral label rather than an email, URL, or identity fallback', async () => {
  const artifact = await create('Summary anonymous');
  for (const [email, name] of [
    ['anonymous@example.com', ''],
    ['email-name@example.com', 'Someone <private@example.com>'],
    ['url-name@example.com', 'https://example.com/private-person'],
    ['domain-name@example.com', 'private.example.com'],
    ['uri-name@example.com', 'tel:5550100'],
  ]) {
    const person = await accept(await invite(email, name));
    await grant(artifact, person, 'read');
  }
  const summary = (await libraryRow(artifact)).sharingSummary;
  assert.deepEqual(summary, { activeCount: 5, pendingCount: 0, people: ['Unnamed person', 'Unnamed person', 'Unnamed person'] });
  assert.doesNotMatch(JSON.stringify(summary), /@|https?:|example\.com/);
});

test('ordinary account library expiry order puts finite deadlines first, breaks ties by ID, and continues through null deadlines', async () => {
  const account = await accept(await invite('expiry-member@example.com', 'Expiry member'));
  const soon = new Date((Math.floor(Date.now() / 1000) + 3600) * 1000).toISOString();
  const late = new Date((Math.floor(Date.now() / 1000) + 7200) * 1000).toISOString();
  const entries = [];
  for (const [index, expiresAt] of [late, null, soon, soon, null].entries()) {
    const artifact = await create(`Expiry fixture ${index}`, {}, account);
    if (expiresAt) assert.equal((await api(`/api/artifacts/${artifact.id}/manage`, { method: 'PATCH', cookie: account.cookie, body: { expiresAt } })).status, 200);
    entries.push({ id: artifact.id, expiresAt });
  }
  const expected = entries.toSorted((a, b) => a.expiresAt === b.expiresAt ? (a.id < b.id ? -1 : 1) : a.expiresAt === null ? 1 : b.expiresAt === null ? -1 : a.expiresAt.localeCompare(b.expiresAt));
  const found = [];
  let cursor;
  do {
    const response = await api('/api/library?sort=expiry&limit=1' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), { cookie: account.cookie });
    assert.equal(response.status, 200);
    assert.equal(response.json.total, 5);
    assert.equal(Object.hasOwn(response.json, 'counts'), false, 'ordinary library does not gain inventory counts');
    found.push(...response.json.artifacts.map(({ id, expiresAt }) => ({ id, expiresAt })));
    cursor = response.json.nextCursor;
  } while (cursor && found.length < 10);
  assert.equal(cursor, null);
  assert.deepEqual(found, expected);
  for (const entry of entries) {
    assert.equal((await api(`/api/artifacts/${entry.id}`, { cookie: account.cookie })).json.expiresAt, entry.expiresAt, 'sorting never changes the deadline');
  }
  assert.equal((await api('/api/library?sort=expiry&expiry=soon', { cookie: account.cookie })).status, 400, 'expiry filtering remains inventory-only');
});

test('every account library cursor is bound to the query, filters, sort and account scope, including empty queries', async () => {
  const creator = await accept(await invite('cursor-member@example.com', 'Cursor member'));
  await create('Cursor first', {}, creator);
  await create('Cursor second', {}, creator);
  for (const sort of ['recent', 'name', 'expiry', 'relevance']) {
    const query = sort === 'relevance' ? '&q=searchablebody' : '';
    const path = `/api/library?sort=${sort}&limit=1${query}`;
    const first = await api(path, { cookie: creator.cookie });
    assert.equal(first.status, 200);
    assert.ok(first.json.nextCursor);
    const cursor = '&cursor=' + encodeURIComponent(first.json.nextCursor);
    assert.equal((await api(path + cursor, { cookie: creator.cookie })).status, 200);
    for (const change of ['&view=mine', '&status=active', '&ownerId=someone', '&q=changedword', `&sort=${sort === 'name' ? 'recent' : 'name'}`]) {
      const changed = new URL(path, worker.base);
      for (const [key, value] of new URLSearchParams(change.slice(1))) changed.searchParams.set(key, value);
      assert.equal((await api(changed.pathname + changed.search + cursor, { cookie: creator.cookie })).status, 400, `cursor rejects ${sort} ${change}`);
    }
    assert.equal((await api(path + cursor, { cookie: owner.cookie })).status, 400, 'cursor cannot move between account scopes');
    assert.equal((await api(path.replace('/api/library', '/api/search') + cursor, { cookie: creator.cookie })).status, 400, 'cursor cannot move to the remote search scope');
    for (const malformed of ['null', '[]', '["expiry",null,"validid"]', '["library","bad",1]']) {
      assert.equal((await api(path + '&cursor=' + encodeURIComponent(malformed), { cookie: creator.cookie })).status, 400);
    }
  }
});

test('sharing summaries remain absent from capabilities, automation, remote search, inventory and other endpoints', async () => {
  const credential = await api('/api/credentials', { method: 'POST', cookie: creator.cookie, body: { name: 'Compact library fixture' } });
  assert.equal(credential.status, 201);
  const artifact = await create('Scopepreviewword', {}, { bearer: credential.json.token });
  const active = await accept(await invite('scope-active@example.com', 'Scope active'));
  const pending = await invite('scope-pending@example.com', 'Scope pending');
  await grant(artifact, active, 'write');
  await grant(artifact, pending, 'read');
  assert.deepEqual((await libraryRow(artifact)).sharingSummary, { activeCount: 1, pendingCount: 1, people: ['Scope active'] });
  const ownerCredential = await api('/api/credentials', { method: 'POST', cookie: owner.cookie, body: { name: 'Compact inventory fixture' } });
  assert.equal(ownerCredential.status, 201);
  const query = 'q=scopepreviewword';
  const noSummary = result => {
    assert.equal(result.status, 200);
    assert.equal(result.json.total, 1);
    assert.equal(Object.hasOwn(result.json.artifacts[0], 'sharingSummary'), false);
  };
  noSummary(await api(`/api/library?${query}`, { bearer: credential.json.token }));
  noSummary(await api(`/api/library?${query}&sort=expiry`, { bearer: credential.json.token }));
  assert.equal((await api(`/api/library?${query}`, { bearer: worker.owner })).status, 401);
  for (const auth of [{ cookie: creator.cookie }, { cookie: owner.cookie }, { bearer: credential.json.token }]) {
    for (const sort of ['recent', 'name', 'relevance']) {
      const result = await api(`/api/search?artifactId=${artifact.id}&${query}&sort=${sort}`, auth);
      noSummary(result);
      assert.equal(Object.hasOwn(result.json, 'counts'), false);
      assert.deepEqual(result.json.searchCoverage, { total: 1, complete: 1, partial: 0, pending: 0, error: 0, unsupported: 0 });
    }
    assert.equal((await api(`/api/search?${query}&sort=expiry`, auth)).status, 400, 'remote library sorts do not expand');
    assert.equal((await api(`/api/search?${query}&expiry=soon`, auth)).status, 403, 'remote library filter authority does not expand');
  }
  for (const auth of [{ cookie: owner.cookie }, { bearer: ownerCredential.json.token }, { bearer: worker.owner }]) {
    const result = await api(`/api/search?scope=inventory&${query}&sort=expiry`, auth);
    noSummary(result);
    assert.deepEqual(result.json.counts, { all: 1, active: 1, archived: 0 });
  }
  const inventory = await api(`/api/admin/artifacts?${query}&sort=expiry`, { cookie: owner.cookie });
  noSummary(inventory);
  assert.deepEqual(inventory.json.counts, { all: 1, active: 1, archived: 0 });
  for (const key of ['viewerUrl', 'editUrl', 'commentUrl']) {
    const token = new URL(artifact[key]).hash.slice(1);
    const result = await api(`/api/search?artifactId=${artifact.id}&${query}`, { token });
    noSummary(result);
    assert.equal(Object.hasOwn(result.json, 'counts'), false);
    assert.deepEqual(result.json.searchCoverage, { total: 1, complete: 1, partial: 0, pending: 0, error: 0, unsupported: 0 });
    assert.deepEqual(Object.keys(result.json.artifacts[0]).sort(), ['canManage', 'createdAt', 'expiresAt', 'icon', 'id', 'permission', 'search', 'searchIndex', 'slug', 'tip', 'title', 'updatedAt', 'viewerUrl']);
    assert.equal((await api(`/api/search?artifactId=${artifact.id}&sort=expiry`, { token })).status, 400);
    assert.equal((await api('/api/library', { token })).status, 401);
  }
  assert.equal(Object.hasOwn((await api(`/api/artifacts/${artifact.id}`, { cookie: creator.cookie })).json, 'sharingSummary'), false);
  assert.equal(Object.hasOwn((await api(`/api/artifacts/${artifact.id}/sharing`, { cookie: creator.cookie })).json, 'sharingSummary'), false);
  for (const auth of [{ cookie: creator.cookie }, { bearer: credential.json.token }, { bearer: worker.owner }]) {
    const list = await api('/api/artifacts', auth);
    assert.equal(list.status, 200);
    assert.equal(JSON.stringify(list.json).includes('sharingSummary'), false, 'the legacy artifact list does not acquire recipient metadata');
  }
});

test('compact library metadata preserves body matches, partial coverage labels and default relevance ordering', async () => {
  const account = await accept(await invite('fts-member@example.com', 'Search member'));
  const bodyMatch = await create('Field notes', { files: { 'index.html': Buffer.from('<h1>Compass river observations</h1>').toString('base64') } }, account);
  const titleMatch = await create('Compass river', {}, account);
  const partial = await create('Compass journal', {}, account);
  const found = await api('/api/library?q=compass%20river&limit=2', { cookie: account.cookie });
  assert.equal(found.status, 200);
  assert.equal(found.json.total, 3);
  assert.deepEqual(found.json.artifacts.map(row => row.id), [titleMatch.id, bodyMatch.id]);
  assert.deepEqual(found.json.searchCoverage, { total: 3, complete: 3, partial: 0, pending: 0, error: 0, unsupported: 0 });
  assert.deepEqual(found.json.artifacts[0].search, { matchedTerms: ['compass', 'river'], totalTerms: 2, partial: false, snippet: null });
  assert.match(found.json.artifacts[1].search.snippet.text, /Compass river/);
  assert.deepEqual(found.json.artifacts[1].searchIndex, { status: 'complete', version: 1 });
  assert.deepEqual(found.json.artifacts[1].sharingSummary, { activeCount: 0, pendingCount: 0, people: [] });
  const next = await api('/api/library?q=compass%20river&limit=2&cursor=' + encodeURIComponent(found.json.nextCursor), { cookie: account.cookie });
  assert.equal(next.status, 200);
  assert.equal(next.json.artifacts[0].id, partial.id);
  assert.deepEqual(next.json.artifacts[0].search, { matchedTerms: ['compass'], totalTerms: 2, partial: true, snippet: null });
  assert.equal(next.json.nextCursor, null);
  const remote = await api('/api/search?q=compass%20river', { cookie: account.cookie });
  assert.deepEqual(remote.json.artifacts.map(row => row.id), [titleMatch.id, bodyMatch.id, partial.id]);
  assert.deepEqual(remote.json.searchCoverage, found.json.searchCoverage);
  const expiry = await api('/api/library?q=compass%20river&sort=expiry', { cookie: account.cookie });
  assert.equal(expiry.status, 200);
  assert.equal(expiry.json.total, 3);
  assert.deepEqual(expiry.json.artifacts.map(row => row.id), [titleMatch.id, bodyMatch.id, partial.id].sort());
  assert.deepEqual(expiry.json.artifacts.find(row => row.id === partial.id).search, { matchedTerms: ['compass'], totalTerms: 2, partial: true, snippet: null });
});
