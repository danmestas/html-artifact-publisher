// End-to-end tests: a local Worker (wrangler dev, fresh state) with the built
// src/fossil.wasm, driven through the HTTP API, Fossil's sync protocol (the
// native fsclient in fossil/cmd/fsclient) and the CLI.
//
//   npm run build:wasm && npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Artifact, createArtifact } from '../public/client.js';
import { controls, thread } from '../public/comments.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const port = 18000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
const owner = 'e2e-owner-token';
const work = mkdtempSync(join(tmpdir(), 'artifact-e2e-'));
const fsclient = join(work, 'fsclient');
let server;
// The wake sink: a webhook that records every delivery and answers 500, so the
// tests also show a failing sink never fails the write.
const wakeSecret = 'e2e-wake-secret';
const wakes = [];
const hook = createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => { wakes.push({ headers: req.headers, body }); res.writeHead(500).end('down'); });
});

const b64 = s => Buffer.from(s).toString('base64');
const fromB64 = s => Buffer.from(s, 'base64').toString();

async function api(path, { method = 'GET', token, bearer, body } = {}) {
  const headers = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (token) headers.Authorization = `Token ${token}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

const tokenOf = url => url.split('#')[1];

async function create(files, extra = {}) {
  const r = await api('/api/artifacts', { method: 'POST', bearer: owner, body: { title: 'Test', files, ...extra } });
  assert.equal(r.status, 201, r.text);
  return { ...r.json, read: tokenOf(r.json.viewerUrl), write: tokenOf(r.json.editUrl), comment: r.json.commentUrl && tokenOf(r.json.commentUrl) };
}

test('artifact icon API preserves metadata, rejects invalid writes and permits unchanged-file icon changes', async () => {
  const files = { 'index.html': Buffer.from('<title>Untouched</title><link rel="icon" href="custom.svg"><h1>Icon</h1>').toString('base64') };
  const a = await create(files, { icon: 'chart' });
  const path = `/api/artifacts/${a.id}`;
  const info = async () => (await api(path, { token: a.read })).json;
  assert.equal((await info()).icon, 'chart');
  assert.equal((await api('/api/artifacts', { bearer: owner })).json.artifacts.find(x => x.id === a.id).icon, 'chart');
  for (const icon of ['__proto__', 'constructor', 'toString', '<svg/>', 'https://example.com/icon.svg', '', 1, true, {}, []]) {
    const result = await api(path, { method: 'PUT', token: a.write, body: { parent: a.tip, files: { 'index.html': Buffer.from('must not land').toString('base64') }, icon } });
    assert.equal(result.status, 400, JSON.stringify(icon));
    assert.equal((await info()).tip, a.tip);
    assert.equal((await info()).icon, 'chart');
    assert.equal((await api('/api/artifacts', { method: 'POST', bearer: owner, body: { files, icon } })).status, 400);
  }
  assert.equal((await api(path, { method: 'PUT', token: a.read, body: { parent: a.tip, files, icon: 'map' } })).status, 403);
  const update = icon => api(path, { method: 'PUT', token: a.write, body: { parent: a.tip, files, ...(icon === undefined ? {} : { icon }) } });
  const metadata = await api(path, { method: 'PUT', token: a.write, body: { parent: a.tip.slice(0, 12), files, icon: 'map', title: 'Renamed metadata' } });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.json.tip, a.tip, 'accepted abbreviated parents return canonical tip');
  assert.equal(metadata.json.parent, a.tip);
  assert.equal((await info()).title, 'Renamed metadata');
  assert.equal((await info()).icon, 'map');
  assert.equal((await info()).tip, a.tip, 'metadata-only update does not create a check-in');
  assert.equal((await update(undefined)).json.code, 'unchanged');
  assert.equal((await info()).icon, 'map');
  assert.equal((await update(null)).status, 200);
  assert.equal((await info()).icon, 'document');
  const legacy = await create(files);
  assert.equal((await api(`/api/artifacts/${legacy.id}`, { token: legacy.read })).json.icon, 'document');
  const art = new Artifact(base, a.id, a.write);
  const changed = await art.publish(a.tip, { 'next.html': '<h1>Next</h1>' }, 'Content update', { icon: 'book' });
  assert.equal((await info()).icon, 'book');
  await art.publish(changed.tip, { 'next.html': '<h1>Newest</h1>' }, 'Preserve icon');
  assert.equal((await info()).icon, 'book');
  const stale = await update('chart');
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'conflict');
  assert.equal((await info()).icon, 'book');
  assert.equal(await (await fetch(`${base}${path}/files/index.html?at=${a.tip}`, { headers: { Authorization: `Token ${a.read}` } })).text(), Buffer.from(files['index.html'], 'base64').toString());
});

// A stock fossil binary, with its global state kept in the test's directory.
const stockFossil = process.env.FOSSIL ?? 'fossil';
const haveStockFossil = (() => {
  try { execFileSync(stockFossil, ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
function stock(...args) {
  try {
    return { ok: true, out: execFileSync(stockFossil, args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: work, FOSSIL_HOME: work, FOSSIL_USER: 'editor' } }) };
  } catch (e) {
    return { ok: false, out: String(e.stderr) + String(e.stdout) };
  }
}

function fossil(...args) {
  try {
    return { ok: true, out: execFileSync(fsclient, args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: String(e.stderr) + String(e.stdout) };
  }
}

function cli(...args) {
  try {
    const out = execFileSync('node', [join(root, 'scripts/publish-html.mjs'), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HTML_PUBLISHER_URL: base, HTML_PUBLISHER_TOKEN: owner },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout) + String(e.stderr) };
  }
}

before(async () => {
  execFileSync('go', ['build', '-o', fsclient, './cmd/fsclient'], { cwd: join(root, 'fossil'), stdio: 'inherit' });
  await new Promise(r => hook.listen(0, '127.0.0.1', r));
  await startServer();
});

// Its own process group, so stopping it ends wrangler and workerd together.
async function startServer() {
  const wakeVars = ['--var', 'WAKE_SINK_KIND:webhook', '--var', `WAKE_SINK_URL:http://127.0.0.1:${hook.address().port}/wake`, '--var', `WAKE_SINK_SECRET:${wakeSecret}`];
  server = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', join(work, 'state'),
    '--var', `BEARER_TOKEN:${owner}`, ...wakeVars, '--show-interactive-dev-session=false'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`wrangler dev did not start:\n${log}`);
}

