// ─── Wake sinks ──────────────────────────────────────────────────────────────
//
// Tells whoever answers comments that an artifact changed. The publisher knows
// no agent: the host picks the sink with WAKE_SINK_KIND (webhook, notify, nats
// or none), WAKE_SINK_URL and WAKE_SINK_SECRET. Every sink carries the same ids
// and nothing else: no clone URL, no link, no credential. Delivery is
// best-effort and bounded; wake() never rejects, so a caller can hand it to
// ctx.waitUntil and forget it. No Worker-only imports, so node tests load it.

import { authorName } from './ticket-author.ts';

export type WakeKind = 'comment' | 'reply' | 'resolve' | 'publish';

export interface WakeEvent {
  artifact: string;
  checkin: string;
  ticket: string | null;
  author: string;
  kind: WakeKind;
}

export interface WakeEnv {
  WAKE_SINK_KIND?: string;
  WAKE_SINK_URL?: string;
  WAKE_SINK_SECRET?: string;
  // Before WAKE_SINK_*: notify only. NOTIFY_AGENT and NOTIFY_SUBSCRIBER still
  // address the notify sink when WAKE_SINK_KIND=notify.
  NOTIFY_URL?: string;
  NOTIFY_AGENT?: string;
  NOTIFY_SUBSCRIBER?: string;
  NOTIFY_API_KEY?: string;
}

interface WakeSocket {
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void;
  send(data: string | Uint8Array): void;
  close(): void;
}

export interface WakeOptions {
  /** Idempotency key; default `<artifact>-<checkin>`. */
  key?: string;
  fetch?: typeof fetch;
  WebSocket?: new (url: string) => WakeSocket;
  log?: (msg: string) => void;
  timeoutMs?: number;
}

const KINDS: readonly string[] = ['comment', 'reply', 'resolve', 'publish'];

/** The wake kind named by `value`, or null. */
export function wakeKind(value: string | null | undefined): WakeKind | null {
  return value && KINDS.includes(value) ? (value as WakeKind) : null;
}

/**
 * The kind of a ticket change: the change that opens a thread is a comment,
 * one that sets status Closed a resolve, and any other (a remark, a reopen to
 * status Open, a field edit) a reply. The API and a fossil push agree on it.
 */
export function ticketKind(opens: boolean, fields: Record<string, string>): WakeKind {
  return opens ? 'comment' : fields.status === 'Closed' ? 'resolve' : 'reply';
}

/**
 * The most ticket changes one sync request wakes for, so a large push cannot
 * fan out into unbounded subrequests (a free-plan Worker has 50 in all).
 */
export const WAKE_FANOUT = 40;

const unknownLogged = new Set<string>();

