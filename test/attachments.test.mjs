// Attachments on comment threads: text kept in Fossil, bytes kept in R2 at
// attachments/<sha256> behind a quarry-attachment stub, and both through a
// clone. A local Worker (wrangler dev, fresh state) and the native fsclient.
//
//   npm run build:wasm && node --test test/attachments.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, createArtifact, haveStockFossil, stockFossil } from './helpers/worker.mjs';

const root = new URL('..', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'artifact-attachments-'));
const fsclient = join(work, 'fsclient');
const sha256 = b => createHash('sha256').update(b).digest('hex');
let worker;

before(async () => {
  execFileSync('go', ['build', '-o', fsclient, './cmd/fsclient'], { cwd: join(root, 'fossil'), stdio: 'inherit' });
  // Small quotas, so the tests can reach them.
  worker = await startWorker(work, { MAX_ATTACHMENTS: '4', MAX_ATTACHMENT_BYTES: '400000' });
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

test('removing an attachment hides it and frees its bytes', async () => {
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

  // Nothing names the bytes any more, so they are gone: attaching them again needs them again.
  const attachAgain = () => api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token: a.comment, body: { target: ticket, name: 'doc.pdf', type: 'application/pdf', sha256: sha, size: bytes.length } });
  assert.equal((await attachAgain()).json?.code, 'missing_blob');
  const reupload = await api(`/api/artifacts/${a.id}/attachments/${sha}`, { method: 'PUT', token: a.comment, raw: bytes, type: 'application/pdf' });
  assert.equal(reupload.json.stored, true, 'the bytes were deleted from R2');
  assert.equal((await attachAgain()).status, 201);
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

test('deleting an artifact keeps attachment bytes another artifact holds', async () => {
  const { a, ticket } = await withThread();
  const other = await withThread();
  const bytes = randomBytes(4000), sha = sha256(bytes);
  const upload = x => api(`/api/artifacts/${x.id}/attachments/${sha}`, { method: 'PUT', token: x.comment, raw: bytes, type: 'image/png' });
  assert.equal((await upload(a)).status, 201);
  assert.equal((await api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token: a.comment, body: { target: ticket, name: 'x.png', type: 'image/png', sha256: sha, size: bytes.length } })).status, 201);
  // Held already: another artifact's upload is hashed, not stored again.
  assert.deepEqual((await upload(other.a)).json, { sha256: sha, size: bytes.length, stored: false });

  assert.equal((await api(`/api/artifacts/${a.id}`, { method: 'DELETE', token: a.write })).status, 204);
  // The other artifact's upload still holds the bytes.
  assert.deepEqual((await upload(other.a)).json, { sha256: sha, size: bytes.length, stored: false });
});

const attachText = (a, ticket, name, token, content = name) =>
  api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token, body: { target: ticket, name, content } });
const detach = (a, ticket, name, token) => api(`/api/artifacts/${a.id}/attachments`, { method: 'DELETE', token, body: { target: ticket, name } });
const upload = (a, bytes, token = a.comment) => api(`/api/artifacts/${a.id}/attachments/${sha256(bytes)}`, { method: 'PUT', token, raw: bytes, type: 'image/png' });

test('a comment link changes only what comment links attached; an edit link changes anything', async () => {
  const { a, ticket } = await withThread();
  assert.equal((await attachText(a, ticket, 'ed.txt', a.write)).status, 201);
  assert.equal((await attachText(a, ticket, 'c.txt', a.comment)).status, 201);

  const over = await attachText(a, ticket, 'ed.txt', a.comment, 'replaced');
  assert.equal(over.status, 403, over.text);
  assert.equal((await detach(a, ticket, 'ed.txt', a.comment)).status, 403);
  assert.equal((await list(a, ticket))['ed.txt'].user, 'edit-link');

  // Comment links share one identity: any of them may replace or remove what one attached.
  assert.equal((await attachText(a, ticket, 'c.txt', a.comment, 'again')).status, 201);
  assert.equal((await detach(a, ticket, 'c.txt', a.comment)).status, 200);

  assert.equal((await attachText(a, ticket, 'c.txt', a.comment)).status, 201);
  assert.equal((await attachText(a, ticket, 'c.txt', a.write, 'taken over')).status, 201);
  assert.equal((await detach(a, ticket, 'c.txt', a.comment)).status, 403, 'now an editor\'s');
  assert.equal((await detach(a, ticket, 'c.txt', a.write)).status, 200);
  assert.equal((await detach(a, ticket, 'ed.txt', a.write)).status, 200);
});