/** Restart the Worker on the same state, so every Durable Object starts fresh. */
async function restartServer() {
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/healthz`); } catch { break; }
    await new Promise(r => setTimeout(r, 500));
  }
  await startServer();
}

after(() => {
  hook.close();
  if (server) try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
  rmSync(work, { recursive: true, force: true });
});

test('publish, read, update, history and conflicts', async () => {
  const a = await create({ 'index.html': b64('<h1>one</h1>'), 'app.js': b64('1') });

  const info = await api(`/api/artifacts/${a.id}`, { token: a.read });
  assert.equal(info.status, 200);
  assert.equal(info.json.role, 'read');
  assert.equal(info.json.tip, a.tip);
  assert.equal(info.json.timeline.length, 1);

  const bundle = await api(`/api/artifacts/${a.id}/bundle`, { token: a.read });
  assert.deepEqual(Object.keys(bundle.json.files).sort(), ['app.js', 'index.html']);

  const v2 = await api(`/api/artifacts/${a.id}`, { method: 'PUT', token: a.write, body: { parent: a.tip, message: 'v2', files: { 'index.html': b64('<h1>two</h1>') } } });
  assert.equal(v2.status, 200, v2.text);
  assert.equal(v2.json.parent, a.tip);

  const stale = await api(`/api/artifacts/${a.id}`, { method: 'PUT', token: a.write, body: { parent: a.tip, files: { 'index.html': b64('stale') } } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'conflict');

  const same = await api(`/api/artifacts/${a.id}`, { method: 'PUT', token: a.write, body: { parent: v2.json.tip, files: { 'index.html': b64('<h1>two</h1>') } } });
  assert.equal(same.status, 409);
  assert.equal(same.json.code, 'unchanged');

  const tip = await api(`/api/artifacts/${a.id}/files/index.html`, { token: a.read });
  assert.equal(tip.text, '<h1>two</h1>');
  const old = await api(`/api/artifacts/${a.id}/files/index.html?at=${a.tip.slice(0, 10)}`, { token: a.read });
  assert.equal(old.text, '<h1>one</h1>');
  // Unchanged files carry forward.
  const carried = await api(`/api/artifacts/${a.id}/bundle`, { token: a.read });
  assert.equal(fromB64(carried.json.files['app.js']), '1');

  const hist = await api(`/api/artifacts/${a.id}`, { token: a.read });
  assert.deepEqual(hist.json.timeline.map(c => c.comment), ['v2', 'Publish']);
});

test('X-Wake: an update wakes the sink with ids only, and a failing sink does not fail it', async () => {
  const a = await create({ 'index.html': b64('<h1>one</h1>') });
  const put = (wake, parent) => fetch(`${base}/api/artifacts/${a.id}`, {
    method: 'PUT', headers: { Authorization: `Token ${a.write}`, 'X-Wake': wake },
    body: JSON.stringify({ parent, files: { 'index.html': b64(`<h1>${wake}</h1>`) }, user: 'reviewer' }),
  });
  const before = wakes.length;
  const r = await put('comment', a.tip);
  assert.equal(r.status, 200);
  const { tip } = await r.json();
  for (let i = 0; i < 100 && wakes.length === before; i++) await new Promise(res => setTimeout(res, 50));
  assert.equal(wakes.length, before + 1, 'the sink was called once');
  const w = wakes.at(-1);
  assert.equal(w.headers['x-signature'], `sha256=${createHmac('sha256', wakeSecret).update(w.body).digest('hex')}`);
  assert.equal(w.headers['idempotency-key'], `${a.id}-${tip}`);
  assert.deepEqual(JSON.parse(w.body), { artifact: a.id, checkin: tip, ticket: null, author: 'reviewer', kind: 'comment' });
  assert.ok(!w.body.includes(a.write) && !w.body.includes(a.read) && !w.body.includes('http'));

  // Not a wake kind: the write lands and nobody is woken.
  const quiet = await put('shout', tip);
  assert.equal(quiet.status, 200);
  await new Promise(res => setTimeout(res, 300));
  assert.equal(wakes.length, before + 1);
});

test('multi-file asset updates, history and sync remain usable', async () => {
  const original = b64('<h1>before assets</h1>');
  const a = await create({ 'index.html': original });
  const files = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`assets/image-${i}.bin`, randomBytes(40000).toString('base64')]));
  let parent = a.tip;
  for (let version = 0; version < 6; version++) {
    files['index.html'] = b64(`<h1>assets ${version}</h1>`);
    const update = await api(`/api/artifacts/${a.id}`, { method: 'PUT', token: a.write, body: { parent, message: `Assets ${version}`, files } });
    assert.equal(update.status, 200, update.text);
    parent = update.json.tip;
    const bundle = await api(`/api/artifacts/${a.id}/bundle`, { token: a.read });
    assert.equal(bundle.status, 200, bundle.text);
    assert.deepEqual(bundle.json.files, files);
  }
  assert.equal((await api(`/api/artifacts/${a.id}/files/index.html?at=${a.tip}`, { token: a.read })).text, '<h1>before assets</h1>');
  const clone = join(work, `${a.id}-assets.fossil`);
  const cloned = fossil('clone', a.cloneUrl, clone);
  assert.ok(cloned.ok, cloned.out);
  const pushed = fossil('push', clone, a.cloneUrl, 'index.html', '<h1>after asset sync</h1>', 'Asset sync recovery');
  assert.ok(pushed.ok, pushed.out);
  const bundle = await api(`/api/artifacts/${a.id}/bundle`, { token: a.read });
  assert.equal(bundle.status, 200, bundle.text);
  assert.deepEqual(bundle.json.files, { ...files, 'index.html': b64('<h1>after asset sync</h1>') });
});

test('blobs: upload, commit, signed links, ranges, sharing and cleanup', async () => {
  const bytes = randomBytes(300000);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const put = (path, body, auth = owner) => fetch(base + path, { method: 'PUT', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'image/png' }, body });
  const head = path => fetch(base + path, { method: 'HEAD', headers: { Authorization: `Bearer ${owner}` } });
  const pointer = `artifact-blob 1\nsha256 ${sha}\nsize ${bytes.length}\ntype image/png\n`;

  assert.equal((await fetch(`${base}/api/blobs/${sha}`, { method: 'PUT', body: bytes })).status >= 400, true, 'anonymous upload refused');
  assert.equal((await put(`/api/blobs/${'0'.repeat(64)}`, bytes)).status, 400, 'bytes must match their name');
  assert.equal((await head(`/api/blobs/${'0'.repeat(64)}`)).status, 404, 'a refused upload leaves nothing');
  const missing = await api('/api/artifacts', { method: 'POST', bearer: owner, body: { files: { 'index.html': b64('<img src="p.png">'), 'p.png': b64(pointer) } } });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'missing_blob');
  assert.deepEqual(missing.json.missing, ['p.png']);

  assert.equal((await put(`/api/blobs/${sha}`, bytes)).status, 201);
  assert.equal((await put(`/api/blobs/${sha}`, bytes)).status, 200, 'a second upload of the same bytes is a no-op');
  const a = await create({ 'index.html': b64('<img src="p.png">'), 'p.png': b64(pointer) });

  const bundle = await api(`/api/artifacts/${a.id}/bundle`, { token: a.read });
  const link = bundle.json.blobs['p.png'];
  assert.equal(link.sha256, sha);
  assert.equal(fromB64(bundle.json.files['p.png']), pointer, 'Fossil holds the pointer');
  const got = await fetch(base + link.url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(bytes));
  const part = await fetch(base + link.url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 100-199/${bytes.length}`);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 200)));
  const tampered = link.url.replace(/sig=(.)/, (m, c) => `sig=${c === 'A' ? 'B' : 'A'}`);
  assert.equal((await fetch(base + tampered)).status, 403, 'a changed signature is refused');
  const expired = link.url.replace(/exp=\d+/, 'exp=1');
  assert.equal((await fetch(base + expired)).status, 403, 'an expired link is refused');

  const readUpload = await fetch(`${base}/api/artifacts/${a.id}/blobs/${sha}`, { method: 'PUT', headers: { Authorization: `Token ${a.read}` }, body: bytes });
  assert.equal(readUpload.status, 403, 'the read link cannot upload');

  // The shared client turns binary files into blobs on its own: create, then update with the edit token.
  const b = await createArtifact(base, owner, { title: 'Blob client', files: { 'index.html': '<img src="same.png">', 'same.png': new Uint8Array(bytes) } });
  const art = new Artifact(base, b.id, tokenOf(b.editUrl));
  const other = randomBytes(5000);
  const { tip } = await art.info();
  await art.publish(tip, { 'clip.mp4': new Uint8Array(other) }, 'Add a clip');
  const bb = await art.bundle();
  assert.equal(bb.blobs['same.png'].sha256, sha, 'identical bytes are stored once');
  assert.ok(Buffer.from(await art.blob(bb.blobs['clip.mp4'])).equals(other));

  // Knowing a hash isn't enough: an artifact that never had the bytes can't point at them.
  const otherSha = bb.blobs['clip.mp4'].sha256;
  const c = await create({ 'index.html': b64('<p>c</p>') });
  const cTip = (await api(`/api/artifacts/${c.id}`, { token: c.read })).json.tip;
  const stolen = `artifact-blob 1\nsha256 ${otherSha}\nsize ${other.length}\ntype video/mp4\n`;
  const steal = await api(`/api/artifacts/${c.id}`, { method: 'PUT', token: c.write, body: { parent: cTip, files: { 'v.mp4': b64(stolen) } } });
  assert.equal(steal.status, 400, steal.text);
  assert.equal(steal.json.code, 'missing_blob');
  assert.equal((await fetch(`${base}/api/artifacts/${c.id}/blobs/${otherSha}`, { method: 'HEAD', headers: { Authorization: `Token ${c.write}` } })).status, 404,
    "HEAD doesn't reveal blobs the caller hasn't uploaded");
  const cArt = new Artifact(base, c.id, c.write);
  await cArt.publish(cTip, { 'v.mp4': new Uint8Array(other) }, 'Upload the bytes themselves');
  assert.ok(Buffer.from(await cArt.blob((await cArt.bundle()).blobs['v.mp4'])).equals(other), 'with the bytes, the same blob is shared');
  await cArt.remove();

  // A blob lives as long as some artifact points at it.
  assert.equal((await api(`/api/artifacts/${a.id}`, { method: 'DELETE', token: a.write })).status, 204);
  assert.equal((await fetch(base + link.url)).status, 403, "a deleted artifact's links stop working");
  assert.equal((await head(`/api/blobs/${sha}`)).status, 200, 'still used by the second artifact');
  await art.remove();
  assert.equal((await head(`/api/blobs/${sha}`)).status, 404, 'deleted with its last artifact');

  // The CLI: a binary file goes to R2, and read --out brings back the real bytes.
  const dir = join(work, 'blob-site');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><img src="photo.webp">');
  writeFileSync(join(dir, 'photo.webp'), bytes);
  const pub = cli('publish', '--json', '--no-clipboard', dir);
  assert.equal(pub.code, 0, pub.out);
  const out = JSON.parse(pub.out);
  const back = join(work, 'blob-back');
  assert.equal(cli('read', out.viewerUrl, '--out', back).code, 0);
  assert.ok(readFileSync(join(back, 'photo.webp')).equals(bytes));
  assert.equal(cli('delete', out.editUrl).code, 0);
});

