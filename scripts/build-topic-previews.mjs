#!/usr/bin/env node
// Pre-render trusted topic artwork; no artifact content, fonts or network access.
// PNGs are checked in so Worker requests need no rendering service or WASM.
import { Resvg } from '@resvg/resvg-js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ICON_NAMES, iconSvg } from '../public/icons.js';

const check = process.argv.includes('--check');
const directory = new URL('../public/share-icons/', import.meta.url);
const tones = {
  document: '#44556b', notes: '#44556b', book: '#5265a7', education: '#5265a7',
  code: '#266ba0', architecture: '#266ba0', tool: '#266ba0',
  design: '#9a4a79', image: '#9a4a79', slides: '#9a4a79',
  research: '#2e7c85', science: '#2e7c85', health: '#2e7c85',
  planning: '#8c651d', calendar: '#8c651d', checklist: '#8c651d',
  finance: '#347457', calculator: '#347457', chart: '#347457',
  security: '#58649e', people: '#a35b45', recipe: '#a35b45',
  travel: '#367e76', map: '#367e76', music: '#8356a3', game: '#8356a3',
};
if (!check) await mkdir(directory, { recursive: true });
for (const name of ICON_NAMES) {
  const tone = tones[name] ?? tones.document;
  const glyph = iconSvg(name).replace('<svg ', '<svg x="504" y="219" width="192" height="192" ')
    .replaceAll('currentColor', tone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#f5f7fa"/>
    <rect x="32.5" y="32.5" width="1135" height="565" rx="24" fill="none" stroke="${tone}" stroke-opacity=".12"/>
    <circle cx="600" cy="315" r="226" fill="${tone}" fill-opacity=".045"/>
    <circle cx="600" cy="315" r="225.5" fill="none" stroke="${tone}" stroke-opacity=".08"/>
    <rect x="444" y="167" width="312" height="312" rx="68" fill="${tone}" fill-opacity=".06"/>
    <rect x="444" y="159" width="312" height="312" rx="68" fill="#fff"/>
    <rect x="444.5" y="159.5" width="311" height="311" rx="67.5" fill="none" stroke="${tone}" stroke-opacity=".16"/>
    ${glyph}
  </svg>`;
  const png = new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();
  const path = new URL(`${name}.png`, directory);
  if (check) {
    const stored = await readFile(path);
    if (!png.equals(stored)) throw new Error(`${name}.png is stale; run npm run build:previews`);
  } else await writeFile(path, png);
}
console.log(`${check ? 'Verified' : 'Generated'} ${ICON_NAMES.length} topic preview PNGs (1200 × 630).`);
