import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker } from './helpers/worker.mjs';
import { ICON_NAMES, iconSvg } from '../public/icons.js';
import { spawnSync } from 'node:child_process';

const work = mkdtempSync(join(tmpdir(), 'hap-share-previews-'));
let worker;
before(async () => { worker = await startWorker(work); });
after(() => { worker?.stop(); rmSync(work, { recursive: true, force: true }); });
async function create(extra = {}) {
  const response = await fetch(`${worker.base}/api/artifacts`, {
    method: 'POST', headers: { Authorization: `Bearer ${worker.owner}` },
    body: JSON.stringify({ title: 'Research findings & next steps', ttlSeconds: null,
      files: { 'index.html': Buffer.from('<h1>PRIVATE_CONTENT_NOT_FOR_PREVIEWS</h1>').toString('base64') }, ...extra }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('unauthenticated sharing gets the real title and an icon card, never page content or credentials', async () => {
  const artifact = await create();
  const response = await fetch(artifact.viewerUrl.split('#')[0] + '?ignored=private-query');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Research findings &amp; next steps<\/title>/);
  assert.match(html, /property="og:title" content="Research findings &amp; next steps"/);
  assert.match(html, /property="og:type" content="website"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  const image = /property="og:image" content="([^"]+)"/.exec(html)?.[1];
  assert.equal(image, `${worker.base}/share-icons/research.png`);
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="630"/);
  assert.ok(!html.includes('PRIVATE_CONTENT_NOT_FOR_PREVIEWS'));
  assert.ok(!html.includes('private-query'));
  for (const link of [artifact.viewerUrl, artifact.editUrl, artifact.commentUrl]) {
    if (link) assert.ok(!html.includes(new URL(link).hash.slice(1)));
  }
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  const privateResponse = await fetch(`${worker.base}/api/artifacts/${artifact.id}`);
  assert.equal(privateResponse.status, 404, 'private API still conceals artifacts from unauthorized callers');
});

test('generated icon cards remain synchronized with their trusted SVG source', () => {
  const result = spawnSync(process.execPath, [new URL('../scripts/build-topic-previews.mjs', import.meta.url).pathname, '--check'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
});

test('titles are escaped as text and attributes, with matching safe server favicons', async () => {
  const title = 'Design & "review" </title><script>BAD_PREVIEW()</script>';
  const artifact = await create({ title, icon: 'security' });
  const response = await fetch(artifact.viewerUrl.split('#')[0]);
  const html = await response.text();
  assert.ok(!html.includes('<script>BAD_PREVIEW()</script>'));
  assert.match(html, /<title>Design &amp; "review" &lt;\/title&gt;&lt;script&gt;BAD_PREVIEW\(\)&lt;\/script&gt;<\/title>/);
  assert.match(html, /property="og:title" content="Design &amp; &quot;review&quot; &lt;\/title&gt;&lt;script&gt;BAD_PREVIEW\(\)&lt;\/script&gt;"/);
  assert.match(html, /property="og:image" content="[^\"]+\/share-icons\/security.png"/);
  const favicon = /<link rel="icon" type="image\/svg\+xml" href="([^"]+)"/.exec(html)?.[1];
  assert.equal(decodeURIComponent(favicon), 'data:image/svg+xml,' + iconSvg('security', true));
  const head = await fetch(artifact.viewerUrl.split('#')[0], { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.match(head.headers.get('cache-control'), /no-store/);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('slug previews follow metadata changes without changing stored icon defaults or exposing history', async () => {
  const artifact = await create({ slug: 'topic-preview-fixture' });
  const url = `${worker.base}/v/topic-preview-fixture`;
  const before = await (await fetch(url)).text();
  assert.ok(before.includes(`property="og:url" content="${url}"`));
  const update = await fetch(`${worker.base}/api/artifacts/${artifact.id}`, {
    method: 'PUT', headers: { Authorization: `Token ${new URL(artifact.editUrl).hash.slice(1)}` },
    body: JSON.stringify({ parent: artifact.tip, title: 'Security threat model', icon: null,
      files: { 'index.html': Buffer.from('<h1>PRIVATE_CONTENT_NOT_FOR_PREVIEWS</h1><p>Updated private content</p>').toString('base64') } }),
  });
  const updated = await update.json();
  assert.equal(update.status, 200, JSON.stringify({ error: updated.error, code: updated.code }));
  const html = await (await fetch(url)).text();
  assert.match(html, /property="og:title" content="Security threat model"/);
  assert.match(html, /\/share-icons\/security.png/);
  assert.ok(!html.includes('Research findings'));
  assert.ok(!html.includes('PRIVATE_CONTENT_NOT_FOR_PREVIEWS'));
  const info = await (await fetch(`${worker.base}/api/artifacts/${artifact.id}`, {
    headers: { Authorization: `Token ${new URL(artifact.viewerUrl).hash.slice(1)}` },
  })).json();
  assert.equal(info.icon, 'document', 'topic inference never mutates stored metadata');
  const deleted = await fetch(`${worker.base}/api/artifacts/${artifact.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${worker.owner}` },
  });
  assert.equal(deleted.status, 204);
  const absent = await (await fetch(url)).text();
  assert.match(absent, /<title>Artifact<\/title>/);
  assert.ok(!absent.includes('Security threat model'));
  assert.match(absent, /\/share-icons\/document.png/);
});

test('expired and nonexistent artifacts never disclose a former title or topic', async () => {
  const artifact = await create({ title: 'Secret clinical research title', ttlSeconds: 1 });
  await new Promise(resolve => setTimeout(resolve, 1200));
  for (const url of [artifact.viewerUrl.split('#')[0], `${worker.base}/v/never-existed`]) {
    const response = await fetch(url);
    const html = await response.text();
    assert.match(html, /<title>Artifact<\/title>/);
    assert.ok(!html.includes('Secret clinical research title'));
    assert.match(html, /\/share-icons\/document.png/);
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
});

test('every topic image is a real, bounded 1200 by 630 PNG readable without authentication', async () => {
  for (const icon of ICON_NAMES) {
    const response = await fetch(`${worker.base}/share-icons/${icon}.png`);
    assert.equal(response.status, 200, `${icon}: available to a preview crawler`);
    assert.match(response.headers.get('content-type'), /image\/png/);
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
    assert.ok(png.length < 100000, `${icon}: small sharing image`);
    const head = await fetch(`${worker.base}/share-icons/${icon}.png`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
});
