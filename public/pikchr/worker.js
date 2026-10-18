// Renders Pikchr for the viewer. It runs as a Web Worker so the wasm never
// needs the viewer's CSP (which the page iframe inherits) to allow WebAssembly.
// Request: {id, source}. Reply: {id, light, dark, width, height} or {id, error}.
const PLAINTEXT_ERRORS = 1, DARK_MODE = 2;
const MAX_SOURCE = 100_000;

const ready = (async () => {
  importScripts('pikchr.js');
  const wasm = await initPikchrModule();
  return { wasm, pikchr: wasm.cwrap('pikchr', 'number', ['string', 'string', 'number', 'number', 'number']) };
})();

function render({ wasm, pikchr }, source, flags) {
  const size = wasm._malloc(8);
  try {
    const p = pikchr(source, 'pikchr', flags, size, size + 4);
    const text = wasm.UTF8ToString(p);
    wasm._free(p);
    const view = new DataView(wasm.HEAPU8.buffer);
    return { text, width: view.getInt32(size, true), height: view.getInt32(size + 4, true) };
  } finally {
    wasm._free(size);
  }
}

self.onmessage = async ({ data }) => {
  const { id, source } = data ?? {};
  const reply = msg => self.postMessage({ id, ...msg });
  try {
    if (typeof source !== 'string') throw new Error('Pikchr source must be a string');
    if (source.length > MAX_SOURCE) throw new Error('Pikchr source is over 100 KB');
    if (source.includes('\0')) throw new Error('Pikchr source contains a NUL character');
    const r = await ready;
    const light = render(r, source, PLAINTEXT_ERRORS);
    if (light.width < 0) return reply({ error: light.text.trim() });
    const dark = render(r, source, PLAINTEXT_ERRORS | DARK_MODE);
    reply({ light: light.text, dark: dark.text, width: light.width, height: light.height });
  } catch (e) {
    reply({ error: String(e?.message ?? e) });
  }
};