test('access control', async () => {
  const a = await create({ 'index.html': b64('<p>private</p>') });
  assert.equal((await api(`/api/artifacts/${a.id}`)).status, 404, 'anonymous');
  assert.equal((await api(`/api/artifacts/${a.id}`, { token: 'f'.repeat(64) })).status, 404, 'wrong token');
  const ro = await api(`/api/artifacts/${a.id}`, { method: 'PUT', token: a.read, body: { parent: a.tip, files: { 'index.html': b64('x') } } });
  assert.equal(ro.status, 403);
  assert.equal((await api(`/api/artifacts/${a.id}/data/x`, { method: 'PUT', token: a.read, body: 1 })).status, 403);
  assert.equal((await api('/api/artifacts', { method: 'POST', token: a.write, body: { files: { 'index.html': b64('x') } } })).status, 401);
  assert.equal((await api('/api/artifacts', { bearer: 'nope' })).status, 401);
  assert.equal((await api(`/api/artifacts/${a.id}`, { method: 'DELETE', token: a.read })).status, 401);

  const owned = await api(`/api/artifacts/${a.id}`, { bearer: owner });
  assert.equal(owned.json.role, 'write');
  // Editors can share the read link; readers never see any token.
  assert.equal((await api(`/api/artifacts/${a.id}`, { token: a.write })).json.readToken, a.read);
  assert.equal((await api(`/api/artifacts/${a.id}`, { token: a.read })).json.readToken, undefined);
  const list = await api('/api/artifacts', { bearer: owner });
  assert.ok(list.json.artifacts.some(x => x.id === a.id));

  assert.equal((await api(`/api/artifacts/${a.id}`, { method: 'DELETE', token: a.write })).status, 204);
  assert.equal((await api(`/api/artifacts/${a.id}`, { token: a.write })).status, 404);
});

test('slugs', async () => {
  const slug = `s-${randomBytes(4).toString('hex')}`;
  const a = await create({ 'index.html': b64('<p>slug</p>') }, { slug });
  assert.ok(a.viewerUrl.includes(`/v/${slug}#`));
  assert.equal((await api(`/api/artifacts/${slug}`, { token: a.read })).json.id, a.id);
  const taken = await api('/api/artifacts', { method: 'POST', bearer: owner, body: { slug, files: { 'index.html': b64('x') } } });
  assert.equal(taken.status, 409);
});

test('page data', async () => {
  const a = await create({ 'index.html': b64('<p>data</p>') });
  assert.equal((await api(`/api/artifacts/${a.id}/data/count`, { token: a.read })).json, null);
  assert.equal((await api(`/api/artifacts/${a.id}/data/count`, { method: 'PUT', token: a.write, body: { n: 3 } })).status, 200);
  assert.deepEqual((await api(`/api/artifacts/${a.id}/data/count`, { token: a.read })).json, { n: 3 });
  assert.deepEqual((await api(`/api/artifacts/${a.id}/data`, { token: a.read })).json, ['count']);
  // Data stays out of the history.
  assert.equal((await api(`/api/artifacts/${a.id}`, { token: a.read })).json.timeline.length, 1);
});

test('files too large for one row are refused', async () => {
  const a = await create({ 'index.html': b64('<p>size</p>') });
  const noise = randomBytes(2_500_000).toString('base64');
  const r = await api(`/api/artifacts/${a.id}`, { method: 'PUT', token: a.write, body: { parent: a.tip, files: { 'big.bin': noise } } });
  assert.equal(r.status, 413);
  assert.equal(r.json.code, 'too_large');
  // Compressible content of the same size is fine.
  const zeros = Buffer.alloc(2_500_000).toString('base64');
  const ok = await api(`/api/artifacts/${a.id}`, { method: 'PUT', token: a.write, body: { parent: a.tip, files: { 'zeros.bin': zeros } } });
  assert.equal(ok.status, 200, ok.text);
});

