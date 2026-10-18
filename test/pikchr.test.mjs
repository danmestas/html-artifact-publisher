// Pikchr support: the skill's render.mjs, the CLI's block extraction, and the
// viewer's font detection. No server needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { loadPikchr, pikchrBlocks } from '../scripts/pikchr.mjs';
import { fontsUsed } from '../public/fonts.js';

const render = (args, input) => spawnSync(process.execPath, ['skills/pikchr/render.mjs', ...args], { input, encoding: 'utf8' });

test('the skill examples render', () => {
  for (const f of ['publish-flow', 'state-machine', 'routes']) {
    const r = render([`skills/pikchr/examples/${f}.pikchr`, '--check']);
    assert.equal(r.status, 0, r.stderr);
  }
});

test('--check reports Pikchr errors with exit 1', () => {
  const r = render(['-', '--check'], 'box "a" at\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /syntax error/);
});

test('--check on a page checks every pre.pikchr block', () => {
  const page = '<!doctype html><body>\n<pre class="pikchr">box "ok"</pre>\n<pre class="big pikchr">box "a" at</pre>';
  const r = render(['-', '--check'], page);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ok: diagram at line 2/);
  assert.match(r.stderr, /diagram at line 3:[\s\S]*syntax error/);
});

test('--svg prints light and dark renderings', () => {
  const light = render(['-', '--svg'], 'box fill 0xe7eef2').stdout;
  const dark = render(['-', '--svg', '--dark'], 'box fill 0xe7eef2').stdout;
  assert.match(light, /^<svg[\s\S]*fill:rgb\(231,238,242\)/);
  assert.match(dark, /^<svg/);
  assert.notEqual(light, dark);
});

test('--studio link carries the source as raw DEFLATE, base64url', () => {
  const source = 'box "café"\narrow\n';
  const r = render(['-', '--studio'], source);
  assert.equal(r.status, 0, r.stderr);
  const z = r.stdout.trim().split('#z=')[1];
  assert.match(z, /^[A-Za-z0-9_-]+$/);
  assert.equal(zlib.inflateRawSync(Buffer.from(z, 'base64url')).toString('utf8'), source);
});

test('pikchrBlocks finds blocks, decodes entities and reports lines', () => {
  const html = '<p>x</p>\n<pre class="pikchr" aria-label="a">A: box\narrow &lt;- "x&amp;y"</pre>\n<pre>not me</pre>\n<pre class=\'note pikchr\'>box</pre>';
  const blocks = pikchrBlocks(html);
  assert.deepEqual(blocks.map(b => b.line), [2, 5]);
  assert.equal(blocks[0].source, 'A: box\narrow <- "x&y"');
  assert.equal(pikchrBlocks('<pre class="pikchrish">box</pre>').length, 0);
});

test('loadPikchr renders and returns errors as values', async () => {
  const pikchr = await loadPikchr();
  const ok = pikchr('box "hi"');
  assert.ok(ok.svg.startsWith('<svg') && ok.width > 0 && ok.height > 0);
  assert.match(pikchr('box at').error, /syntax error/);
});

test('fontsUsed names only the house fonts the CSS uses', () => {
  assert.deepEqual(fontsUsed('body{font-family:"Instrument Sans",system-ui}'), ['Instrument Sans']);
  assert.deepEqual(fontsUsed(":root{--mono:'IBM Plex Mono', monospace} code{font-family:var(--mono)}"), ['IBM Plex Mono']);
  assert.deepEqual(fontsUsed('h1{font: 600 2rem/1.1 IBM Plex Serif, serif}'), ['IBM Plex Serif']);
  assert.deepEqual(fontsUsed('body{font-family:system-ui}'), []);
  assert.deepEqual(fontsUsed('body{font-family:"IBM Plex Sans Condensed"}'), [], 'a different family');
  assert.deepEqual(fontsUsed('@font-face{font-family:"Instrument Sans";src:url(x.woff2)} body{font-family:"Instrument Sans"}'), [],
    'a page that brings its own face keeps it');
});
