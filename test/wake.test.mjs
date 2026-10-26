import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { wake, wakeKind } from '../src/wake.ts';

// The wake sinks: one event, delivered however the host chose by env, never
// carrying a clone URL or a credential, never failing the write that fired it.

const event = {
  artifact: 'Ab3_x-9', checkin: 'a'.repeat(64), ticket: null, author: 'edit-link', kind: 'comment',
};

function recorder(status = 200) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status }); };
  return { calls, fetch };
}

function quiet() {
  const lines = [];
  return { lines, log: msg => lines.push(String(msg)) };
}

// The notify request exactly as wake() in src/index.ts sent it before #19.
function legacyNotify(env, id, tip, kind) {
  const base = env.NOTIFY_URL, agent = env.NOTIFY_AGENT, subscriber = env.NOTIFY_SUBSCRIBER;
  return {
    url: `${base.replace(/\/$/, '')}/v1/inbox/conversations/${encodeURIComponent(agent)}/messages`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${env.NOTIFY_API_KEY}`,
        'Idempotency-Key': `${id}-${tip.slice(0, 32)}`,
      },
      body: JSON.stringify({
        subscriberId: subscriber || 'html-artifact-publisher',
        conversationId: `artifact-${id}`,
        text: `Artifact ${id} has a new ${kind} at check-in ${tip.slice(0, 10)}. Pull it to read it.`,
      }),
    },
  };
}

const notifyEnv = {
  NOTIFY_URL: 'https://notify.example/', NOTIFY_AGENT: 'agent one', NOTIFY_SUBSCRIBER: '', NOTIFY_API_KEY: 'k-123',
};

function sameRequest(got, want) {
  assert.equal(got.url, want.url);
  assert.equal(got.init.method, want.init.method);
  assert.deepEqual(got.init.headers, want.init.headers);
  assert.equal(got.init.body, want.init.body);
}

test('wake kind: only comment, reply, resolve and publish', () => {
  for (const k of ['comment', 'reply', 'resolve', 'publish']) assert.equal(wakeKind(k), k);
  for (const k of [null, '', 'edit', 'Comment', 'comment.x', 'comment ']) assert.equal(wakeKind(k), null);
});

test('unset kind with NOTIFY_* sends the request the old code sent', async () => {
  const r = recorder();
  await wake({ ...notifyEnv }, event, { fetch: r.fetch, log: quiet().log });
  assert.equal(r.calls.length, 1);
  sameRequest(r.calls[0], legacyNotify(notifyEnv, event.artifact, event.checkin, 'comment'));
});

test('unset kind without a complete NOTIFY_* config sends nothing, as before', async () => {
  for (const missing of ['NOTIFY_URL', 'NOTIFY_AGENT', 'NOTIFY_API_KEY']) {
    const r = recorder();
    await wake({ ...notifyEnv, [missing]: '' }, event, { fetch: r.fetch, log: quiet().log });
    assert.equal(r.calls.length, 0, missing);
  }
});

test('notify: WAKE_SINK_* mapped from NOTIFY_* is identical to the legacy request', async () => {
  const env = {
    WAKE_SINK_KIND: 'notify', WAKE_SINK_URL: notifyEnv.NOTIFY_URL, WAKE_SINK_SECRET: notifyEnv.NOTIFY_API_KEY,
    NOTIFY_AGENT: notifyEnv.NOTIFY_AGENT, NOTIFY_SUBSCRIBER: 'sub-7',
  };
  const r = recorder();
  await wake(env, { ...event, kind: 'reply' }, { fetch: r.fetch, log: quiet().log });
  assert.equal(r.calls.length, 1);
  sameRequest(r.calls[0], legacyNotify({ ...notifyEnv, NOTIFY_SUBSCRIBER: 'sub-7' }, event.artifact, event.checkin, 'reply'));
});

test('webhook: signed JSON body, idempotency key, nothing secret', async () => {
  const env = { WAKE_SINK_KIND: 'webhook', WAKE_SINK_URL: 'https://hooks.example/wake', WAKE_SINK_SECRET: 'shh-secret' };
  const r = recorder();
  await wake(env, { ...event, ticket: 'b'.repeat(40), kind: 'resolve' }, { fetch: r.fetch, log: quiet().log });
  assert.equal(r.calls.length, 1);
  const { url, init } = r.calls[0];
  assert.equal(url, 'https://hooks.example/wake');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers['Idempotency-Key'], `${event.artifact}-${event.checkin}`);
  const reference = createHmac('sha256', 'shh-secret').update(Buffer.from(init.body, 'utf8')).digest('hex');
  assert.equal(init.headers['X-Signature'], `sha256=${reference}`);
  const payload = JSON.parse(init.body);
  assert.deepEqual(Object.keys(payload).sort(), ['artifact', 'author', 'checkin', 'kind', 'ticket']);
  assert.deepEqual(payload, {
    artifact: event.artifact, checkin: event.checkin, ticket: 'b'.repeat(40), author: 'edit-link', kind: 'resolve',
  });
  assert.ok(!init.body.includes('shh-secret'));
  assert.ok(!/clone|token|https?:/i.test(init.body));
});

test('webhook: a caller-supplied idempotency key replaces the default', async () => {
  const env = { WAKE_SINK_KIND: 'webhook', WAKE_SINK_URL: 'https://hooks.example/wake', WAKE_SINK_SECRET: 's' };
  const r = recorder();
  await wake(env, event, { fetch: r.fetch, log: quiet().log, key: 'Ab3_x-9-ticketchange' });
  assert.equal(r.calls[0].init.headers['Idempotency-Key'], 'Ab3_x-9-ticketchange');
});

// A stub of the WebSocket the Worker runtime provides: records what the client
// sends and answers as a NATS server would.
function natsServer({ onConnect = 'ok' } = {}) {
  const sockets = [];
  class StubSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      this.listeners = {};
      sockets.push(this);
      queueMicrotask(() => this.emit('message', { data: 'INFO {"server_id":"x","headers":true,"max_payload":1048576}\r\n' }));
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    emit(type, ev) { for (const fn of this.listeners[type] ?? []) fn(ev); }
    send(data) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      this.sent.push(text);
      if (!text.includes('PING\r\n')) return;
      if (onConnect === 'ok') queueMicrotask(() => this.emit('message', { data: new TextEncoder().encode('PONG\r\n').buffer }));
      if (onConnect === 'err') queueMicrotask(() => this.emit('message', { data: "-ERR 'Authorization Violation'\r\n" }));
    }
    close() { this.closed = true; }
  }
  return { sockets, WebSocket: StubSocket };
}

test('nats: CONNECT with the token, PUB on artifact.<id>.<kind>, PING, close', async () => {
  const server = natsServer();
  const env = { WAKE_SINK_KIND: 'nats', WAKE_SINK_URL: 'wss://nats.example:443', WAKE_SINK_SECRET: 'tok-1' };
  const q = quiet();
  await wake(env, { ...event, kind: 'publish' }, { WebSocket: server.WebSocket, log: q.log });
  assert.equal(server.sockets.length, 1);
  const ws = server.sockets[0];
  assert.equal(ws.url, 'wss://nats.example:443');
  assert.ok(ws.closed);
  const wire = ws.sent.join('');
  const lines = wire.split('\r\n');
  assert.ok(lines[0].startsWith('CONNECT '));
  const connect = JSON.parse(lines[0].slice('CONNECT '.length));
  assert.equal(connect.auth_token, 'tok-1');
  assert.equal(connect.verbose, false);
  assert.equal(connect.user, undefined);
  const body = JSON.stringify({ ...event, kind: 'publish' });
  assert.equal(lines[1], `PUB artifact.${event.artifact}.publish ${new TextEncoder().encode(body).length}`);
  assert.equal(lines[2], body);
  assert.equal(lines[3], 'PING');
  assert.deepEqual(q.lines, []);
});

test('nats: user:password secret becomes user and pass', async () => {
  const server = natsServer();
  const env = { WAKE_SINK_KIND: 'nats', WAKE_SINK_URL: 'wss://nats.example', WAKE_SINK_SECRET: 'svc:p:ss' };
  await wake(env, event, { WebSocket: server.WebSocket, log: quiet().log });
  const connect = JSON.parse(server.sockets[0].sent.join('').split('\r\n')[0].slice('CONNECT '.length));
  assert.equal(connect.user, 'svc');
  assert.equal(connect.pass, 'p:ss');
  assert.equal(connect.auth_token, undefined);
});

test('nats: a server error or a silent server is logged, never thrown, and bounded', async () => {
  const env = { WAKE_SINK_KIND: 'nats', WAKE_SINK_URL: 'wss://nats.example', WAKE_SINK_SECRET: 't' };
  const err = natsServer({ onConnect: 'err' }), q = quiet();
  await wake(env, event, { WebSocket: err.WebSocket, log: q.log });
  assert.ok(err.sockets[0].closed);
  assert.match(q.lines.join('\n'), /Authorization Violation/);

  const silent = natsServer({ onConnect: 'none' }), q2 = quiet();
  const started = Date.now();
  await wake(env, event, { WebSocket: silent.WebSocket, log: q2.log, timeoutMs: 50 });
  assert.ok(Date.now() - started < 2000);
  assert.ok(silent.sockets[0].closed);
  assert.match(q2.lines.join('\n'), /timed out/);
});

test('subject-unsafe artifact ids and kinds are refused before any sink', async () => {
  const server = natsServer(), r = recorder(), q = quiet();
  const env = { WAKE_SINK_KIND: 'nats', WAKE_SINK_URL: 'wss://nats.example', WAKE_SINK_SECRET: 't' };
  for (const artifact of ['a.b', 'a b', 'a*', 'a>', '', 'x'.repeat(65)]) {
    await wake(env, { ...event, artifact }, { WebSocket: server.WebSocket, log: q.log });
  }
  await wake(env, { ...event, kind: 'comment.>' }, { WebSocket: server.WebSocket, log: q.log });
  await wake({ WAKE_SINK_KIND: 'webhook', WAKE_SINK_URL: 'https://h.example', WAKE_SINK_SECRET: 's' },
    { ...event, checkin: 'not hex' }, { fetch: r.fetch, log: q.log });
  assert.equal(server.sockets.length, 0);
  assert.equal(r.calls.length, 0);
});

test('none sends nothing', async () => {
  const r = recorder(), server = natsServer();
  await wake({ WAKE_SINK_KIND: 'none', ...notifyEnv }, event, { fetch: r.fetch, WebSocket: server.WebSocket, log: quiet().log });
  assert.equal(r.calls.length, 0);
  assert.equal(server.sockets.length, 0);
});

test('an unknown kind is none, logged once, never thrown', async () => {
  const r = recorder(), q = quiet();
  const env = { WAKE_SINK_KIND: 'carrier-pigeon', ...notifyEnv };
  await wake(env, event, { fetch: r.fetch, log: q.log });
  await wake(env, event, { fetch: r.fetch, log: q.log });
  assert.equal(r.calls.length, 0);
  assert.equal(q.lines.filter(l => l.includes('carrier-pigeon')).length, 1);
});

test('failing sinks resolve: HTTP errors, network errors and timeouts are logged', async () => {
  const env = { WAKE_SINK_KIND: 'webhook', WAKE_SINK_URL: 'https://hooks.example/wake', WAKE_SINK_SECRET: 'hook-secret-9' };
  const q = quiet();
  await wake(env, event, { fetch: recorder(500).fetch, log: q.log });
  await wake(env, event, { fetch: async () => { throw new Error('boom'); }, log: q.log });
  await wake(env, event, {
    log: q.log, timeoutMs: 20,
    fetch: (_u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  });
  assert.equal(q.lines.length, 3);
  assert.match(q.lines[0], /500/);
  assert.ok(q.lines.every(l => !l.includes('hook-secret-9')));
});
