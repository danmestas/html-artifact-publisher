import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Artifact, ApiError, ConflictError } from '../public/client.js';

test('discussion client preserves no-argument reads and explicit correction/view contracts', async t => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
    return Response.json({ tickets: [], nextCursor: null });
  };
  t.after(() => { globalThis.fetch = original; });
  const art = new Artifact('https://example.test', 'fixture', '');
  await art.tickets();
  assert.equal(calls[0].url, 'https://example.test/api/artifacts/fixture/tickets');
  await art.tickets({ limit: 25, cursor: 'opaque cursor', q: 'two words', filter: 'mine', sort: 'reference', identity: 'account' });
  const query = new URL(calls[1].url).searchParams;
  assert.deepEqual(Object.fromEntries(query), { limit: '25', cursor: 'opaque cursor', q: 'two words', filter: 'mine', sort: 'reference', identity: 'account' });
  await art.editComment('ticket', 'message', 'Revised', { identity: 'guest' });
  assert.deepEqual(calls[2], { url: 'https://example.test/api/artifacts/fixture/tickets/ticket/messages/message', method: 'PATCH', body: { text: 'Revised', identity: 'guest' } });
  await art.discussionView('ticket', 'message', true, { identity: 'account' });
  assert.deepEqual(calls[3], { url: 'https://example.test/api/artifacts/fixture/tickets/ticket/view', method: 'PUT', body: { readThrough: 'message', following: true, identity: 'account' } });
  await art.discussionView('ticket', undefined, false);
  assert.deepEqual(calls[4].body, { following: false });
});

test('discussion mutators carry captured identity only as a dedicated optional precondition header', async t => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => { calls.push(options); return Response.json({}); };
  t.after(() => { globalThis.fetch = original; });
  const art = new Artifact('https://example.test', 'fixture', '');
  await art.comment({ text: 'Captured draft', identity: 'account' }, { expectedIdentity: 'account:captured', auth: 'ignored', headers: { Authorization: 'ignored' } });
  await art.editComment('ticket', 'message', 'Corrected', { identity: 'account', expectedIdentity: 'account:captured' });
  await art.discussionView('ticket', 'message', true, { identity: 'guest', expectedIdentity: 'guest:captured' });
  await art.comment({ text: 'Initial anonymous draft' }, { expectedIdentity: null });
  assert.deepEqual(calls.map(c => c.headers['X-Comment-Identity']), ['account:captured', 'account:captured', 'guest:captured', undefined]);
  assert.equal(calls.some(c => Object.hasOwn(c.headers, 'Authorization')), false, 'public options cannot override artifact authorization');
  assert.equal(calls.some(c => Object.hasOwn(JSON.parse(c.body), 'expectedIdentity')), false, 'precondition never becomes a claimed author in JSON');
});

test('API errors expose validated retry delay and never automatically repeat mutations', async t => {
  assert.equal(new ApiError(429, { retryAfter: 17 }).retryAfter, 17);
  assert.equal(new ApiError(429, { retryAfter: 17 }, new Headers({ 'Retry-After': '23' })).retryAfter, 23);
  for (const retryAfter of [undefined, null, -1, NaN, Infinity, 'not seconds']) assert.equal(new ApiError(429, { retryAfter }).retryAfter, 0);
  assert.equal(new ConflictError(409, { code: 'conflict', retryAfter: 4 }).retryAfter, 4);
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    return Response.json({ error: 'wait', code: 'rate_limited', retryAfter: 5 }, { status: 429, headers: { 'Retry-After': '13' } });
  };
  t.after(() => { globalThis.fetch = original; });
  const art = new Artifact('https://example.test', 'fixture', '');
  await assert.rejects(art.comment({ text: 'Only once' }), error => error instanceof ApiError && error.retryAfter === 13 && error.code === 'rate_limited');
  assert.equal(attempts, 1);
});

test('oversized discussion errors expose explicit validated continuation without automatically skipping', async t => {
  const original = globalThis.fetch;
  let attempts = 0;
  const ticketUuid = 'a'.repeat(40);
  const resumeCursor = JSON.stringify([1, 'bound query', ticketUuid]);
  globalThis.fetch = async () => {
    attempts++;
    return Response.json({ error: 'Oversized discussion', code: 'discussion_too_large', ticketUuid, ref: 17, resumeCursor }, { status: 413 });
  };
  t.after(() => { globalThis.fetch = original; });
  const art = new Artifact('https://example.test', 'fixture', '');
  await assert.rejects(art.tickets(), error => error.status === 413 && error.ticketUuid === ticketUuid && error.ref === 17 && error.resumeCursor === resumeCursor);
  assert.equal(attempts, 1, 'only the reader may deliberately continue past the identified history');
  const invalid = new ApiError(413, { code: 'discussion_too_large', ticketUuid: 'short', ref: -1, resumeCursor: 'x'.repeat(2049) });
  assert.equal(invalid.ticketUuid, null);
  assert.equal(invalid.ref, null);
  assert.equal(invalid.resumeCursor, null);
});
