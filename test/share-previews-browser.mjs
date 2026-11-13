// Opt-in real browser verification: node test/share-previews-browser.mjs.
// Uses only an isolated loopback Worker and test-mail transport.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, freePort } from './helpers/worker.mjs';
import { iconSvg } from '../public/icons.js';

const exec = promisify(execFile);
const work = mkdtempSync(join(tmpdir(), 'hap-preview-browser-'));
const session = `topic-preview-${process.pid}`;
let worker;
const stop = () => worker?.stop();
process.once('exit', stop);
process.once('SIGTERM', () => { stop(); process.exit(1); });
async function browser(...args) {
  try {
    return (await exec('agent-browser', ['--session', session, ...args], {
      encoding: 'utf8', timeout: 45000, env: { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '180000' },
    })).stdout;
  } catch (error) {
    const diagnostic = `${error.code ?? ''} ${error.stdout ?? ''} ${error.stderr ?? ''}`
      .replace(/https?:\/\/[^\s"']+/g, '[fixture URL]')
      .replace(/\b[0-9a-f]{64}\b/gi, '[private capability]').slice(0, 1200);
    throw new Error(`Browser command failed: ${args[0]}: ${diagnostic}`);
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
}
try {
  const port = await freePort();
  worker = await startWorker(work, { OWNER_EMAIL: 'owner@example.com', APP_ORIGIN: `http://127.0.0.1:${port}`, TEST_MAIL_TRANSPORT: 'loopback' }, { port });
  const title = 'Research findings for browser verification';
  const created = await fetch(worker.base + '/api/artifacts', {
    method: 'POST', headers: { Authorization: `Bearer ${worker.owner}` },
    body: JSON.stringify({ title, ttlSeconds: 0, files: { 'index.html': Buffer.from('<h1>Private fixture</h1>').toString('base64') } }),
  });
  assert.equal(created.status, 201);
  const artifact = await created.json();
  await open(artifact.viewerUrl);
  await browser('wait', '#bar:not([hidden])');
  assert.equal(await evaluate('document.title'), title);
  assert.equal(await evaluate('decodeURIComponent(document.querySelector(\'link[rel="icon"]\').href)'), 'data:image/svg+xml,' + iconSvg('research', true));
  assert.equal(await evaluate('document.querySelector(\'meta[property="og:title"]\').content'), title);
  const requested = await fetch(worker.base + '/api/auth/request', { method: 'POST', headers: { Origin: worker.base }, body: JSON.stringify({ email: 'owner@example.com' }) });
  const login = await requested.json();
  assert.ok(login.loginUrl, 'isolated test-mail login available');
  const verified = await fetch(worker.base + '/api/auth/verify', { method: 'POST', headers: { Origin: worker.base }, body: JSON.stringify({ token: new URL(login.loginUrl).hash.slice(7) }) });
  assert.equal(verified.status, 200);
  const cookie = verified.headers.getSetCookie()[0].split(';')[0];
  const split = cookie.indexOf('=');
  await browser('cookies', 'set', cookie.slice(0, split), cookie.slice(split + 1), '--url', worker.base, '--httpOnly', '--sameSite', 'Lax');
  await open(worker.base + '/');
  await browser('wait', '.artifact-title');
  const paths = await evaluate(`(() => { const a = [...document.querySelectorAll('.artifact-title')].find(a => a.textContent.includes(${JSON.stringify(title)})); return [...a.querySelectorAll('.artifact-icon svg path')].map(p => p.getAttribute('d')); })()`);
  const expectedPaths = [...iconSvg('research').matchAll(/<path d="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(paths, expectedPaths, 'library icon matches viewer and shared-link topic');
  console.log('Browser verification passed: actual title, server OG metadata, topic favicon, and matching library icon.');
} finally {
  try { await browser('close'); } catch { /* local fixture cleanup still proceeds */ }
  stop();
  rmSync(work, { recursive: true, force: true });
}
