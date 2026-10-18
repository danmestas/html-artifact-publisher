#!/usr/bin/env node
// Renders a Pikchr diagram to an HTML <figure> that works inside the artifact
// viewer: two inline SVGs (light and dark, swapped by prefers-color-scheme),
// no scripts, no wasm at view time. Uses the Pikchr Studio wasm build in
// ./vendor, so it needs nothing but Node 18+. The SVG that is hidden by the theme is
// display:none, so screen readers meet one diagram, not two.
//
//   node skills/pikchr/render.mjs diagram.pikchr --alt "What it shows" [--caption "..."] [--out fig.html]
//   node skills/pikchr/render.mjs diagram.pikchr --check     # render errors only
//   node skills/pikchr/render.mjs diagram.pikchr --studio    # print a Pikchr Studio link
//
// Exit 0 on success, 1 on a Pikchr error (printed to stderr), 2 on bad usage.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const STUDIO = process.env.PIKCHR_STUDIO_URL || 'https://pikchr-studio.daniel-mestas.workers.dev/';
const PLAINTEXT_ERRORS = 1, DARK_MODE = 2;

const usage = `usage: render.mjs <file.pikchr | -> [--alt <text>] [--caption <text>] [--out <file>]
                  [--check] [--studio] [--no-style]`;
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const alt = flag('--alt'), caption = flag('--caption'), out = flag('--out');
const check = bool('--check'), studio = bool('--studio'), noStyle = bool('--no-style');
if (args.length !== 1 || args[0].startsWith('--')) { console.error(usage); process.exit(2); }
const source = fs.readFileSync(args[0] === '-' ? 0 : args[0], 'utf8');

if (studio) {
  const z = zlib.deflateRawSync(Buffer.from(source, 'utf8')).toString('base64url');
  console.log(STUDIO + '#z=' + z);
  process.exit(0);
}

const vendor = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor');
const context = vm.createContext({ require: createRequire(import.meta.url), process, console, URL, TextDecoder, TextEncoder,
  setTimeout, __dirname: vendor, __filename: path.join(vendor, 'pikchr.js') });
vm.runInContext(fs.readFileSync(path.join(vendor, 'pikchr.js'), 'utf8'), context);
const wasm = await context.initPikchrModule({ locateFile: p => path.join(vendor, p) });
const pikchr = wasm.cwrap('pikchr', 'number', ['string', 'string', 'number', 'number', 'number']);

function render(flags) {
  const size = wasm._malloc(8);
  try {
    const p = pikchr(source, 'pikchr', flags, size, size + 4);
    const text = wasm.UTF8ToString(p); wasm._free(p);
    const view = new DataView(wasm.HEAPU8.buffer);
    return { text, width: view.getInt32(size, true), height: view.getInt32(size + 4, true) };
  } finally { wasm._free(size); }
}

const light = render(PLAINTEXT_ERRORS);
if (light.width < 0) { console.error(light.text.trim()); process.exit(1); }
if (check) { console.error(`ok: ${light.width}×${light.height} px`); process.exit(0); }
if (!alt) { console.error('--alt is required: one or two sentences saying what the diagram shows.\n' + usage); process.exit(2); }
const dark = render(PLAINTEXT_ERRORS | DARK_MODE);

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Below 70% of its natural size Pikchr's text gets too small to read, so a wide
// diagram keeps that minimum width and scrolls inside its box on a phone.
const minWidth = Math.round(light.width * 0.7);
function svg(r, cls) {
  return r.text.trim()
    .replace(/ data-pikchr-date="[^"]*"/, '')
    .replace(/^<svg /, `<svg role="img" aria-label="${esc(alt)}" `)
    .replace(/class="pikchr"/, `class="pikchr ${cls}" width="${r.width}" height="${r.height}"`)
    .replace(/style='font-size:initial;'/, `style='font-size:initial;max-width:${r.width}px;min-width:${minWidth}px'`);
}

const style = `<style>
.pikchr-figure{margin:24px 0}
.pikchr-figure .pk-scroll{overflow-x:auto}
.pikchr-figure svg{display:block;width:100%;height:auto;margin:0 auto;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.pikchr-figure .pk-dark{display:none}
@media (prefers-color-scheme:dark){.pikchr-figure .pk-light{display:none}.pikchr-figure .pk-dark{display:block}}
.pikchr-figure figcaption{margin-top:8px;font-size:14px;color:var(--ink-2,#555a63)}
</style>`;

const html = [
  `<figure class="pikchr-figure">`,
  `<div class="pk-scroll">`,
  svg(light, 'pk-light'),
  svg(dark, 'pk-dark'),
  `</div>`,
  caption ? `<figcaption>${esc(caption)}</figcaption>` : '',
  `</figure>`,
  noStyle ? '' : style,
].filter(Boolean).join('\n') + '\n';

if (out) fs.writeFileSync(out, html); else process.stdout.write(html);
