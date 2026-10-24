// Real app and static Workers share an isolated local R2 bucket, never live credentials.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'artifact-publications-'));
const legacy = 'publications-legacy-fixture';
const servers = [];
const b64 = value => Buffer.from(value).toString('base64');
const sha256 = value => createHash('sha256').update(value).digest('hex');
let base, publicBase, admin, creator, stranger;

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}
async function api(path, { method = 'GET', cookie, bearer, token, body } = {}) {
  const headers = { Origin: base };
  if (cookie) headers.Cookie = cookie;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (token) headers.Authorization = `Token ${token}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* static or empty body */ }
  return { status: res.status, json, text, headers: res.headers };
}
async function account(email, owner) {
  const requested = owner
    ? await api('/api/invitations', { method: 'POST', cookie: owner.cookie, body: { email, name: email.split('@')[0] } })
    : await api('/api/auth/request', { method: 'POST', body: { email } });
  assert.equal(requested.status, 200, requested.text);
  assert.ok(requested.json.loginUrl);
  const token = new URL(requested.json.loginUrl).hash.slice(7);
  const verified = await api('/api/auth/verify', { method: 'POST', body: { token } });
  assert.equal(verified.status, 200, verified.text);
  return { cookie: verified.headers.get('set-cookie').split(';')[0], user: verified.json.user };
}
async function create(auth, files = { 'index.html': b64('<h1>Publication fixture</h1>') }) {
  // Explicit account credentials preserve ownership and return legacy capability links.
  if (auth.cookie && !auth.bearer) {
    const credential = await api('/api/credentials', { ...auth, method: 'POST', body: { name: 'Publication capability fixture' } });
    assert.equal(credential.status, 201, credential.text);
    auth = { bearer: credential.json.token };
  }
  const res = await api('/api/artifacts', { ...auth, method: 'POST', body: { title: 'Publication fixture', ttlSeconds: null, files } });
  assert.equal(res.status, 201, res.text);
  return { ...res.json, read: res.json.viewerUrl.split('#')[1], write: res.json.editUrl.split('#')[1] };
}
async function publish(artifact, auth, documents, at = artifact.tip) {
  const res = await api(`/api/artifacts/${artifact.id}/publications`, { ...auth, method: 'POST', body: { at, documents } });
  assert.equal(res.status, 201, res.text);
  const row = res.json;
  assert.match(row.id, /^[a-zA-Z0-9_-]{12}$/);
  assert.equal(row.artifactId, artifact.id);
  assert.equal(row.checkin, at);
  assert.equal(row.status, 'live');
  assert.equal(row.title, 'Publication fixture');
  assert.equal(row.url, `${publicBase}/${row.id}/`);
  assert.equal(new Date(row.createdAt).toISOString(), row.createdAt);
  assert.ok(row.files > 0);
  assert.ok(row.bytes > 0);
  return row;
}
async function publicGet(path, options = {}) {
  return fetch(publicBase + path, { ...options, signal: AbortSignal.timeout(10000) });
}
async function start(args, origin, path, ready) {
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  for (const name of ['CF_API_TOKEN', 'CLOUDFLARE_API_TOKEN', 'CF_API_KEY', 'CLOUDFLARE_API_KEY', 'CF_EMAIL', 'CLOUDFLARE_EMAIL']) delete env[name];
  // This detached process group carries its own deadline even if the test runner dies.
  const lease = `
    const {spawn}=require('node:child_process');
    const timer=setTimeout(()=>process.kill(-process.pid,'SIGKILL'),300000);
    const child=spawn(process.argv[1],process.argv.slice(2),{stdio:'inherit'});
    child.once('error',()=>{clearTimeout(timer);process.exit(1)});
    child.once('exit',code=>{clearTimeout(timer);process.exit(code??1)});
  `;
  const server = spawn(process.execPath, ['-e', lease, join(root, 'node_modules/.bin/wrangler'), 'dev', ...args, '--ip', '127.0.0.1', '--persist-to', join(work, 'state'), '--show-interactive-dev-session=false'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  servers.push(server);
  let log = '', exited = false;
  server.once('exit', () => { exited = true; });
  server.once('error', error => { log += error.message; exited = true; });
  const capture = data => { log = (log + data).slice(-12000); };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !exited) {
    try { if (ready(await fetch(origin + path, { signal: AbortSignal.timeout(2000) }))) return; } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Wrangler did not start before its deadline:\n${log}`);
}
before(async () => {
  const appPort = await freePort();
  const publicPort = await freePort();
  base = `http://127.0.0.1:${appPort}`;
  publicBase = `http://127.0.0.1:${publicPort}`;
  await start(['--port', String(appPort), '--var', `BEARER_TOKEN:${legacy}`, '--var', 'OWNER_EMAIL:owner@example.com', '--var', `APP_ORIGIN:${base}`, '--var', `PUBLIC_ORIGIN:${publicBase}`, '--var', 'TEST_MAIL_TRANSPORT:loopback'], base, '/healthz', res => res.ok);
  await start(['--config', 'wrangler.public.jsonc', '--port', String(publicPort)], publicBase, '/missing/', res => res.status === 404);
  admin = await account('owner@example.com');
  creator = await account('publisher@example.com', admin);
  stranger = await account('other@example.com', admin);
});
after(async () => {
  for (const server of servers) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await Promise.all(servers.map(server => new Promise(resolve => {
    if (server.exitCode !== null || server.signalCode !== null || !server.pid) return resolve();
    const timer = setTimeout(() => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already gone */ } resolve(); }, 3000);
    server.once('exit', () => { clearTimeout(timer); resolve(); });
  })));
  rmSync(work, { recursive: true, force: true });
});

