import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cssExternalReferences,
  externalReferenceWarnings,
  htmlDocumentProblems,
  htmlExternalReferences,
} from '../scripts/input-validation.mjs';

const cli = new URL('../scripts/publish-html.mjs', import.meta.url).pathname;

// Only references the viewer would actually try to load count. A link the
// reader follows, a URL in prose, and a URL in a JavaScript string do not.
test('HTML: warns for external subresources, not navigation, prose or scripts', () => {
  const html = `<!doctype html><html><head>
<link rel="stylesheet" href="https://cdn.example/a.css">
<link rel="canonical" href="https://example.com/page">
<script src="https://cdn.example/app.js"></script>
<script>const endpoint = "https://api.example/data";</script>
<style>@import "https://fonts.example/css"; .a{background:url('https://img.example/a.png')} .b{background:url("/local.png")}</style>
</head><body>
<a href="https://example.com/read">Read</a>
<p>See https://example.com/plain for details.</p>
<img src="https://img.example/b.png" srcset="https://img.example/c.png 2x, images/local.png 1x">
<div style="background-image: url(https://img.example/d.png)"></div>
<textarea><img src="https://ignored.example/e.png"></textarea>
</body></html>`;
  assert.deepEqual(new Set(htmlExternalReferences(html)), new Set([
    'https://cdn.example/a.css',
    'https://cdn.example/app.js',
    'https://fonts.example/css',
    'https://img.example/a.png',
    'https://img.example/b.png',
    'https://img.example/c.png',
    'https://img.example/d.png',
  ]));
});

test('HTML: local, data and fragment references are not external', () => {
  const html = `<!doctype html><img src="images/a.png" srcset="images/b.png 2x" style="background:url('data:image/png;base64,AA')">
<svg><use href="#icon"></use><image href="data:image/svg+xml,<svg/>"></image></svg>`;
  assert.deepEqual(htmlExternalReferences(html), []);
});

test('HTML: a duplicate src attribute keeps the first, as HTML parsers do', () => {
  assert.deepEqual(htmlExternalReferences('<img src="https://first.example/a.png" src="https://second.example/b.png">'), [
    'https://first.example/a.png',
  ]);
  assert.deepEqual(htmlExternalReferences('<img src="images/local.png" src="https://second.example/b.png">'), []);
});

test('CSS: warns for external @import and url(), not local or data', () => {
  const css = `
    @import "https://x.example/a.css";
    @import url(https://x.example/b.css);
    @font-face { src: url("//cdn.example/f.woff2") }
    body { background: url('../local.png') }
    .icon { background: url(data:image/png;base64,AAAA) }
    /* url(https://comment.example/nope.png) */
  `;
  assert.deepEqual(new Set(cssExternalReferences(css)), new Set([
    'https://x.example/a.css',
    'https://x.example/b.css',
    '//cdn.example/f.woff2',
  ]));
});

test('warnings scan HTML and CSS files only, with one message per reference', () => {
  const warnings = externalReferenceWarnings({
    'index.html': Buffer.from('<!doctype html><script src="https://cdn.example/a.js"></script>'),
    'styles/site.css': Buffer.from('body{background:url(https://cdn.example/b.png)}'),
    'app.js': Buffer.from('fetch("https://api.example/data")'),
    'NOTES.md': Buffer.from('https://example.com/prose'),
    'other/page.html': Buffer.from('<!doctype html><img src="https://cdn.example/a.js">'),
  });
  assert.deepEqual(warnings, [
    'external URL: https://cdn.example/a.js',
    'external URL: https://cdn.example/b.png',
  ]);
});

// A directory could slip a fragment through as an HTML document the viewer
// serves; it gets the same clear refusal as a single file.
test('standalone check accepts real documents and names the offending file', () => {
  for (const good of ['<!doctype html><p>x', '  <!DOCTYPE HTML><p>x', '﻿<!doctype html><p>x', '<html lang="en"><p>x']) {
    assert.equal(htmlDocumentProblems({ 'index.html': Buffer.from(good) }).length, 0, good);
  }
  const problems = htmlDocumentProblems({
    'index.html': Buffer.from('<!doctype html><h1>ok</h1>'),
    'partials/nav.html': Buffer.from('<nav>fragment</nav>'),
    'notes.txt': Buffer.from('no doctype here'),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /partials\/nav\.html does not appear to be a standalone HTML document/);
  assert.match(problems[0], /Expected content to start with <!doctype html or <html/);
});

test('standalone check requires a tag boundary, not just the prefix', () => {
  for (const impostor of ['<htmlish><p>x', '<!doctype html5><p>x', '<html-x><p>x']) {
    assert.equal(htmlDocumentProblems({ 'index.html': Buffer.from(impostor) }).length, 1, impostor);
  }
  for (const real of ['<html>', '<html lang="en">', '<html/>', '<!doctype html>', '<!doctype html SYSTEM "about:legacy-compat">']) {
    assert.equal(htmlDocumentProblems({ 'index.html': Buffer.from(real) }).length, 0, real);
  }
});

test('CLI refuses a non-standalone file and directory consistently, without wrapping', () => {
  const work = mkdtempSync(join(tmpdir(), 'artifact-input-'));
  const env = { ...process.env, HTML_PUBLISHER_URL: 'http://127.0.0.1:1', HTML_PUBLISHER_TOKEN: 'unused' };
  try {
    const file = join(work, 'fragment.html');
    writeFileSync(file, '<div>fragment</div>');
    const single = spawnSync(process.execPath, [cli, 'publish', '--json', '--no-clipboard', file], { encoding: 'utf8', env });
    assert.equal(single.status, 1);
    assert.match(single.stderr, /does not appear to be a standalone HTML document/);

    const nonHtml = join(work, 'page.txt');
    writeFileSync(nonHtml, '<div>fragment</div>');
    const odd = spawnSync(process.execPath, [cli, 'publish', '--json', '--no-clipboard', nonHtml], { encoding: 'utf8', env });
    assert.equal(odd.status, 1, 'a single file is served as index.html whatever its name');
    assert.match(odd.stderr, /page\.txt does not appear to be a standalone HTML document/);

    const dir = join(work, 'site');
    mkdirSync(join(dir, 'partials'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><h1>ok</h1>');
    writeFileSync(join(dir, 'partials', 'nav.html'), '<nav>fragment</nav>');
    const many = spawnSync(process.execPath, [cli, 'publish', '--json', '--no-clipboard', dir], { encoding: 'utf8', env });
    assert.equal(many.status, 1);
    assert.match(many.stderr, /partials\/nav\.html does not appear to be a standalone HTML document/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
