/**
 * Guest discussion: a view-link reader (or an account holding only read
 * access) may identify with a display name and post discussion into the
 * artifact's ordinary thread view, without being elevated to the comment or
 * write role. The identity is a cookie the browser keeps; only its hash is
 * stored, and it conveys no artifact access on its own.
 *
 * A guest profile is private to one artifact and never enters Fossil: the
 * name is the only thing a ticket change records (with a `(guest)` suffix),
 * and the email stays in the Repo's own table for the owner to review.
 *
 * Discussion is enabled in code for this build. The upstream responder must
 * gate on server-owned per-change authority from the tickets API, treating
 * unknown/imported history as untrusted. The severity label is descriptive
 * only; wake suppression and Fossil fields are not safety boundaries.
 */

import { ticketAuthor } from './ticket-author.ts';

export const GUEST_COOKIE = 'hap_guest';
/** How long an identity lasts (seconds). The cookie's Max-Age states the same figure. */
export const GUEST_TTL = 30 * 86400;
/** Descriptive discussion label; never an authorization signal. */
export const GUEST_DISCUSSION = 'guest-discussion';
export const GUEST_NAME_MAX = 64;
export const GUEST_EMAIL_MAX = 254;
export const GUEST_BODY = 'Body must be JSON with optional name (up to 64 characters) and email (up to 254)';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The profile a PUT /guest body asks for, normalized, or null when it is not valid. */
export function guestInput(b: Record<string, unknown> | null): { name: string; email: string } | null {
  if (!b || Object.keys(b).some(k => k !== 'name' && k !== 'email')) return null;
  const { name = '', email = '' } = b;
  if (typeof name !== 'string' || typeof email !== 'string') return null;
  const n = name.trim();
  const e = email.trim();
  if (n.length > GUEST_NAME_MAX || e.length > GUEST_EMAIL_MAX || CONTROL.test(n) || CONTROL.test(e)) return null;
  if (e && !EMAIL.test(e)) return null;
  // A blank name is still an identity: the reader may add a name later.
  return { name: n || 'Guest', email: e.toLowerCase() };
}

/** The guest cookie's token from a request, or '' when there is none. */
export function guestToken(req: Request): string {
  return /(?:^|;\s*)hap_guest=([a-f0-9]{64})(?:;|$)/.exec(req.headers.get('Cookie') ?? '')?.[1] ?? '';
}

/** The cookie that carries `token`; scoped to the artifact API, never readable by page scripts. */
export function guestCookie(req: Request, token: string, clear = false): string {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${GUEST_COOKIE}=${token}; Path=/api/artifacts/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : GUEST_TTL}${secure}`;
}

/** The author a guest change records: a display name, never an address, and marked as a guest. */
export function guestAuthor(name: string): string {
  return ticketAuthor({ kind: 'guest', name });
}

/** A rate window for guest writes (seconds). */
export const GUEST_WINDOW = 300;
/** Posts one guest identity may make in a window. */
export const GUEST_POSTS = 10;
/** Posts one artifact may carry in a window, from all guests. */
export const GUEST_ARTIFACT_POSTS = 60;
/** Posts one client address may make in a window. */
export const GUEST_IP_POSTS = 30;
/** Profile writes one client address, and one identity, may make in a window. */
export const GUEST_PROFILE_IP = 20;
export const GUEST_PROFILE_ID = 10;
/** Claims one identity and one client address may make in a window. */
export const GUEST_CLAIM_ID = 5;
export const GUEST_CLAIM_IP = 20;

/** The limit each key carries, for a Retry-After that matches the key that refused. */
export type RateKey = [string, number];

/** Seconds until every key admits again: the longest wait among them. */
export async function rateWait(reg: { rateWait(key: string, limit?: number): Promise<number> }, keys: RateKey[]): Promise<number> {
  let wait = 0;
  for (const [key, limit] of keys) wait = Math.max(wait, await reg.rateWait(key, limit));
  return wait;
}