test('an artifact holds at most MAX_ATTACHMENTS attachments and MAX_ATTACHMENT_BYTES of uploads', async () => {
  const { a, ticket } = await withThread();
  const t2 = (await api(`/api/artifacts/${a.id}/tickets`, { method: 'POST', token: a.comment, body: { text: 'second thread' } })).json.ticketUuid;
  for (const [t, name] of [[ticket, '1.txt'], [ticket, '2.txt'], [t2, '3.txt'], [t2, '4.txt']]) assert.equal((await attachText(a, t, name, a.comment)).status, 201);
  const fifth = await attachText(a, ticket, '5.txt', a.comment);
  assert.equal(fifth.status, 413, fifth.text);
  assert.equal(fifth.json.code, 'quota');
  assert.equal((await attachText(a, ticket, '1.txt', a.comment, 'replacing adds none')).status, 201);

  const big = randomBytes(300_000), more = randomBytes(150_000);
  assert.equal((await upload(a, big)).status, 201);
  const over = await upload(a, more);
  assert.equal(over.status, 413, over.text);
  assert.equal(over.json.code, 'quota');
  assert.equal((await upload(a, big)).status, 200, 'bytes it already holds cost nothing more');
  // A refused or failed upload gives its reservation back.
  assert.equal((await api(`/api/artifacts/${a.id}/attachments/${sha256(more)}`, { method: 'PUT', token: a.comment, raw: randomBytes(90_000) })).status, 400);
  assert.equal((await upload(a, randomBytes(90_000))).status, 201);
});

test('attachment uploads are rate limited per artifact', async () => {
  const { a } = await withThread();
  for (let i = 0; i < 60; i++) assert.equal((await upload(a, randomBytes(16))).status, 201, `upload ${i}`);
  const limited = await upload(a, randomBytes(16));
  assert.equal(limited.status, 429, limited.text);
  assert.equal((await api(`/api/artifacts/${a.id}/attachments/${'ab'.repeat(32)}`, { method: 'HEAD', token: a.comment })).status, 404, 'HEAD is not counted');
});

test('attachments outside threads are out of reach: a wiki page pushed from a clone', { skip: !haveStockFossil && !process.env.CI && 'stock fossil is not installed' }, async () => {
  const { a, ticket } = await withThread();
  const env = { ...process.env, HOME: work, FOSSIL_HOME: work, FOSSIL_USER: 'editor' };
  const stock = (...args) => execFileSync(stockFossil, args, { cwd: work, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  const clone = join(work, `${a.id}-wiki.fossil`), page = 'abcd1234', file = join(work, 'wiki-note.txt');
  stock('clone', a.cloneUrl, clone);
  writeFileSync(file, 'on a wiki page');
  stock('wiki', 'create', page, file, '-R', clone);
  stock('attachment', 'add', page, file, '-R', clone);
  stock('push', a.cloneUrl, '-R', clone);

  assert.equal((await api(`/api/artifacts/${a.id}/attachments?target=${page}`, { token: a.read })).status, 404);
  assert.equal((await detach(a, page, 'wiki-note.txt', a.comment)).status, 404);
  assert.equal((await attachText(a, page, 'x.txt', a.comment)).status, 404);
  stock('pull', a.cloneUrl, '-R', clone);
  assert.equal(stock('sql', '-R', clone, `SELECT count(*) FROM attachment WHERE target='${page}' AND isLatest AND coalesce(src,'')!=''`).trim(), '1');
  assert.ok(await list(a, ticket));
});

/** A PUT that declares `declared` bytes, sends `sent`, then drops the connection. */
function abortedPut(a, sha, sent, declared) {
  return new Promise(resolve => {
    const url = new URL(`${worker.base}/api/artifacts/${a.id}/attachments/${sha}`);
    const req = request(url, { method: 'PUT', headers: { Authorization: `Token ${a.comment}`, 'Content-Length': String(declared) } });
    req.on('error', () => resolve());
    req.on('response', res => { res.resume(); res.on('end', resolve); });
    req.write(sent, () => setTimeout(() => { req.destroy(); resolve(); }, 500));
  });
}

test('an attachment upload never replaces or removes stored bytes', async () => {
  const { a, ticket } = await withThread();
  const other = await withThread();
  const bytes = randomBytes(20_000), sha = sha256(bytes);
  assert.equal((await upload(a, bytes)).status, 201);
  assert.equal((await api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token: a.comment, body: { target: ticket, name: 'keep.png', type: 'image/png', sha256: sha, size: bytes.length } })).status, 201);
  for (const junk of [randomBytes(10), randomBytes(20_000), randomBytes(30_000)]) {
    const r = await api(`/api/artifacts/${other.a.id}/attachments/${sha}`, { method: 'PUT', token: other.a.comment, raw: junk });
    assert.ok(r.status >= 400 && r.status < 500, `junk of ${junk.length} bytes answered ${r.status}`);
  }
  await abortedPut(other.a, sha, randomBytes(1000), 50_000);
  await abortedPut(other.a, sha, bytes.subarray(0, 1000), bytes.length);
  const got = (await list(a, ticket))['keep.png'];
  assert.equal(got.missing, undefined);
  assert.ok(Buffer.from(await (await fetch(worker.base + got.url)).arrayBuffer()).equals(bytes));
});

