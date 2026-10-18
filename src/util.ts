/** Small pure helpers shared by the Worker and its Durable Objects. */

/** 21-char URL-safe random ID (nanoid alphabet, crypto-random). */
export function genId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  return Array.from(bytes, b => chars[b & 63]!).join('');
}

/** 32-byte random hex token. */
export function genToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of a string, as lowercase hex. */
export async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

/** Timing-safe string equality for tokens and digests. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Clamp ttlSeconds into [0, maxTtl].
 * Returns defaultTtl when input is absent/invalid, null for "no expiry" (0).
 */
export function clampTtl(ttlSeconds: unknown, defaultTtl: number, maxTtl: number): number | null {
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds)) return defaultTtl;
  const v = Math.min(Math.max(Math.floor(ttlSeconds), 0), maxTtl);
  return v === 0 ? null : v;
}

export function isoOrNull(sec: number | null): string | null {
  return sec != null ? new Date(sec * 1000).toISOString() : null;
}

export function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
