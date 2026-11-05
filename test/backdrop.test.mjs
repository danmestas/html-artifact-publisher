import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backdropColor, chooseCanvas } from '../public/backdrop.js';

test('backdropColor accepts only a computed colour and never a declaration', () => {
  for (const color of ['rgb(16, 20, 24)', 'rgba(0, 0, 0, 0)', 'color(srgb 0.1 0.2 0.3)', 'hsl(210 20% 10%)', 'oklch(0.2 0.02 260)']) {
    assert.equal(backdropColor(color), color);
  }
  for (const value of [
    '', 'white', '#101418', 'red; position: fixed', 'url(javascript:alert(1))',
    'rgb(0,0,0);background-image:url(https://outside.invalid)', 'expression(alert(1))',
    'rgb(' + '9'.repeat(200) + ')', 0, null, undefined, {}, [], true,
  ]) {
    assert.equal(backdropColor(value), null, String(value));
  }
});

test('chooseCanvas follows html, then body, the way the browser propagates a canvas', () => {
  const opaque = color => ({ color, paints: true });
  const transparent = { color: 'rgba(0, 0, 0, 0)', paints: false };
  const color = (html, body) => chooseCanvas(html, body, backdropColor);

  // The authoring pattern: tokens on body only.
  assert.equal(color(transparent, opaque('rgb(20, 21, 23)')), 'rgb(20, 21, 23)');
  // html wins over body when both paint.
  assert.equal(color(opaque('rgb(251, 250, 248)'), opaque('rgb(20, 21, 23)')), 'rgb(251, 250, 248)');
  // A transparent page names no colour: the viewer's own ground shows through.
  assert.equal(color(transparent, transparent), null);
  // A translucent layer does not back the page on its own.
  assert.equal(color(transparent, { color: 'rgba(16, 20, 24, 0.4)', paints: false }), null);
  // A malformed colour from a page report is rejected.
  assert.equal(color({ color: 'red; position: fixed', paints: true }, transparent), null);
  // A body may be missing on an unusual document.
  assert.equal(color(opaque('rgb(16, 20, 24)'), null), 'rgb(16, 20, 24)');
});
