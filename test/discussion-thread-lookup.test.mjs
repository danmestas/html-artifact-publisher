import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Artifact } from '../public/client.js';
import { startWorker, createArtifact } from './helpers/worker.mjs';

test('exact thread lookup opens older resolved discussions beyond the initial scan cohort', { timeout: 120000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'hap-discussion-lookup-'));
  let worker;
  try {
    worker = await startWorker(work);
    const a = await createArtifact(worker.base, worker.owner, '<h1>Exact lookup</h1>');
    const art = new Artifact(worker.base, a.id, a.write);
    const target = await art.comment({ text: 'Older resolved discussion' });
    await art.comment({ ticketUuid: target.ticketUuid, status: 'Closed' });
    for (let i = 0; i < 36; i++) await art.comment({ text: `Newer discussion ${i}` });
    const initial = await art.tickets();
    assert.equal(initial.tickets.some(t => t.uuid === target.ticketUuid), false, 'target is older than the first bounded cohort');
    assert.ok(initial.nextCursor);
    const exact = await art.tickets({ thread: target.ticketUuid });
    assert.equal(exact.tickets.length, 1);
    assert.equal(exact.tickets[0].uuid, target.ticketUuid);
    assert.equal(exact.tickets[0].status, 'Closed');
    assert.equal(exact.tickets[0].ref, 1);
    assert.equal(exact.tickets[0].changes.length, 2);
    assert.equal(exact.tickets[0].changes[0].text, 'Older resolved discussion');
    assert.equal(exact.tickets[0].changes[0].canEdit, false, 'shared token does not become personal authorship on lookup');
    assert.deepEqual(exact.viewer, { key: null, label: 'Guest', verified: false });
    assert.equal(exact.limit, 1);
    assert.equal(exact.truncated, false);
    assert.equal(exact.nextCursor, null);
    const other = await createArtifact(worker.base, worker.owner, '<h1>Other artifact</h1>');
    const foreign = await new Artifact(worker.base, other.id, other.write).comment({ text: 'Foreign discussion' });
    for (const thread of [foreign.ticketUuid, 'f'.repeat(40), 'f'.repeat(64)]) await assert.rejects(art.tickets({ thread }), error => error.status === 404);
    for (const extra of [{ q: 'Newer' }, { filter: 'open' }, { sort: 'reference' }, { cursor: initial.nextCursor }, { limit: 2 }]) await assert.rejects(art.tickets({ thread: target.ticketUuid, ...extra }), error => error.status === 400);
    const denied = new Artifact(worker.base, a.id, 'f'.repeat(64));
    await assert.rejects(denied.tickets({ thread: target.ticketUuid }), error => error.status === 404);
  } finally {
    worker?.stop();
    rmSync(work, { recursive: true, force: true });
  }
});