test('deleting an artifact deletes what was uploaded to it but never used', async () => {
  const a = (await withThread()).a, other = (await withThread()).a;
  const attachment = randomBytes(3000), blob = randomBytes(3000);
  assert.equal((await upload(a, attachment)).status, 201);
  const putBlob = x => api(`/api/artifacts/${x.id}/blobs/${sha256(blob)}`, { method: 'PUT', token: x.write, raw: blob, type: 'image/png' });
  assert.equal((await putBlob(a)).status, 201);
  assert.equal((await api(`/api/artifacts/${a.id}`, { method: 'DELETE', token: a.write })).status, 204);
  assert.equal((await upload(other, attachment)).json.stored, true, 'the attachment upload went with its artifact');
  assert.equal((await putBlob(other)).json.stored, true, 'the blob upload went with its artifact');
});

test('removing or replacing attachments gives their bytes back to the quota', async () => {
  // MAX_ATTACHMENT_BYTES is 400000 here.
  const { a, ticket } = await withThread();
  const attachBytes = async (name, bytes, token) => {
    assert.equal((await upload(a, bytes, token)).status, 201);
    const r = await api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token, body: { target: ticket, name, type: 'image/png', sha256: sha256(bytes), size: bytes.length } });
    assert.equal(r.status, 201, r.text);
  };
  for (const name of ['1.png', '2.png', '3.png']) await attachBytes(name, randomBytes(120_000), a.comment);
  for (const name of ['1.png', '2.png', '3.png']) assert.equal((await detach(a, ticket, name, a.comment)).status, 200);
  await attachBytes('editor.png', randomBytes(120_000), a.write);

  // Replacing one by name frees the bytes it replaced.
  await attachBytes('r.png', randomBytes(130_000), a.write);
  await attachBytes('r.png', randomBytes(130_000), a.write);
  await attachBytes('s.png', randomBytes(130_000), a.write);

  // A refused attach keeps no hold on the bytes: they stay an unattached upload.
  const mine = randomBytes(10_000);
  assert.equal((await upload(a, mine)).status, 201);
  const refused = await api(`/api/artifacts/${a.id}/attachments`, { method: 'POST', token: a.comment, body: { target: ticket, name: 'editor.png', type: 'image/png', sha256: sha256(mine), size: mine.length } });
  assert.equal(refused.status, 403, refused.text);
});

test('bytes being deleted cannot be reused until the deletion is done', async () => {
  // A second Worker that pauses between deciding what to delete and deleting it.
  const slowWork = mkdtempSync(join(tmpdir(), 'artifact-attachments-slow-'));
  const slow = await startWorker(slowWork, { TEST_CLEANUP_PAUSE_MS: '4000' });
  try {
    const call = (path, { method = 'GET', token, body, raw } = {}) => fetch(slow.base + path, {
      method, headers: { Authorization: `Token ${token}`, 'Content-Type': 'image/png' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const a = await createArtifact(slow.base, slow.owner, '<p>a</p>'), b = await createArtifact(slow.base, slow.owner, '<p>b</p>');
    const bytes = randomBytes(5000), sha = sha256(bytes);
    const pointer = Buffer.from(`artifact-blob 1\nsha256 ${sha}\nsize ${bytes.length}\ntype image/png\n`).toString('base64');
    const commit = async x => {
      const tip = (await (await call(`/api/artifacts/${x.id}`, { token: x.read })).json()).tip;
      return call(`/api/artifacts/${x.id}`, { method: 'PUT', token: x.write, body: { parent: tip, files: { 'img.png': pointer } } });
    };
    assert.equal((await call(`/api/artifacts/${a.id}/blobs/${sha}`, { method: 'PUT', token: a.write, raw: bytes })).status, 201);
    assert.equal((await commit(a)).status, 200);
    assert.equal((await call(`/api/artifacts/${b.id}/blobs/${sha}`, { method: 'PUT', token: b.write, raw: bytes })).status, 200, 'b proves it has the bytes');

    // Deleting a, the last artifact pointing at the blob, decides to delete it, then pauses.
    const deleting = call(`/api/artifacts/${a.id}`, { method: 'DELETE', token: a.write });
    await new Promise(r => setTimeout(r, 1500));
    const during = await commit(b);
    assert.equal(during.status, 400, await during.clone().text());
    assert.equal((await during.json()).code, 'missing_blob');
    assert.equal((await call(`/api/artifacts/${b.id}/blobs/${sha}`, { method: 'PUT', token: b.write, raw: bytes })).status, 409);
    assert.equal((await deleting).status, 204);

    // Done: b uploads the bytes again and keeps them.
    const again = await call(`/api/artifacts/${b.id}/blobs/${sha}`, { method: 'PUT', token: b.write, raw: bytes });
    assert.equal(again.status, 201);
    assert.equal((await commit(b)).status, 200);
    const bundle = await (await call(`/api/artifacts/${b.id}/bundle`, { token: b.read })).json();
    assert.ok(Buffer.from(await (await fetch(slow.base + bundle.blobs['img.png'].url)).arrayBuffer()).equals(bytes));
  } finally {
    slow.stop();
    rmSync(slowWork, { recursive: true, force: true });
  }
});
