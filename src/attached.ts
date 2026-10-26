// The attached-responder flag: an unversioned file `attached.json` in the
// artifact's repository, {responder, since, contact}, set by whoever answers
// comments (`fossil unversioned add` + `fossil uv sync`) and removed when they
// stop. It is unversioned so setting it never makes a check-in. Anyone who can
// push unversioned files can write it, so it is untrusted: a reader gets only
// these three fields, validated, and a file that is not usable reads as absent.

export const ATTACHED_FILE = 'attached.json';

const MAX_FILE = 4096; // bytes; the longest valid file is about 1.5 KB
const MAX_RESPONDER = 100; // code points
const MAX_CONTACT = 200;
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/;

export type Attached = { responder: string; since: string | null; contact: string | null };

/** A single line of text of 1 to `max` code points, trimmed, or null. */
function line(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(s) || Array.from(s).length > max) return null;
  return s;
}

/** The flag from the base64 body `uvGet` returned, or null when absent or not valid. */
export function attachedFrom(b64: string | null | undefined): Attached | null {
  if (!b64 || b64.length > Math.ceil(MAX_FILE / 3) * 4) return null;
  let parsed: unknown;
  try {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const f = parsed as Record<string, unknown>;
  const responder = line(f.responder, MAX_RESPONDER);
  if (!responder) return null;
  const since = typeof f.since === 'string' && ISO_TIME.test(f.since) && !Number.isNaN(Date.parse(f.since)) ? f.since : null;
  return { responder, since, contact: line(f.contact, MAX_CONTACT) };
}
