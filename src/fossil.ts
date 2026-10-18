/**
 * The Fossil engine: go-libfossil compiled to wasm (fossil/), shared by every
 * repository object in this isolate.
 *
 * run() makes one synchronous call into Go inside one SQLite transaction of
 * the calling object. Go reaches that object's storage through the single
 * __dosql dispatcher below, which points at `current` only for the duration
 * of the call, so objects sharing the runtime never see each other's data.
 */

import './wasm_exec.js';
import wasm from './fossil.wasm';

export interface FossilRequest {
  op: string;
  [key: string]: unknown;
}

export interface FossilReply<T = Record<string, unknown>> {
  ok?: boolean;
  result?: T;
  error?: string;
  code?: string;
  aborted?: string;
}

interface FossilApi {
  call(request: string, body?: Uint8Array): string;
}

let api: FossilApi | null = null;
let current: SqlStorage | null = null;

function boot(): FossilApi {
  if (api) return api;
  const go = new Go();
  go.run(new WebAssembly.Instance(wasm, go.importObject));
  api = (globalThis as unknown as { fossilDO: FossilApi }).fossilDO;
  if (!api) throw new Error('the Fossil engine did not start');
  return api;
}

type Param = string | number | null | ArrayBuffer;

(globalThis as Record<string, unknown>).__dosql = (q: string, params: unknown[]) => {
  if (!current) return { error: 'no repository is bound to this call' };
  try {
    const ps: Param[] = params.map(p => (p instanceof Uint8Array ? p.slice().buffer : (p as Param)));
    const cur = current.exec(q, ...ps);
    const rows = [...cur.raw()];
    let id = 0, n = 0;
    if (cur.rowsWritten > 0) {
      const meta = current.exec('SELECT last_insert_rowid(), changes()').raw().next().value as [number, number];
      [id, n] = meta;
    }
    return { cols: cur.columnNames, rows, id, n };
  } catch (e) {
    return { error: String((e as Error).message ?? e) };
  }
};

class Abort extends Error {}

/**
 * Run one request against `storage`. A failed or rolled-back request leaves
 * the database exactly as it was.
 */
export function run<T>(storage: DurableObjectStorage, request: FossilRequest, body?: Uint8Array): FossilReply<T> {
  const fossil = boot();
  let reply: FossilReply<T> = {};
  try {
    storage.transactionSync(() => {
      current = storage.sql;
      reply = JSON.parse(fossil.call(JSON.stringify(request), body)) as FossilReply<T>;
      if (!reply.ok || reply.aborted) throw new Abort();
    });
  } catch (e) {
    if (!(e instanceof Abort)) throw e;
    if (reply.ok || reply.aborted) reply = { error: reply.aborted ?? reply.error, code: reply.aborted?.includes('too large') ? 'too_large' : (reply.code ?? 'aborted') };
  } finally {
    current = null;
  }
  return reply;
}
