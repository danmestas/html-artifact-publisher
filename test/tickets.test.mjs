import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('engine ticket ops: open, reply, list, changes and timelineSince', { timeout: 120000 }, () => {
  const result = spawnSync(process.execPath, [new URL('./helpers/wasm-tickets.mjs', import.meta.url).pathname], {
    encoding: 'utf8', timeout: 110000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  const summary = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.deepEqual({ tickets: summary.tickets, changes: summary.changes, since: summary.since },
    { tickets: 2, changes: 2, since: 3 });
});
