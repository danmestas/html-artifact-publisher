// What the attached responder is doing about each comment thread: an
// unversioned file `responder-status.json`, {threads: {<ticketUuid>: entry}},
// written only through PUT …/responder-status, so a status never makes a
// check-in, a ticket change or a wake. An edit link's clone can push the file
// too, so a reader gets only validated entries.

export const RESPONDER_STATUS_FILE = 'responder-status.json';
export const STATUS_ENTRIES_MAX = 200;

const MAX_FILE = 131072; // bytes; 200 of the longest entries are about 50 KB
const MAX_STEP = 80; // code points
const PREFIX = /^[0-9a-f]{10,64}$/;
const HASH = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/;

export type StatusState = 'delivered' | 'seen' | 'working' | 'done' | 'failed';
type StoredState = Exclude<StatusState, 'done'>;
const STATES: readonly StatusState[] = ['delivered', 'seen', 'working', 'done', 'failed'];

export type StatusRequest = { change: string; state: StatusState; step?: string };
export type StatusEntry = { change: string; state: StoredState; step?: string; since: string; updated: string };
export type StatusFile = { threads: Record<string, StatusEntry> };

/** A single line of 1 to MAX_STEP code points, or null. Not trimmed: the body must already be clean. */
function step(v: unknown): string | null {
  if (typeof v !== 'string' || !v || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(v) || Array.from(v).length > MAX_STEP) return null;
  return v;
}

const time = (v: unknown): v is string => typeof v === 'string' && ISO_TIME.test(v) && !Number.isNaN(Date.parse(v));
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The parsed PUT body, or null for anything but exactly {change, state, step?}. */
export function statusRequest(b: unknown): StatusRequest | null {
  if (!record(b) || Object.keys(b).some(k => k !== 'change' && k !== 'state' && k !== 'step')) return null;
  if (typeof b.change !== 'string' || !PREFIX.test(b.change)) return null;
  if (!STATES.includes(b.state as StatusState)) return null;
  const out: StatusRequest = { change: b.change, state: b.state as StatusState };
  if ('step' in b) {
    const s = step(b.step);
    if (!s) return null;
    out.step = s;
  }
  return out;
}

/**
 * The thread holding a change whose hash starts with `prefix`, and that
 * change's full hash (the newest, should one thread hold two); 'none', or
 * 'many' when changes in more than one thread match.
 */
export function resolveChange(threads: { uuid: string; changes: { artifact: string }[] }[], prefix: string): { ticketUuid: string; change: string } | 'none' | 'many' {
  let found: { ticketUuid: string; change: string } | null = null;
  for (const t of threads) {
    const match = [...t.changes].reverse().find(c => c.artifact.startsWith(prefix));
    if (!match) continue;
    if (found) return 'many';
    found = { ticketUuid: t.uuid, change: match.artifact };
  }
  return found ?? 'none';
}

/** The newest-updated `max` entries. */
function capped(threads: Record<string, StatusEntry>, max: number): Record<string, StatusEntry> {
  const entries = Object.entries(threads);
  if (entries.length <= max) return threads;
  entries.sort(([, a], [, b]) => Date.parse(b.updated) - Date.parse(a.updated));
  return Object.fromEntries(entries.slice(0, max));
}

/**
 * The file after one status write at `now` (RFC 3339). `done` removes the thread's entry only
 * when it is for that change: a follow-up asked while the first was being answered keeps its
 * own status.
 */
export function applyStatus(file: StatusFile, ticketUuid: string, change: string, state: StatusState, stepText: string | undefined, now: string): StatusFile {
  const threads = { ...file.threads };
  if (state === 'done') {
    if (threads[ticketUuid]?.change === change) delete threads[ticketUuid];
    return { threads };
  }
  const old = threads[ticketUuid];
  const entry: StatusEntry = { change, state, since: old?.change === change ? old.since : now, updated: now };
  if (stepText !== undefined) entry.step = stepText;
  // Re-inserted last, so an entry being updated is never the one dropped.
  delete threads[ticketUuid];
  threads[ticketUuid] = entry;
  return { threads: capped(threads, STATUS_ENTRIES_MAX) };
}

function entryFrom(v: unknown): StatusEntry | null {
  if (!record(v)) return null;
  if (typeof v.change !== 'string' || !HASH.test(v.change)) return null;
  if (!STATES.includes(v.state as StatusState) || v.state === 'done') return null;
  if (!time(v.since) || !time(v.updated)) return null;
  const entry: StatusEntry = { change: v.change, state: v.state as StoredState, since: v.since, updated: v.updated };
  if (v.step !== undefined) {
    const s = step(v.step);
    if (!s) return null;
    entry.step = s;
  }
  return entry;
}

/** The file from the base64 body `uvGet` returned: its valid entries, or none. */
export function statusFrom(b64: string | null | undefined): StatusFile {
  const empty: StatusFile = { threads: {} };
  if (!b64 || b64.length > Math.ceil(MAX_FILE / 3) * 4) return empty;
  let parsed: unknown;
  try {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return empty;
  }
  if (!record(parsed) || !record(parsed.threads)) return empty;
  const threads: Record<string, StatusEntry> = {};
  for (const [uuid, v] of Object.entries(parsed.threads)) {
    const entry = HASH.test(uuid) ? entryFrom(v) : null;
    if (entry) threads[uuid] = entry;
  }
  return { threads: capped(threads, STATUS_ENTRIES_MAX) };
}
