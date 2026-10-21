import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('multi-file updates stay within the WASM memory budget', { timeout: 120000 }, () => {
  const result = spawnSync(process.execPath, ['--wasm-max-mem-pages=2048', new URL('./helpers/wasm-memory.mjs', import.meta.url).pathname], {
    encoding: 'utf8', timeout: 110000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  const metrics = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.ok(metrics.peakWasmBytes <= 48 * 1024 * 1024, JSON.stringify(metrics));
});