test('fossil clone and push', async () => {
  const a = await create({ 'index.html': b64('<h1>clone me</h1>') });
  const clone = join(work, `${a.id}.fossil`);

  assert.ok(fossil('clone', a.cloneUrl, clone).ok, 'editor clone');
  const pushed = fossil('push', clone, a.cloneUrl, 'index.html', '<h1>pushed</h1>', 'pushed from a clone');
  assert.ok(pushed.ok, pushed.out);
  assert.equal((await api(`/api/artifacts/${a.id}/files/index.html`, { token: a.read })).text, '<h1>pushed</h1>');
  assert.equal((await api(`/api/artifacts/${a.id}`, { token: a.read })).json.timeline[0].comment, 'pushed from a clone');

  const anon = fossil('clone', `${base}/r/${a.id}`, join(work, `${a.id}-anon.fossil`));
  assert.ok(!anon.ok && /not authorized/.test(anon.out), anon.out);

  const viewerUrl = a.cloneUrl.replace(/editor:[0-9a-f]+@/, `viewer:${a.read}@`);
  const vclone = join(work, `${a.id}-viewer.fossil`);
  assert.ok(fossil('clone', viewerUrl, vclone).ok, 'viewer clone');
  const vpush = fossil('push', vclone, viewerUrl, 'index.html', 'nope', 'viewer push');
  assert.ok(!vpush.ok && /not authorized to push/.test(vpush.out), vpush.out);

  const big = join(work, 'big.bin');
  writeFileSync(big, randomBytes(3_000_000));
  const fresh = join(work, `${a.id}-big.fossil`);
  assert.ok(fossil('clone', a.cloneUrl, fresh).ok);
  const tooBig = fossil('push', fresh, a.cloneUrl, 'big.bin', `@${big}`, 'too big');
  assert.ok(!tooBig.ok && /too large to store/.test(tooBig.out), tooBig.out);
  // A check-in can arrive before its file in a separate sync request.
  assert.equal((await api(`/api/artifacts/${a.id}/files/big.bin`, { token: a.read })).status, 404);
  const recovery = join(work, `${a.id}-recovery.fossil`);
  assert.ok(fossil('clone', a.cloneUrl, recovery).ok, 'repository still clones after rejected push');
  assert.equal((await api(`/api/artifacts/${a.id}/files/index.html`, { token: a.read })).text, '<h1>pushed</h1>', 'previously stored content remains readable');
});

test('comment link: tickets through the API, a stock fossil clone and a terminal push', { skip: !haveStockFossil && !process.env.CI && 'stock fossil is not installed' }, async () => {
  const a = await create({ 'index.html': b64('<h1 id="intro">comment on me</h1>') });
  assert.match(a.commentUrl, new RegExp(`/v/${a.id}#[0-9a-f]{64}$`));
  assert.ok(![a.read, a.write].includes(a.comment), 'a token of its own');
  const tickets = (token = a.read) => api(`/api/artifacts/${a.id}/tickets`, { token });
  const post = (token, body) => api(`/api/artifacts/${a.id}/tickets`, { method: 'POST', token, body });

  // The comment link opens the page as a commenter: no publish or manage rights, no other link.
  const seen = await api(`/api/artifacts/${a.id}`, { token: a.comment });
  assert.equal(seen.status, 200, seen.text);
  assert.equal(seen.json.role, 'comment');
  assert.equal(seen.json.canManage, false);
  assert.equal(seen.json.readToken, undefined);
  assert.equal(seen.json.commentToken, undefined);
  assert.equal((await api(`/api/artifacts/${a.id}`, { token: a.read })).json.commentToken, undefined, 'readers never see it');
  assert.equal((await api(`/api/artifacts/${a.id}`, { token: a.write })).json.commentToken, a.comment, 'editors can share it');

  // What the viewer shows each link, from the same replies.
  const shows = async token => controls((await api(`/api/artifacts/${a.id}`, { token })).json);
  assert.deepEqual(await shows(a.comment), { threads: true, commentBox: true, edit: false, publish: false, commentLink: false });
  assert.deepEqual(await shows(a.read), { threads: true, commentBox: false, edit: false, publish: false, commentLink: false });
  assert.deepEqual(await shows(a.write), { threads: true, commentBox: true, edit: true, publish: false, commentLink: true });

  const opened = await post(a.comment, { text: 'The heading reads oddly.\nCan it be shorter?', anchor: 'intro', author: 'mallory', user: 'mallory' });
  assert.equal(opened.status, 400, 'the body cannot name the author');
  const first = await post(a.comment, { text: 'The heading reads oddly.\nCan it be shorter?', anchor: 'intro' });
  assert.equal(first.status, 201, first.text);
  assert.match(first.json.ticketUuid, /^[0-9a-f]{40}$/);
  assert.match(first.json.artifact, /^[0-9a-f]{40,64}$/);
  const reply = await post(a.write, { ticketUuid: first.json.ticketUuid, text: 'Shortened in the next version.' });
  assert.equal(reply.status, 200, reply.text);
  const resolved = await post(a.comment, { ticketUuid: first.json.ticketUuid, status: 'Closed' });
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal((await post(a.read, { text: 'readers cannot comment' })).status, 403, 'the read link never writes');
  assert.equal((await tickets()).json.tickets.length, 1, 'a refused write leaves nothing');

  const listed = await tickets();
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.truncated, false);
  assert.equal(listed.json.limit, 100, 'the default cap');
  const [t] = listed.json.tickets;
  assert.equal(t.uuid, first.json.ticketUuid);
  assert.equal(t.status, 'Closed');
  assert.equal(t.fields.title, 'The heading reads oddly.');
  assert.equal(t.fields.comment, 'The heading reads oddly.\nCan it be shorter?');
  assert.equal(t.fields.subsystem, 'intro', 'the anchor');
  assert.equal(t.fields.type, 'Comment');
  assert.deepEqual(t.changes.map(c => c.user), ['comment-link', 'edit-link', 'comment-link']);
  assert.equal(t.changes[1].comment, 'Shortened in the next version.');
  assert.equal(t.changes[2].fields.status, 'Closed');
  assert.equal((await tickets(a.comment)).status, 200, 'the comment link reads threads');
  assert.deepEqual(thread(t), {
    uuid: t.uuid, title: 'The heading reads oddly.', status: 'Closed', resolved: true, anchor: 'intro', checkins: [],
    messages: [
      { user: 'comment-link', time: t.changes[0].time, text: 'The heading reads oddly.\nCan it be shorter?', status: '' },
      { user: 'edit-link', time: t.changes[1].time, text: 'Shortened in the next version.', status: '' },
      { user: 'comment-link', time: t.changes[2].time, text: '', status: 'Closed' },
    ],
  });

  // Bounded, validated input.
  for (const [body, why] of [
    [{}, 'no text'], [{ text: '   ' }, 'blank text'], [{ text: 'x'.repeat(8001) }, 'text too long'],
    [{ text: 'x', anchor: 'a'.repeat(501) }, 'anchor too long'], [{ text: 'x', status: 'Closed' }, 'status on a new thread'],
    [{ ticketUuid: first.json.ticketUuid, status: 'Fixed' }, 'unknown status'], [{ ticketUuid: first.json.ticketUuid }, 'nothing to change'],
    [{ ticketUuid: 'abc', text: 'x' }, 'not a ticket id'], [{ text: 'x', fields: { title: 'y' } }, 'unknown key'], [{ text: 7 }, 'text not a string'],
  ]) assert.equal((await post(a.comment, body)).status, 400, why);
  assert.equal((await post(a.comment, { ticketUuid: 'f'.repeat(40), text: 'x' })).status, 404, 'unknown ticket');

  // The ticket is in the repository: a stock fossil clone has it.
  const clone = join(work, `${a.id}-tickets.fossil`);
  const cloned = stock('clone', a.cloneUrl, clone);
  assert.ok(cloned.ok, cloned.out);
  const history = stock('ticket', 'history', first.json.ticketUuid, '-R', clone);
  assert.ok(history.ok, history.out);
  assert.match(history.out, /Shortened in the next version\./);
  assert.match(stock('sql', '-R', clone, "SELECT status||' '||subsystem FROM ticket").out, /Closed intro/);

  // A ticket made in a terminal and pushed appears with no Worker step.
  const added = stock('ticket', 'add', 'title', 'From the terminal', 'status', 'Open', 'type', 'Comment', '-R', clone);
  assert.ok(added.ok, added.out);
  const pushed = stock('push', a.cloneUrl, '-R', clone);
  assert.ok(pushed.ok, pushed.out);
  const after = (await tickets()).json.tickets;
  const terminal = after.find(x => x.fields.title === 'From the terminal');
  assert.ok(terminal, JSON.stringify(after));
  assert.equal(terminal.changes[0].user, 'editor');

  // One capped read: the newest-changed threads, and whether there are more.
  const capped = await api(`/api/artifacts/${a.id}/tickets?limit=1`, { token: a.read });
  assert.equal(capped.status, 200, capped.text);
  assert.equal(capped.json.tickets.length, 1);
  assert.equal(capped.json.truncated, true);
  assert.equal(capped.json.limit, 1);
  assert.equal(capped.json.tickets[0].fields.title, 'From the terminal', 'newest first');
  for (const limit of ['0', '201', 'x', '1.5', '-1']) {
    assert.equal((await api(`/api/artifacts/${a.id}/tickets?limit=${limit}`, { token: a.read })).status, 400, `limit=${limit}`);
  }
  assert.equal((await api(`/api/artifacts/${a.id}/tickets?limit=200`, { token: a.read })).json.tickets.length, 2);

  // Tickets that arrived since a check-in.
  const since = await api(`/api/artifacts/${a.id}/timeline?since=${a.tip}&type=t`, { token: a.read });
  assert.equal(since.status, 200, since.text);
  assert.equal(since.json.timeline.length, 4);
  assert.ok(since.json.timeline.every(e => e.type === 't'));
  assert.equal(since.json.timeline[0].user, 'editor', 'newest first');
  assert.equal((await api(`/api/artifacts/${a.id}/timeline`, { token: a.read })).status, 400, 'since is required');
  assert.equal((await api(`/api/artifacts/${a.id}/timeline?since=${a.tip}&type=zz`, { token: a.read })).status, 400);

  // Authors come from the credential: the owner's bearer token, or an account's name.
  const byOwner = await api(`/api/artifacts/${a.id}/tickets`, { method: 'POST', bearer: owner, body: { text: 'From the owner' } });
  assert.equal(byOwner.status, 201, byOwner.text);
  assert.equal((await tickets()).json.tickets.find(x => x.uuid === byOwner.json.ticketUuid).changes[0].user, 'owner');
});

