import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, freePort } from './helpers/worker.mjs';

const exec = promisify(execFile);

test('the remote search CLI finds real persisted body content using instance and artifact credentials', { timeout: 60000 }, async () => {
  const state = mkdtempSync(join(tmpdir(), 'remote-search-client-'));
  let app;
  try {
    const port = await freePort();
    app = await startWorker(state, { APP_ORIGIN: `http://127.0.0.1:${port}` }, { port });
    const response = await fetch(app.base + '/api/artifacts', {
      method: 'POST', headers: { Authorization: `Bearer ${app.owner}` }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ title: 'Remote client example', ttlSeconds: null,
        files: { 'index.html': Buffer.from('<!doctype html><html><body><p>Unique riverword subject</p></body></html>').toString('base64') } }),
    });
    assert.equal(response.status, 201);
    const artifact = await response.json();
    for (const mode of ['instance', 'artifact']) {
      const args = ['scripts/publish-html.mjs', 'search', 'riverword', '--json'];
      if (mode === 'artifact') args.push('--artifact', artifact.viewerUrl);
      let result;
      try {
        result = await exec(process.execPath, args, { cwd: new URL('..', import.meta.url), timeout: 25000,
          env: { ...process.env, HTML_PUBLISHER_URL: app.base, HTML_PUBLISHER_TOKEN: app.owner } });
      } catch (error) {
        // Child errors otherwise include command arguments, including a local capability.
        throw new Error(`Remote CLI failed in ${mode} mode (exit ${error.code})`);
      }
      const data = JSON.parse(result.stdout);
      assert.equal(data.total, 1);
      assert.equal(data.artifacts[0].id, artifact.id);
      assert.match(data.artifacts[0].search.snippet.text, /riverword/);
      assert.equal(new URL(data.artifacts[0].viewerUrl).hash, '');
      assert.equal(result.stdout.includes(app.owner), false);
      assert.equal(Object.hasOwn(data.artifacts[0], 'editUrl'), false);
      assert.equal(Object.hasOwn(data.artifacts[0], 'cloneUrl'), false);
    }
  } finally {
    app?.stop();
    rmSync(state, { recursive: true, force: true });
  }
});
