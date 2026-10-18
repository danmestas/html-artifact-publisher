#!/usr/bin/env node
// Checks Pikchr diagrams and makes Pikchr Studio links. The viewer renders the
// diagrams in a page itself; this is for catching errors before publishing.
//
//   node skills/pikchr/render.mjs diagram.pikchr --check   # one source file (or - for stdin)
//   node skills/pikchr/render.mjs page.html --check        # every <pre class="pikchr"> in a page
//   node skills/pikchr/render.mjs diagram.pikchr --studio  # print a Pikchr Studio link
//   node skills/pikchr/render.mjs diagram.pikchr --svg [--dark]   # SVG for use outside artifacts
//
// The renderer is the viewer's own wasm: public/pikchr/ when run inside the
// html-artifact-publisher repo, otherwise downloaded once from
// $HTML_PUBLISHER_URL/pikchr/ into ~/.cache/html-artifact-publisher/pikchr/.
// Exit 0 on success, 1 on a Pikchr error (printed to stderr), 2 on bad usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STUDIO = process.env.PIKCHR_STUDIO_URL || 'https://pikchr-studio.daniel-mestas.workers.dev/';
const usage = 'usage: render.mjs <file.pikchr | page.html | -> (--check | --studio | --svg [--dark])';

const args = process.argv.slice(2);
const bool = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const check = bool('--check'), studio = bool('--studio'), svg = bool('--svg'), dark = bool('--dark');
if (args.length !== 1 || args[0].startsWith('--') || check + studio + svg !== 1) { console.error(usage); process.exit(2); }
const input = fs.readFileSync(args[0] === '-' ? 0 : args[0], 'utf8');

if (studio) {
  console.log(STUDIO + '#z=' + zlib.deflateRawSync(Buffer.from(input, 'utf8')).toString('base64url'));
  process.exit(0);
}

// In the repo, scripts/pikchr.mjs and public/pikchr/ sit two levels up.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoHelper = path.resolve(here, '../../scripts/pikchr.mjs');
let loadPikchr, pikchrBlocks, dir;
if (fs.existsSync(repoHelper) && fs.existsSync(path.resolve(here, '../../public/pikchr/pikchr.wasm'))) {
  ({ loadPikchr, pikchrBlocks } = await import(pathToFileURL(repoHelper)));
} else {
  ({ loadPikchr, pikchrBlocks } = await standalone());
}
const pikchr = await loadPikchr(dir);

if (svg) {
  const r = pikchr(input, { dark });
  if (r.error) { console.error(r.error); process.exit(1); }
  process.stdout.write(r.svg);
  process.exit(0);
}

const isHtml = /\.html?$/i.test(args[0]) || /^\s*<(!doctype|html|head|body|pre)\b/i.test(input);
const blocks = isHtml ? pikchrBlocks(input) : [{ source: input, line: 1 }];
if (isHtml && !blocks.length) { console.error('no <pre class="pikchr"> blocks found'); process.exit(0); }
let failed = 0;
for (const b of blocks) {
  const r = pikchr(b.source);
  const where = isHtml ? `diagram at line ${b.line}` : 'diagram';
  if (r.error) { failed++; console.error(`${where}:\n${r.error}\n`); }
  else console.error(`ok: ${where}, ${r.width}×${r.height} px`);
}
process.exit(failed ? 1 : 0);

// Outside the repo: fetch the viewer's wasm once and keep the helpers inline.
async function standalone() {
  const base = process.env.HTML_PUBLISHER_URL;
  dir = path.join(os.homedir(), '.cache', 'html-artifact-publisher', 'pikchr');
  for (const f of ['pikchr.js', 'pikchr.wasm']) {
    if (fs.existsSync(path.join(dir, f))) continue;
    if (!base) { console.error('Set HTML_PUBLISHER_URL so the Pikchr renderer can be downloaded from the publisher.'); process.exit(2); }
    const r = await fetch(new URL(`/pikchr/${f}`, base));
    if (!r.ok) { console.error(`could not download ${f}: HTTP ${r.status}`); process.exit(2); }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, f), Buffer.from(await r.arrayBuffer()));
  }
  const vm = await import('node:vm');
  const { createRequire } = await import('node:module');
  return {
    async loadPikchr(dir) {
      const context = vm.createContext({ require: createRequire(import.meta.url), process, console, URL, TextDecoder, TextEncoder,
        setTimeout, __dirname: dir, __filename: path.join(dir, 'pikchr.js') });
      vm.runInContext(fs.readFileSync(path.join(dir, 'pikchr.js'), 'utf8'), context);
      const wasm = await context.initPikchrModule({ locateFile: p => path.join(dir, p) });
      const fn = wasm.cwrap('pikchr', 'number', ['string', 'string', 'number', 'number', 'number']);
      return (source, { dark = false } = {}) => {
        const size = wasm._malloc(8);
        try {
          const p = fn(source, 'pikchr', 1 | (dark ? 2 : 0), size, size + 4);
          const text = wasm.UTF8ToString(p); wasm._free(p);
          const view = new DataView(wasm.HEAPU8.buffer);
          const width = view.getInt32(size, true), height = view.getInt32(size + 4, true);
          return width < 0 ? { error: text.trim() } : { svg: text, width, height };
        } finally { wasm._free(size); }
      };
    },
    pikchrBlocks(html) {
      const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      return [...html.matchAll(/<pre\b[^>]*\bclass\s*=\s*["']?[^"'>]*\bpikchr\b[^>]*>([\s\S]*?)<\/pre\s*>/gi)].map(m => ({
        source: m[1].replace(/&(#\d+|[a-z]+);/gi, (s, e) => e[0] === '#' ? String.fromCodePoint(+e.slice(1)) : ent[e] ?? s),
        line: html.slice(0, m.index).split('\n').length,
      }));
    },
  };
}