test('pinned static snapshot hydrates R2 and survives private edits and source deletion; revocation is complete', async () => {
  const bytes = randomBytes(300000), hash = sha256(bytes);
  const upload = await fetch(`${base}/api/blobs/${hash}`, { method: 'PUT', headers: { Authorization: `Bearer ${legacy}`, 'Content-Type': 'image/png' }, body: bytes });
  assert.equal(upload.status, 201);
  const pointer = `artifact-blob 1\nsha256 ${hash}\nsize ${bytes.length}\ntype image/png\n`;
  const artifact = await create({ bearer: legacy }, { 'index.html': b64('<h1>PRIVATE HISTORY MARKER</h1>'), 'images/x.png': b64(pointer) });
  const original = '<!doctype html><html><head><title>Pinned snapshot</title></head><body><h1>PINNED PUBLIC MARKER</h1><img src="images/x.png"><a href="/other.html">Other</a></body></html>';
  const other = '<!doctype html><html><body><h1>Second static document</h1></body></html>';
  const updated = await api(`/api/artifacts/${artifact.id}`, { method: 'PUT', token: artifact.write, body: { parent: artifact.tip, files: { 'index.html': b64(original), 'other.html': b64(other), 'style.css': b64('h1{color:red}') } } });
  assert.equal(updated.status, 200, updated.text);
  assert.equal((await api(`/api/artifacts/${artifact.id}/data/private-record`, { method: 'PUT', token: artifact.write, body: { secret: 'PRIVATE DATA MARKER' } })).status, 200);
  const current = await api(`/api/artifacts/${artifact.id}`, { token: artifact.read });
  assert.equal(current.json.tip, updated.json.tip, 'await the committed source before publishing');
  const pinned = { ...artifact, tip: updated.json.tip };
  const row = await publish(pinned, { bearer: legacy }, { 'index.html': original, 'other.html': other });
  assert.equal(row.files, 4);
  assert.equal(row.ownerId, 'instance-owner');
  const retained = await publish(pinned, { cookie: admin.cookie }, { 'index.html': original, 'other.html': other });

  const redirect = await publicGet(`/${row.id}`, { redirect: 'manual' });
  assert.ok([301, 302, 307, 308].includes(redirect.status));
  assert.equal(new URL(redirect.headers.get('location'), publicBase).pathname, `/${row.id}/`);
  const page = await publicGet(`/${row.id}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('cache-control'), /no-store/);
  assert.equal(page.headers.get('set-cookie'), null);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /(?:^|;)\s*sandbox(?:\s|;|$)/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /connect-src 'self'(?:;|$)/);
  assert.doesNotMatch(csp, /https?:|\*/);
  const html = await page.text();
  assert.match(html, /PINNED PUBLIC MARKER/);
  assert.doesNotMatch(html, /PRIVATE HISTORY MARKER|PRIVATE DATA MARKER|artifact-blob|viewer\.js/);
  assert.match(html, new RegExp(`<base\\s+href=["']${publicBase}/${row.id}/["']`));
  assert.match(html, new RegExp(`(?:href=["']|href=)${publicBase}/${row.id}/other\\.html|href=["']/${row.id}/other\\.html`), 'root links stay inside this snapshot');
  assert.match(await (await publicGet(`/${row.id}/other.html`)).text(), /Second static document/);
  assert.equal(await (await publicGet(`/${row.id}/style.css`)).text(), 'h1{color:red}');
  const image = await publicGet(`/${row.id}/images/x.png`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(sha256(Buffer.from(await image.arrayBuffer())), hash);
  for (const path of [`/${row.id}/data/private-record`, `/${row.id}/.fossil`, `/${row.id}/history`, `/api/artifacts/${artifact.id}`, `/b/${artifact.id}/${hash}`]) {
    assert.equal((await publicGet(path, { headers: { Cookie: admin.cookie, Authorization: `Bearer ${legacy}` } })).status, 404, path);
  }
  const edit = await api(`/api/artifacts/${artifact.id}`, { method: 'PUT', token: artifact.write, body: { parent: pinned.tip, files: { 'index.html': b64('<h1>NEW PRIVATE VERSION</h1>') } } });
  assert.equal(edit.status, 200, edit.text);
  assert.equal(await (await publicGet(`/${row.id}/`)).text(), html, 'later private writes cannot mutate the published snapshot');
  assert.equal((await api(`/api/artifacts/${artifact.id}`, { method: 'DELETE', token: artifact.write })).status, 204);
  assert.equal(await (await publicGet(`/${row.id}/`)).text(), html, 'source deletion leaves the independent snapshot intact');
  assert.equal(sha256(Buffer.from(await (await publicGet(`/${row.id}/images/x.png`)).arrayBuffer())), hash);
  const removed = await api(`/api/publications/${row.id}`, { method: 'DELETE', cookie: admin.cookie });
  assert.equal(removed.status, 200, removed.text);
  assert.deepEqual(removed.json, { ok: true });
  for (const path of ['', 'index.html', 'other.html', 'images/x.png', 'style.css']) assert.equal((await publicGet(`/${row.id}/${path}`)).status, 404, path);
  for (let i = 0; i < 2; i++) {
    const cleaned = await api('/api/publications/cleanup', { method: 'POST', bearer: legacy, body: {} });
    assert.equal(cleaned.status, 200, cleaned.text);
    assert.ok(Number.isInteger(cleaned.json.cleaned));
    assert.equal(typeof cleaned.json.remaining, 'boolean');
    assert.equal((await publicGet(`/${retained.id}/`)).status, 200, 'cleanup must never remove a live publication');
  }
  const list = await api('/api/publications', { cookie: admin.cookie });
  assert.ok(!list.json.publications.some(item => item.id === row.id), 'deleted rows are excluded');
  assert.ok(list.json.publications.some(item => item.id === retained.id));
});

test('publication rights require account ownership, not read/edit links or named writer access', async () => {
  const auth = { cookie: creator.cookie };
  const artifact = await create(auth);
  const documents = { 'index.html': '<h1>Publication fixture</h1>' };
  const endpoint = `/api/artifacts/${artifact.id}/publications`;
  const denied = [{}, { token: artifact.read }, { token: artifact.write }, { cookie: stranger.cookie }];
  for (const access of denied) {
    const res = await api(endpoint, { ...access, method: 'POST', body: { at: artifact.tip, documents } });
    assert.ok([401, 403, 404].includes(res.status), res.text);
  }
  assert.equal((await api(`/api/artifacts/${artifact.id}/sharing`, { ...auth, method: 'PUT', body: { userId: stranger.user.id, permission: 'write' } })).status, 200);
  const sharedWriter = await api(endpoint, { cookie: stranger.cookie, method: 'POST', body: { at: artifact.tip, documents } });
  assert.equal(sharedWriter.status, 403, sharedWriter.text);
  const row = await publish(artifact, auth, documents);
  assert.equal(row.ownerId, creator.user.id);
  const second = await publish(artifact, { cookie: admin.cookie }, documents);
  const own = await api('/api/publications?artifactId=' + artifact.id, auth);
  assert.equal(own.status, 200, own.text);
  assert.ok(own.json.publications.some(item => item.id === row.id));
  assert.ok(Object.hasOwn(own.json, 'nextCursor'));
  const foreign = await api('/api/publications', { cookie: stranger.cookie });
  assert.equal(foreign.status, 200, foreign.text);
  assert.deepEqual(foreign.json.publications, []);
  const filtered = await api('/api/publications?artifactId=' + artifact.id, { cookie: stranger.cookie });
  assert.equal(filtered.status, 200, filtered.text);
  assert.deepEqual(filtered.json.publications, []);
  const inventory = await api('/api/publications', { cookie: admin.cookie });
  assert.ok(inventory.json.publications.some(item => item.id === row.id));
  assert.ok(inventory.json.publications.some(item => item.id === second.id));
  for (const access of denied) {
    const res = await api(`/api/publications/${row.id}`, { ...access, method: 'DELETE' });
    assert.ok([401, 403, 404].includes(res.status), res.text);
  }
  for (const access of [{}, auth, { token: artifact.write }]) {
    const res = await api('/api/publications/cleanup', { ...access, method: 'POST', body: {} });
    assert.ok([401, 403, 404].includes(res.status), res.text);
  }
  assert.equal((await publicGet(`/${row.id}/`)).status, 200, 'denied deletes leave the snapshot live');
  assert.equal((await api(`/api/artifacts/${artifact.id}`, { ...auth, method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/publications/${row.id}`, { ...auth, method: 'DELETE' })).status, 200, 'publication owner can revoke after source deletion');
  assert.equal((await publicGet(`/${row.id}/`)).status, 404);
});

test('canonical checkins and complete, safe prepared-document maps are required atomically', async () => {
  const auth = { cookie: creator.cookie };
  const artifact = await create(auth, { 'index.html': b64('<h1>Entry</h1>'), 'nested/other.html': b64('<h1>Nested</h1>') });
  const documents = { 'index.html': '<h1>Entry</h1>', 'nested/other.html': '<h1>Nested</h1>' };
  const beforeList = await api('/api/publications?artifactId=' + artifact.id, auth);
  assert.equal(beforeList.status, 200, beforeList.text);
  assert.deepEqual(beforeList.json.publications, []);
  const invalid = [
    { at: 'latest', documents },
    { at: artifact.tip.slice(0, 12), documents },
    { at: artifact.tip.toUpperCase(), documents },
    { at: '0'.repeat(64), documents },
    { at: artifact.tip },
    { at: artifact.tip, documents: {} },
    { at: artifact.tip, documents: { 'index.html': '<h1>Missing nested document</h1>' } },
    { at: artifact.tip, documents: { ...documents, '../escape.html': '<h1>No</h1>' } },
    { at: artifact.tip, documents: { ...documents, '/absolute.html': '<h1>No</h1>' } },
    { at: artifact.tip, documents: { ...documents, 'nested/../escape.html': '<h1>No</h1>' } },
    { at: artifact.tip, documents: { ...documents, 'unknown.html': '<h1>No</h1>' } },
    { at: artifact.tip, documents: { ...documents, 'index.html': 42 } },
  ];
  for (const body of invalid) {
    const res = await api(`/api/artifacts/${artifact.id}/publications`, { ...auth, method: 'POST', body });
    assert.ok([400, 404, 422].includes(res.status), `invalid publication was accepted: ${res.status} ${res.text}`);
    const list = await api('/api/publications?artifactId=' + artifact.id, auth);
    assert.deepEqual(list.json.publications, [], 'a failed export never becomes publicly listed');
    if (res.json?.id) assert.equal((await publicGet(`/${res.json.id}/`)).status, 404, 'failed exports are never served');
  }
  const valid = await publish(artifact, auth, documents);
  assert.equal((await publicGet(`/${valid.id}/nested/other.html`)).status, 200);
  for (const path of [`/${valid.id}/%2e%2e%2findex.html`, `/${valid.id}/nested%2f..%2f..%2findex.html`]) assert.equal((await publicGet(path)).status, 404, 'encoded traversal cannot escape a snapshot');
});

test('root CSS URLs and nested HTML resolve within the snapshot without changing relative asset paths', async () => {
  const auth = { cookie: creator.cookie };
  const entry = '<!doctype html><html><head><base href="https://wrong.invalid/"><meta name="artifact-nonce" content="private-fixture"><link rel="stylesheet" href="/styles/site.css"><style>.hero{background:url(/images/icon.svg)}</style></head><body style="background:url(\'/images/icon.svg\')"><a href="nested/other.html">Nested</a><img srcset="/images/icon.svg 1x, /images/icon.svg 2x"><img srcset="data:image/jpeg;base64,/9j/fixture 1x, /images/icon.svg 2x"></body></html>';
  const nested = '<!doctype html><html><head><base href="https://wrong.invalid/nested/"></head><body><img src="../images/icon.svg"><a href="/index.html">Home</a><a href="#details">Details</a><a href="?view=full">Full view</a><h2 id="details">Details</h2></body></html>';
  const css = '@import "/styles/theme.css"; .root{background:url(/images/icon.svg)} .relative{background:url(../images/icon.svg)}';
  const icon = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0h1v1H0z"/></svg>';
  const artifact = await create(auth, { 'index.html': b64(entry), 'nested/other.html': b64(nested), 'styles/site.css': b64(css), 'styles/theme.css': b64('body{color:navy}'), 'images/icon.svg': b64(icon) });
  const row = await publish(artifact, auth, { 'index.html': entry, 'nested/other.html': nested });
  const prefix = `/${row.id}`;
  const page = await (await publicGet(prefix + '/')).text();
  assert.equal((page.match(/<base\s/gi) || []).length, 1);
  assert.ok(page.includes(`<base href="${publicBase}${prefix}/">`));
  assert.doesNotMatch(page, /wrong\.invalid|artifact-nonce|private-fixture/);
  assert.ok(page.includes(`href="${prefix}/styles/site.css"`));
  assert.ok(page.includes(`url(${prefix}/images/icon.svg)`), 'style elements rewrite root URLs');
  assert.ok(page.includes(`url('${prefix}/images/icon.svg')`), 'style attributes rewrite root URLs');
  assert.ok(page.includes(`srcset="${prefix}/images/icon.svg 1x, ${prefix}/images/icon.svg 2x"`));
  assert.ok(page.includes(`srcset="data:image/jpeg;base64,/9j/fixture 1x, ${prefix}/images/icon.svg 2x"`), 'a data URL comma is not a root-relative candidate separator');
  assert.ok(page.includes('href="nested/other.html"'), 'relative HTML links retain their meaning');
  const nestedPage = await (await publicGet(prefix + '/nested/other.html')).text();
  const nestedBase = /<base\s+href="([^"]+)"/.exec(nestedPage)?.[1];
  assert.equal(nestedBase, `${publicBase}${prefix}/nested/other.html`, nestedPage);
  assert.ok(nestedPage.includes('href="#details"'));
  assert.ok(nestedPage.includes('href="?view=full"'));
  assert.equal(new URL('#details', nestedBase).href, `${publicBase}${prefix}/nested/other.html#details`, 'fragment links stay on the nested document');
  assert.equal(new URL('?view=full', nestedBase).href, `${publicBase}${prefix}/nested/other.html?view=full`, 'query links stay on the nested document');
  for (const link of ['#details', '?view=full']) {
    const resolved = new URL(link, nestedBase);
    const linked = await publicGet(resolved.pathname + resolved.search + resolved.hash);
    assert.equal(linked.status, 200, `resolved ${link} remains a real document request`);
    assert.equal(await linked.text(), nestedPage);
  }
  const nestedImage = new URL('../images/icon.svg', nestedBase);
  assert.equal(nestedImage.href, `${publicBase}${prefix}/images/icon.svg`);
  const nestedAsset = await publicGet(nestedImage.pathname);
  assert.equal(nestedAsset.status, 200, 'the nested document relative asset actually loads');
  assert.equal(await nestedAsset.text(), icon);
  assert.equal(new URL('sibling.html', nestedBase).href, `${publicBase}${prefix}/nested/sibling.html`);
  assert.ok(nestedPage.includes('src="../images/icon.svg"'));
  assert.ok(nestedPage.includes(`href="${prefix}/index.html"`));
  assert.doesNotMatch(nestedPage, /wrong\.invalid/);
  const stylesheet = await publicGet(prefix + '/styles/site.css');
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get('content-type'), /text\/css/);
  const renderedCss = await stylesheet.text();
  assert.ok(renderedCss.includes(`@import "${prefix}/styles/theme.css"`));
  assert.ok(renderedCss.includes(`url(${prefix}/images/icon.svg)`));
  assert.ok(renderedCss.includes('url(../images/icon.svg)'), 'relative CSS URLs stay relative to the stylesheet');
  assert.equal(await (await publicGet(prefix + '/images/icon.svg')).text(), icon);
  assert.equal(await (await publicGet(prefix + '/styles/theme.css')).text(), 'body{color:navy}');
});

test('a sole entry containing a literal percent serves at the snapshot root and its encoded path', async () => {
  const auth = { cookie: creator.cookie };
  const html = '<!doctype html><html><head><title>Percent entry</title></head><body><h1>Literal percent entry</h1><a href="#details">Details</a><h2 id="details">Details</h2></body></html>';
  const artifact = await create(auth, { 'report%.html': b64(html) });
  const row = await publish(artifact, auth, { 'report%.html': html });
  assert.equal(row.files, 1);
  const rootPage = await publicGet(`/${row.id}/`);
  assert.equal(rootPage.status, 200);
  const rendered = await rootPage.text();
  assert.match(rendered, /Literal percent entry/);
  const entryBase = /<base\s+href="([^"]+)"/.exec(rendered)?.[1];
  assert.equal(entryBase, `${publicBase}/${row.id}/report%25.html`);
  assert.equal(new URL('#details', entryBase).href, `${publicBase}/${row.id}/report%25.html#details`);
  const encodedPage = await publicGet(`/${row.id}/report%25.html`);
  assert.equal(encodedPage.status, 200);
  assert.equal(await encodedPage.text(), rendered, 'manifest entry paths are raw filenames, not URLs to decode again');
});
