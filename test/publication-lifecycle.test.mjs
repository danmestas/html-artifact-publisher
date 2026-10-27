import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

// Exercise the actual Registry lifecycle with SQLite and an in-memory R2 boundary.
// The integration suite separately verifies Wrangler RPC, authorization and serving.
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const compile = file => ts.transpileModule(readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const durable = moduleUrl('export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }');
const util = moduleUrl(compile('util.ts'));
const files = moduleUrl(compile('publication-files.ts'));
const registrySource = compile('registry.ts').replace("'cloudflare:workers'", JSON.stringify(durable)).replace("'./util'", JSON.stringify(util)).replace("'./publication-files'", JSON.stringify(files));
const { Registry } = await import(moduleUrl(registrySource));

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let queue = Promise.resolve();
  const ctx = {
    storage: {
      sql: { exec(query, ...args) {
        // Registry schema creation intentionally contains multiple statements.
        if (!args.length && /;\s*\S/.test(query)) { db.exec(query); return { toArray: () => [] }; }
        const statement = db.prepare(query);
        const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
        return { toArray: () => rows };
      } },
      transactionSync: fn => fn(),
    },
    blockConcurrencyWhile(fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; },
  };
  const objects = new Map();
  const bucket = {
    failDeletes: false,
    async put(key, value) { objects.set(key, value); },
    async delete(keys) {
      if (this.failDeletes) throw new Error('simulated R2 outage');
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list({ prefix, limit }) { return { objects: [...objects.keys()].filter(key => key.startsWith(prefix)).slice(0, limit).map(key => ({ key })) }; },
  };
  return { registry: new Registry(ctx, { BLOBS: bucket }), db, objects, bucket };
}

test('artifact icons persist through add, touch and legacy defaults', async t => {
  const { registry } = fixture(t);
  const entry = { id: 'icon-test', slug: null, title: 'Icon', createdAt: 1, updatedAt: 1, expiresAt: null, tip: 'first' };
  await registry.add(entry);
  assert.equal((await registry.get(entry.id)).icon, 'document');
  await registry.touch(entry.id, 'second', undefined, 'chart');
  assert.equal((await registry.get(entry.id)).icon, 'chart');
  await registry.touch(entry.id, 'third');
  assert.equal((await registry.get(entry.id)).icon, 'chart');
  await registry.touch(entry.id, 'fourth', undefined, null);
  assert.equal((await registry.list(10))[0].icon, 'document');
  await registry.touch(entry.id, 'newer-tip');
  await registry.touch(entry.id, undefined, 'Metadata title', 'map');
  assert.equal((await registry.get(entry.id)).tip, 'newer-tip', 'metadata updates never replace a concurrent content tip');
  assert.equal((await registry.get(entry.id)).title, 'Metadata title');
});

test('cleanup removes failed and abandoned staging but preserves live and current builds', async t => {
  const { registry, db, objects } = fixture(t);
  const begin = () => registry.beginPublication('source', 'owner', 'Snapshot', 'a'.repeat(64));
  const live = await begin(), failed = await begin(), stale = await begin(), building = await begin();
  for (const row of [live, failed, stale, building]) objects.set(`publications/${row.id}/files/index.html`, '<h1>Static</h1>');
  await registry.activatePublication(live.id, 'index.html', 1, 15);
  await registry.failPublication(failed.id);
  db.prepare('UPDATE publications SET created_at=? WHERE id=?').run(new Date(Date.now() - 7200_000).toISOString(), stale.id);
  assert.equal(await registry.activatePublication(stale.id, 'index.html', 1, 15), null, 'an expired builder cannot activate while cleanup is pending');
  assert.deepEqual(await registry.cleanupPublications(), { cleaned: 2, remaining: false });
  assert.equal((await registry.publication(live.id)).status, 'live');
  assert.ok(objects.has(`publications/${live.id}/manifest`));
  assert.ok(objects.has(`publications/${live.id}/files/index.html`));
  assert.ok(objects.has(`publications/${building.id}/files/index.html`));
  for (const row of [failed, stale]) {
    assert.equal((await registry.publication(row.id)).status, 'deleted');
    assert.ok(![...objects.keys()].some(key => key.startsWith(`publications/${row.id}/`)));
  }
  assert.deepEqual(await registry.cleanupPublications(), { cleaned: 0, remaining: false });
});

test('cleanup revisits tombstones to collect late writes after the publisher has died', async t => {
  const { registry, objects } = fixture(t);
  const row = await registry.beginPublication('source', 'owner', 'Snapshot', 'a'.repeat(64));
  await registry.revokePublication(row.id);
  // Simulate an in-flight R2 put finishing after revoke, with no catch/finally left alive.
  objects.set(`publications/${row.id}/files/late.png`, 'late copied bytes');
  assert.deepEqual(await registry.cleanupPublications(), { cleaned: 1, remaining: false });
  assert.ok(!objects.has(`publications/${row.id}/files/late.png`));
  assert.deepEqual(await registry.cleanupPublications(), { cleaned: 0, remaining: false });
});

test('cleanup paginates tombstones without starvation and starts a fresh sweep afterward', async t => {
  const { registry, objects } = fixture(t);
  const rows = [];
  for (let i = 0; i < 28; i++) {
    const row = await registry.beginPublication('source', 'owner', 'Snapshot', 'a'.repeat(64));
    await registry.revokePublication(row.id);
    rows.push(row);
    objects.set(`publications/${row.id}/files/late.txt`, 'late bytes');
  }
  assert.deepEqual(await registry.cleanupPublications(), { cleaned: 25, remaining: true });
  assert.deepEqual(await registry.cleanupPublications(), { cleaned: 3, remaining: false });
  assert.equal(objects.size, 0);
  objects.set(`publications/${rows[0].id}/files/later.txt`, 'even later bytes');
  const first = await registry.cleanupPublications(), second = await registry.cleanupPublications();
  assert.equal(first.cleaned + second.cleaned, 1);
  assert.equal(second.remaining, false);
  assert.equal(objects.size, 0);
});

test('revocation cannot be undone by a late builder and R2 cleanup failures remain retryable', async t => {
  const { registry, bucket, objects } = fixture(t);
  const row = await registry.beginPublication('source', 'owner', 'Snapshot', 'a'.repeat(64));
  objects.set(`publications/${row.id}/files/index.html`, 'static');
  await registry.revokePublication(row.id);
  assert.equal(await registry.activatePublication(row.id, 'index.html', 1, 6), null);
  assert.ok(!objects.has(`publications/${row.id}/manifest`));
  const live = await registry.beginPublication('source', 'owner', 'Live', 'b'.repeat(64));
  objects.set(`publications/${live.id}/files/index.html`, 'static');
  await registry.activatePublication(live.id, 'index.html', 1, 6);
  bucket.failDeletes = true;
  await assert.rejects(registry.revokePublication(live.id), /simulated R2 outage/);
  assert.equal((await registry.publication(live.id)).status, 'live', 'failed visibility-marker removal is not reported as revoked');
  bucket.failDeletes = false;
  await registry.revokePublication(live.id);
  assert.ok(![...objects.keys()].some(key => key.startsWith(`publications/${live.id}/`)));
});
