// A local Worker (wrangler dev, fresh state) for tests that need their own
// configuration, such as a wake sink, and a stock fossil with its global state
// kept in the test's directory.

import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;

export const stockFossil = process.env.FOSSIL ?? 'fossil';
export const haveStockFossil = (() => {
  try { execFileSync(stockFossil, ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/** Start wrangler dev with `vars`; resolves to { base, owner, stop } once /healthz answers. */
export async function startWorker(work, vars = {}) {
  const port = 20000 + Math.floor(Math.random() * 2000);
  const base = `http://127.0.0.1:${port}`;
  const owner = 'worker-helper-owner-token';
  const varArgs = Object.entries({ BEARER_TOKEN: owner, ...vars }).flatMap(([k, v]) => ['--var', `${k}:${v}`]);
  // Its own process group, so stop() ends wrangler and workerd together.
  const server = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--port', String(port), '--ip', '127.0.0.1',
    '--persist-to', join(work, 'state'), ...varArgs, '--show-interactive-dev-session=false'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  const stop = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ } };
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return { base, owner, stop };
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  stop();
  throw new Error(`wrangler dev did not start:\n${log}`);
}

/** A new artifact with its links' tokens and links. */
export async function createArtifact(base, owner, html) {
  const res = await fetch(`${base}/api/artifacts`, {
    method: 'POST', headers: { Authorization: `Bearer ${owner}` },
    body: JSON.stringify({ title: 'Test', files: { 'index.html': Buffer.from(html).toString('base64') } }),
  });
  if (res.status !== 201) throw new Error(`create answered ${res.status}: ${await res.text()}`);
  const a = await res.json();
  const tok = url => url.split('#')[1];
  return { ...a, read: tok(a.viewerUrl), write: tok(a.editUrl), comment: tok(a.commentUrl) };
}
