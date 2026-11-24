import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorker, freePort } from './helpers/worker.mjs';

const work = mkdtempSync(join(tmpdir(), 'hap-library-pages-'));
let worker, owner, creator, reader, outsider;
const entries = [];
const ids = result => result.artifacts.map(row => row.id);
async function api(path, { method = 'GET', cookie = creator?.cookie, bearer, body } = {}) {
  const response = await fetch(worker.base + path, {
    method, headers: { Origin: worker.base, ...(cookie ? { Cookie: cookie } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function accept(invitation) {
  assert.equal(invitation.status, 200);
  const result = await api('/api/auth/verify', { method: 'POST', cookie: '', body: { token: new URL(invitation.json.loginUrl).hash.slice(7) } });
  assert.equal(result.status, 200);
  return { cookie: result.cookie, user: result.json.user };
}
async function invite(email, name) {
  return accept(await api('/api/invitations', { method: 'POST', cookie: owner.cookie, body: { email, name } }));
}
async function create(title, account = creator, extra = {}) {
  const result = await api('/api/artifacts', { method: 'POST', cookie: account.cookie, body: {
    title, ttlSeconds: null, files: { 'index.html': Buffer.from('<p>Pagingbody river observations</p>').toString('base64') }, ...extra,
  } });
  assert.equal(result.status, 201);
  return result.json;
}
async function manage(entry, body) {
  assert.equal((await api(`/api/artifacts/${entry.id}/manage`, { method: 'PATCH', body })).status, 200);
}
async function grant(entry, permission) {
  assert.equal((await api(`/api/artifacts/${entry.id}/sharing`, { method: 'PUT', body: { userId: reader.user.id, permission } })).status, 200);
}
async function page(path, account = creator) {
  const result = await api(path, { cookie: account.cookie });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.nextCursor, null);
  assert.ok(Number.isSafeInteger(result.json.page));
  assert.ok([10, 25, 50, 100].includes(result.json.pageSize));
  return result.json;
}
before(async () => {
  const port = await freePort();
  worker = await startWorker(work, { OWNER_EMAIL: 'owner@example.com', APP_ORIGIN: `http://127.0.0.1:${port}`, TEST_MAIL_TRANSPORT: 'loopback' }, { port });
  owner = await accept(await api('/api/auth/request', { method: 'POST', body: { email: 'owner@example.com' } }));
  creator = await invite('creator@example.com', 'Creator');
  reader = await invite('reader@example.com', 'Reader');
  outsider = await invite('outsider@example.com', 'Outsider');
  const deadline = new Date((Math.floor(Date.now() / 1000) + 3600) * 1000).toISOString();
  for (let i = 0; i < 26; i++) {
    const entry = await create(i % 2 ? 'pagingfixture' : 'Pagingfixture');
    if (i < 12) await manage(entry, { expiresAt: deadline });
    entries.push({ ...entry, expiresAt: i < 12 ? deadline : null });
  }
});
after(() => { worker?.stop(); rmSync(work, { recursive: true, force: true }); });

test('numbered mode validates each parameter strictly and never expands the remote search API', async () => {
  const invalid = [
    'page=', 'page=0', 'page=-1', 'page=1.1', 'page=1e2', 'page=%2B1', 'page=%201', 'page=1x', 'page=01',
    'page=9007199254740992', 'page=1&page=1', 'page=1&page=', 'pageSize=10', 'pageSize=',
    'page=1&pageSize=', 'page=1&pageSize=0', 'page=1&pageSize=11', 'page=1&pageSize=10.0', 'page=1&pageSize=010',
    'page=1&pageSize=10&pageSize=10', 'page=1&cursor=', 'page=1&cursor=[]', 'page=1&limit=', 'page=1&limit=10',
  ];
  for (const path of ['/api/library', '/api/admin/artifacts']) {
    for (const query of invalid) {
      const result = await api(`${path}?${query}`, { cookie: path.includes('admin') ? owner.cookie : creator.cookie });
      assert.equal(result.status, 400, `${path}?${query}`);
    }
  }
  for (const query of ['page=1', 'page=', 'pageSize=10', 'pageSize=']) {
    assert.equal((await api(`/api/search?${query}`)).status, 400, `remote search rejects ${query}`);
    assert.equal((await api(`/api/search?scope=inventory&${query}`, { cookie: owner.cookie })).status, 400);
  }
});

test('empty, single, first, last and oversized numbered pages have exact totals and effective page metadata', async () => {
  for (const [path, account] of [['/api/library?q=nomatchanywhere', creator], ['/api/admin/artifacts?q=nomatchanywhere', owner], ['/api/library', outsider]]) {
    const empty = await page(`${path}${path.includes('?') ? '&' : '?'}page=9007199254740991&pageSize=10`, account);
    assert.equal(empty.page, 1);
    assert.equal(empty.pageSize, 10);
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.artifacts, []);
  }
  const single = await create('Singlepagefixture', outsider);
  const one = await page('/api/library?page=10', outsider);
  assert.equal(one.page, 1);
  assert.equal(one.pageSize, 25);
  assert.equal(one.total, 1);
  assert.deepEqual(ids(one), [single.id]);
  for (const size of [10, 25, 50, 100]) {
    const first = await page(`/api/library?page=1&pageSize=${size}&sort=name`);
    const last = await page(`/api/library?page=9007199254740991&pageSize=${size}&sort=name`);
    const expected = entries.map(entry => entry.id).sort();
    const lastPage = Math.ceil(expected.length / size);
    assert.equal(first.total, 26);
    assert.equal(first.page, 1);
    assert.equal(first.pageSize, size);
    assert.deepEqual(ids(first), expected.slice(0, size));
    assert.equal(last.page, lastPage);
    assert.equal(last.total, 26);
    assert.deepEqual(ids(last), expected.slice((lastPage - 1) * size));
    assert.equal(Object.hasOwn(first, 'counts'), false);
    assert.ok(first.artifacts.every(row => row.sharingSummary?.activeCount === 0));
  }
});

test('direct slices preserve stable recent, title, expiry and relevance ordering including ties and body matches', async () => {
  const binaryExpiryExpected = [...entries.filter(entry => entry.expiresAt).map(entry => entry.id).sort(), ...entries.filter(entry => !entry.expiresAt).map(entry => entry.id).sort()];
  for (const sort of ['recent', 'name', 'expiry', 'relevance']) {
    const query = `sort=${sort}${sort === 'relevance' ? '&q=pagingfixture%20pagingbody' : ''}`;
    const legacy = await api(`/api/library?${query}&limit=100`);
    assert.equal(legacy.status, 200);
    assert.equal(Object.hasOwn(legacy.json, 'page'), false);
    const found = [];
    for (let number = 1; number <= 3; number++) {
      const result = await page(`/api/library?${query}&page=${number}&pageSize=10`);
      assert.equal(result.page, number);
      assert.equal(result.total, 26);
      assert.deepEqual(result.searchCoverage, legacy.json.searchCoverage);
      assert.deepEqual(ids(result), ids(legacy.json).slice((number - 1) * 10, number * 10));
      found.push(...ids(result));
      if (sort === 'relevance') {
        assert.ok(result.artifacts.every(row => row.search.matchedTerms.join(' ') === 'pagingfixture pagingbody'));
        assert.ok(result.artifacts.every(row => row.search.snippet.text.includes('Pagingbody')));
      }
    }
    assert.equal(new Set(found).size, 26);
    if (sort === 'name') assert.deepEqual(found, entries.map(entry => entry.id).sort());
    if (sort === 'expiry') assert.deepEqual(found, binaryExpiryExpected);
    if (sort === 'recent' || sort === 'relevance') {
      const ordered = legacy.json.artifacts.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || (a.id < b.id ? 1 : -1));
      assert.deepEqual(found, ordered.map(entry => entry.id));
    }
  }
});

test('filters, inventory counts and named reader grants are recomputed under the caller authorization', async () => {
  for (const entry of entries.slice(0, 3)) await manage(entry, { archived: true });
  for (const entry of entries.slice(3, 5)) assert.equal((await api(`/api/artifacts/${entry.id}/star`, { method: 'PUT', body: { starred: true } })).status, 200);
  for (const entry of entries.slice(3, 15)) await grant(entry, 'read');
  await create('Pagingfixture private', outsider);
  const mine = await page('/api/library?view=mine&page=3&pageSize=10');
  assert.equal(mine.total, 23);
  assert.equal(mine.artifacts.length, 3);
  const credential = await api('/api/credentials', { method: 'POST', body: { name: 'Paging fixture' } });
  assert.equal(credential.status, 201);
  const automated = await api('/api/library?view=mine&page=3&pageSize=10', { cookie: '', bearer: credential.json.token });
  assert.equal(automated.status, 200);
  assert.equal(automated.json.page, 3);
  assert.deepEqual(ids(automated.json), ids(mine));
  assert.ok(automated.json.artifacts.every(row => !Object.hasOwn(row, 'sharingSummary')));
  const archived = await page('/api/library?view=archived&page=99&pageSize=10');
  assert.equal(archived.total, 3);
  assert.equal(archived.page, 1);
  const starred = await page('/api/library?view=starred&page=1&pageSize=10');
  assert.equal(starred.total, 2);
  const shared = await page('/api/library?view=shared&page=2&pageSize=10', reader);
  assert.equal(shared.total, 12);
  assert.equal(shared.artifacts.length, 2);
  assert.ok(shared.artifacts.every(row => row.permission === 'read' && !row.canManage && !Object.hasOwn(row, 'sharingSummary')));
  assert.equal((await api('/api/admin/artifacts?page=1', { cookie: reader.cookie })).status, 403);
  assert.equal((await api('/api/library?page=1', { cookie: '', bearer: worker.owner })).status, 401);
  assert.equal((await api('/api/library?page=1', { cookie: '' })).status, 401);
  for (const status of ['all', 'active', 'archived']) {
    const query = `q=pagingbody&ownerId=${creator.user.id}&status=${status}`;
    const result = await page(`/api/admin/artifacts?${query}&page=99&pageSize=10`, owner);
    assert.deepEqual(result.counts, { all: 26, active: 23, archived: 3 });
    assert.equal(result.total, status === 'all' ? 26 : status === 'active' ? 23 : 3);
    assert.equal(result.page, Math.ceil(result.total / 10));
    assert.ok(result.artifacts.every(row => row.ownerId === creator.user.id && !Object.hasOwn(row, 'sharingSummary')));
  }
  const soon = await page(`/api/admin/artifacts?ownerId=${creator.user.id}&expiry=soon&page=99&pageSize=10`, owner);
  assert.deepEqual(soon.counts, { all: 12, active: 9, archived: 3 });
  assert.equal(soon.page, 2);
  await grant(entries[3], null);
  await grant(entries[4], null);
  const revoked = await page('/api/library?view=shared&page=2&pageSize=10', reader);
  assert.equal(revoked.total, 10);
  assert.equal(revoked.page, 1);
  assert.ok(!ids(revoked).includes(entries[3].id) && !ids(revoked).includes(entries[4].id));
});

test('expired and deleted matches shrink totals and clamp pages without returning stale permission results', async () => {
  const temporary = await create('Shrinkfixture', creator, { ttlSeconds: 4 });
  const permanent = await create('Shrinkfixture');
  assert.equal((await page('/api/library?q=shrinkfixture&page=99&pageSize=10')).total, 2);
  const deadline = Date.parse(temporary.expiresAt);
  await delay(Math.max(0, deadline - Date.now()) + 1200);
  const expired = await page('/api/library?q=shrinkfixture&page=99&pageSize=10');
  assert.equal(expired.total, 1);
  assert.equal(expired.page, 1);
  assert.deepEqual(ids(expired), [permanent.id]);
  const inventory = await page('/api/admin/artifacts?q=shrinkfixture&page=99&pageSize=10', owner);
  assert.equal(inventory.total, 1);
  assert.deepEqual(inventory.counts, { all: 1, active: 1, archived: 0 });
  assert.deepEqual(ids(inventory), [permanent.id]);
  assert.equal((await api(`/api/artifacts/${permanent.id}`, { method: 'DELETE' })).status, 204);
  const deleted = await page('/api/library?q=shrinkfixture&page=99&pageSize=10');
  assert.equal(deleted.total, 0);
  assert.equal(deleted.page, 1);
  assert.deepEqual(deleted.artifacts, []);
  const original = await page('/api/library?page=3&pageSize=10');
  assert.equal(original.page, 3);
  for (const entry of entries.slice(20, 23)) assert.equal((await api(`/api/artifacts/${entry.id}`, { method: 'DELETE' })).status, 204);
  const shrunk = await page('/api/library?page=3&pageSize=10');
  assert.equal(shrunk.total, 20);
  assert.equal(shrunk.page, 2);
  assert.equal(shrunk.artifacts.length, 10);
});

test('no-page library, inventory and remote search retain cursor continuation and response shape', async () => {
  for (const [path, account] of [['/api/library?q=pagingbody', creator], ['/api/admin/artifacts?q=pagingbody', owner], ['/api/search?q=pagingbody', creator]]) {
    const first = await api(`${path}&limit=2`, { cookie: account.cookie });
    assert.equal(first.status, 200);
    assert.equal(first.json.artifacts.length, 2);
    assert.ok(first.json.nextCursor);
    assert.equal(Object.hasOwn(first.json, 'page'), false);
    assert.equal(Object.hasOwn(first.json, 'pageSize'), false);
    const next = await api(`${path}&limit=2&cursor=${encodeURIComponent(first.json.nextCursor)}`, { cookie: account.cookie });
    assert.equal(next.status, 200);
    assert.equal(next.json.total, first.json.total);
    assert.ok(ids(next.json).every(id => !ids(first.json).includes(id)));
  }
});
