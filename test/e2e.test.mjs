// End-to-end tests: a local Worker (wrangler dev, fresh state) with the built
// src/fossil.wasm, driven through the HTTP API, Fossil's sync protocol (the
// native fsclient in fossil/cmd/fsclient) and the CLI.
//
//   npm run build:wasm && npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { Artifact, createArtifact } from '../public/client.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const port = 18000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
const owner = 'e2e-owner-token';
const work = mkdtempSync(join(tmpdir(), 'artifact-e2e-'));
const fsclient = join(work, 'fsclient');
let server;

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
  return { ...r.json, read: tokenOf(r.json.viewerUrl), write: tokenOf(r.json.editUrl) };
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
  // Its own process group, so after() can stop wrangler and workerd together.
  server = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', join(work, 'state'),
    '--var', `BEARER_TOKEN:${owner}`, '--show-interactive-dev-session=false'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
});

after(() => {
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
  assert.ok(out.viewerUrl && out.editUrl && out.cloneUrl);

  writeFileSync(join(dir, 'index.html'), '<!doctype html><link rel="stylesheet" href="style.css"><h1>v2</h1>');
  const up = cli('update', '--json', '--no-clipboard', '--message', 'second', out.editUrl, dir);
  assert.equal(up.code, 0, up.out);
  // The link printed after an update opens the artifact: it carries the read token.
  const upOut = JSON.parse(up.out);
  assert.equal(upOut.viewerUrl, out.viewerUrl);
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
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    await r.arrayBuffer();
  }
});
