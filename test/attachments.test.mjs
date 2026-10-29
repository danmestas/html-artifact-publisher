// Attachments on comment threads: text kept in Fossil, bytes kept in R2 at
// attachments/<sha256> behind a quarry-attachment stub, and both through a
// clone. A local Worker (wrangler dev, fresh state) and the native fsclient.
//
//   npm run build:wasm && node --test test/attachments.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, createArtifact } from './helpers/worker.mjs';

const root = new URL('..', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'artifact-attachments-'));
const fsclient = join(work, 'fsclient');
const sha256 = b => createHash('sha256').update(b).digest('hex');
let worker;

before(async () => {
  execFileSync('go', ['build', '-o', fsclient, './cmd/fsclient'], { cwd: join(root, 'fossil'), stdio: 'inherit' });
  worker = await startWorker(work);
});
after(() => {
  worker?.stop();
  rmSync(work, { recursive: true, force: true });
});

async function api(path, { method = 'GET', token, body, raw, type } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Token ${token}`;
  if (type) headers['Content-Type'] = type;
  const res = await fetch(worker.base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

function fossil(...args) {
  try {
    return { ok: true, out: execFileSync(fsclient, args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: String(e.stderr) + String(e.stdout) };
  }
}

async function withThread() {
  const a = await createArtifact(worker.base, worker.owner, '<h1>attach to me</h1>');
  const t = await api(`/api/artifacts/${a.id}/tickets`, { method: 'POST', token: a.comment, body: { text: 'see the screenshot' } });
  assert.equal(t.status, 201, t.text);
  return { a, ticket: t.json.ticketUuid };
}

const list = async (a, ticket, token = a.read) => {
  const r = await api(`/api/artifacts/${a.id}/attachments?target=${ticket}`, { token });
  assert.equal(r.status, 200, r.text);
  return Object.fromEntries(r.json.attachments.map(x => [x.name, x]));
};

test('a comment link attaches text, kept in Fossil, that readers list and open', async () => {
  const { a, ticket } = await withThread();
  const r = await api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token: a.comment, body: { target: ticket, name: 'notes.txt', content: 'hello' } });
  assert.equal(r.status, 201, r.text);
  assert.match(r.json.artifact, /^[0-9a-f]{64}$/);

  const got = (await list(a, ticket))['notes.txt'];
  assert.deepEqual({ size: got.size, type: got.type, external: got.external, user: got.user, missing: got.missing },
    { size: 5, type: 'text/plain', external: false, user: 'comment-link', missing: undefined });
  assert.equal(got.sha256, undefined);
  assert.match(got.url, new RegExp(`^/a/${a.id}\\?target=${ticket}&name=notes.txt&exp=\\d+&sig=[\\w-]{43}$`));

  const file = await fetch(worker.base + got.url);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'hello');
  assert.match(file.headers.get('Content-Disposition'), /^attachment; filename="notes.txt"/);
  assert.match(file.headers.get('Content-Security-Policy'), /sandbox/);
  assert.equal(file.headers.get('X-Content-Type-Options'), 'nosniff');
  // A forged or altered link opens nothing.
  assert.equal((await fetch(worker.base + got.url.replace('notes.txt', 'other.txt'))).status, 403);

  const big = await api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token: a.comment, body: { target: ticket, name: 'big.txt', content: 'x'.repeat(256 * 1024 + 1) } });
  assert.equal(big.status, 413, big.text);
  const pointer = `artifact-blob 1\nsha256 ${'ab'.repeat(32)}\nsize 1\ntype image/png\n`;
  assert.equal((await api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token: a.comment, body: { target: ticket, name: 'p.txt', content: pointer } })).status, 400);
  assert.equal((await api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token: a.comment, body: { target: ticket, name: 'a/b.txt', content: 'x' } })).status, 400);
  assert.equal((await api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token: a.comment, body: { target: 'f'.repeat(40), name: 'x.txt', content: 'x' } })).status, 404);
});

test('a read link lists attachments but cannot add, upload or remove them', async () => {
  const { a, ticket } = await withThread();
  assert.deepEqual(await list(a, ticket), {});
  const add = await api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token: a.read, body: { target: ticket, name: 'x.txt', content: 'x' } });
  assert.equal(add.status, 403, add.text);
  const bytes = randomBytes(1000);
  const put = await api(`/api/artifacts/${a.id}/attachments/${sha256(bytes)}`, { method: 'PUT', token: a.read, raw: bytes, type: 'image/png' });
  assert.equal(put.status, 403, put.text);
  assert.equal((await api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token: a.comment, body: { target: ticket, name: 'x.txt', content: 'x' } })).status, 201);
  const del = await api(`/api/artifacts/${a.id}/attachments`, { method: 'DELETE', token: a.read, body: { target: ticket, name: 'x.txt' } });
  assert.equal(del.status, 403, del.text);
  assert.ok((await list(a, ticket))['x.txt']);
  assert.equal((await api(`/api/artifacts/${a.id}/attachments?target=${ticket}`)).status, 404, 'no link, no list');
});

test('bytes go to R2 at attachments/<sha256> and the thread holds a stub naming them', async () => {
  const { a, ticket } = await withThread();
  const bytes = randomBytes(300_000), sha = sha256(bytes);
  const attach = token => api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token, body: { target: ticket, name: 'shot.png', type: 'image/png', sha256: sha, size: bytes.length } });

  const early = await attach(a.comment);
  assert.equal(early.status, 400, early.text);
  assert.equal(early.json.code, 'missing_blob');

  const put = await api(`/api/artifacts/${a.id}/attachments/${sha}`, { method: 'PUT', token: a.comment, raw: bytes, type: 'image/png' });
  assert.equal(put.status, 201, put.text);
  const wrong = randomBytes(10);
  assert.equal((await api(`/api/artifacts/${a.id}/attachments/${sha256(bytes.subarray(1))}`, { method: 'PUT', token: a.comment, raw: wrong })).status, 400);
  // Attachment bytes are not check-in blobs: a commit cannot point a file at them.
  const pointer = Buffer.from(`artifact-blob 1\nsha256 ${sha}\nsize ${bytes.length}\ntype image/png\n`).toString('base64');
  const commit = await api(`/api/artifacts/${a.id}`, { method: 'PUT', token: a.write, body: { parent: a.tip, files: { 'shot.png': pointer } } });
  assert.equal(commit.json?.code, 'missing_blob', commit.text);

  const ok = await attach(a.comment);
  assert.equal(ok.status, 201, ok.text);
  const got = (await list(a, ticket))['shot.png'];
  assert.deepEqual({ size: got.size, type: got.type, external: got.external, sha256: got.sha256, missing: got.missing },
    { size: 300_000, type: 'image/png', external: true, sha256: sha, missing: undefined });
  const file = await fetch(worker.base + got.url);
  assert.equal(file.status, 200);
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(bytes));
  assert.match(file.headers.get('Content-Disposition'), /^inline; filename="shot.png"/);
  assert.equal(file.headers.get('Content-Type'), 'image/png');

  // A clone carries the attachment (its content is the stub, not the bytes).
  const clone = join(work, `${a.id}.fossil`);
  assert.ok(fossil('clone', a.cloneUrl, clone).ok);
  const db = new DatabaseSync(clone, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM attachment WHERE filename='shot.png'").get().n, 1);
  db.close();

  // Knowing the hash is not enough: another artifact cannot attach these bytes.
  const other = await withThread();
  const stolen = await api(`/api/artifacts/${other.a.id}/attachments`, { method: 'POST', token: other.a.comment, body: { target: other.ticket, name: 'shot.png', type: 'image/png', sha256: sha, size: bytes.length } });
  assert.equal(stolen.json?.code, 'missing_blob', stolen.text);
});

test('deleting an attachment hides it; its bytes stay', async () => {
  const { a, ticket } = await withThread();
  const bytes = randomBytes(5000), sha = sha256(bytes);
  assert.equal((await api(`/api/artifacts/${a.id}/attachments/${sha}`, { method: 'PUT', token: a.comment, raw: bytes, type: 'application/pdf' })).status, 201);
  assert.equal((await api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token: a.comment, body: { target: ticket, name: 'doc.pdf', type: 'application/pdf', sha256: sha, size: bytes.length } })).status, 201);
  const before = (await list(a, ticket))['doc.pdf'];

  const del = await api(`/api/artifacts/${a.id}/attachments`, { method: 'DELETE', token: a.comment, body: { target: ticket, name: 'doc.pdf' } });
  assert.equal(del.status, 200, del.text);
  assert.deepEqual(await list(a, ticket), {});
  assert.equal((await api(`/api/artifacts/${a.id}/attachments`, { method: 'DELETE', token: a.comment, body: { target: ticket, name: 'doc.pdf' } })).status, 404);
  assert.equal((await fetch(worker.base + before.url)).status, 404, 'a link names the current attachment, which is gone');

  // Attached again, it serves the same bytes: they never left R2.
  assert.equal((await api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token: a.comment, body: { target: ticket, name: 'doc.pdf', type: 'application/pdf', sha256: sha, size: bytes.length } })).status, 201);
  const again = (await list(a, ticket))['doc.pdf'];
  assert.ok(Buffer.from(await (await fetch(worker.base + again.url)).arrayBuffer()).equals(bytes));
});

test('fossil push: a regular attachment shows up; a stub naming bytes never uploaded here is missing', async () => {
  const { a, ticket } = await withThread();
  const clone = join(work, `${a.id}-push.fossil`);
  assert.ok(fossil('clone', a.cloneUrl, clone).ok);
  const pushed = fossil('attach', clone, a.cloneUrl, ticket, 'pushed.txt', 'from a clone');
  assert.ok(pushed.ok, pushed.out);
  const ext = fossil('attach-external', clone, a.cloneUrl, ticket, 'elsewhere.png', 'cd'.repeat(32), '1234', 'image/png');
  assert.ok(ext.ok, ext.out);

  const got = await list(a, ticket);
  assert.equal(got['pushed.txt'].user, 'editor');
  assert.equal(got['pushed.txt'].external, false);
  assert.equal(await (await fetch(worker.base + got['pushed.txt'].url)).text(), 'from a clone');
  assert.deepEqual({ external: got['elsewhere.png'].external, missing: got['elsewhere.png'].missing, url: got['elsewhere.png'].url },
    { external: true, missing: true, url: undefined });
});

test('deleting an artifact deletes the attachment bytes no other artifact names', async () => {
  const { a, ticket } = await withThread();
  const other = await withThread();
  const bytes = randomBytes(4000), sha = sha256(bytes);
  const upload = x => api(`/api/artifacts/${x.id}/attachments/${sha}`, { method: 'PUT', token: x.comment, raw: bytes, type: 'image/png' });
  assert.equal((await upload(a)).status, 201);
  assert.equal((await api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token: a.comment, body: { target: ticket, name: 'x.png', type: 'image/png', sha256: sha, size: bytes.length } })).status, 201);
  // Held already: another artifact's upload is hashed, not stored again.
  assert.deepEqual((await upload(other.a)).json, { sha256: sha, size: bytes.length, stored: false });

  assert.equal((await api(`/api/artifacts/${a.id}`, { method: 'DELETE', token: a.write })).status, 204);
  // Only an upload named it elsewhere, not an attachment: the object went with the artifact.
  assert.deepEqual((await upload(other.a)).json, { sha256: sha, size: bytes.length, stored: true });
});
