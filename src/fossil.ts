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
  const instance = new WebAssembly.Instance(wasm, go.importObject);
  go.run(instance);
  // The TinyGo engine runs without a scheduler, so it cannot answer through a
  // js.FuncOf callback: it exports fossil_call, which takes its arguments from
  // __fossilIn and leaves the reply in __fossilOut (fossil/export_js.go). A
  // standard Go build (GO_COMPILER=go) installs fossilDO instead.
  const call = (instance.exports as { fossil_call?: () => void }).fossil_call;
  if (call) {
    const g = globalThis as unknown as { __fossilIn?: [string, Uint8Array | undefined]; __fossilOut?: string };
    api = {
      call(request, body) {
        g.__fossilIn = [request, body];
        try {
          call();
          return g.__fossilOut as string;
        } finally {
          g.__fossilIn = g.__fossilOut = undefined;
        }
      },
    };
  } else {
    api = (globalThis as unknown as { fossilDO: FossilApi }).fossilDO;
  }
  if (!api) throw new Error('the Fossil engine did not start');
  return api;
}

type Param = string | number | null | ArrayBuffer;

(globalThis as Record<string, unknown>).__dosql = (q: string, params: unknown[]) => {
  if (!current) return { error: 'no repository is bound to this call' };
  try {
    // Keep the repository's storage contract independent of workerd's SQLite
    // limit (newer local runtimes may allow larger rows). HTTP writes already
    // check this in fossil/limits.go; Fossil sync reaches this adapter directly.
    // Match maxStored there, and let dosql's existing SQLITE_TOOBIG path abort
    // the entire transaction instead of acknowledging an unstorable sync.
    if (params.some(p => p instanceof Uint8Array && p.byteLength > 1_990_000)) {
      return { error: 'SQLITE_TOOBIG: artifact exceeds the repository storage limit' };
    }
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
