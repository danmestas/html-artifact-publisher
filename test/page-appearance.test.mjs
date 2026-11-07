import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { pageAppearance } from '../public/page-appearance.js';

function runtime({ authorTheme, preference = 'system' } = {}) {
  const parent = {}, listeners = {};
  const media = { mediaText: '(max-width: 640px) and (prefers-color-scheme: dark), print' };
  const light = { mediaText: '(prefers-color-scheme: light)' };
  const document = {
    documentElement: { dataset: authorTheme === undefined ? {} : { theme: authorTheme } },
    styleSheets: [{ cssRules: [{ cssRules: [{ media, cssRules: [] }, { media: light, cssRules: [] }] }] }],
    addEventListener: (name, fn) => { listeners[name] = fn; },
  };
  runInNewContext(`(${pageAppearance})(${JSON.stringify(preference)})`, { document, parent, addEventListener: (name, fn) => { listeners[name] = fn; }, MutationObserver: class { constructor(fn) { listeners.stylesChanged = fn; } observe() {} } });
  listeners.DOMContentLoaded();
  return { document, media, light, listeners, send: (theme, source = parent) => listeners.message({ source, data: { __artifactAppearance: 1, theme } }) };
}

test('System restores an author theme after an explicit reader override', () => {
  const r = runtime({ authorTheme: 'sepia', preference: 'dark' });
  assert.equal(r.document.documentElement.dataset.theme, 'dark');
  r.send('light');
  assert.equal(r.document.documentElement.dataset.theme, 'light');
  r.send('system');
  assert.equal(r.document.documentElement.dataset.theme, 'sepia');
});

test('new styles follow the current explicit preference', () => {
  const r = runtime();
  r.send('dark');
  const media = { mediaText: '(prefers-color-scheme: dark) and (orientation: portrait)' };
  r.document.styleSheets.push({ cssRules: [{ media }] });
  r.listeners.stylesChanged();
  assert.equal(media.mediaText, '(min-width: 0px) and (orientation: portrait)');
  r.send('system');
  assert.equal(media.mediaText, '(prefers-color-scheme: dark) and (orientation: portrait)');
});

test('sandbox appearance updates only from its parent and restores original media for System', () => {
  const r = runtime(), original = r.media.mediaText;
  r.send('dark', {});
  r.send('red; color: red');
  assert.equal(r.document.documentElement.dataset.theme, undefined);
  assert.equal(r.media.mediaText, original);
  r.send('dark');
  assert.equal(r.document.documentElement.dataset.theme, 'dark');
  assert.equal(r.media.mediaText, '(max-width: 640px) and (min-width: 0px), print');
  assert.equal(r.light.mediaText, '(max-width: 0px)');
  r.send('light');
  assert.equal(r.document.documentElement.dataset.theme, 'light');
  assert.equal(r.media.mediaText, '(max-width: 640px) and (max-width: 0px), print');
  assert.equal(r.light.mediaText, '(min-width: 0px)');
  r.send('system');
  assert.equal(r.document.documentElement.dataset.theme, undefined);
  assert.equal(r.media.mediaText, original);
  assert.equal(r.light.mediaText, '(prefers-color-scheme: light)');
});
