import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, createArtifact } from './helpers/worker.mjs';

test('older retrieval reaches every thread beyond the historical 200-thread ceiling', { timeout: 120000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'hap-discussion-pagination-'));
  let worker;
  try {
    worker = await startWorker(work);
    const a = await createArtifact(worker.base, worker.owner, '<h1>Many threads</h1>');
    const base = `${worker.base}/api/artifacts/${a.id}/tickets`;
    const headers = { Authorization: `Token ${a.write}` };
    const ids = [];
    let oldest;
    for (let i = 0; i < 205; i++) {
      const response = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ text: `Thread ${i}` }) });
      assert.equal(response.status, 201, `thread ${i} created`);
      const result = await response.json();
      ids.push(result.ticketUuid);
      if (!oldest) oldest = result;
    }
    let cursor = '', seen = [], refs = [];
    do {
      const query = new URLSearchParams({ limit: '37', ...(cursor ? { cursor } : {}) });
      const response = await fetch(`${base}?${query}`, { headers });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.ok(result.tickets.length <= 37);
      seen.push(...result.tickets.map(t => t.uuid));
      refs.push(...result.tickets.map(t => t.ref));
      cursor = result.nextCursor;
    } while (cursor);
    assert.equal(seen.length, 205);
    assert.equal(new Set(seen).size, 205);
    assert.equal(new Set(refs).size, 205);
    assert.deepEqual(seen.toSorted(), ids.toSorted());
    const search = async (q, filter) => {
      let cursor = '', found = [];
      do {
        const params = new URLSearchParams({ q, filter, ...(cursor ? { cursor } : {}) });
        const response = await fetch(`${base}?${params}`, { headers });
        assert.equal(response.status, 200);
        const result = await response.json();
        found.push(...result.tickets);
        cursor = result.nextCursor;
      } while (cursor);
      return found;
    };
    const before = await search('Thread 0', 'open');
    assert.equal(before.length, 1);
    const ref = before[0].ref;
    const response = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ ticketUuid: oldest.ticketUuid, text: 'Needle only inside a reply', status: 'Closed' }) });
    assert.equal(response.status, 200);
    const after = await search('Needle', 'resolved');
    assert.equal(after.length, 1, 'search covers reply text on older threads');
    assert.equal(after[0].uuid, oldest.ticketUuid);
    assert.equal(after[0].ref, ref, 'reply and resolution never renumber');
    assert.equal(after[0].changes.every(c => c.canEdit === false), true, 'shared CLI capabilities do not identify an author');
    const empty = await (await fetch(`${base}?q=NoSuchMessage`, { headers })).json();
    assert.equal(empty.tickets.length, 0);
    assert.ok(empty.nextCursor, 'an empty bounded scan truthfully exposes remaining search candidates');
  } finally {
    worker?.stop();
    rmSync(work, { recursive: true, force: true });
  }
});
