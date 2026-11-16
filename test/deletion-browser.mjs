// Opt-in browser regression: node test/deletion-browser.mjs.
// Only an isolated loopback Worker and test-mail transport are used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, freePort } from './helpers/worker.mjs';

const exec = promisify(execFile);
const work = mkdtempSync(join(tmpdir(), 'hap-deletion-browser-'));
const session = `deletion-${process.pid}`;
let worker;
const stop = () => worker?.stop();
process.once('exit', stop);
process.once('SIGTERM', () => { stop(); process.exit(1); });
async function browser(...args) {
  try {
    return (await exec('agent-browser', ['--session', session, ...args], {
      encoding: 'utf8', timeout: 45000, env: { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '180000' },
    })).stdout;
  } catch { throw new Error(`Browser command failed: ${args[0]} (fixture credentials omitted)`); }
}
async function evaluate(source) {
  await browser('frame', 'main');
  const result = JSON.parse(await browser('--json', 'eval', source));
  assert.equal(result.success, true, 'browser evaluation succeeded');
  return result.data.result;
}
try {
  const port = await freePort();
  worker = await startWorker(work, { OWNER_EMAIL: 'owner@example.com', APP_ORIGIN: `http://127.0.0.1:${port}`, TEST_MAIL_TRANSPORT: 'loopback' }, { port });
  const response = await fetch(worker.base + '/api/artifacts', {
    method: 'POST', headers: { Authorization: `Bearer ${worker.owner}` },
    body: JSON.stringify({ title: 'Delete redirect fixture', ttlSeconds: 0, files: { 'index.html': Buffer.from('<h1>Deletion fixture</h1>').toString('base64') } }),
  });
  assert.equal(response.status, 201);
  const artifact = await response.json();
  const requested = await (await fetch(worker.base + '/api/auth/request', { method: 'POST', headers: { Origin: worker.base }, body: JSON.stringify({ email: 'owner@example.com' }) })).json();
  const verified = await fetch(worker.base + '/api/auth/verify', { method: 'POST', headers: { Origin: worker.base }, body: JSON.stringify({ token: new URL(requested.loginUrl).hash.slice(7) }) });
  assert.equal(verified.status, 200);
  const cookie = verified.headers.getSetCookie()[0].split(';')[0];
  const split = cookie.indexOf('=');
  await browser('cookies', 'set', cookie.slice(0, split), cookie.slice(split + 1), '--url', worker.base, '--httpOnly', '--sameSite', 'Lax');
  const url = worker.base + '/v/' + artifact.id;
  await browser('open', url);
  const tabs = JSON.parse(await browser('--json', 'tab', 'list')).data.tabs;
  const tab = tabs.find(t => t.url === url);
  assert.ok(tab);
  await browser('--pin-tab', 'tab', tab.tabId);
  await browser('wait', '#bar:not([hidden])');
  await browser('wait', '--fn', 'document.getElementById("frame").style.display === "block"');
  await evaluate(`(() => {
    const original = window.fetch.bind(window);
    window.__deleteRequests = 0;
    window.fetch = (input, init) => {
      if (init?.method === 'DELETE') {
        window.__deleteRequests++;
        if (window.__failDelete) return Promise.resolve(new Response(JSON.stringify({error:'Temporary deletion failure'}), {status:503,headers:{'Content-Type':'application/json'}}));
      }
      return original(input, init);
    };
    window.confirm = () => false;
    return true;
  })()`);
  await browser('click', '#titleBtn');
  await browser('click', '#deleteBtn');
  assert.equal(await evaluate('window.__deleteRequests'), 0, 'cancelling sends no deletion request');
  assert.equal(await evaluate('location.pathname'), '/v/' + artifact.id, 'cancelling stays in the viewer');
  await evaluate('window.confirm = () => true; window.__failDelete = true; true');
  await browser('click', '#titleBtn');
  await browser('click', '#deleteBtn');
  await browser('wait', '#toast:not([hidden])');
  assert.equal(await evaluate('document.getElementById("toastText").textContent'), 'Could not delete: Temporary deletion failure');
  assert.equal(await evaluate('location.pathname'), '/v/' + artifact.id, 'failed deletion does not redirect');
  assert.equal(await evaluate('document.getElementById("frame").style.display'), 'block', 'failed deletion leaves the page visible');
  assert.equal(await evaluate('document.getElementById("deleteBtn").disabled'), false, 'failed deletion can be retried');
  await evaluate('window.__failDelete = false; true');
  const historyLength = await evaluate('history.length');
  await browser('click', '#titleBtn');
  await browser('click', '#deleteBtn');
  await browser('wait', '--fn', 'location.pathname === "/"');
  assert.equal(await evaluate('history.length'), historyLength, 'library navigation replaces the deleted viewer history entry');
  await browser('wait', '#app:not([hidden])');
  const removed = await fetch(worker.base + '/api/artifacts/' + artifact.id, { headers: { Authorization: `Bearer ${worker.owner}` } });
  assert.equal(removed.status, 404, 'artifact was actually deleted');
  console.log('Browser verification passed: cancel keeps the viewer; failure preserves the page and allows retry; success replaces the deleted viewer with the Artifacts library.');
} finally {
  try { await browser('close'); } catch { /* fixture cleanup still proceeds */ }
  stop();
  rmSync(work, { recursive: true, force: true });
}
