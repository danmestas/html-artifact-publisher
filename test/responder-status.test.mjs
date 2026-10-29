import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStatus, resolveChange, statusFrom, statusRequest as fromBody, STATUS_ENTRIES_MAX } from '../src/responder-status.ts';

// The route parses the body as JSON first; text that is not JSON never reaches it.
const statusRequest = text => { try { return fromBody(JSON.parse(text)); } catch { return null; } };
const file = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64');
const hex = (c, n = 40) => c.repeat(n);
const T0 = '2026-10-29T10:00:00.000Z', T1 = '2026-10-29T10:00:05.000Z', T2 = '2026-10-29T10:01:00.000Z';

// The body of PUT …/responder-status: exactly these keys, or nothing.
test('statusRequest: change, state and an optional one-line step; anything else is refused', () => {
  assert.deepEqual(statusRequest('{"change":"0123456789","state":"seen"}'), { change: '0123456789', state: 'seen' });
  assert.deepEqual(statusRequest(JSON.stringify({ change: hex('a', 64), state: 'working', step: 'reading the page' })),
    { change: hex('a', 64), state: 'working', step: 'reading the page' });
  for (const state of ['delivered', 'seen', 'working', 'done', 'failed']) assert.equal(statusRequest(JSON.stringify({ change: hex('b', 10), state })).state, state);
  assert.equal(statusRequest(JSON.stringify({ change: 'a', state: 'seen', step: 'x'.repeat(80) })), null, 'change too short');
  assert.equal(statusRequest(JSON.stringify({ change: hex('a', 10), state: 'seen', step: 'x'.repeat(80) })).step.length, 80, 'the step limit is inclusive');
  for (const bad of ['', 'not json', 'null', '[]', '"seen"', '{}',
    JSON.stringify({ change: hex('a', 9), state: 'seen' }), JSON.stringify({ change: hex('a', 65), state: 'seen' }),
    JSON.stringify({ change: hex('A', 10), state: 'seen' }), JSON.stringify({ change: 'g'.repeat(10), state: 'seen' }),
    JSON.stringify({ change: 1234567890, state: 'seen' }), JSON.stringify({ change: hex('a', 10) }),
    JSON.stringify({ change: hex('a', 10), state: 'busy' }), JSON.stringify({ change: hex('a', 10), state: 'Seen' }),
    JSON.stringify({ change: hex('a', 10), state: 'seen', step: '' }), JSON.stringify({ change: hex('a', 10), state: 'seen', step: 'x'.repeat(81) }),
    JSON.stringify({ change: hex('a', 10), state: 'seen', step: 'two\nlines' }), JSON.stringify({ change: hex('a', 10), state: 'seen', step: 7 }),
    JSON.stringify({ change: hex('a', 10), state: 'seen', step: null }),
    JSON.stringify({ change: hex('a', 10), state: 'seen', extra: 1 }), JSON.stringify({ change: hex('a', 10), state: 'seen', ticketUuid: hex('c') })]) {
    assert.equal(statusRequest(bad), null, bad.slice(0, 60));
  }
});

const threads = [
  { uuid: hex('1'), changes: [{ artifact: 'abc0000001' + hex('0', 30) }, { artifact: 'abc0000002' + hex('0', 30) }] },
  { uuid: hex('2'), changes: [{ artifact: 'abc0000003' + hex('0', 30) }] },
];

test('resolveChange: a prefix names one thread, none, or is ambiguous across threads', () => {
  assert.deepEqual(resolveChange(threads, 'abc0000002'), { ticketUuid: hex('1'), change: 'abc0000002' + hex('0', 30) });
  assert.deepEqual(resolveChange(threads, 'abc0000003' + hex('0', 30)), { ticketUuid: hex('2'), change: 'abc0000003' + hex('0', 30) }, 'a full hash');
  assert.equal(resolveChange(threads, 'abc0000004'), 'none');
  assert.equal(resolveChange([], 'abc0000001'), 'none');
  assert.equal(resolveChange(threads, 'abc000000'), 'many', 'two threads hold a change with this prefix');
  // Both changes of one thread match: still that one thread, its newest matching change.
  assert.deepEqual(resolveChange(threads.slice(0, 1), 'abc000000'), { ticketUuid: hex('1'), change: 'abc0000002' + hex('0', 30) });
});

