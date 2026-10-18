// The Pikchr skill's renderer (skills/pikchr/render.mjs) and its vendored wasm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';

const render = (args, input) => spawnSync(process.execPath, ['skills/pikchr/render.mjs', ...args], { input, encoding: 'utf8' });

test('renders the example as a light and a dark SVG figure', () => {
  const r = render(['skills/pikchr/examples/publish-flow.pikchr', '--alt', 'Publish flow', '--caption', 'A & B']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<figure class="pikchr-figure">/);
  assert.equal(r.stdout.match(/<svg role="img" aria-label="Publish flow"/g).length, 2);
  assert.match(r.stdout, /class="pikchr pk-light"/);
  assert.match(r.stdout, /class="pikchr pk-dark"/);
  assert.match(r.stdout, /<figcaption>A &amp; B<\/figcaption>/);
  assert.doesNotMatch(r.stdout, /<script|on\w+=|https?:\/\/(?!www\.w3\.org)/);
});

test('reports Pikchr errors with exit 1', () => {
  const r = render(['-', '--check'], 'box "a" at\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /syntax error/);
});

test('requires --alt to render', () => {
  assert.equal(render(['-'], 'box\n').status, 2);
});

test('Studio link carries the source as raw DEFLATE, base64url', () => {
  const source = 'box "café"\narrow\n';
  const r = render(['-', '--studio'], source);
  assert.equal(r.status, 0, r.stderr);
  const z = r.stdout.trim().split('#z=')[1];
  assert.match(z, /^[A-Za-z0-9_-]+$/);
  assert.equal(zlib.inflateRawSync(Buffer.from(z, 'base64url')).toString('utf8'), source);
});
