// fossil.js — loads go-libfossil's wasm build (wasm/main.go) and returns its
// API with errors turned into exceptions. Works in the browser and in Node.
//
//   const fossil = await loadFossil(gzippedWasmBytes);
//   fossil.create('title', 'user'); fossil.commit({ 'index.html': bytes }, 'msg', 'user');
//   const file = fossil.export();

let loaded = null;

export function loadFossil(wasmGz) {
  return (loaded ??= start(wasmGz));
}

async function start(wasmGz) {
  await import('../wasm_exec.js');
  const wasm = await gunzip(wasmGz);
  const ready = new Promise(resolve => { globalThis.onFossilReady = resolve; });
  const go = new globalThis.Go();
  const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
  go.run(instance);
  await ready;
  const api = {};
  for (const [name, f] of Object.entries(globalThis.fossil)) {
    api[name] = (...args) => {
      const out = f(...args);
      if (typeof out !== 'string') return out;
      const v = JSON.parse(out);
      if (v && typeof v === 'object' && !Array.isArray(v) && 'error' in v) throw new Error(v.error);
      return v;
    };
  }
  return api;
}

async function gunzip(bytes) {
  bytes = new Uint8Array(bytes);
  // Already inflated (a server sent it with Content-Encoding: gzip).
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