// The flag is state about the artifact, kept where every responder can set it:
// an unversioned file, so it never makes a check-in and needs no republish.
test('attached responder: attached.json set and cleared by a stock fossil, read by every link', { skip: !haveStockFossil && !process.env.CI && 'stock fossil is not installed' }, async () => {
  const a = await create({ 'index.html': b64('<h1>who answers</h1>') });
  const get = (token = a.read) => api(`/api/artifacts/${a.id}`, { token });
  const clone = join(work, `${a.id}-attached.fossil`);
  assert.ok(stock('clone', a.cloneUrl, clone).ok);
  // The newest modification time wins a unversioned conflict, so each set is a second later than the last.
  let mtime = Math.floor(Date.now() / 1000);
  const stamp = () => new Date(++mtime * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const set = (content, name = 'attached.json') => {
    const src = join(work, `${a.id}-${name}`);
    writeFileSync(src, content);
    const added = stock('uv', 'add', src, '--as', name, '--mtime', stamp(), '-R', clone);
    assert.ok(added.ok, added.out);
    const synced = stock('uv', 'sync', a.cloneUrl, '-R', clone);
    assert.ok(synced.ok, synced.out);
  };

  for (const token of [a.read, a.comment, a.write]) assert.equal((await get(token)).json.attached, null, 'nothing attached yet');
  const tip = (await get()).json.tip;

  const since = '2026-10-26T12:00:00Z';
  set(JSON.stringify({ responder: 'local session', since, contact: 'dan@example.com', secret: 'dropped' }));
  for (const token of [a.read, a.comment, a.write]) {
    const r = await get(token);
    assert.deepEqual(r.json.attached, { responder: 'local session', since, contact: 'dan@example.com' }, 'public state: every link sees it');
  }
  assert.equal((await get()).json.tip, tip, 'no check-in, no republish');
  assert.equal((await get()).json.timeline.length, 1);

  // Only a write-capable user can set it; a read link cannot push it.
  const readUrl = a.cloneUrl.replace(/editor:[0-9a-f]+@/, `viewer:${a.read}@`);
  const vclone = join(work, `${a.id}-attached-viewer.fossil`);
  assert.ok(stock('clone', readUrl, vclone).ok);
  writeFileSync(join(work, 'forged.json'), JSON.stringify({ responder: 'forged' }));
  stock('uv', 'add', join(work, 'forged.json'), '--as', 'attached.json', '-R', vclone);
  stock('uv', 'sync', readUrl, '-R', vclone);
  assert.equal((await get()).json.attached.responder, 'local session', 'a read link cannot change it');

  // Untrusted content: unusable files read as absent, markup stays text.
  let round = 0;
  for (const bad of ['not json', '[]', '"x"', '{"responder":7}', '{"responder":""}', JSON.stringify({ responder: 'x'.repeat(101) }), ' '.repeat(5000) + '{"responder":"late"}']) {
    const name = `valid ${++round}`;
    set(JSON.stringify({ responder: name }));
    assert.equal((await get()).json.attached?.responder, name, bad.slice(0, 20));
    set(bad);
    assert.equal((await get()).json.attached, null, bad.slice(0, 30));
  }
  set(JSON.stringify({ responder: '<img src=x onerror=alert(1)>', since: 'soon', contact: 'c'.repeat(500) }));
  assert.deepEqual((await get()).json.attached, { responder: '<img src=x onerror=alert(1)>', since: null, contact: null });

  // Removing it clears the flag on the next load.
  assert.ok(stock('uv', 'rm', 'attached.json', '--mtime', stamp(), '-R', clone).ok);
  assert.ok(stock('uv', 'sync', a.cloneUrl, '-R', clone).ok);
  for (const token of [a.read, a.comment, a.write]) assert.equal((await get(token)).json.attached, null, 'cleared');

  // The viewer has a place for the banner above the thread list.
  const html = await (await fetch(`${base}/v/${a.id}`)).text();
  assert.match(html, /id="responderNote"/);
});

// The wakes for artifact `id`, once `n` have arrived and a quiet spell shows no more follow.
async function wakesFor(id, n) {
  const mine = () => wakes.filter(w => JSON.parse(w.body).artifact === id);
  for (let i = 0; i < 200 && mine().length < n; i++) await new Promise(res => setTimeout(res, 50));
  await new Promise(res => setTimeout(res, 400));
  return mine().map(w => {
    assert.equal(w.headers['x-signature'], `sha256=${createHmac('sha256', wakeSecret).update(w.body).digest('hex')}`, 'signed');
    return { key: w.headers['idempotency-key'], ...JSON.parse(w.body) };
  });
}

test('wake: API comments, replies, resolves and reopens wake the sink once each', async () => {
  const a = await create({ 'index.html': b64('<h1 id="intro">wake me</h1>') });
  const post = (token, body) => api(`/api/artifacts/${a.id}/tickets`, { method: 'POST', token, body });
  const event = (kind, change, ticket, author) => ({ key: `${a.id}-${change}`, artifact: a.id, checkin: change, ticket, author, kind });

  const first = await post(a.comment, { text: 'Too loud?', anchor: 'intro' });
  assert.equal(first.status, 201, first.text);
  assert.deepEqual(await wakesFor(a.id, 1), [event('comment', first.json.artifact, first.json.ticketUuid, 'comment-link')]);

  const reply = await post(a.write, { ticketUuid: first.json.ticketUuid, text: 'Quieter now.' });
  assert.equal(reply.status, 200, reply.text);
  const resolve = await post(a.comment, { ticketUuid: first.json.ticketUuid, status: 'Closed' });
  assert.equal(resolve.status, 200, resolve.text);
  const reopen = await post(a.comment, { ticketUuid: first.json.ticketUuid, status: 'Open' });
  assert.equal(reopen.status, 200, reopen.text);
  const byOwner = await api(`/api/artifacts/${a.id}/tickets`, { method: 'POST', bearer: owner, body: { ticketUuid: first.json.ticketUuid, text: 'Noted.' } });
  assert.equal(byOwner.status, 200, byOwner.text);
  // Refused writes wake nobody.
  assert.equal((await post(a.read, { text: 'readers cannot comment' })).status, 403);
  assert.equal((await post(a.comment, { text: '' })).status, 400);
  assert.equal((await post(a.comment, { ticketUuid: 'f'.repeat(40), text: 'x' })).status, 404);

  assert.deepEqual(await wakesFor(a.id, 5), [
    event('comment', first.json.artifact, first.json.ticketUuid, 'comment-link'),
    event('reply', reply.json.artifact, first.json.ticketUuid, 'edit-link'),
    event('resolve', resolve.json.artifact, first.json.ticketUuid, 'comment-link'),
    event('reply', reopen.json.artifact, first.json.ticketUuid, 'comment-link'),
    event('reply', byOwner.json.artifact, first.json.ticketUuid, 'owner'),
  ]);
});

test('wake: a pushed ticket wakes the sink once; clones, pulls and pushes of nothing new wake nobody', { skip: !haveStockFossil && !process.env.CI && 'stock fossil is not installed' }, async () => {
  const a = await create({ 'index.html': b64('<p>terminal</p>') });
  const first = await api(`/api/artifacts/${a.id}/tickets`, { method: 'POST', token: a.comment, body: { text: 'From the viewer' } });
  assert.equal(first.status, 201, first.text);
  assert.equal((await wakesFor(a.id, 1)).length, 1);
  const changes = async uuid => (await api(`/api/artifacts/${a.id}/tickets`, { token: a.read })).json.tickets.find(t => t.uuid === uuid).changes;

  const clone = join(work, `${a.id}-wake.fossil`);
  const cloned = stock('clone', a.cloneUrl, clone);
  assert.ok(cloned.ok, cloned.out);
  for (const args of [['pull', a.cloneUrl], ['push', a.cloneUrl], ['sync', a.cloneUrl]]) {
    const r = stock(...args, '-R', clone);
    assert.ok(r.ok, r.out);
  }
  assert.equal((await wakesFor(a.id, 1)).length, 1, 'the viewer comment going back and forth is not news');

  const added = stock('ticket', 'add', 'title', 'From the terminal', 'status', 'Open', 'type', 'Comment', '-R', clone);
  assert.ok(added.ok, added.out);
  const uuid = /([0-9a-f]{40})/.exec(added.out)?.[1];
  assert.ok(uuid, added.out);
  const pushed = stock('push', a.cloneUrl, '-R', clone);
  assert.ok(pushed.ok, pushed.out);
  const [created] = await changes(uuid);
  const got = await wakesFor(a.id, 2);
  assert.equal(got.length, 2, JSON.stringify(got));
  assert.deepEqual(got[1], { key: `${a.id}-${created.artifact}`, artifact: a.id, checkin: created.artifact, ticket: uuid, author: 'editor', kind: 'comment' });

  // From the terminal: a reply on the viewer's thread and a resolve, in one push.
  assert.ok(stock('ticket', 'change', first.json.ticketUuid, '+comment', 'Seen it.', '-R', clone).ok);
  assert.ok(stock('ticket', 'change', uuid, 'status', 'Closed', '-R', clone).ok);
  assert.ok(stock('push', a.cloneUrl, '-R', clone).ok);
  const replied = (await changes(first.json.ticketUuid)).at(-1), closed = (await changes(uuid)).at(-1);
  const both = (await wakesFor(a.id, 4)).slice(2);
  assert.deepEqual(both.sort((x, y) => x.kind.localeCompare(y.kind)), [
    { key: `${a.id}-${replied.artifact}`, artifact: a.id, checkin: replied.artifact, ticket: first.json.ticketUuid, author: 'editor', kind: 'reply' },
    { key: `${a.id}-${closed.artifact}`, artifact: a.id, checkin: closed.artifact, ticket: uuid, author: 'editor', kind: 'resolve' },
  ]);

  // Another clone takes everything: nothing new reached the Worker.
  const other = join(work, `${a.id}-wake-2.fossil`);
  assert.ok(stock('clone', a.cloneUrl, other).ok);
  assert.ok(stock('pull', a.cloneUrl, '-R', clone).ok);
  assert.equal((await wakesFor(a.id, 4)).length, 4);
});

test('wake: a push of N tickets wakes N, and at most 40', { skip: !haveStockFossil && !process.env.CI && 'stock fossil is not installed' }, async () => {
  const a = await create({ 'index.html': b64('<p>many</p>') });
  const clone = join(work, `${a.id}-many.fossil`);
  assert.ok(stock('clone', a.cloneUrl, clone).ok);
  const add = n => {
    for (let i = 0; i < n; i++) assert.ok(stock('ticket', 'add', 'title', `t${i}`, 'status', 'Open', 'type', 'Comment', '-R', clone).ok);
    const r = stock('push', a.cloneUrl, '-R', clone);
    assert.ok(r.ok, r.out);
  };
  add(3);
  const three = await wakesFor(a.id, 3);
  assert.equal(three.length, 3);
  assert.ok(three.every(w => w.kind === 'comment' && w.author === 'editor'));
  assert.equal(new Set(three.map(w => w.ticket)).size, 3);
  add(45);
  const all = await wakesFor(a.id, 43);
  assert.equal(all.length, 43, 'the push of 45 woke 40');
  assert.equal(new Set(all.map(w => w.key)).size, 43);
});

if (process.env.VIEWER_BROWSER_QA === '1') test('real browser: comment pins, thread panel, resolve and the read link', async () => {
  const { viewerQA, XSS } = await import('./viewer-browser.mjs');
  const a = await create({ 'index.html': b64('<!doctype html><h1 id="intro">Heading text</h1><p>The quick brown <em>fox</em> jumps over the lazy dog.</p>') }, { title: 'A long artifact title for a compact toolbar on even the narrowest phone' });
  const post = async (token, body) => {
    const r = await api(`/api/artifacts/${a.id}/tickets`, { method: 'POST', token, body });
    assert.ok(r.status === 200 || r.status === 201, r.text);
    return r.json.ticketUuid;
  };
  const heading = await post(a.comment, { text: 'About the heading', anchor: 'intro' });
  await post(a.write, { ticketUuid: heading, text: `Shortened in @${a.tip.slice(0, 12)}.` });
  await post(a.comment, { text: 'About the fox', anchor: 'brown fox jumps' });
  await post(a.comment, { text: 'Where did it go', anchor: 'a sentence that is gone' });
  await post(a.comment, { text: 'No anchor at all' });
  await post(a.comment, { text: XSS.text, anchor: XSS.anchor });
  // An author is whatever a clone's user was: push one named like markup.
  let authorXss = false;
  if (haveStockFossil) {
    const clone = join(work, `${a.id}-qa.fossil`);
    assert.ok(stock('clone', a.cloneUrl, clone).ok);
    assert.ok(stock('user', 'new', XSS.author, '', 'x', '-R', clone).ok);
    const added = stock('ticket', 'add', 'title', 'From a clone', 'status', 'Open', 'type', 'Comment', '-R', clone, '-U', XSS.author);
    assert.ok(added.ok, added.out);
    assert.ok(stock('push', a.cloneUrl, '-R', clone).ok);
    authorXss = (await api(`/api/artifacts/${a.id}/tickets`, { token: a.read })).json.tickets.some(t => t.changes[0].user === XSS.author);
    assert.ok(authorXss, 'the pushed ticket carries the markup-like author');
  }
  let stamp = Math.floor(Date.now() / 1000);
  const attach = haveStockFossil ? content => {
    const clone = join(work, `${a.id}-qa.fossil`);
    const when = () => new Date(++stamp * 1000).toISOString().slice(0, 19).replace('T', ' ');
    if (content === null) assert.ok(stock('uv', 'rm', 'attached.json', '--mtime', when(), '-R', clone).ok);
    else {
      writeFileSync(join(work, `${a.id}-qa-attached.json`), content);
      assert.ok(stock('uv', 'add', join(work, `${a.id}-qa-attached.json`), '--as', 'attached.json', '--mtime', when(), '-R', clone).ok);
    }
    const synced = stock('uv', 'sync', a.cloneUrl, '-R', clone);
    assert.ok(synced.ok, synced.out);
  } : undefined;
  await viewerQA({ base, a: { ...a, authorXss }, api, output: join(root, '.wrangler/viewer-browser-qa'), attach });
});

test('comment link: commenting is all it can do, and delete revokes it', async () => {
  const a = await create({ 'index.html': b64('<p>only comments</p>') });
  const commit = await api(`/api/artifacts/${a.id}`, { method: 'PUT', token: a.comment, body: { parent: a.tip, files: { 'index.html': b64('x') } } });
  assert.equal(commit.status, 403, commit.text);
  assert.equal((await api(`/api/artifacts/${a.id}/data/x`, { method: 'PUT', token: a.comment, body: 1 })).status, 403, 'no page data writes');
  assert.equal((await api(`/api/artifacts/${a.id}`, { method: 'DELETE', token: a.comment })).status, 401, 'no delete');
  const upload = await fetch(`${base}/api/artifacts/${a.id}/blobs/${'0'.repeat(64)}`, { method: 'PUT', headers: { Authorization: `Token ${a.comment}` }, body: 'x' });
  assert.equal(upload.status, 403, 'no uploads');
  assert.equal((await api(`/api/artifacts/${a.id}/publications`, { method: 'POST', token: a.comment, body: { at: a.tip, documents: {} } })).status, 401, 'no public snapshots');
  for (const login of ['editor', 'viewer']) {
    const url = a.cloneUrl.replace(/editor:[0-9a-f]+@/, `${login}:${a.comment}@`);
    const r = fossil('clone', url, join(work, `${a.id}-${login}-comment.fossil`));
    assert.ok(!r.ok && /not authorized|login failed/.test(r.out), `no sync as ${login}: ${r.out}`);
  }
  assert.equal((await api(`/api/artifacts/${a.id}`, { token: a.comment })).json.tip, a.tip, 'nothing changed');

  assert.equal((await api(`/api/artifacts/${a.id}`, { method: 'DELETE', token: a.write })).status, 204);
  assert.equal((await api(`/api/artifacts/${a.id}`, { token: a.comment })).status, 404);
  assert.equal((await api(`/api/artifacts/${a.id}/tickets`, { method: 'POST', token: a.comment, body: { text: 'still here?' } })).status, 404);
});

// Old-state fixtures edit only this suite's throwaway Durable Object storage:
// the database whose _artifact row is artifact `id`.
function repoSQL(id, sql) {
  const state = join(work, 'state');
  for (const file of readdirSync(state, { recursive: true })) {
    if (!String(file).endsWith('.sqlite')) continue;
    // Workerd owns these live fixture databases; wait boundedly for its short write locks.
    const db = new DatabaseSync(join(state, String(file)), { timeout: 1000 });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = '_artifact'").get() && db.prepare('SELECT 1 FROM _artifact WHERE id = ?').get(id)) {
        return db.prepare(sql).all();
      }
    } finally { db.close(); }
  }
  throw new Error(`no repository database for ${id}`);
}

