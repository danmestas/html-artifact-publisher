import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import '../../src/wasm_exec.js';

const database = () => new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
let db = database();
let failAfterBlobs = 0;
globalThis.__dosql = (q, params) => {
  try {
    if (failAfterBlobs && /INSERT INTO blob\(/i.test(q) && --failAfterBlobs === 0) {
      throw new Error('injected storage failure');
    }
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
let peak = 0;
function call(request) {
  db.exec('SAVEPOINT request');
  let reply;
  try {
    reply = JSON.parse(globalThis.fossilDO.call(JSON.stringify({ user: 'memory-test', comment: 'Memory regression', ...request })));
    if (!reply.ok || reply.aborted) db.exec('ROLLBACK TO request');
  } catch (error) {
    db.exec('ROLLBACK TO request');
    throw error;
  } finally {
    db.exec('RELEASE request');
    peak = Math.max(peak, instance.exports.memory.buffer.byteLength);
  }
  return reply;
}
function ok(request) {
  const reply = call(request);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.aborted, undefined, JSON.stringify(reply));
  return reply.result;
}
const b64 = value => Buffer.from(value).toString('base64');
let tip = ok({ op: 'create', projectName: 'Memory regression', readToken: 'reader', writeToken: 'editor', files: { 'index.html': b64('<h1>original</h1>') } }).tip;
const files = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`tiny-${i}.txt`, b64(String(i))]));
tip = ok({ op: 'commit', parent: tip, files }).tip;
// Deterministic incompressible bytes stand in for already-compressed images.
for (let i = 0; i < 8; i++) {
  const bytes = Buffer.concat(Array.from({ length: 1024 }, (_, j) => createHash('sha256').update(`${i}:${j}`).digest()));
  files[`image-${i}.bin`] = b64(bytes);
}
for (let version = 0; version < 12; version++) {
  files['index.html'] = b64(`<h1>version ${version}</h1>`);
  tip = ok({ op: 'commit', parent: tip, files }).tip;
  const bundle = ok({ op: 'bundle' });
  assert.equal(bundle.files['index.html'], files['index.html']);
  for (const [name, content] of Object.entries(files)) assert.equal(bundle.files[name], content, name);
}
const beforeBlobs = db.prepare('SELECT count(*) AS n FROM blob').get().n;
failAfterBlobs = 3;
const failed = call({ op: 'commit', parent: tip, files: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`rejected-${i}.txt`, b64(`new ${i}`)])) });
assert.notEqual(failed.ok, true);
assert.match(failed.error, /injected storage failure/);
assert.equal(failAfterBlobs, 0, 'failure occurs after earlier blob writes');
assert.equal(db.prepare('SELECT count(*) AS n FROM blob').get().n, beforeBlobs, 'failed request rolls back all writes');
assert.equal(ok({ op: 'tip' }).tip, tip);
const rejected = call({ op: 'commit', parent: '00000000', files: { 'index.html': b64('must not land') } });
assert.equal(rejected.code, 'conflict');
assert.equal(ok({ op: 'tip' }).tip, tip);
assert.equal(ok({ op: 'bundle' }).files['index.html'], files['index.html']);
tip = ok({ op: 'commit', parent: tip, files: { 'recovery.txt': b64('recovered') } }).tip;
const first = db;
const second = database();
db = second;
const otherTip = ok({ op: 'create', projectName: 'Other repository', readToken: 'reader', writeToken: 'editor', files: { 'index.html': b64('<h1>other repository</h1>') } }).tip;
for (let i = 0; i < 8; i++) {
  db = first;
  assert.equal(ok({ op: 'tip' }).tip, tip);
  assert.equal(ok({ op: 'bundle' }).files['recovery.txt'], b64('recovered'));
  db = second;
  assert.equal(ok({ op: 'tip' }).tip, otherTip);
  assert.equal(ok({ op: 'bundle' }).files['recovery.txt'], undefined);
}
first.close();
second.close();
console.log(JSON.stringify({ peakWasmBytes: peak, updates: 14, files: Object.keys(files).length }));
process.exit(0);
