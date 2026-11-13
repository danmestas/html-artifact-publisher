// Opt-in real Chromium QA for the viewer's account workspace, invoked by
// VIEWER_WORKSPACE_QA=1 (test/viewer-workspace.test.mjs owns the Worker). It
// covers what only a browser can show: the sidebar's account-scoped cache, the
// single inspector that never reloads the page, draft/scroll/frame identity
// across pane switches, and the capability link that must not become an account.
//
// Every agent-browser call is asynchronous on purpose. Node has to keep
// draining the Worker's and wrangler's pipes while a command runs; a
// synchronous wait blocks the event loop, so a response the browser is waiting
// on is only read once the test yields, which looks exactly like a stalled page.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function viewerWorkspaceQA({ base, output, api, account, artifact, namedEditor, grantCandidate, secondAccount, recentArtifact }) {
  mkdirSync(output, { recursive: true });
  // A page-init script that (a) on a page opened with ?holdLibrary=1 sends the
  // first /api/library request immediately, under whatever cookie the page has at
  // that moment, but withholds its answer until the test releases it, so a late
  // answer issued for one account can arrive after another account was confirmed;
  // and (b) answers the viewer's leave prompt from a flag, recording each ask.
  const initScript = join(output, 'workspace-init.js');
  writeFileSync(initScript, `(() => {
  const original = window.fetch;
  const hold = location.search.includes('holdLibrary=1');
  let holdFirst = hold;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  window.__libraryHeld = false;
  window.__libraryAnswered = false;
  window.__releaseLibrary = () => { window.__libraryHeld = false; release(); };
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (holdFirst && /\\/api\\/library\\b/.test(url)) {
      holdFirst = false;
      const request = original.call(this, input, init);
      window.__libraryHeld = true;
      return held.then(() => request).finally(() => { window.__libraryAnswered = true; });
    }
    return original.call(this, input, init);
  };
  window.__confirmCalls = [];
  window.__cancelLeave = false;
  window.confirm = function (message) {
    window.__confirmCalls.push(String(message));
    return !window.__cancelLeave;
  };
})();\n`);

  const session = `viewer-workspace-qa-${process.pid}`;
  let viewerTab = '';
  const run = async (...args) => {
    const exec = async (...command) => (await execFileAsync('agent-browser', ['--session', session, ...command], {
      encoding: 'utf8', timeout: 45000,
      env: { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '600000', AGENT_BROWSER_INIT_SCRIPTS: initScript },
    })).stdout;
    try {
      // The CLI can select its initial blank tab after a fill. Keep every
      // workspace action on the fixture, not whichever tab it made current.
      if (viewerTab && !['open', 'close', 'tab', 'get'].includes(args[0])) await exec('tab', viewerTab);
      const stdout = await exec(...args);
      if (args[0] === 'open') {
        const tabs = JSON.parse(await exec('--json', 'tab', 'list')).data.tabs;
        viewerTab = tabs.find(t => t.url === args[1])?.tabId ?? '';
        assert.ok(viewerTab, 'the fixture viewer has its own browser tab');
        // Remove only the unused initial tab in this test's isolated session;
        // it must never become the fallback target of a later command.
        for (const tab of tabs) if (tab.tabId !== viewerTab && tab.url === 'about:blank') await exec('tab', 'close', tab.tabId);
        await exec('--pin-tab', 'tab', viewerTab);
      }
      return stdout;
    } catch (error) {
      const label = ['open', 'cookies'].includes(args[0]) ? `${args[0]} [private fixture]` : args.join(' ').slice(0, 90);
      const diagnostic = `agent-browser ${label} (${error.code ?? 'failed'}): ${error.stdout ?? ''}${error.stderr ?? ''}`;
      throw new Error(diagnostic.replace(/\b[0-9a-f]{64}\b/gi, '[private capability]'));
    }
  };
  const json = async source => {
    // Interacting with the embedded page can change the CLI's frame context.
    // Workspace assertions always refer to the parent viewer, never its iframe.
    await run('frame', 'main');
    const result = JSON.parse(await run('--json', 'eval', source));
    assert.equal(result.success, true, String(result.error ?? 'browser evaluation failed'));
    return result.data.result;
  };
  const wait = selector => run('wait', selector);
  const cookieOf = user => user.cookie.split('=').slice(1).join('=');
  const signInAs = user => run('cookies', 'set', 'artifact_session', cookieOf(user), '--url', base, '--httpOnly', '--sameSite', 'Lax');
  let failure;
  let stage = 'start';
  try {
    stage = 'owner-workspace';
    // ── A signed-in owner sees their account workspace ────────────────────
    await signInAs(account);
    await run('set', 'viewport', '1440', '900');
    await run('open', `${base}/v/${artifact.id}`);
    await run('tab', viewerTab);
    await run('wait', '--fn', `document.visibilityState === 'visible'`);
    await wait('#bar:not([hidden])');
    await wait('#navBtn:not([hidden])');
    await run('wait', '--fn', `document.getElementById('recentList').children.length > 0`);
    assert.equal(await json(`document.getElementById('recentList').textContent.includes(${JSON.stringify(artifact.title)})`), true, 'the sidebar lists the signed-in account’s recent artifacts');
    assert.equal(await json(`document.getElementById('librarySidebar').hidden`), false, 'a wide signed-in page docks the library sidebar');

    // On phones the drawer toggle replaces, rather than overlaps, the library link.
    for (const width of [320, 375, 393]) {
      await run('set', 'viewport', String(width), '844');
      assert.equal(await json(`(() => { const n = document.getElementById('navBtn'), r = n.getBoundingClientRect(); return !n.hidden && getComputedStyle(document.getElementById('backLibrary')).display === 'none' && n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) && document.documentElement.scrollWidth <= innerWidth; })()`), true, 'phone navigation has an unobstructed touch target');
    }
    await run('set', 'viewport', '1440', '900');

    // Rename through the cookie-only dialog, then read it back from the API.
    await run('click', '#titleBtn');
    await wait('#titleMenu:not([hidden])');
    await run('click', '#renameBtn');
    await wait('#renameDialog[open]');
    await run('fill', '#renameTitle', 'Renamed in the workspace');
    await run('click', '#renameForm button[type=submit]');
    await run('wait', '--fn', `!document.getElementById('renameDialog').open`);
    assert.equal((await api(`/api/artifacts/${artifact.id}`, { cookie: account.cookie })).json.title, 'Renamed in the workspace', 'the owner renames with the account cookie alone');

    stage = 'management-dialog-contrast';
    for (const theme of ['dark', 'light']) {
      await run('tab', viewerTab);
      await run('wait', '--fn', `document.visibilityState === 'visible'`);
      await json(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      await run('click', '#titleBtn');
      await run('click', '#expirationBtn');
      await wait('#expirationDialog[open]');
      const contrast = () => json(`(() => {
        const button = document.querySelector('#expirationForm [type=submit]');
        const rgb = s => s.match(/[\\d.]+/g).slice(0, 3).map(Number);
        const lum = c => c.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
        const style = getComputedStyle(button), surface = rgb(getComputedStyle(document.getElementById('expirationDialog')).backgroundColor), opacity = Number(style.opacity);
        const blend = s => rgb(s).map((v, i) => opacity * v + (1 - opacity) * surface[i]);
        const a = lum(blend(style.color)), b = lum(blend(style.backgroundColor));
        const focus = getComputedStyle(document.getElementById('expiryMode'));
        const ring = rgb(focus.outlineColor), f = lum(ring), ground = lum(surface);
        return { text: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), focus: (Math.max(f, ground) + .05) / (Math.min(f, ground) + .05), ringChroma: Math.max(...ring) - Math.min(...ring), outlineWidth: focus.outlineWidth };
      })()`);
      await run('screenshot', join(output, `expiration-${theme}.png`));
      const enabled = await contrast();
      assert.ok(enabled.text >= 4.5, JSON.stringify({ theme, enabled }));
      assert.ok(enabled.focus >= 3 && enabled.ringChroma <= 15 && enabled.outlineWidth === '2px', JSON.stringify({ theme, enabled }));
      await json(`document.querySelector('#expirationForm [type=submit]').disabled = true`);
      const disabled = await contrast();
      writeFileSync(join(output, `expiration-${theme}-contrast.json`), JSON.stringify({ theme, enabled, disabled }, null, 2));
      await run('screenshot', join(output, `expiration-${theme}-saving.png`));
      assert.ok(disabled.text >= 4.5, JSON.stringify({ theme, disabled }));
      await json(`document.querySelector('#expirationForm [type=submit]').disabled = false`);
      await run('press', 'Escape');
      await run('wait', '--fn', `!document.getElementById('expirationDialog').open`);
    }

    stage = 'grants';
    // ── Named access: every change lands in the UI and on the server ──────
    // Opened before the inspector's long-lived connections fill the browser's
    // per-origin pool, so the sharing read is not queued behind them.
    const person = grantCandidate.user;
    await run('click', '#shareBtn');
    await wait('#shareMenu:not([hidden])');
    await run('wait', '--fn', `[...document.getElementById('peoplePick').options].some(o => o.value === ${JSON.stringify(person.id)})`);
    await run('select', '#peoplePick', person.id);
    await run('select', '#peoplePermission', 'read');
    await run('click', '#peopleForm button[type=submit]');
    // The row appears without waiting for a reload of the pane…
    await run('wait', '--fn', `document.getElementById('peopleList').textContent.includes(${JSON.stringify(person.email)})`);
    const added = (await api(`/api/artifacts/${artifact.id}/sharing`, { cookie: account.cookie })).json;
    assert.ok(added.grants.some(g => g.userId === person.id && g.permission === 'read'), 'the added grant is on the server and in the list');
    // …and a change is shown in the same row and stored.
    const rowSelect = `#peopleList select[aria-label="Permission for ${person.email}"]`;
    await run('select', rowSelect, 'write');
    await run('wait', '--fn', `document.querySelector(${JSON.stringify(rowSelect)}).value === 'write' && !document.querySelector(${JSON.stringify(rowSelect)}).disabled`);
    const changed = (await api(`/api/artifacts/${artifact.id}/sharing`, { cookie: account.cookie })).json;
    assert.ok(changed.grants.some(g => g.userId === person.id && g.permission === 'write'), 'a permission change is on the server and stays in the list');
    await run('click', `#peopleList button[aria-label="Remove access for ${person.email}"]`);
    await run('wait', '--fn', `!document.getElementById('peopleList').textContent.includes(${JSON.stringify(person.email)})`);
    const removed = (await api(`/api/artifacts/${artifact.id}/sharing`, { cookie: account.cookie })).json;
    assert.ok(!removed.grants.some(g => g.userId === person.id), 'a removed grant leaves the server and the list');
    await run('wait', '--fn', `!document.querySelector('#peopleForm button[type=submit]').disabled`);
    assert.equal(await json(`document.querySelector('#peopleForm button[type=submit]').disabled`), false, 'the form is usable again once the change settled');
    await run('press', 'Escape');

    stage = 'inspector';
    // ── One inspector, never a reloaded page ──────────────────────────────
    await run('click', '#discussionsBtn');
    await wait('#threadPanel:not([hidden])');
    await run('wait', '--fn', `document.querySelectorAll('#threadPanel .thread').length > 0`);
    await json(`(window.__frame = document.getElementById('frame').contentWindow, true)`);
    await run('click', '#versionBtn');
    await wait('#historyPanel:not([hidden])');
    assert.equal(await json(`document.getElementById('threadPanel').hidden`), true, 'history and comments are exclusive');
    await run('click', '#discussionsBtn');
    await wait('#threadPanel:not([hidden])');
    assert.equal(await json(`document.getElementById('historyPanel').hidden`), true, 'switching back hides history');
    assert.equal(await json(`window.__frame === document.getElementById('frame').contentWindow`), true, 'switching panes keeps the same page instance');
    assert.equal(await json(`document.getElementById('inspector').hidden`), false, 'one inspector serves both');

    // A reply draft survives closing the inspector, opening history and returning.
    await run('click', '#threadPanel .thread:first-of-type summary');
    await run('wait', '--fn', `document.getElementById('threadPanel').dataset.mode === 'thread'`);
    await run('fill', '#threadPanel .thread.focus .reply textarea', 'An unfinished reply');
    const focusedThread = await json(`(() => { const t = document.querySelector('#threadPanel .thread.focus'); return { label: t?.dataset.label ?? null, mode: document.getElementById('threadPanel')?.dataset.mode ?? null, hidden: document.getElementById('inspector')?.hidden ?? null, top: window === top, path: location.pathname, reply: t?.querySelector('.reply textarea')?.value ?? null }; })()`);
    assert.ok(focusedThread.label && focusedThread.reply === 'An unfinished reply', JSON.stringify(focusedThread));
    const label = focusedThread.label;
    await run('click', '#threadClose');
    await run('wait', '--fn', `document.getElementById('inspector').hidden`);
    await run('click', '#versionBtn');
    await wait('#historyPanel:not([hidden])');
    await run('click', '#discussionsBtn');
    await wait('#threadPanel:not([hidden])');
    await run('click', `#threadList .thread[data-label="${label}"] summary`);
    await run('wait', '--fn', `document.getElementById('threadPanel').dataset.mode === 'thread'`);
    assert.equal(await json(`document.querySelector('#threadPanel .thread.focus .reply textarea').value`), 'An unfinished reply', 'a draft survives closing and switching panes');
    // Nothing was persisted to browser storage.
    assert.equal(await json(`Object.keys(localStorage).length + Object.keys(sessionStorage).length`), 0, 'drafts stay in memory, not browser storage');

    // Panel scroll survives a background refresh of the same threads.
    const scrollable = await json(`(() => { const s = document.querySelector('#threadPanel .panel-scroll'); s.scrollTop = s.scrollHeight; return s.scrollTop > 0; })()`);
    if (scrollable) {
      const before = await json(`document.querySelector('#threadPanel .panel-scroll').scrollTop`);
      await api(`/api/artifacts/${artifact.id}/tickets`, { method: 'POST', token: artifact.write, body: { text: 'A reply from another client' } });
      await run('wait', '--fn', `document.getElementById('threadPanel').textContent.includes('A reply from another client')`);
      assert.equal(await json(`document.querySelector('#threadPanel .panel-scroll').scrollTop`), before, 'a background update keeps the reader’s position');
    }

    stage = 'leave';
    // ── Leaving by a recent row asks first; other doors do not ────────────
    await run('click', '#discussionsBtn');
    await wait('#threadPanel:not([hidden])');
    await run('click', `#threadList .thread[data-label="${label}"] summary`);
    await run('wait', '--fn', `document.getElementById('threadPanel').dataset.mode === 'thread'`);
    const here = await json('location.href');
    const away = await json(`(() => {
      window.__confirmCalls = []; window.__cancelLeave = true;
      const link = [...document.querySelectorAll('#recentList .recent-item')].find(a => !a.hasAttribute('aria-current'));
      if (!link) return null;
      link.click();
      return link.href;
    })()`);
    assert.ok(away, 'the sidebar has another artifact to leave by');
    assert.equal(await json('location.href'), here, 'canceling the prompt keeps the page');
    assert.equal(await json('window.__confirmCalls.length'), 1, 'a recent row asks exactly once');
    assert.equal(await json(`document.querySelector('#threadPanel .thread.focus .reply textarea').value`), 'An unfinished reply', 'canceling a recent-row navigation keeps the reply draft');
    // Do not let the reply map mask an unsent new-comment draft. Switching
    // inspectors returns Comments to its index, but the composer still exists.
    await run('fill', '#threadPanel .thread.focus .reply textarea', '');
    await run('click', '#allComments');
    await run('click', '#generalComment');
    await wait('#commentForm:not([hidden])');
    await run('fill', '#commentText', 'A general draft that survives a history visit');
    await run('click', '#versionBtn');await wait('#historyPanel:not([hidden])');
    await run('click', '#discussionsBtn');await wait('#threadPanel:not([hidden])');
    assert.equal(await json(`document.getElementById('threadPanel').dataset.mode`), 'index');
    assert.equal(await json(`document.getElementById('commentText').value`), 'A general draft that survives a history visit');
    await json(`(() => { window.__confirmCalls=[];window.__cancelLeave=true;[...document.querySelectorAll('#recentList .recent-item')].find(a=>!a.hasAttribute('aria-current')).click();return true; })()`);
    assert.equal(await json('location.href'), here, 'a hidden new-comment draft still prevents silent Recent navigation');
    assert.equal(await json('window.__confirmCalls.length'),1,'the new-comment path asks exactly once after switching panes');
    assert.equal(await json(`document.getElementById('commentText').value`),'A general draft that survives a history visit');
    await run('click','#generalComment');await wait('#commentForm:not([hidden])');
    await run('fill','#commentText','');await run('click','#cancelComment');
    // A modifier-click opens elsewhere: it is not leaving this page. The event
    // is synthesized, so the browser's own new-tab behaviour still exists as a
    // same-page default action; block that at capture so the check is about the
    // viewer's guard and not about Chromium following an untrusted click.
    await json('(window.__pageMarker = Math.random(), true)');
    assert.equal(await json(`(() => {
      window.__confirmCalls = []; window.__cancelLeave = true;
      const link = [...document.querySelectorAll('#recentList .recent-item')][0];
      window.addEventListener('click', e => e.preventDefault(), { once: true, capture: true });
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
      return window.__confirmCalls.length;
    })()`), 0, 'a new-tab click is never prompted for');
    assert.equal(await json('typeof window.__pageMarker === "number"'), true, 'a modifier-click does not navigate this page');
    // Another version of this page swaps in place, so it asks nothing.
    const versionHref = await json(`(() => {
      window.__confirmCalls = []; window.__cancelLeave = true;
      const link = document.querySelector('#versionList a[aria-current="false"]');
      if (!link) return null;
      link.click();
      return link.href;
    })()`);
    if (versionHref) {
      // The hash navigation and its in-place render are both asynchronous; wait
      // for the new version to be the one on screen before reading the chrome.
      const nextHash = new URL(versionHref).hash;
      await run('wait', '--fn', `location.hash === ${JSON.stringify(nextHash)} && document.getElementById('role').textContent !== ''`);
      assert.equal(await json('window.__confirmCalls.length'), 0, 'an internal version change is not a leave');
      assert.ok(await json('typeof window.__pageMarker === "number"'), 'the version change swapped in place instead of loading a page');
    }

    stage = 'identity-loss';
    // ── The cookie is the account; the capability link is not ─────────────
    // Signing out elsewhere, while this page keeps its edit link, must drop the
    // account UI without a reload: the link still opens the content, but it was
    // never evidence that the cookie owner is signed in.
    assert.equal(await json(`!document.getElementById('navBtn').hidden`), true, 'a signed-in owner has the library toggle');
    // Revalidation deliberately ignores hidden pages. Activate this test's
    // original tab before simulating a return, rather than dispatching an event
    // whose visible-state precondition is false.
    await run('tab', viewerTab);
    await run('wait', '--fn', `document.visibilityState === 'visible'`);
    await run('cookies', 'clear');
    assert.equal(await json(`fetch('/api/session', { cache: 'no-store' }).then(r => r.json()).then(data => data.user)`), null, 'clearing cookies removes the account session');
    await json(`(document.dispatchEvent(new Event('visibilitychange')), true)`);
    await run('wait', '--fn', `document.getElementById('navBtn').hidden`);
    assert.equal(await json(`document.getElementById('navBtn').hidden`), true, 'observed identity loss hides the library toggle');
    assert.equal(await json(`document.getElementById('recentList').children.length`), 0, 'the recent cache is scoped to the account and is gone');
    await run('click', '#titleBtn');
    await wait('#titleMenu:not([hidden])');
    await run('wait', '--fn', `document.getElementById('renameBtn').hidden`);
    assert.equal(await json(`document.getElementById('renameBtn').hidden`), true, 'management goes with the cookie, not the link');

    // A fresh page with only the edit link behaves the same way from the start.
    await run('open', `${base}/v/${artifact.id}#${artifact.write}`);
    await wait('#bar:not([hidden])');
    await run('wait', '--fn', `document.getElementById('navBtn').hidden`);
    assert.equal(await json(`document.getElementById('navBtn').hidden`), true, 'a signed-out capability reader gets no library toggle');
    await run('click', '#titleBtn');
    assert.equal(await json(`document.getElementById('renameBtn').hidden`), true, 'no management without a cookie');
    assert.equal(await json(`document.getElementById('expirationBtn').hidden`), true);
    assert.equal(await json(`document.getElementById('uploadFilesBtn').hidden`), false, 'the legacy edit link still uploads');
    assert.equal(await json(`document.getElementById('deleteBtn').hidden`), false, 'the legacy edit link still deletes');
    assert.ok(await json(`document.getElementById('authorityNote').textContent.includes('edit link')`), 'the page says which authority is acting');
    await run('press', 'Escape');
    await run('click', '#shareBtn');
    await wait('#shareMenu:not([hidden])');
    assert.equal(await json(`document.getElementById('peopleSection').hidden`), true, 'no people inventory without an account');
    assert.equal(await json(`document.getElementById('publicationSection').hidden`), true, 'no snapshots inventory without an account');
    assert.equal(await json(`document.getElementById('libraryLink')`), null, 'a capability link page offers no library link');
    assert.ok(await json(`document.getElementById('shareRows').textContent.includes('Edit link')`), 'the link itself is still shareable');
    await run('press', 'Escape');

    stage = 'named-editor';
    // ── A named editor has account UI but no management ───────────────────
    await signInAs(namedEditor);
    await run('open', `${base}/v/${artifact.id}`);
    await run('wait', '--fn', `document.getElementById('role').textContent === 'Can edit'`);
    assert.equal(await json(`document.getElementById('role').textContent`), 'Can edit', 'a named editor acts by account, not link');
    await run('click', '#titleBtn');
    await wait('#titleMenu:not([hidden])');
    await run('wait', '--fn', `document.getElementById('renameBtn').hidden`);
    assert.equal(await json(`document.getElementById('renameBtn').hidden`), true, 'a named editor does not manage');
    assert.equal(await json(`document.getElementById('peopleSection')?.hidden ?? true`), true, 'and sees no people section');

    stage = 'stale-answer';
    // ── A late answer for the previous account is never shown as this one ──
    // The first library request is sent while `account` owns the cookie but is
    // held until after `secondAccount` has been confirmed. Its answer lists the
    // first account's artifacts; showing it under the second would be a leak.
    await signInAs(account);
    await run('open', `${base}/v/${artifact.id}?holdLibrary=1`);
    await wait('#bar:not([hidden])');
    await run('wait', '--fn', `window.__libraryHeld === true`);
    await run('tab', viewerTab);
    await run('wait', '--fn', `document.visibilityState === 'visible'`);
    await signInAs(secondAccount);
    await json(`(document.dispatchEvent(new Event('visibilitychange')), true)`);
    await run('wait', '--fn', `document.getElementById('recentList').textContent.includes('Only the second account has this')`);
    assert.equal(await json(`document.getElementById('recentList').textContent.includes(${JSON.stringify(recentArtifact.title)})`), false, 'the second account sees only its own artifacts');
    await json('(window.__releaseLibrary(), true)');
    await run('wait', '--fn', `window.__libraryAnswered === true`);
    // Let any write the late answer could make land, then read the list again.
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await json(`document.getElementById('recentList').textContent.includes('Only the second account has this')`), true, 'the second account’s own list survives the late answer');
    assert.equal(await json(`document.getElementById('recentList').textContent.includes(${JSON.stringify(recentArtifact.title)})`), false, 'a late answer for the previous account is discarded, not cached under this one');
    return { output };
  } catch (error) {
    failure = error;
    error.message = `[stage: ${stage}] ${error.message}`;
    throw error;
  } finally {
    try { await run('close'); } catch (error) { if (!failure) throw error; }
  }
}
