// Deleting an artifact deletes the R2 blobs only it held: never bytes another
// artifact's tree names through an upload of its own, never bytes someone has
// uploaded and not yet used, and never bytes a deletion still in progress may
// remove. Local Workers (wrangler dev, fresh state) and the native fsclient.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, createArtifact } from './helpers/worker.mjs';

const root = new URL('..', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'artifact-blob-cleanup-'));
const fsclient = join(work, 'fsclient');
const sha256 = b => createHash('sha256').update(b).digest('hex');

before(() => {
  execFileSync('go', ['build', '-o', fsclient, './cmd/fsclient'], { cwd: join(root, 'fossil'), stdio: 'inherit' });
});
after(() => rmSync(work, { recursive: true, force: true }));

/** A Worker with its own state and `vars`, and a fetch helper bound to it. */
async function withWorker(vars, body) {
  const dir = mkdtempSync(join(work, 'state-'));
  const w = await startWorker(dir, vars);
  const call = (path, { method = 'GET', token, bearer, body: b, raw } = {}) => fetch(w.base + path, {
    method,
    headers: { Authorization: bearer ? `Bearer ${bearer}` : `Token ${token}`, 'Content-Type': 'image/png' },
    body: raw ?? (b === undefined ? undefined : JSON.stringify(b)),
  });
  try { await body(w, call); } finally { w.stop(); }
}

const pointerText = bytes => `artifact-blob 1\nsha256 ${sha256(bytes)}\nsize ${bytes.length}\ntype image/png\n`;

async function commitPointer(call, x, bytes) {
  const tip = (await (await call(`/api/artifacts/${x.id}`, { token: x.read })).json()).tip;
  return call(`/api/artifacts/${x.id}`, { method: 'PUT', token: x.write, body: { parent: tip, files: { 'img.png': Buffer.from(pointerText(bytes)).toString('base64') } } });
}

async function served(w, call, x, path, bytes) {
  const bundle = await (await call(`/api/artifacts/${x.id}/bundle`, { token: x.read })).json();
  assert.deepEqual(bundle.missing, [], `${path} is not missing`);
  const res = await fetch(w.base + bundle.blobs[path].url);
  assert.equal(res.status, 200);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes));
}

test('bytes another artifact pushed a pointer to, from a clone, survive this one', async () => {
  await withWorker({}, async (w, call) => {
    const a = await createArtifact(w.base, w.owner, '<p>a</p>'), b = await createArtifact(w.base, w.owner, '<p>b</p>');
    const bytes = randomBytes(5000), sha = sha256(bytes);
    assert.equal((await call(`/api/artifacts/${a.id}/blobs/${sha}`, { method: 'PUT', token: a.write, raw: bytes })).status, 201);
    assert.equal((await commitPointer(call, a, bytes)).status, 200);

    // b uploads the bytes, then pushes its pointer from a clone; nobody views b yet.
    assert.equal((await call(`/api/artifacts/${b.id}/blobs/${sha}`, { method: 'PUT', token: b.write, raw: bytes })).status, 200);
    const clone = join(work, `${b.id}.fossil`), pointer = join(work, `${b.id}-pointer`);
    writeFileSync(pointer, pointerText(bytes));
    execFileSync(fsclient, ['clone', b.cloneUrl, clone], { stdio: 'ignore' });
    execFileSync(fsclient, ['push', clone, b.cloneUrl, 'pushed.png', `@${pointer}`, 'pointer from a clone'], { stdio: 'ignore' });

    assert.equal((await call(`/api/artifacts/${a.id}`, { method: 'DELETE', token: a.write })).status, 204);
    await served(w, call, b, 'pushed.png', bytes);
  });
});

test('bytes someone uploaded and has not used yet survive an artifact that also held them', async () => {
  await withWorker({}, async (w, call) => {
    const a = await createArtifact(w.base, w.owner, '<p>a</p>');
    const bytes = randomBytes(5000), sha = sha256(bytes);
    assert.equal((await call(`/api/artifacts/${a.id}/blobs/${sha}`, { method: 'PUT', token: a.write, raw: bytes })).status, 201);
    assert.equal((await commitPointer(call, a, bytes)).status, 200);
    // The owner uploads the same bytes for an artifact it has not created yet.
    assert.equal((await call(`/api/blobs/${sha}`, { method: 'PUT', bearer: w.owner, raw: bytes })).status, 200);

    assert.equal((await call(`/api/artifacts/${a.id}`, { method: 'DELETE', token: a.write })).status, 204);
    const created = await call('/api/artifacts', { method: 'POST', bearer: w.owner, body: { title: 'later', files: { 'index.html': Buffer.from('<img src="img.png">').toString('base64'), 'img.png': Buffer.from(pointerText(bytes)).toString('base64') } } });
    assert.equal(created.status, 201, await created.clone().text());
    const c = await created.json();
    await served(w, call, { id: c.id, read: c.viewerUrl.split('#')[1] }, 'img.png', bytes);
  });
});

test('a deletion still running is not taken for an abandoned one', async () => {
  // The deletion pauses longer than a tombstone takes to go stale.
  await withWorker({ TEST_CLEANUP_PAUSE_MS: '4000', TEST_TOMBSTONE_STALE_MS: '1000' }, async (w, call) => {
    const a = await createArtifact(w.base, w.owner, '<p>a</p>'), b = await createArtifact(w.base, w.owner, '<p>b</p>');
    const bytes = randomBytes(5000), sha = sha256(bytes);
    const put = x => call(`/api/artifacts/${x.id}/blobs/${sha}`, { method: 'PUT', token: x.write, raw: bytes });
    assert.equal((await put(a)).status, 201);
    assert.equal((await commitPointer(call, a, bytes)).status, 200);

    const deleting = call(`/api/artifacts/${a.id}`, { method: 'DELETE', token: a.write });
    await new Promise(r => setTimeout(r, 2000));
    assert.equal((await put(b)).status, 409, 'the deletion is still running');
    assert.equal((await deleting).status, 204);

    assert.equal((await put(b)).status, 201);
    assert.equal((await commitPointer(call, b, bytes)).status, 200);
    await served(w, call, b, 'img.png', bytes);
  });
});
