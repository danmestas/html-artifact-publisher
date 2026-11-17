import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, createArtifact } from './helpers/worker.mjs';

const root = new URL('..', import.meta.url).pathname;
function watchedSourceTimes() {
  const files = ['wrangler.jsonc', 'package.json', 'package-lock.json'];
  for (const folder of ['src', 'public']) for (const name of readdirSync(join(root, folder), { recursive: true })) files.push(`${folder}/${name}`);
  return new Map(files.flatMap(name => {
    try { const info = statSync(join(root, name)); return info.isFile() ? [[name, info.mtimeMs]] : []; }
    catch { return []; }
  }));
}

function unexpectedAppendDiagnostic(response, raw, iteration, secrets, context = {}) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { /* runtime failures may be plain text or HTML */ }
  const sanitize = value => {
    let text = String(value);
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
    return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
      .replace(/\b(?:Bearer|Token)\s+[^\s"'<>]+/gi, '[credential]')
      .replace(/[A-Za-z0-9_-]{32,}/g, '[opaque]')
      .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  };
  return JSON.stringify({
    at: new Date().toISOString(), ...context,
    iteration, status: response.status, contentType: sanitize(response.headers.get('content-type') ?? ''),
    code: sanitize(typeof parsed?.code === 'string' ? parsed.code : 'unstructured_response'),
    error: sanitize(typeof parsed?.error === 'string' ? parsed.error : raw),
  });
}

test('unexpected history append diagnostics preserve the error but sanitize credentials and URLs', () => {
  const credential = 'a'.repeat(64);
  const response = new Response('', { status: 503, headers: { 'Content-Type': 'application/json' } });
  const diagnostic = unexpectedAppendDiagnostic(response, JSON.stringify({ code: 'reset', error: `object reset; Token ${credential}; http://editor:${credential}@example.test/path; local-fixture-secret` }), 17, ['local-fixture-secret']);
  assert.equal(diagnostic.includes(credential), false);
  assert.equal(diagnostic.includes('local-fixture-secret'), false);
  assert.equal(diagnostic.includes('http://'), false);
  const parsed = JSON.parse(diagnostic);
  assert.equal(parsed.iteration, 17);
  assert.equal(parsed.status, 503);
  assert.equal(parsed.code, 'reset');
  assert.ok(parsed.error.includes('object reset'));
});

test('history scans retain only a bounded complete cohort and oversized histories fail explicitly', { timeout: 120000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), 'hap-discussion-history-'));
  const startedAt = new Date().toISOString();
  const beforeSourceTimes = watchedSourceTimes();
  let worker;
  try {
    worker = await startWorker(work);
    const a = await createArtifact(worker.base, worker.owner, '<h1>Long histories</h1>');
    const base = `${worker.base}/api/artifacts/${a.id}/tickets`;
    const headers = { Authorization: `Token ${a.write}` };
    const post = async (url, body) => {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, json: await response.json() };
    };
    const ids = [];
    const text = 'large message '.repeat(571).slice(0, 7900);
    for (let i = 0; i < 4; i++) {
      const opened = await post(base, { text: `Opening ${i}\n${text}` });
      assert.equal(opened.status, 201);
      ids.push(opened.json.ticketUuid);
      for (let j = 0; j < 18; j++) {
        const reply = await post(base, { ticketUuid: opened.json.ticketUuid, text: `Reply ${j}\n${text}` });
        assert.equal(reply.status, 200);
      }
    }
    let cursor = '', seen = [], pages = 0;
    do {
      const params = new URLSearchParams({ limit: '200', ...(cursor ? { cursor } : {}) });
      const response = await fetch(`${base}?${params}`, { headers });
      assert.equal(response.status, 200);
      const bytes = await response.text();
      assert.ok(Buffer.byteLength(bytes) < 2 * 1024 * 1024 + 4096, 'serialized cohort stays under budget plus envelope');
      const result = JSON.parse(bytes);
      for (const ticket of result.tickets) assert.equal(ticket.changes.length, 19, 'never silently truncate an individual history');
      seen.push(...result.tickets.map(t => t.uuid));
      cursor = result.nextCursor;
      pages++;
    } while (cursor);
    assert.ok(pages > 1, 'raw-history scan budget yields continuation before requested limit');
    assert.deepEqual(seen.toSorted(), ids.toSorted());
    assert.equal(new Set(seen).size, 4);

    const big = await createArtifact(worker.base, worker.owner, '<h1>Oversized history</h1>');
    const bigBase = `${worker.base}/api/artifacts/${big.id}/tickets`;
    const bigHeaders = { Authorization: `Token ${big.write}` };
    const olderResponse = await fetch(bigBase, { method: 'POST', headers: bigHeaders, body: JSON.stringify({ text: 'Older healthy discussion' }) });
    assert.equal(olderResponse.status, 201);
    const older = await olderResponse.json();
    let response = await fetch(bigBase, { method: 'POST', headers: bigHeaders, body: JSON.stringify({ text }) });
    assert.equal(response.status, 201);
    const original = await response.json();
    const appendDiagnostic = (response, raw, iteration) => {
      const changedSources = [...watchedSourceTimes()].filter(([name, mtime]) => beforeSourceTimes.get(name) !== mtime)
        .map(([name, mtime]) => ({ name, modifiedAt: new Date(mtime).toISOString() }));
      return unexpectedAppendDiagnostic(response, raw, iteration, [worker.owner, a.read, a.write, a.comment, big.read, big.write, big.comment], { startedAt, changedSources });
    };
    let guarded = false;
    for (let i = 0; i < 80; i++) {
      response = await fetch(bigBase, { method: 'POST', headers: bigHeaders, body: JSON.stringify({ ticketUuid: original.ticketUuid, text: `${i}\n${text}`, ...(i === 0 ? { status: 'Closed' } : {}) }) });
      // Drain EVERY response before the next append, including successful writes.
      const raw = await response.text();
      if (response.status === 413) {
        let error;
        try { error = JSON.parse(raw); } catch { /* reported through sanitized diagnostics below */ }
        assert.equal(error?.code === 'discussion_too_large', true, appendDiagnostic(response, raw, i));
        guarded = true;
        break;
      }
      if (response.status !== 200) assert.equal(response.status, 200, appendDiagnostic(response, raw, i));
    }
    assert.equal(guarded, true, 'preflight bounds any one materialized history before WASM reads it');
    response = await fetch(bigBase, { headers: bigHeaders });
    assert.equal(response.status, 413);
    const error = await response.json();
    assert.equal(error.code, 'discussion_too_large');
    assert.equal('tickets' in error, false, 'oversized result is an explicit error, not a partial success');
    assert.equal(error.ticketUuid, original.ticketUuid);
    assert.ok(Number.isSafeInteger(error.ref) && error.ref > 0);
    assert.ok(error.resumeCursor, 'reader can explicitly continue after the identified oversized candidate');
    response = await fetch(`${bigBase}?cursor=${encodeURIComponent(error.resumeCursor)}`, { headers: bigHeaders });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).tickets.map(t => t.uuid), [older.ticketUuid]);
    response = await fetch(`${bigBase}?thread=${original.ticketUuid}`, { headers: bigHeaders });
    assert.equal(response.status, 413, 'exact lookup reuses the same pre-expansion history budget');
    const directError = await response.json();
    assert.equal(directError.code, 'discussion_too_large');
    assert.equal(directError.resumeCursor, null, 'exact lookup never offers to skip its selected target');
    response = await fetch(`${bigBase}?filter=open`, { headers: bigHeaders });
    assert.equal(response.status, 200, 'metadata-excluded histories are never expanded');
    assert.deepEqual((await response.json()).tickets.map(t => t.uuid), [older.ticketUuid]);
    const profileResponse = await fetch(`${worker.base}/api/artifacts/${big.id}/guest`, { method: 'PUT', headers: bigHeaders, body: JSON.stringify({ name: 'Following reader' }) });
    assert.equal(profileResponse.status, 200);
    const profileCookie = profileResponse.headers.getSetCookie().find(c => c.startsWith('hap_guest='))?.split(';')[0];
    assert.ok(profileCookie, 'following state has a real private guest identity');
    await profileResponse.arrayBuffer();
    const followHeaders = { Authorization: `Token ${big.read}`, Cookie: profileCookie, Origin: worker.base };
    const followResponse = await fetch(`${bigBase}/${older.ticketUuid}/view`, { method: 'PUT', headers: followHeaders, body: JSON.stringify({ following: true }) });
    assert.equal(followResponse.status, 200);
    await followResponse.arrayBuffer();
    response = await fetch(`${bigBase}?filter=following`, { headers: followHeaders });
    assert.equal(response.status, 200, 'an oversized unfollowed discussion never poisons the Following view');
    const following = await response.json();
    assert.deepEqual(following.tickets.map(t => t.uuid), [older.ticketUuid]);
    assert.equal(following.nextCursor, null, 'excluded oversized candidate needs neither an explicit skip nor continuation');
    const newerResponse = await fetch(bigBase, { method: 'POST', headers: bigHeaders, body: JSON.stringify({ text: 'Newer healthy discussion' }) });
    assert.equal(newerResponse.status, 201);
    const newer = await newerResponse.json();
    response = await fetch(bigBase, { headers: bigHeaders });
    assert.equal(response.status, 200);
    const preceding = await response.json();
    assert.deepEqual(preceding.tickets.map(t => t.uuid), [newer.ticketUuid], 'preceding normal cohort is not discarded');
    assert.ok(preceding.nextCursor);
    response = await fetch(`${bigBase}?cursor=${encodeURIComponent(preceding.nextCursor)}`, { headers: bigHeaders });
    assert.equal(response.status, 413, 'normal cursor stops BEFORE the oversized candidate');
    const nextError = await response.json();
    response = await fetch(`${bigBase}?cursor=${encodeURIComponent(nextError.resumeCursor)}`, { headers: bigHeaders });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).tickets.map(t => t.uuid), [older.ticketUuid]);
    response = await fetch(`${bigBase}?q=Older`, { headers: bigHeaders });
    assert.equal(response.status, 413);
    const searchError = await response.json();
    assert.ok(searchError.resumeCursor);
    response = await fetch(`${bigBase}?q=Older&cursor=${encodeURIComponent(searchError.resumeCursor)}`, { headers: bigHeaders });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).tickets.map(t => t.uuid), [older.ticketUuid], 'explicit continuation preserves global search availability');
    response = await fetch(`${bigBase}?q=Different&cursor=${encodeURIComponent(searchError.resumeCursor)}`, { headers: bigHeaders });
    assert.equal(response.status, 400, 'oversized resume cursor remains query-bound');
  } finally {
    worker?.stop();
    rmSync(work, { recursive: true, force: true });
  }
});