/** Deliver `event` to the sink the env names. Never rejects. */
export async function wake(env: WakeEnv, event: WakeEvent, opts: WakeOptions = {}): Promise<void> {
  const log = opts.log ?? ((msg: string) => console.warn(msg));
  try {
    const sink = sinkOf(env);
    if (sink.kind === 'none') {
      if (sink.unknown && !unknownLogged.has(sink.unknown)) {
        unknownLogged.add(sink.unknown);
        log(`wake: unknown WAKE_SINK_KIND ${JSON.stringify(sink.unknown.slice(0, 32))}; waking nobody`);
      }
      return;
    }
    const e = checked(event);
    if (!e) {
      log('wake: event refused (artifact, check-in, ticket or kind is malformed)');
      return;
    }
    const key = opts.key ?? `${e.artifact}-${e.checkin}`;
    const timeoutMs = opts.timeoutMs ?? 5000;
    if (sink.kind === 'nats') {
      const WS = opts.WebSocket ?? (globalThis as unknown as { WebSocket: new (url: string) => WakeSocket }).WebSocket;
      await natsPublish(WS, sink.url, sink.secret, `artifact.${e.artifact}.${e.kind}`, JSON.stringify(e), timeoutMs);
      return;
    }
    const req = sink.kind === 'webhook' ? await webhookRequest(sink.url, sink.secret, e, key) : notifyRequest(sink, e, opts.key);
    const res = await (opts.fetch ?? fetch)(req.url, { ...req.init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) log(`wake: ${sink.kind} answered ${res.status}`);
  } catch (err) {
    log(`wake: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
  }
}

type Sink =
  | { kind: 'none'; unknown?: string }
  | { kind: 'webhook'; url: string; secret: string }
  | { kind: 'nats'; url: string; secret: string }
  | { kind: 'notify'; url: string; secret: string; agent: string; subscriber: string };

function sinkOf(env: WakeEnv): Sink {
  const kind = env.WAKE_SINK_KIND ?? '';
  const url = env.WAKE_SINK_URL ?? '', secret = env.WAKE_SINK_SECRET ?? '';
  const agent = env.NOTIFY_AGENT ?? '', subscriber = env.NOTIFY_SUBSCRIBER ?? '';
  switch (kind) {
    // Unset: the configuration from before WAKE_SINK_*, unchanged.
    case '': {
      const base = env.NOTIFY_URL ?? '', apiKey = env.NOTIFY_API_KEY ?? '';
      return base && agent && apiKey ? { kind: 'notify', url: base, secret: apiKey, agent, subscriber } : { kind: 'none' };
    }
    case 'none':
      return { kind: 'none' };
    case 'notify':
      return url && agent && secret ? { kind, url, secret, agent, subscriber } : { kind: 'none' };
    case 'webhook':
    case 'nats':
      return url && secret ? { kind, url, secret } : { kind: 'none' };
    default:
      return { kind: 'none', unknown: kind };
  }
}

// Ids only, each safe in a NATS subject token and a header value.
function checked(e: WakeEvent): WakeEvent | null {
  const hex = /^[0-9a-f]{1,64}$/;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(e.artifact) || !hex.test(e.checkin) || !wakeKind(e.kind)) return null;
  if (e.ticket !== null && !hex.test(e.ticket)) return null;
  return {
    artifact: e.artifact, checkin: e.checkin, ticket: e.ticket,
    author: authorName(String(e.author).replace(/[\u0000-\u001f\u007f]/g, '')), kind: e.kind,
  };
}

interface Outgoing { url: string; init: { method: string; headers: Record<string, string>; body: string } }

// X-Signature: sha256=<hex HMAC-SHA256 of the exact body bytes, keyed by WAKE_SINK_SECRET>.
async function webhookRequest(url: string, secret: string, e: WakeEvent, key: string): Promise<Outgoing> {
  const body = JSON.stringify(e);
  const enc = new TextEncoder();
  const hmac = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, enc.encode(body)));
  const hex = Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
  return {
    url,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': `sha256=${hex}`, 'Idempotency-Key': key },
      body,
    },
  };
}

// Byte for byte the request the Worker sent to notify before WAKE_SINK_*.
function notifyRequest(s: { url: string; secret: string; agent: string; subscriber: string }, e: WakeEvent, key?: string): Outgoing {
  return {
    url: `${s.url.replace(/\/$/, '')}/v1/inbox/conversations/${encodeURIComponent(s.agent)}/messages`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${s.secret}`,
        'Idempotency-Key': key ?? `${e.artifact}-${e.checkin.slice(0, 32)}`,
      },
      body: JSON.stringify({
        subscriberId: s.subscriber || 'html-artifact-publisher',
        conversationId: `artifact-${e.artifact}`,
        text: `Artifact ${e.artifact} has a new ${e.kind} at check-in ${e.checkin.slice(0, 10)}. Pull it to read it.`,
      }),
    },
  };
}

// NATS over its WebSocket transport (Workers cannot open raw TCP to NATS):
// wait for INFO, send CONNECT, PUB and PING in one frame, and finish on PONG.
// The secret is a token, or `user:password` when it holds a colon.
function natsPublish(
  WS: new (url: string) => WakeSocket, url: string, secret: string, subject: string, body: string, timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const enc = new TextEncoder(), dec = new TextDecoder();
    const colon = secret.indexOf(':');
    const auth = colon > 0 ? { user: secret.slice(0, colon), pass: secret.slice(colon + 1) } : { auth_token: secret };
    const connect = JSON.stringify({
      verbose: false, pedantic: false, protocol: 1, lang: 'html-artifact-publisher', version: '1', ...auth,
    });
    const frame = `CONNECT ${connect}\r\nPUB ${subject} ${enc.encode(body).length}\r\n${body}\r\nPING\r\n`;
    let ws: WakeSocket | undefined, buf = '', sent = false, done = false;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('nats: timed out')), timeoutMs);
    try {
      ws = new WS(url);
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    ws.addEventListener('message', ev => {
      const d = ev.data;
      buf += typeof d === 'string' ? d : d instanceof ArrayBuffer || ArrayBuffer.isView(d) ? dec.decode(d as ArrayBuffer) : '';
      for (let i = buf.indexOf('\r\n'); i >= 0 && !done; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (line.startsWith('INFO ') && !sent) {
          sent = true;
          ws!.send(enc.encode(frame));
        } else if (line === 'PING') {
          ws!.send(enc.encode('PONG\r\n'));
        } else if (line === 'PONG' && sent) {
          finish();
        } else if (line.startsWith('-ERR')) {
          finish(new Error(`nats: ${line.slice(0, 200)}`));
        }
      }
      if (buf.length > 65536) finish(new Error('nats: oversized line'));
    });
    ws.addEventListener('error', () => finish(new Error('nats: socket error')));
    ws.addEventListener('close', () => finish(new Error('nats: closed before PONG')));
  });
}
