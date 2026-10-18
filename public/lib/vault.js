// vault.js — the encryption boundary, shared by the viewer and the CLI.
//
// A stored artifact is iv[12] || AES-256-GCM(key, gzip(repository bytes)). The
// gzip matters: a .fossil file is mostly empty SQLite pages. The key
// is fixed for the life of the artifact (so its link never changes); every
// write uses a fresh IV.
//
// Links carry everything after the '#', which browsers never send:
//   #<key>                     read
//   #<key>.<writeToken>        read + write (edit link)
//   ...@<check-in>             optional: view that check-in instead of the tip
// base64url never contains '.' or '@', so the parts split unambiguously.

export function b64uEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(s) {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '===='.slice((std.length % 4) || 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export function newKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

function importKey(raw, use) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [use]);
}

async function pipe(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function seal(rawKey, bytes) {
  bytes = await pipe(bytes, new CompressionStream('gzip'));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(rawKey, 'encrypt'), bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

export async function unseal(rawKey, blob) {
  if (blob.length < 13) throw new Error('stored artifact is too short');
  const iv = blob.subarray(0, 12);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await importKey(rawKey, 'decrypt'), blob.subarray(12));
  } catch {
    throw new Error('decryption failed: wrong key or corrupt data');
  }
  return pipe(new Uint8Array(plain), new DecompressionStream('gzip'));
}

/** Parse a link fragment (with or without the leading '#'). */
export function parseFragment(hash) {
  let s = hash.replace(/^#/, '');
  let at = '';
  const atPos = s.indexOf('@');
  if (atPos !== -1) {
    at = decodeURIComponent(s.slice(atPos + 1));
    s = s.slice(0, atPos);
  }
  const [keyPart, write = ''] = s.split('.');
  if (!keyPart) throw new Error('the link has no key: it must end in #<key>');
  const key = b64uDecode(keyPart);
  if (key.length !== 32) throw new Error('the key in the link must be 32 bytes');
  return { key, write, at };
}

export function fragment({ key, write = '', at = '' }) {
  return '#' + b64uEncode(key) + (write ? '.' + write : '') + (at ? '@' + encodeURIComponent(at) : '');
}
