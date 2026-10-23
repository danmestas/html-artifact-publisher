// blobs.js — large and binary files live in R2, not in Fossil. Fossil keeps a
// small pointer file at the file's own path:
//
//   artifact-blob 1
//   sha256 <64 hex>
//   size <bytes>
//   type <media type>
//
// Shared by the Worker, the viewer and the CLI, so all three agree on which
// files become blobs and on the pointer format.

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Text files stay in Fossil unless they are over this size. */
export const BLOB_THRESHOLD = 256 * 1024;

const TEXT = /\.(html?|css|m?js|json|svg|txt|md|xml|csv|tsv|pikchr|map|ya?ml|toml)$/i;

const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  ico: 'image/x-icon', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  pdf: 'application/pdf', wasm: 'application/wasm', zip: 'application/zip',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', xml: 'application/xml',
};

export function typeOf(path) {
  return TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** Binary files always become blobs; text files only when they are large. */
export function isBlob(path, bytes) {
  return !TEXT.test(path) || bytes.length > BLOB_THRESHOLD;
}

const POINTER = /^artifact-blob 1\nsha256 ([0-9a-f]{64})\nsize (\d{1,15})\ntype ([\w.+-]{1,64}\/[\w.+-]{1,128})\n?$/;

export function pointerText({ sha256, size, type }) {
  return `artifact-blob 1\nsha256 ${sha256}\nsize ${size}\ntype ${type}\n`;
}

/** { sha256, size, type } when `bytes` is a pointer file, else null. */
export function parsePointer(bytes) {
  if (!bytes || bytes.length > 300 || bytes[0] !== 0x61) return null; // 'a'
  const m = POINTER.exec(typeof bytes === 'string' ? bytes : dec.decode(bytes));
  return m ? { sha256: m[1], size: Number(m[2]), type: m[3] } : null;
}

export async function sha256hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}

/** The pointer for `bytes`, and the pointer file's own bytes. */
export async function pointerFor(path, bytes) {
  const blob = { sha256: await sha256hex(bytes), size: bytes.length, type: typeOf(path) };
  return { blob, bytes: enc.encode(pointerText(blob)) };
}