test('comment link: an artifact from before comment links gets one from its editor, once', async () => {
  const a = await create({ 'index.html': b64('<p>old</p>') });
  const columns = () => repoSQL(a.id, "SELECT name FROM pragma_table_info('_artifact')").map(c => c.name);
  const stored = () => ({ ...repoSQL(a.id, 'SELECT comment_hash, comment_token FROM _artifact')[0] });
  // The shape an artifact stored before comment links has, in a fresh object.
  repoSQL(a.id, 'ALTER TABLE _artifact DROP COLUMN comment_hash');
  repoSQL(a.id, 'ALTER TABLE _artifact DROP COLUMN comment_token');
  assert.ok(!columns().includes('comment_hash'));
  await restartServer();
  const info = token => api(`/api/artifacts/${a.id}`, { token });

  const read = await info(a.read);
  assert.equal(read.status, 200, read.text);
  assert.equal(read.json.commentToken, undefined);
  assert.ok(columns().includes('comment_hash') && columns().includes('comment_token'), 'ensureTable adds the columns');
  assert.deepEqual(stored(), { comment_hash: '', comment_token: '' }, 'a read link mints nothing');

  const first = (await info(a.write)).json.commentToken;
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, a.comment, 'the token from before the columns were dropped is gone');
  assert.deepEqual(stored(), { comment_hash: createHash('sha256').update(first).digest('hex'), comment_token: first });
  assert.equal((await info(a.write)).json.commentToken, first, 'a second open keeps it');
  assert.equal((await info(first)).json.role, 'comment');
  assert.equal((await info(a.comment)).status, 404);

  const page = join(work, 'old-artifact.html');
  writeFileSync(page, '<!doctype html><p>updated</p>');
  const up = cli('update', '--json', '--no-clipboard', a.editUrl, page);
  assert.equal(up.code, 0, up.out);
  assert.equal(JSON.parse(up.out).commentUrl, `${a.editUrl.split('#')[0]}#${first}`, 'update returns the same one');
  assert.equal(stored().comment_token, first);

  // The check runs once per object: a column dropped under a live one is not looked for again.
  repoSQL(a.id, 'ALTER TABLE _artifact DROP COLUMN comment_hash');
  repoSQL(a.id, 'ALTER TABLE _artifact DROP COLUMN comment_token');
  assert.equal((await info(a.read)).status, 200);
  assert.ok(!columns().includes('comment_hash'), 'no second PRAGMA table_info check');
});

