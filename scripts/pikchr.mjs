// Pikchr in Node, from the same wasm the viewer uses (public/pikchr/).
// Used by publish-html.mjs to refuse pages whose diagrams don't render.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const PIKCHR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/pikchr');
const PLAINTEXT_ERRORS = 1, DARK_MODE = 2;

/** Loads the renderer from `dir` (pikchr.js + pikchr.wasm). */
export async function loadPikchr(dir = PIKCHR_DIR) {
  const context = vm.createContext({ require: createRequire(import.meta.url), process, console, URL, TextDecoder, TextEncoder,
    setTimeout, __dirname: dir, __filename: path.join(dir, 'pikchr.js') });
  vm.runInContext(fs.readFileSync(path.join(dir, 'pikchr.js'), 'utf8'), context);
  const wasm = await context.initPikchrModule({ locateFile: p => path.join(dir, p) });
  const pikchr = wasm.cwrap('pikchr', 'number', ['string', 'string', 'number', 'number', 'number']);
  /** {svg, width, height} or {error}. */
  return (source, { dark = false } = {}) => {
    const size = wasm._malloc(8);
    try {
      const p = pikchr(source, 'pikchr', PLAINTEXT_ERRORS | (dark ? DARK_MODE : 0), size, size + 4);
      const text = wasm.UTF8ToString(p);
      wasm._free(p);
      const view = new DataView(wasm.HEAPU8.buffer);
      const width = view.getInt32(size, true), height = view.getInt32(size + 4, true);
      return width < 0 ? { error: text.trim() } : { svg: text, width, height };
    } finally {
      wasm._free(size);
    }
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m);

/** The sources of the page's <pre class="pikchr"> blocks, with their line numbers. */
export function pikchrBlocks(html) {
  const out = [];
  for (const m of html.matchAll(/<pre\b([^>]*)>([\s\S]*?)<\/pre\s*>/gi)) {
    const cls = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    if (!cls || !(cls[1] ?? cls[2] ?? cls[3]).split(/\s+/).includes('pikchr')) continue;
    out.push({ source: decode(m[2]), line: html.slice(0, m.index).split('\n').length });
  }
  return out;
}
