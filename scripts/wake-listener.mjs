#!/usr/bin/env node
// wake-listener.mjs — an example receiver for the webhook wake sink. It checks
// each POST's X-Signature against WAKE_SINK_SECRET over the exact body bytes,
// refuses bodies over 16 KiB, drops an Idempotency-Key it has already taken,
// and runs <command> once per wake, one at a time, with the body on stdin and
// the signature in WAKE_SIGNATURE, so the command can check it again.
//
//   WAKE_SINK_SECRET=… node scripts/wake-listener.mjs [--port 8787] [--host 127.0.0.1] -- \
//     node scripts/responder.mjs <edit-or-comment-url>
//
// Point the Worker's WAKE_SINK_URL at it (through a tunnel when the Worker is
// deployed). The command is run directly, never through a shell, and the body
// is never parsed here.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { verifySignature } from './watch.mjs';

const MAX_BODY = 16 * 1024;
const MAX_DRAIN = 1 << 20; // read and drop at most this much of an oversized body, then hang up
const MAX_QUEUE = 100;
const MAX_KEYS = 1000;
const RUN_TIMEOUT_MS = 10 * 60_000;

const log = msg => process.stderr.write(`wake-listener: ${msg}\n`);
function die(msg) {
  log(msg);
  process.exit(2);
}

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const opts = dash < 0 ? argv : argv.slice(0, dash);
const command = dash < 0 ? [] : argv.slice(dash + 1);
const opt = (flag, fallback) => {
  const i = opts.indexOf(flag);
  return i !== -1 && i + 1 < opts.length ? opts[i + 1] : fallback;
};
const port = Number(opt('--port', '8787'));
const host = opt('--host', '127.0.0.1');
const secret = process.env.WAKE_SINK_SECRET ?? '';
if (!command.length) die('usage: wake-listener.mjs [--port 8787] [--host 127.0.0.1] -- <command> [args...]');
if (!secret) die('WAKE_SINK_SECRET is required: the listener runs nothing it cannot verify');
if (!Number.isInteger(port) || port < 0 || port > 65535) die('--port must be 0 to 65535');

const seen = new Set();
const queue = [];
let running = null, stopping = false;

function remember(key) {
  seen.add(key);
  if (seen.size > MAX_KEYS) seen.delete(seen.values().next().value);
}

function next() {
  if (running || !queue.length) return;
  const job = queue.shift();
  const child = spawn(command[0], command.slice(1), {
    stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, WAKE_SIGNATURE: job.signature },
  });
  running = child;
  const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS);
  child.on('error', err => log(`${job.label} could not start: ${err.message}`));
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    running = null;
    log(`${job.label} exit ${code ?? signal}`);
    if (stopping) process.exit(0);
    next();
  });
  child.stdin.on('error', () => {}); // a command that does not read stdin
  child.stdin.end(job.body);
}

const server = createServer((req, res) => {
  const answer = (status, text = '') => res.writeHead(status, { 'Content-Type': 'text/plain' }).end(text);
  if (req.method !== 'POST') return res.writeHead(405, { Allow: 'POST' }).end();
  if (Number(req.headers['content-length'] ?? 0) > MAX_DRAIN) {
    res.writeHead(413, { Connection: 'close' }).end();
    return req.destroy();
  }
  const chunks = [];
  let size = 0;
  req.on('data', chunk => {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
    else if (size > MAX_DRAIN) req.destroy();
  });
  req.on('end', () => {
    if (size > MAX_BODY) return answer(413, 'too large\n');
    const body = Buffer.concat(chunks);
    const signature = String(req.headers['x-signature'] ?? '');
    if (!verifySignature(secret, body, signature)) return answer(401, 'bad signature\n');
    const key = String(req.headers['idempotency-key'] ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 200);
    if (key && seen.has(key)) return answer(200, 'already taken\n');
    if (stopping || queue.length >= MAX_QUEUE) return answer(503, 'busy\n');
    if (key) remember(key);
    queue.push({ body, signature, label: key || 'wake' });
    answer(202, 'accepted\n');
    next();
  });
});
server.requestTimeout = 10_000;
server.headersTimeout = 5_000;

function stop() {
  if (stopping) process.exit(130);
  stopping = true;
  queue.length = 0;
  server.close();
  if (!running) process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

server.listen(port, host, () => {
  process.stdout.write(`listening on http://${host}:${server.address().port}\n`);
});