test('viewer shell', async () => {
  const a = await create({ 'index.html': b64('<p>view</p>') });
  const r = await fetch(`${base}/v/${a.id}`);
  assert.equal(r.status, 200);
  const csp = r.headers.get('Content-Security-Policy');
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce, csp);
  assert.ok((await r.text()).includes(`content="${nonce}"`));
  assert.match(csp, /script-src [^;]*'wasm-unsafe-eval'/, 'pages may run their own WebAssembly');
  assert.match(csp, /connect-src 'self'/, 'but still connect nowhere else');
});

test('CLI', async () => {
  const dir = join(work, 'site');
  mkdirSync(join(dir, 'img'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><link rel="stylesheet" href="style.css"><h1>v1</h1>');
  writeFileSync(join(dir, 'style.css'), 'h1{color:red}');
  writeFileSync(join(dir, 'img', 'dot.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

  const pub = cli('publish', '--json', '--no-clipboard', '--title', 'CLI', dir);
  assert.equal(pub.code, 0, pub.out);
  const out = JSON.parse(pub.out);
  assert.ok(out.viewerUrl && out.editUrl && out.cloneUrl && out.commentUrl);
  assert.equal(out.commentUrl.split('#')[0], out.viewerUrl.split('#')[0]);

  writeFileSync(join(dir, 'index.html'), '<!doctype html><link rel="stylesheet" href="style.css"><h1>v2</h1>');
  const up = cli('update', '--json', '--no-clipboard', '--message', 'second', out.editUrl, dir);
  assert.equal(up.code, 0, up.out);
  // The link printed after an update opens the artifact: it carries the read token.
  const upOut = JSON.parse(up.out);
  assert.equal(upOut.viewerUrl, out.viewerUrl);
  assert.equal(upOut.commentUrl, out.commentUrl);
  assert.equal(upOut.linkVerified, true);
  assert.equal(out.linkVerified, true);
  assert.equal(cli('update', '--no-clipboard', out.editUrl, dir).code, 1, 'nothing changed');
  assert.notEqual(cli('update', '--no-clipboard', out.viewerUrl, dir).code, 0, 'read link cannot update');

  const hist = JSON.parse(cli('history', '--json', out.viewerUrl).out);
  assert.deepEqual(hist.map(c => c.comment), ['second', 'Publish site']);
  assert.match(cli('read', out.viewerUrl).out, /<h1>v2<\/h1>/);
  assert.match(cli('read', `${out.viewerUrl}@${hist[1].uuid.slice(0, 12)}`).out, /<h1>v1<\/h1>/);
  assert.match(cli('list').out, /CLI/);
  assert.equal(cli('delete', out.editUrl).code, 0);

  // Human output lists the comment link under the read link.
  const human = cli('publish', '--no-clipboard', dir);
  assert.equal(human.code, 0, human.out);
  const lines = human.out.split('\n');
  const published = lines.findIndex(l => l.startsWith('Published: '));
  const comment = lines.findIndex(l => /^\s+Comment link: .*\/v\/.*#[0-9a-f]{64}$/.test(l));
  assert.ok(published >= 0 && comment > published, human.out);
  assert.equal(cli('delete', /Edit link \(keep private\): (\S+)/.exec(human.out)[1]).code, 0);
});

test('CLI --notes ships NOTES.md with the page (tracked in #22)', async () => {
  const dir = join(work, 'notes-site');
  mkdirSync(dir, { recursive: true });
  const page = join(dir, 'page.html');
  const notes = join(dir, 'context.txt');
  writeFileSync(page, '<!doctype html><h1>n1</h1>');
  writeFileSync(notes, '# Notes\nKeep the header.\n');

  const pub = cli('publish', '--json', '--no-clipboard', '--notes', notes, page);
  assert.equal(pub.code, 0, pub.out);
  const out = JSON.parse(pub.out);
  const a = { read: tokenOf(out.viewerUrl), id: out.id };

  // Stored as NOTES.md next to index.html, in the one publish check-in.
  const bundle = await api(`/api/artifacts/${a.id}/bundle`, { token: a.read });
  assert.deepEqual(Object.keys(bundle.json.files).sort(), ['NOTES.md', 'index.html']);
  assert.equal(fromB64(bundle.json.files['NOTES.md']), '# Notes\nKeep the header.\n');
  assert.equal(JSON.parse(cli('history', '--json', out.viewerUrl).out).length, 1);

  // fossil clone shows it at the tip.
  const clone = join(work, `${a.id}-notes.fossil`);
  assert.ok(fossil('clone', out.cloneUrl, clone).ok, 'clone');

  // The viewer's entry page is still the HTML.
  assert.match(cli('read', out.viewerUrl).out, /<h1>n1<\/h1>/);
  // read writes it back out with the rest.
  const back = join(work, 'notes-back');
  assert.equal(cli('read', out.viewerUrl, '--out', back).code, 0);
  assert.equal(readFileSync(join(back, 'NOTES.md'), 'utf8'), '# Notes\nKeep the header.\n');

  // Update without --notes leaves it untouched; with --notes replaces it.
  writeFileSync(page, '<!doctype html><h1>n2</h1>');
  assert.equal(cli('update', '--json', '--no-clipboard', out.editUrl, page).code, 0);
  let b = await api(`/api/artifacts/${a.id}/bundle`, { token: a.read });
  assert.equal(fromB64(b.json.files['NOTES.md']), '# Notes\nKeep the header.\n');
  assert.equal(fromB64(b.json.files['index.html']), '<!doctype html><h1>n2</h1>');
  writeFileSync(notes, 'Decided: dark mode.\n');
  assert.equal(cli('update', '--json', '--no-clipboard', '--notes', notes, out.editUrl, page).code, 0);
  b = await api(`/api/artifacts/${a.id}/bundle`, { token: a.read });
  assert.equal(fromB64(b.json.files['NOTES.md']), 'Decided: dark mode.\n');

  assert.notEqual(cli('publish', '--no-clipboard', '--notes', join(dir, 'missing.md'), page).code, 0, 'missing notes file');
  assert.notEqual(cli('publish', '--no-clipboard', '--notes', dir, page).code, 0, 'notes is a directory');
  assert.equal(cli('delete', out.editUrl).code, 0);
});

test('pages with Pikchr: broken diagrams are refused, renderer and fonts are served', async () => {
  const dir = join(work, 'diagram');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><pre class="pikchr">box "a" at</pre>');
  const bad = cli('publish', '--json', '--no-clipboard', dir);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /Pikchr error in index.html, diagram at line 1/);

  writeFileSync(join(dir, 'index.html'), '<!doctype html><pre class="pikchr">box "a"; arrow; box "b"</pre>');
  const good = cli('publish', '--json', '--no-clipboard', dir);
  assert.equal(good.code, 0, good.out);
  assert.equal(cli('delete', JSON.parse(good.out).editUrl).code, 0);

  for (const path of ['/pikchr/worker.js', '/pikchr/pikchr.js', '/pikchr/pikchr.wasm', '/fonts/instrument-sans.woff2', '/diagrams.js', '/fonts.js']) {
    try {
      const r = await fetch(base + path);
      assert.equal(r.status, 200, path);
      await r.arrayBuffer();
    } catch (cause) {
      throw new Error(`Asset fetch failed for ${path} (wrangler exit=${server.exitCode}, signal=${server.signalCode})`, { cause });
    }
  }
});
