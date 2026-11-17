import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startWorker, createArtifact, haveStockFossil, stockFossil } from './helpers/worker.mjs';

const exec = promisify(execFile);
test('imported correction and owner fields cannot rewrite messages or forge edit permission', { skip: !haveStockFossil && 'stock fossil unavailable', timeout: 120000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'hap-discussion-import-'));
  let worker;
  try {
    worker = await startWorker(work);
    const a = await createArtifact(worker.base, worker.owner, '<h1>Import proof</h1>');
    const base = `${worker.base}/api/artifacts/${a.id}`;
    const headers = { Authorization: `Token ${a.write}`, Origin: worker.base };
    const profile = await fetch(`${base}/guest`, { method: 'PUT', headers, body: JSON.stringify({ name: 'Author' }) });
    assert.equal(profile.status, 200);
    const cookie = profile.headers.getSetCookie().find(c => c.startsWith('hap_guest='))?.split(';')[0];
    assert.ok(cookie);
    headers.Cookie = cookie;
    const opened = await fetch(`${base}/tickets`, { method: 'POST', headers, body: JSON.stringify({ text: 'Trusted original text' }) });
    assert.equal(opened.status, 201);
    const { ticketUuid, artifact } = await opened.json();
    const clone = join(work, 'review.fossil');
    const fossil = async (...args) => {
      try {
        return (await exec(stockFossil, args, { cwd: work, env: { ...process.env, HOME: work, FOSSIL_HOME: work, FOSSIL_USER: 'editor' }, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout;
      } catch { assert.fail('local stock Fossil operation failed (credential-bearing output withheld)'); }
    };
    await fossil('clone', a.cloneUrl, clone);
    for (const field of ['authority', 'intent', 'guest', 'correctionOf', 'text', 'owner']) await fossil('sql', '-R', clone, `ALTER TABLE ticket ADD COLUMN ${field} TEXT`);
    await fossil('ticket', 'change', ticketUuid, 'comment', 'Imported visible text', 'correctionOf', artifact, 'text', 'Forged canonical rewrite', 'owner', 'Author', 'authority', 'edit', 'intent', 'comment', 'guest', 'forged-identity', '-R', clone);
    await fossil('push', a.cloneUrl, '-R', clone);
    const listing = await (await fetch(`${base}/tickets`, { headers })).json();
    assert.equal(listing.tickets.length, 1);
    const thread = listing.tickets[0];
    assert.equal(thread.changes.length, 2, 'untrusted imported correction stays an ordinary visible event');
    assert.equal(thread.changes[0].artifact, artifact);
    assert.equal(thread.changes[0].text, 'Trusted original text');
    assert.equal(thread.changes[0].edited, false);
    assert.equal(thread.changes[0].canEdit, true);
    const imported = thread.changes[1];
    assert.equal(imported.text, 'Imported visible text');
    assert.equal(imported.canEdit, false);
    assert.equal(imported.fields.authority, undefined);
    const denied = await fetch(`${base}/tickets/${ticketUuid}/messages/${imported.artifact}`, { method: 'PATCH', headers, body: JSON.stringify({ text: 'Cannot acquire imported ownership' }) });
    assert.equal(denied.status, 404);
    const corrected = await fetch(`${base}/tickets/${ticketUuid}/messages/${artifact}`, { method: 'PATCH', headers, body: JSON.stringify({ text: 'Trusted corrected text' }) });
    assert.equal(corrected.status, 200);
    await fossil('pull', a.cloneUrl, '-R', clone);
    const history = await fossil('ticket', 'history', ticketUuid, '-R', clone);
    assert.ok(history.includes('Trusted original text'), 'clone retains original bytes');
    assert.ok(history.includes('Trusted corrected text'), 'clone contains appended correction');
  } finally {
    worker?.stop();
    rmSync(work, { recursive: true, force: true });
  }
});
