// An upload never replaces or removes bytes already stored: a body that does
// not match its name, or that never completes, leaves the stored object as it
// was. A local Worker (wrangler dev, fresh state).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, createArtifact } from './helpers/worker.mjs';

const work = mkdtempSync(join(tmpdir(), 'artifact-blob-integrity-'));
const sha256 = b => createHash('sha256').update(b).digest('hex');
let worker;

before(async () => { worker = await startWorker(work); });
after(() => {
  worker?.stop();
  rmSync(work, { recursive: true, force: true });
});

const put = (a, sha, body) => fetch(`${worker.base}/api/artifacts/${a.id}/blobs/${sha}`, {
  method: 'PUT', headers: { Authorization: `Token ${a.write}`, 'Content-Type': 'image/png' }, body,
});

/** A PUT that declares `declared` bytes, sends `sent`, then drops the connection. */
function abortedPut(a, sha, sent, declared) {
  return new Promise(resolve => {
    const url = new URL(`${worker.base}/api/artifacts/${a.id}/blobs/${sha}`);
    const req = request(url, { method: 'PUT', headers: { Authorization: `Token ${a.write}`, 'Content-Length': String(declared) } });
    req.on('error', () => resolve());
    req.on('response', res => { res.resume(); res.on('end', resolve); });
    req.write(sent, () => setTimeout(() => { req.destroy(); resolve(); }, 500));
  });
}

/** The bytes artifact `a` serves for blob `sha`, through the bundle's signed link. */
async function served(a, sha, bytes) {
  const pointer = Buffer.from(`artifact-blob 1\nsha256 ${sha}\nsize ${bytes.length}\ntype image/png\n`).toString('base64');
  const info = await (await fetch(`${worker.base}/api/artifacts/${a.id}`, { headers: { Authorization: `Token ${a.read}` } })).json();
  const commit = await fetch(`${worker.base}/api/artifacts/${a.id}`, {
    method: 'PUT', headers: { Authorization: `Token ${a.write}` }, body: JSON.stringify({ parent: info.tip, files: { 'img.png': pointer } }),
  });
  assert.ok([200, 409].includes(commit.status), await commit.text());
  const bundle = await (await fetch(`${worker.base}/api/artifacts/${a.id}/bundle`, { headers: { Authorization: `Token ${a.read}` } })).json();
  const res = await fetch(worker.base + bundle.blobs['img.png'].url);
  assert.equal(res.status, 200);
  return Buffer.from(await res.arrayBuffer());
}

test('a body that does not match its name leaves the stored blob intact', async () => {
  const owner = await createArtifact(worker.base, worker.owner, '<p>owner</p>');
  const other = await createArtifact(worker.base, worker.owner, '<p>other</p>');
  const bytes = randomBytes(20_000), sha = sha256(bytes);
  assert.equal((await put(owner, sha, bytes)).status, 201);

  for (const junk of [randomBytes(10), randomBytes(20_000), randomBytes(30_000)]) {
    const r = await put(other, sha, junk);
    assert.ok(r.status >= 400 && r.status < 500, `junk of ${junk.length} bytes answered ${r.status}`);
  }
  assert.ok((await served(owner, sha, bytes)).equals(bytes), 'the owner still serves its bytes');
});

test('an upload that never completes leaves the stored blob intact, and stores nothing when there was none', async () => {
  const owner = await createArtifact(worker.base, worker.owner, '<p>owner</p>');
  const other = await createArtifact(worker.base, worker.owner, '<p>other</p>');
  const bytes = randomBytes(20_000), sha = sha256(bytes);
  assert.equal((await put(owner, sha, bytes)).status, 201);
  await abortedPut(other, sha, randomBytes(1000), 50_000);
  await abortedPut(other, sha, bytes.subarray(0, 1000), bytes.length);
  assert.ok((await served(owner, sha, bytes)).equals(bytes));

  const fresh = randomBytes(20_000), freshSha = sha256(fresh);
  await abortedPut(owner, freshSha, fresh.subarray(0, 1000), fresh.length);
  const head = await fetch(`${worker.base}/api/artifacts/${owner.id}/blobs/${freshSha}`, { method: 'HEAD', headers: { Authorization: `Token ${owner.write}` } });
  assert.equal(head.status, 404, 'nothing was stored for the aborted upload');
  assert.equal((await put(owner, freshSha, fresh)).status, 201);
  assert.ok((await served(owner, freshSha, fresh)).equals(fresh));
});
