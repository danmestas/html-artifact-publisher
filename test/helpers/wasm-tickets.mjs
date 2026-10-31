import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import '../../src/wasm_exec.js';

// Drives the ticket ops of the built engine over an in-memory SQLite store,
// as the Durable Object does: a reader comment is a Fossil ticket, a reply or
// a resolution is a change to it, and timelineSince tells which tickets
// arrived after a known artifact.
const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
globalThis.__dosql = (q, params) => {
  try {
    const statement = db.prepare(q);
    const cols = statement.columns().map(c => c.name);
    if (cols.length) {
      statement.setReturnArrays(true);
      const rows = statement.all(...params).map(row => row.map(v => v instanceof Uint8Array ? v.slice().buffer : v));
      return { cols, rows, id: 0, n: 0 };
    }
    if (params.length === 0) {
      db.exec(q);
      return { cols: [], rows: [], id: 0, n: 0 };
    }
    const result = statement.run(...params);
    return { cols: [], rows: [], id: Number(result.lastInsertRowid), n: Number(result.changes) };
  } catch (error) {
    return { error: error.message };
  }
};
const go = new Go();
const { instance } = await WebAssembly.instantiate(readFileSync(new URL('../../src/fossil.wasm', import.meta.url)), go.importObject);
go.run(instance);
// The TinyGo engine exports fossil_call (no scheduler, so no js.FuncOf); a
// standard Go build installs globalThis.fossilDO instead.
const engine = instance.exports.fossil_call ? {
  call(request, body) {
    globalThis.__fossilIn = [request, body];
    try { instance.exports.fossil_call(); return globalThis.__fossilOut; } finally { globalThis.__fossilIn = globalThis.__fossilOut = undefined; }
  },
} : globalThis.fossilDO;

function call(request) {
  db.exec('SAVEPOINT request');
  let reply;
  try {
    reply = JSON.parse(engine.call(JSON.stringify({ user: 'reader', comment: 'Ticket test', ...request })));
    if (!reply.ok || reply.aborted) db.exec('ROLLBACK TO request');
  } finally {
    db.exec('RELEASE request');
  }
  return reply;
}
function ok(request) {
  const reply = call(request);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.result;
}
const b64 = value => Buffer.from(value).toString('base64');

const tip = ok({ op: 'create', projectName: 'Comments', readToken: 'r', writeToken: 'w', files: { 'index.html': b64('<h1>page</h1>') } }).tip;
const tipUuid = ok({ op: 'info' });
assert.ok(tip);

const first = ok({ op: 'ticketAdd', fields: { title: 'Heading is unclear', status: 'Open', type: 'Comment' }, comment: 'The second heading reads oddly.' });
assert.match(first.ticketUuid, /^[0-9a-f]{40}$/);
assert.match(first.artifact, /^[0-9a-f]{40}([0-9a-f]{24})?$/);
const second = ok({ op: 'ticketAdd', fields: { title: 'Typo in footer', status: 'Open', type: 'Comment' }, comment: '' });
const reply = ok({ op: 'ticketSet', ticketUuid: first.ticketUuid, fields: { status: 'Closed' }, comment: 'Reworded in the next version.' });
assert.match(reply.artifact, /^[0-9a-f]{40}([0-9a-f]{24})?$/);

const tickets = ok({ op: 'ticketList' });
assert.equal(tickets.length, 2);
const byId = Object.fromEntries(tickets.map(t => [t.uuid ?? t.ticketUuid ?? t.tkt_uuid, t]));
const statusOf = t => t.status ?? t.fields?.status;
assert.equal(statusOf(byId[first.ticketUuid]), 'Closed', JSON.stringify(tickets));
assert.equal(statusOf(byId[second.ticketUuid]), 'Open', JSON.stringify(tickets));

const changes = ok({ op: 'ticketChanges', ticketUuid: first.ticketUuid });
assert.equal(changes.length, 2, JSON.stringify(changes));

// Threads in one call, newest-changed first, capped by limit.
const threads = ok({ op: 'ticketThreads', limit: 1 });
assert.equal(threads.truncated, true, JSON.stringify(threads));
assert.equal(threads.limit, 1);
assert.equal(threads.tickets.length, 1);
assert.equal(threads.tickets[0].uuid, first.ticketUuid, 'the most recently changed');
assert.equal(threads.tickets[0].changes.length, 2);
const all = ok({ op: 'ticketThreads', limit: 200 });
assert.equal(all.truncated, false);
assert.deepEqual(all.tickets.map(t => t.uuid).sort(), [first.ticketUuid, second.ticketUuid].sort());

const since = ok({ op: 'timelineSince', hash: tip, types: ['t'] });
assert.equal(since.length, 3, JSON.stringify(since));
assert.ok(since.every(e => e.type === 't'), JSON.stringify(since));
assert.deepEqual(ok({ op: 'timelineSince', hash: reply.artifact, types: [] }), []);

const unknown = call({ op: 'ticketSet', ticketUuid: '0'.repeat(40), fields: { status: 'Closed' } });
assert.notEqual(unknown.ok, true);
assert.equal(ok({ op: 'ticketList' }).length, 2, 'a failed write leaves the tickets as they were');

const unchanged = call({ op: 'commit', parent: tip.slice(0, 12), files: { 'index.html': b64('<h1>page</h1>') } });
assert.equal(unchanged.ok, undefined);
assert.equal(unchanged.code, 'unchanged');
assert.deepEqual(unchanged.result, { tip }, 'unchanged replies carry the canonical tip validated at the commit boundary');
const newer = ok({ op: 'commit', parent: tip, files: { 'index.html': b64('<h1>Newer</h1>') } });
assert.notEqual(newer.tip, tip);
assert.equal(unchanged.result.tip, tip, 'a later commit cannot change the acknowledged metadata-only base');
assert.equal(call({ op: 'commit', parent: tip, files: { 'index.html': b64('<h1>page</h1>') } }).code, 'conflict');

console.log(JSON.stringify({ tickets: tickets.length, changes: changes.length, since: since.length, info: Boolean(tipUuid) }));