test('applyStatus: since kept for the same change, reset for another; updated always; step omitted; done deletes', () => {
  const t = hex('1'), c1 = hex('a'), c2 = hex('b');
  let f = applyStatus({ threads: {} }, t, c1, 'delivered', undefined, T0);
  assert.deepEqual(f, { threads: { [t]: { change: c1, state: 'delivered', since: T0, updated: T0 } } });
  assert.equal('step' in f.threads[t], false, 'no step key when none was given');
  f = applyStatus(f, t, c1, 'working', 'reading the page', T1);
  assert.deepEqual(f.threads[t], { change: c1, state: 'working', step: 'reading the page', since: T0, updated: T1 });
  f = applyStatus(f, t, c1, 'seen', undefined, T1);
  assert.equal('step' in f.threads[t], false, 'a write without a step drops the old one');
  f = applyStatus(f, t, c2, 'seen', 'reading the thread', T2);
  assert.deepEqual(f.threads[t], { change: c2, state: 'seen', step: 'reading the thread', since: T2, updated: T2 }, 'another change starts over');
  const other = applyStatus(f, hex('2'), c1, 'delivered', undefined, T2);
  assert.equal(Object.keys(other.threads).length, 2);
  const done = applyStatus(other, t, c2, 'done', undefined, T2);
  assert.deepEqual(Object.keys(done.threads), [hex('2')], 'done deletes only its thread');
  assert.deepEqual(applyStatus({ threads: {} }, t, c1, 'done', undefined, T0), { threads: {} }, 'done with nothing stored');
  assert.equal(Object.keys(f.threads).length, 1, 'the input is not mutated');
});

test('applyStatus: at most 200 entries; the oldest updated goes first', () => {
  assert.equal(STATUS_ENTRIES_MAX, 200);
  let f = { threads: {} };
  const at = i => new Date(Date.parse(T0) + i * 1000).toISOString();
  // Written out of order, so insertion order is not what decides.
  for (let i = 0; i < 200; i++) {
    const n = (i * 37) % 200;
    f = applyStatus(f, n.toString(16).padStart(40, '0'), hex('a'), 'delivered', undefined, at(n));
  }
  assert.equal(Object.keys(f.threads).length, 200);
  f = applyStatus(f, hex('f'), hex('a'), 'delivered', undefined, at(500));
  assert.equal(Object.keys(f.threads).length, 200);
  assert.equal((0).toString(16).padStart(40, '0') in f.threads, false, 'the oldest is dropped');
  assert.equal((1).toString(16).padStart(40, '0') in f.threads, true, 'the next oldest stays');
  assert.equal(hex('f') in f.threads, true, 'the new entry stays');
  // Updating an existing entry at the cap drops nothing.
  const again = applyStatus(f, (1).toString(16).padStart(40, '0'), hex('a'), 'seen', undefined, at(501));
  assert.equal(Object.keys(again.threads).length, 200);
  assert.equal((2).toString(16).padStart(40, '0') in again.threads, true);
});

// The file is unversioned and an edit link's clone can push any bytes as it,
// so a reader gets only valid entries, and an unusable file reads as empty.
test('statusFrom: valid entries only; an unusable file reads as no entries', () => {
  const good = { change: hex('a'), state: 'working', step: 'reading the page', since: T0, updated: T1 };
  assert.deepEqual(statusFrom(file({ threads: { [hex('1')]: good } })), { threads: { [hex('1')]: good } });
  assert.deepEqual(statusFrom(file({ threads: { [hex('1')]: { ...good, extra: 'x' } } })), { threads: { [hex('1')]: good } }, 'unknown keys dropped');
  const { step, ...noStep } = good;
  assert.deepEqual(statusFrom(file({ threads: { [hex('1')]: noStep } })).threads[hex('1')], noStep);
  for (const bad of [null, undefined, '', '!!!', file(''), file('null'), file('[]'), file('{}'), file({ threads: [] }), file({ threads: null }),
    file({ threads: { x: 1 } }), file(' '.repeat(140000) + '{"threads":{}}')]) {
    assert.deepEqual(statusFrom(bad), { threads: {} }, String(bad).slice(0, 30));
  }
  const entries = statusFrom(file({ threads: {
    [hex('1')]: good,
    [hex('2')]: { ...good, state: 'done' },
    [hex('3')]: { ...good, state: 'bogus' },
    [hex('4')]: { ...good, change: 'nothex' },
    [hex('5')]: { ...good, step: 'a\nb' },
    [hex('6')]: { ...good, since: 'yesterday' },
    [hex('7')]: { ...good, updated: undefined },
    'not-a-uuid': good,
    [hex('8')]: { ...good, step: '<img src=x onerror=alert(1)>' },
  } })).threads;
  assert.deepEqual(Object.keys(entries).sort(), [hex('1'), hex('8')], 'invalid entries are dropped, the rest kept');
  assert.equal(entries[hex('8')].step, '<img src=x onerror=alert(1)>', 'text is text: the viewer never renders it as markup');
  const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [i.toString(16).padStart(40, '0'), good]));
  assert.equal(Object.keys(statusFrom(file({ threads: many })).threads).length, 200, 'at most 200 entries are read');
});
