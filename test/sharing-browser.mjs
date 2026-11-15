// Opt-in: node test/sharing-browser.mjs. No production data or email.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, freePort } from './helpers/worker.mjs';

const exec = promisify(execFile);
const work = mkdtempSync(join(tmpdir(), 'hap-sharing-browser-'));
const session = `sharing-${process.pid}`;
let worker;
const stop = () => worker?.stop();
process.once('exit', stop);
process.once('SIGTERM', () => { stop(); process.exit(1); });
async function browser(...args) {
  try {
    return (await exec('agent-browser', ['--session', session, ...args], {
      encoding: 'utf8', timeout: 45000,
      env: { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '180000' },
    })).stdout;
  } catch {
    throw new Error(`Browser command failed: ${args[0]} (private fixture details omitted)`);
  }
}
async function evaluate(source) {
  await browser('frame', 'main');
  const result = JSON.parse(await browser('--json', 'eval', source));
  assert.equal(result.success, true, 'browser evaluation succeeded');
  return result.data.result;
}
async function open(url) {
  await browser('open', url);
  const tabs = JSON.parse(await browser('--json', 'tab', 'list')).data.tabs;
  const tab = tabs.find(t => t.url === url);
  assert.ok(tab, 'fixture tab exists');
  for (const other of tabs) if (other.tabId !== tab.tabId && other.url === 'about:blank') await browser('tab', 'close', other.tabId);
  await browser('--pin-tab', 'tab', tab.tabId);
  await browser('wait', '#bar:not([hidden])');
}
try {
  const port = await freePort();
  worker = await startWorker(work, { OWNER_EMAIL: 'owner@example.com', APP_ORIGIN: `http://127.0.0.1:${port}`, TEST_MAIL_TRANSPORT: 'loopback' }, { port });
  const created = await fetch(worker.base + '/api/artifacts', {
    method: 'POST', headers: { Authorization: `Bearer ${worker.owner}` },
    body: JSON.stringify({ title: 'Sharing regression', ttlSeconds: 0, files: { 'index.html': Buffer.from('<h1>Sharing fixture</h1>').toString('base64') } }),
  });
  assert.equal(created.status, 201);
  const artifact = await created.json();
  const requested = await fetch(worker.base + '/api/auth/request', { method: 'POST', headers: { Origin: worker.base }, body: JSON.stringify({ email: 'owner@example.com' }) });
  const login = await requested.json();
  assert.ok(login.loginUrl);
  const verified = await fetch(worker.base + '/api/auth/verify', { method: 'POST', headers: { Origin: worker.base }, body: JSON.stringify({ token: new URL(login.loginUrl).hash.slice(7) }) });
  assert.equal(verified.status, 200);
  const cookie = verified.headers.getSetCookie()[0].split(';')[0];
  const split = cookie.indexOf('=');
  await browser('cookies', 'set', cookie.slice(0, split), cookie.slice(split + 1), '--url', worker.base, '--httpOnly', '--sameSite', 'Lax');
  const plainUrl = `${worker.base}/v/${artifact.id}`;
  await open(plainUrl);
  await browser('click', '#shareBtn');
  assert.equal(await evaluate(`document.getElementById('libraryLink')?.value === ${JSON.stringify(plainUrl)}`), true, 'named-access library link remains available');
  assert.equal(await evaluate(`document.getElementById('readLink')?.value === ${JSON.stringify(artifact.viewerUrl)}`), true, 'signed-in owner sees the reusable read-only link');
  assert.equal(await evaluate(`!document.getElementById('editLink') && !document.getElementById('cloneCmd')`), true, 'account sharing does not disclose edit or clone credentials');
  await evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async value => { window.__copiedShareLink = value; } }); true`);
  await browser('click', '#readLink + button');
  assert.equal(await evaluate(`window.__copiedShareLink === ${JSON.stringify(artifact.viewerUrl)}`), true, 'the Copy button copies the read-only link, not the sign-in-required URL');
  // Remove the account session server-side, then open the copied capability.
  const logout = await fetch(worker.base + '/api/auth/logout', { method: 'POST', headers: { Origin: worker.base, Cookie: cookie } });
  assert.equal(logout.status, 200);
  await open(artifact.viewerUrl);
  await browser('click', '#shareBtn');
  assert.equal(await evaluate(`document.getElementById('readLink')?.value === ${JSON.stringify(artifact.viewerUrl)}`), true, 'logged-out reader sees the same sharing link');
  assert.equal(await evaluate(`!document.getElementById('editLink')`), true, 'logged-out link cannot offer edit credentials');
  console.log('Browser verification passed: signed-in owner can copy the same read-only link that works after logout.');
} finally {
  try { await browser('close'); } catch { /* local cleanup still proceeds */ }
  stop();
  rmSync(work, { recursive: true, force: true });
}
