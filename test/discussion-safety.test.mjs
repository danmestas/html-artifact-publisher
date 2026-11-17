import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, createArtifact } from './helpers/worker.mjs';

test('guest corrections preserve discussion-only authority and blocked guests lose correction privileges', { timeout: 120000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'hap-discussion-safety-'));
  const wakes = [];
  const hook = createServer((req, res) => {
    req.resume();
    req.on('end', () => { wakes.push(true); res.writeHead(204).end(); });
  });
  let worker;
  try {
    await new Promise(resolve => hook.listen(0, '127.0.0.1', resolve));
    worker = await startWorker(work, { WAKE_SINK_KIND: 'webhook', WAKE_SINK_URL: `http://127.0.0.1:${hook.address().port}/wake`, WAKE_SINK_SECRET: 'isolated-test-secret' });
    const a = await createArtifact(worker.base, worker.owner, '<h1>Safety</h1>');
    const base = `${worker.base}/api/artifacts/${a.id}`;
    const headers = { Authorization: `Token ${a.read}`, Origin: worker.base };
    const identified = await fetch(`${base}/guest`, { method: 'PUT', headers, body: JSON.stringify({ name: 'Guest author' }) });
    assert.equal(identified.status, 200);
    const profile = await identified.json();
    const cookie = identified.headers.getSetCookie().find(c => c.startsWith('hap_guest='))?.split(';')[0];
    assert.ok(cookie);
    headers.Cookie = cookie;
    const opened = await fetch(`${base}/tickets`, { method: 'POST', headers, body: JSON.stringify({ text: 'Ordinary discussion' }) });
    assert.equal(opened.status, 201);
    const { ticketUuid, artifact } = await opened.json();
    const correctionPath = `${base}/tickets/${ticketUuid}/messages/${artifact}`;
    const privileged = { ...headers, Authorization: `Token ${a.write}` };
    const corrected = await fetch(correctionPath, { method: 'PATCH', headers: privileged, body: JSON.stringify({ text: 'Still ordinary discussion' }) });
    assert.equal(corrected.status, 200);
    const result = await corrected.json();
    let listing = await (await fetch(`${base}/tickets`, { headers })).json();
    assert.equal(listing.tickets[0].changes[0].fields.authority, 'view');
    assert.equal(listing.tickets[0].changes[0].canEdit, true);
    assert.equal(listing.tickets[0].lastChange, result.artifact);
    // A privileged API post is a positive control for the webhook observer.
    const control = await fetch(`${base}/tickets`, { method: 'POST', headers: { ...headers, Authorization: `Token ${a.comment}` }, body: JSON.stringify({ text: 'Explicit work request' }) });
    assert.equal(control.status, 201);
    const controlMessage = await control.json();
    for (let i = 0; i < 40 && wakes.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(wakes.length, 1, 'only the explicit privileged post wakes, never the guest post or correction');
    const controlCorrection = await fetch(`${base}/tickets/${controlMessage.ticketUuid}/messages/${controlMessage.artifact}`, { method: 'PATCH', headers: privileged, body: JSON.stringify({ text: 'Text correction is not a new work request' }) });
    assert.equal(controlCorrection.status, 200);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(wakes.length, 1, 'privileged-origin corrections also never create new work');
    const blocked = await fetch(`${base}/guests/${profile.guest.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${worker.owner}` }, body: JSON.stringify({ blocked: true }) });
    assert.equal(blocked.status, 200);
    listing = await (await fetch(`${base}/tickets`, { headers })).json();
    assert.equal(listing.tickets.find(t => t.uuid === ticketUuid).changes[0].canEdit, false);
    assert.equal((await fetch(correctionPath, { method: 'PATCH', headers: privileged, body: JSON.stringify({ text: 'Blocked correction' }) })).status, 404);
    assert.equal((await fetch(`${base}/tickets/${ticketUuid}/view`, { method: 'PUT', headers, body: JSON.stringify({ following: true }) })).status, 403);
  } finally {
    worker?.stop();
    await new Promise(resolve => hook.close(resolve));
    rmSync(work, { recursive: true, force: true });
  }
});
