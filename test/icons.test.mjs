import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Artifact, createArtifact } from '../public/client.js';
import { ICON_NAMES, validIcon, iconSvg } from '../public/icons.js';

test('trusted icons reject prototype keys, URLs, markup and non-string values', () => {
  for (const value of ICON_NAMES) assert.equal(validIcon(value), true);
  for (const value of ['constructor', '__proto__', 'toString', '<svg/>', 'https://example.com/a.svg', 4, true, {}, []]) {
    assert.equal(validIcon(value), false);
    assert.equal(iconSvg(value), iconSvg('document'));
  }
  assert.equal(validIcon(null), true);
  assert.equal(validIcon(undefined), true);
  assert.match(iconSvg('chart', true), /prefers-color-scheme:dark/);
  assert.notEqual(iconSvg('chart'), iconSvg('document'));
});

test('public client rejects invalid icons before uploading any file', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected network call'); });
  const files = { 'binary.png': new Uint8Array([0, 1, 2]) };
  await assert.rejects(createArtifact('https://example.com', 'unused', { files, icon: '<svg/>' }), /Invalid artifact icon/);
  await assert.rejects(new Artifact('https://example.com', 'id', 'unused').publish('tip', files, 'Update', { icon: 5 }), /Invalid artifact icon/);
  assert.equal(calls, 0);
});

test('CLI validates icons before reading files or contacting the publisher', () => {
  const cli = new URL('../scripts/publish-html.mjs', import.meta.url);
  for (const icon of ['constructor', 'https://example.com/a.svg', '<svg/>', 'unknown']) {
    const result = spawnSync(process.execPath, [cli.pathname, '--icon', icon, '/nonexistent'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--icon must be one of:/);
  }
  const help = spawnSync(process.execPath, [cli.pathname, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--icon <name>/);
});
