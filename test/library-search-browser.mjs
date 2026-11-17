// Opt-in real-Chromium QA for library content search. Not part of `npm test`:
// it starts its own Worker and needs a full Chrome, because the default
// agent-browser executable is currently broken on this machine (RAF).
//
//   BODY_SEARCH_BROWSER_QA=1 AGENT_BROWSER_HEADED=1 \
//   AGENT_BROWSER_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     node --test test/library-search-browser.mjs
//
// It is written against the merged backend: a body-only match, an excerpt that
// renders page source as inert text, the sort URL contract, coverage wording,
// and the owner-only backfill panel. Run it after the backend lands; until
// then the endpoints it reads do not exist and it is expected to fail.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { startWorker, freePort } from './helpers/worker.mjs';

const execFileAsync = promisify(execFile);
const CHROME = process.env.AGENT_BROWSER_CHROME || '';

function haveAgentBrowser() {
  try { execFileSync('agent-browser', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// A full Chrome is passed explicitly; the default executable cannot paint
// requestAnimationFrame on this machine, which stalls every wait on a frame.
function driver(session) {
  const flags = [...(CHROME ? ['--executable-path', CHROME] : []), ...(process.env.AGENT_BROWSER_HEADED === '1' ? ['--headed'] : [])];
  const run = async (...args) => (await execFileAsync('agent-browser', ['--session', session, ...flags, ...args], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '120000' },
  })).stdout;
  const evaluate = async source => {
    const result = JSON.parse(await run('--json', 'eval', source));
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data.result;
  };
  return { run, evaluate, wait: selector => run('wait', selector), click: selector => run('click', selector) };
}

function api(base) {
  return async (path, { method = 'GET', cookie = '', body } = {}) => {
    const res = await fetch(base + path, {
      method, headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, headers: res.headers, json };
  };
}

async function signIn(call, base, email) {
  const requested = await call('/api/auth/request', { method: 'POST', body: { email, returnTo: '/' } });
  assert.equal(requested.status, 200, 'local mail transport');
  const verified = await call('/api/auth/verify', { method: 'POST', body: { token: new URL(requested.json.loginUrl).hash.slice(1).split('token=')[1] } });
  assert.equal(verified.status, 200);
  return verified.headers.get('set-cookie').split(';')[0];
}

test('real browser: content search shows honest excerpts, sort state and owner index progress', { timeout: 300000 }, async t => {
  if (process.env.BODY_SEARCH_BROWSER_QA !== '1') return t.skip('BODY_SEARCH_BROWSER_QA=1 enables the real-browser content search QA');
  if (!haveAgentBrowser()) return t.skip('agent-browser is not installed');
  const port = await freePort();
  const app = await startWorker(join(process.cwd(), '.wrangler', 'body-search-qa-' + process.pid), {
    OWNER_EMAIL: 'owner@example.com', APP_ORIGIN: `http://127.0.0.1:${port}`, TEST_MAIL_TRANSPORT: 'loopback',
  }, { port });
  const call = api(app.base);
  const output = join(process.cwd(), '.wrangler', 'body-search-qa-shots');
  mkdirSync(output, { recursive: true });
  const session = `body-search-qa-${process.pid}`;
  const { run, evaluate, wait } = driver(session);
  try {
    const cookie = await signIn(call, app.base, 'owner@example.com');
    const page = '<h1>Field notes</h1><p>The capybara population recovered across five river basins.</p><pre>&lt;img src=x onerror=alert(1)&gt;</pre>';
    const created = await call('/api/artifacts', { method: 'POST', cookie, body: { title: 'River report', ttlSeconds: null, files: { 'index.html': Buffer.from(page).toString('base64') } } });
    assert.equal(created.status, 201);
    // Static text is indexed, but scripts are never executed: a second document
    // makes partial coverage real even when the text query has no matches.
    const partial = await call('/api/artifacts', { method: 'POST', cookie, body: {
      title: 'Interactive appendix', ttlSeconds: null,
      files: { 'index.html': Buffer.from('<!doctype html><html><body><p>Appendix</p><script>document.body.append("dynamic-only")</script></body></html>').toString('base64') },
    } });
    assert.equal(partial.status, 201);

    await run('cookies', 'set', 'artifact_session', cookie.split('=')[1], '--url', app.base, '--httpOnly', '--sameSite', 'Lax');
    await run('open', `${app.base}/?q=capybara`);
    await wait('.artifact-title');

    // A body-only hit renders an excerpt whose marks are the query words.
    assert.equal(await evaluate('document.querySelector(".artifact-title").textContent.includes("River report")'), true);
    assert.equal(await evaluate('document.querySelector(".search-excerpt mark")?.textContent'), 'capybara');
    assert.equal(await evaluate('document.querySelector(".search-path").textContent'), 'index.html');
    // Page source in the artifact body stays inert text inside the excerpt.
    assert.equal(await evaluate('!!document.querySelector(".search-excerpt img, .search-excerpt script")'), false, 'no element parsed out of page source');
    assert.ok((await evaluate('document.querySelector(".search-excerpt").textContent')).includes('<img src=x onerror=alert(1)>'));
    assert.match(await evaluate('document.querySelector(".search-facts").textContent'), /Matched in page content/);

    // The relevance sort is visible only with a query, and the URL records an
    // explicit recent so a reload cannot flip it back to relevance.
    assert.equal(await evaluate('document.getElementById("sort").querySelector(\'[value="relevance"]\').hidden'), false);
    await run('select', '#sort', 'recent');
    assert.equal(await evaluate('new URLSearchParams(location.search).get("sort")'), 'recent');
    await run('fill', '#search', 'river');
    await run('press', 'Enter');
    await wait('.artifact-title');
    assert.equal(await evaluate('new URLSearchParams(location.search).get("sort")'), 'recent', 'an explicit recent survives a query edit');
    await run('fill', '#search', '');
    await run('press', 'Enter');
    await wait('#content[aria-busy="false"]');
    assert.equal(await evaluate('document.getElementById("sort").value'), 'recent');
    assert.equal(await evaluate('document.getElementById("sort").querySelector(\'[value="relevance"]\').hidden'), true);
    // A chosen recent is written even without a query, so a reload keeps it and
    // the next query does not mistake it for the default.
    await run('reload');
    await wait('#content[aria-busy="false"]');
    assert.equal(await evaluate('document.getElementById("sort").value'), 'recent', 'a chosen recent survives a reload');
    assert.equal(await evaluate('new URLSearchParams(location.search).get("sort")'), 'recent');
    // A fresh default recent, with no choice recorded, becomes relevance on the
    // first query instead.
    await run('open', `${app.base}/`);
    await wait('#content[aria-busy="false"]');
    assert.equal(await evaluate('document.getElementById("sort").value'), 'recent');
    assert.equal(await evaluate('new URLSearchParams(location.search).get("sort")'), null, 'the untouched default writes no sort');
    await run('fill', '#search', 'capybara');
    await run('press', 'Enter');
    await wait('.artifact-title');
    assert.equal(await evaluate('document.getElementById("sort").value'), 'relevance', 'a first query from the default recent becomes relevance');

    // Screenshots at both phone widths and both themes.
    for (const width of [390, 320]) for (const theme of ['light', 'dark']) {
      await run('set', 'viewport', String(width), '1000');
      await run('open', `${app.base}/?q=capybara`);
      await wait('.search-excerpt');
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await run('screenshot', join(output, `search-${theme}-${width}.png`));
    }

    // The index panel is owner-only, on the inventory, and never starts a
    // build on its own: no POST until the button is pressed. Nothing is read
    // from the status endpoint just by loading the page either.
    await run('open', `${app.base}/?view=admin`);
    await wait('#content[aria-busy="false"]');
    assert.equal(await evaluate('document.getElementById("search-index-panel").open'), false, 'the panel starts closed');
    // Count index requests from here on; a reload would drop this wrapper.
    await evaluate(`(()=>{
      const real = window.fetch;
      window.fetch = (url, options) => {
        const path = new URL(String(url), location.href).pathname;
        if (path === '/api/admin/search-index') { if (options?.method === 'POST') window.__indexPosts = (window.__indexPosts||0)+1; else window.__indexGets = (window.__indexGets||0)+1; }
        return real(url, options);
      }; window.__indexPosts = 0; window.__indexGets = 0; return true;
    })()`);
    assert.equal(await evaluate('document.getElementById("search-index-panel").hidden'), false);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(await evaluate('window.__indexGets'), 0, 'loading the inventory reads no index status');
    await evaluate('document.getElementById("search-index-panel").open=true');
    await run('wait', '--fn', 'window.__indexGets>0');
    assert.equal(await evaluate('window.__indexPosts'), 0, 'opening the panel does not start a build');
    await run('click', '#search-index-start');
    await run('wait', '--fn', 'window.__indexPosts===1');
    await evaluate('document.getElementById("search-index-panel").open=false');
    const held = await evaluate('window.__indexGets');
    await new Promise(r => setTimeout(r, 5000));
    assert.equal(await evaluate('window.__indexGets'), held, 'closing the panel stops polling');
    await run('screenshot', join(output, 'index-panel.png'));

    // A delayed error from a closed panel must not overwrite a newly opened
    // panel's confirmed progress. Exercise the real handler, not a fake card.
    await evaluate(`(()=>{
      const real = window.fetch; let hold = true;
      window.fetch = (url, options) => {
        if (hold && new URL(String(url), location.href).pathname === '/api/admin/search-index' && options?.method !== 'POST') {
          hold = false;
          return new Promise((_resolve, reject) => { window.__releaseOldIndex = () => reject(new Error('superseded-index-error')); });
        }
        return real(url, options);
      };
      document.getElementById('search-index-panel').open = true;
      return true;
    })()`);
    await run('wait', '--fn', 'typeof window.__releaseOldIndex === "function"');
    await evaluate('document.getElementById("search-index-panel").open=false');
    await run('wait', '--fn', '!document.getElementById("search-index-panel").open');
    await evaluate('document.getElementById("search-index-panel").open=true');
    await run('wait', '--fn', 'window.__indexGets > ' + held);
    await wait('#search-index-start:not([disabled])');
    await evaluate('window.__releaseOldIndex(); true');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await evaluate('document.getElementById("search-index-status").textContent.includes("superseded-index-error")'), false,
      'an old request cannot change the reopened panel');
    await evaluate('document.getElementById("search-index-panel").open=false');

    // A member never sees the panel, and no status is read for them.
    const invited = await call('/api/invitations', { method: 'POST', cookie, body: { email: 'member@example.com', name: 'Member' } });
    assert.equal(invited.status, 200, 'invite a member for the inventory check');
    const memberCookie = await signIn(call, app.base, 'member@example.com');
    await run('cookies', 'set', 'artifact_session', memberCookie.split('=')[1], '--url', app.base, '--httpOnly', '--sameSite', 'Lax');
    await run('open', `${app.base}/?view=admin`);
    await wait('#content[aria-busy="false"]');
    assert.equal(await evaluate('document.getElementById("search-index-panel").hidden'), true, 'members see no index panel');
    assert.equal(await evaluate('location.search.includes("view=admin")'), false, 'a member is returned to the library');

    // A query that matches nothing still states coverage honestly.
    await run('cookies', 'set', 'artifact_session', cookie.split('=')[1], '--url', app.base, '--httpOnly', '--sameSite', 'Lax');
    await run('open', `${app.base}/?q=zzzznotpresent`);
    await wait('#content[aria-busy="false"]');
    assert.equal(await evaluate('!!document.querySelector(".empty")'), true);
    assert.match(await evaluate('document.querySelector(".empty").textContent'), /Nothing in/);
    assert.equal(await evaluate('document.getElementById("search-coverage").hidden'), false, 'coverage is shown even with no results');
    // Coverage never calls a partly searched index unsearched.
    assert.doesNotMatch(await evaluate('document.getElementById("search-coverage").textContent'), /No artifact content has been searched yet\.[\s\S]*partly/,
      'a partly searched index is not described as nothing searched');

    // An account switch clears result rows, coverage and any open panel before
    // the new identity renders anything.
    await run('open', `${app.base}/?q=capybara`);
    await wait('.artifact-title');
    await evaluate(`(()=>{ window.__preSwitchRows = document.querySelectorAll('#content article').length; return true; })()`);
    const stale = await evaluate('window.__preSwitchRows');
    assert.ok(stale > 0, 'the owner had rendered rows before switching');
    await run('cookies', 'clear');
    await run('open', `${app.base}/?q=capybara`);
    await wait('#login:not([hidden])');
    assert.equal(await evaluate('document.querySelectorAll("#content article").length'), 0, 'signing out clears result rows');
    assert.equal(await evaluate('document.getElementById("search-coverage").hidden'), true, 'signing out clears coverage');
    assert.equal(await evaluate('document.getElementById("search-index-panel").hidden'), true, 'signing out hides the index panel');
  } finally {
    try { await execFileAsync('agent-browser', ['--session', session, 'close'], { timeout: 30000 }); } catch { /* already closed */ }
    app.stop();
  }
});
