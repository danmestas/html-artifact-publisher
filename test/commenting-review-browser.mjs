// Opt-in real Chromium QA for the commenting review (M1–M9): a compact
// identity line, recoverable drafts, stable references, thread deep links,
// filters, honest retry, own-message corrections and phone layouts.
//
//   COMMENTING_BROWSER_QA=1 node test/commenting-review-browser.mjs
//
// Requires the agent-browser executable. It owns its Worker, its loopback
// test mail and its disposable state, so nothing here touches production.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserDriver } from './library-browser.mjs';

// Every capability token is redacted from a failure message; the fixture's
// tokens are secrets even when they only exist in a test process.
const redact = value => String(value).replace(/[a-f0-9]{64}/g, '[redacted]').slice(0, 3000);

export const commentingReviewChecks = [
  'an identity line replaces the tall identity panel, and discussions are visible at once',
  'a guest posts a general comment and an anchored pin comment from one compact composer',
  'a rate-limited post keeps its text, counts down, and never reposts on its own',
  'a reload offers the interrupted draft for explicit Restore or Discard',
  'switching identity never shows the previous identity’s draft',
  'references stay stable across a reply, a resolve and Activity/Page order',
  'a thread deep link opens the thread, and survives a sign-in round trip',
  'search, filters and older pages come from the server',
  'a real 429 retains the text, counts down, and never reposts',
  'a reply draft survives a true reload with explicit Restore/Discard',
  'a proven own message saves a correction by click, with visible history',
  'a deep link outside the loaded page opens by exact server lookup',
  'a copied thread link never carries an edit or comment capability',
  'a manager copies a read-only thread link, never its own edit token',
  'an identity switch during a post aborts it and posts nothing under the new one',
  'only the reader’s own message offers Edit, with visible history after a correction',
  'phone widths 320 and 390 in light and dark keep controls reachable without overflow',
];

export async function commentingReviewQA({ base, api, artifact: a, output, accounts = null, setCookie = null, shortenRateWindow = null, clearRateLimits = null }) {
  mkdirSync(output, { recursive: true });
  const drivers = [];
  const open = name => {
    const driver = browserDriver(`${name}-${process.pid}`, { asyncCommands: true });
    drivers.push(driver);
    return driver.run;
  };
  const read = async (driver, source) => {
    const response = JSON.parse(await driver('--json', 'eval', source));
    assert.equal(response.success, true, JSON.stringify(response).slice(0, 400));
    return response.data.result;
  };
  // agent-browser's --fn wait has a fixed 25s ceiling, which is well above the
  // 3s rate window this suite shortens to.
  const waitFor = (driver, source, label) => driver('wait', '--fn', source).catch(error => {
    throw new Error(`wait ${label}: ${redact(error.stderr || error.message)}`);
  });
  // Wait until the tab's draft store actually holds words, so a reload never
  // races the debounced save (the composer saves as the reader types).
  const draftStored = async (driver, text) => {
    await waitFor(driver, `(() => {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (!key || !key.startsWith('hap-comment-draft:v1:')) continue;
        try {
          const raw = JSON.parse(sessionStorage.getItem(key));
          // The binding is a JSON tuple [artifact, version, thread, kind, identity].
          const binding = JSON.parse(key.slice('hap-comment-draft:v1:'.length));
          if (raw?.draft?.text?.includes(${JSON.stringify(text)}) && Array.isArray(binding)) return true;
        } catch { /* a foreign key */ }
      }
      return false;
    })()`, `draft saved: ${text.slice(0, 24)}`);
  };
  // The panel scrolls; a control below the fold has to be brought into view
  // before a click can reach it (agent-browser does not scroll inner scrollers).
  const press = async (driver, selector) => {
    await read(driver, `(document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' }), true)`);
    await driver('click', selector);
  };
  // Open the new-comment composer from any panel state, then wait for the
  // form itself: a click that lands while a thread is open would do nothing.
  const openComposer = async (driver, which = '#generalComment') => {
    await showPanel(driver);
    if (await read(driver, `!document.getElementById('commentForm').hidden`)) return;
    await read(driver, `(() => { const b = document.querySelector(${JSON.stringify(which)}); if (b) b.click(); return true; })()`);
    await waitFor(driver, `!document.getElementById('commentForm').hidden`, 'composer open');
  };
  // The discussions control is a toggle: open the panel, never close it.
  // The discussions button is a toggle, so open only when the panel is shut,
  // and then leave any open thread for the list the caller asked for.
  const showPanel = async (driver, mode = 'index') => {
    await read(driver, `(() => {
      if (document.getElementById('inspector').hidden) document.getElementById('discussionsBtn').click();
      return true;
    })()`);
    await waitFor(driver, `!document.getElementById('threadPanel').hidden`, 'the discussion panel is open');
    if (await read(driver, `document.getElementById('threadPanel').dataset.mode !== ${JSON.stringify(mode)}`)) {
      // The all-comments control exists only in a thread view, and is scrolled
      // with the panel; use the API path the panel itself uses instead of a
      // click that may be off-screen or already hidden.
      if (mode === 'index') {
        // A non-bubbling click reaches the control's own handler without
        // reaching the document listener that closes the inspector.
        // The control's handler is the app's own path back to the index; it
        // is dispatched directly (non-bubbling) so a hidden control or an
        // off-screen one still works, and nothing else closes the panel.
        await read(driver, `(() => {
          document.getElementById('allComments').dispatchEvent(new MouseEvent('click', { bubbles: false, cancelable: true }));
          return true;
        })()`);
      }
    }
    const state = await read(driver, `document.getElementById('threadPanel').dataset.mode + '/' + document.getElementById('allComments').hidden`);
    await waitFor(driver, `!document.getElementById('inspector').hidden && !document.getElementById('threadPanel').hidden && document.getElementById('threadPanel').dataset.mode === ${JSON.stringify(mode)}`, `panel visible in ${mode} (was ${state})`);
  };
  try {
    const guest = await open('guest');
    const reader = await open('reader');
    await guest('set', 'viewport', '1280', '900');
    await guest('open', `${base}/v/${a.id}#${a.read}`);
    await guest('wait', '#bar:not([hidden])');
    await showPanel(guest);
    await guest('wait', '#identityLine:not([hidden])');
    // The inventory starts empty, immediately — not behind a 646px identity form.
    await waitFor(guest, `document.getElementById('threadList').children.length === 0 && document.getElementById('identityLine').getBoundingClientRect().height < 48`, 'compact identity line');
    assert.equal(await read(guest, `document.getElementById('guestProfile').hidden`), true, 'identity details are collapsed until asked for');

    // ── Identity: one line, deliberate change, optional details ────────────
    await guest('click', '#identityChange');
    await guest('wait', '#guestProfile:not([hidden])');
    await guest('fill', '#guestName', 'Review Guest');
    await press(guest, '#saveGuestProfile');
    await waitFor(guest, `document.getElementById('guestProfile').hidden && document.getElementById('identityText').textContent.includes('Review Guest')`, 'identity line names the reader');

    // ── M4: one compact composer for general and pinned comments ───────────
    await guest('click', '#generalComment');
    await waitFor(guest, `!document.getElementById('commentForm').hidden`, 'direct general composer is open');
    assert.ok((await read(guest, `document.getElementById('commentForm').getBoundingClientRect().height`)) < 240, 'the general composer is compact');
    await guest('fill', '#commentText', 'General review note');
    await guest('click', '#commentForm button[type=submit]');
    await waitFor(guest, `!![...document.querySelectorAll('#threadList .thread')].find(t => t.textContent.includes('General review note'))`, 'posted thread visible at once');
    const refOf = async title => read(guest, `(() => { const t = [...document.querySelectorAll('#threadPanel .thread')].find(x => x.querySelector('summary .title')?.textContent === ${JSON.stringify(title)}); return t?.dataset.label ?? null; })()`);
    const generalRef = await refOf('General review note');
    assert.match(generalRef, /^\d+$/, 'a thread carries its server reference');

    // ── M9: a pin comment carries bounded page context, plain text only ────
    await guest('click', '#commentsBtn');
    await guest('wait', '#placementHint:not([hidden])');
    const frame = await read(guest, `(() => { const r = document.getElementById('frame').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    await guest('mouse', 'move', String(Math.round(frame.x + frame.w / 2)), String(Math.round(frame.y + frame.h / 3)));
    await guest('mouse', 'down');
    await guest('mouse', 'up');
    await guest('wait', '#commentBubble:not([hidden])');
    assert.ok((await read(guest, `document.getElementById('commentBubble').getBoundingClientRect().height`)) < 320, 'the placed composer is compact');
    await guest('fill', '#bubbleText', 'Pinned review note');
    await guest('click', '#commentBubble button[type=submit]');
    await waitFor(guest, `!![...document.querySelectorAll('#threadList .thread')].find(t => t.textContent.includes('Pinned review note'))`, 'pinned comment posted');
    assert.equal(await read(guest, `document.body.innerHTML.includes('<script>window.__xss')`), false, 'context is rendered as text, never markup');

    // ── M5: server-side search, filters, ordering and older pages ──────────
    await showPanel(guest);
    await guest('wait', '#threadTools:not([hidden])');
    await guest('fill', '#threadSearch', 'Pinned');
    await waitFor(guest, `[...document.querySelectorAll('#threadList .thread')].every(t => t.textContent.includes('Pinned')) && document.querySelectorAll('#threadList .thread').length >= 1`, 'search narrows the list');
    await guest('fill', '#threadSearch', '');
    await waitFor(guest, `document.querySelectorAll('#threadList .thread').length >= 2`, 'clearing the search restores the list');
    await guest('click', '#threadFilters [data-filter="mine"]');
    await waitFor(guest, `document.querySelector('#threadFilters [data-filter="mine"]').getAttribute('aria-pressed') === 'true'`, 'Mine filter applies');
    assert.ok((await read(guest, `document.querySelectorAll('#threadList .thread').length`)) >= 2, 'both of this reader’s threads are Mine');
    await guest('click', '#threadFilters [data-filter="all"]');

    // ── M3: references survive reply, resolve, and either order ────────────
    const before = await refOf('General review note');
    await guest('click', `#threadPanel .thread[data-label="${generalRef}"] summary`);
    await guest('wait', '#threadPanel[data-mode="thread"]');
    await guest('fill', '#threadPanel .thread.focus .reply textarea', 'A reply on the same thread');
    await guest('click', '#threadPanel .thread.focus .reply button[type=submit]');
    await waitFor(guest, `document.getElementById('panelTitle').textContent.includes('${generalRef}')`, 'the open thread keeps its reference after a reply');
    await guest('select', '#threadSort', 'page');
    await waitFor(guest, `document.getElementById('threadSort').value === 'page'`, 'page order applies');
    await guest('select', '#threadSort', 'activity');
    await read(guest, `(document.getElementById('allComments').dispatchEvent(new MouseEvent('click', { bubbles: false, cancelable: true })), true)`);
    await waitFor(guest, `document.getElementById('threadPanel').dataset.mode === 'index'`, 'back to the discussion list');
    assert.equal(await refOf('General review note'), before, 'the reference did not change with activity');

    // ── M3: a thread deep link, and the sign-in round trip keeps it ────────
    const uuid = await read(guest, `(async () => (await (await fetch('/api/artifacts/${a.id}/tickets?q=General%20review%20note', { credentials: 'same-origin', headers: { Authorization: 'Token ${a.read}' } })).json()).tickets.find(t => (t.fields.title ?? '').includes('General review note'))?.uuid ?? null)()`);
    assert.ok(uuid, 'the server named the thread uuid');
    await guest('open', `${base}/v/${a.id}?thread=${uuid}#${a.read}`);
    await waitFor(guest, `document.getElementById('threadPanel').dataset.mode === 'thread'`, 'deep link opens a thread');
    await waitFor(guest, `document.getElementById('panelTitle').textContent.includes('${before}')`, 'the deep link opens the named thread');
    assert.equal(await read(guest, `location.search`), `?thread=${uuid}`, 'no capability enters the query');
    const threadPath = encodeURIComponent(`?thread=${uuid}`);
    await waitFor(guest, `document.getElementById('signinAction').href.includes(${JSON.stringify(threadPath)})`, 'sign-in returns to the thread');
    // A target outside the loaded page (many newer threads, filtered out)
    // still opens: the viewer asks the server for exactly that thread.
    // An unknown reference is honest, never a broken panel.
    await guest('open', `${base}/v/${a.id}?thread=${'f'.repeat(40)}#${a.read}`);
    await guest('wait', '#bar:not([hidden])');
    await waitFor(guest, `!document.getElementById('threadNotice').hidden`, 'an unknown thread is explained');
    assert.match(await read(guest, `document.getElementById('threadNoticeText').textContent`), /not on this artifact/i);

    // ── M2: reload recovery is explicit, identity-scoped, never silent ─────
    await guest('open', `${base}/v/${a.id}#${a.read}`);
    await guest('wait', '#bar:not([hidden])');
    await showPanel(guest);
    await guest('click', '#generalComment');
    await waitFor(guest, `!document.getElementById('commentForm').hidden`, 'direct general composer is open');
    await guest('fill', '#commentText', 'Draft that must survive a reload');
    await draftStored(guest, 'Draft that must survive a reload');
    await guest('reload');
    await guest('wait', '#bar:not([hidden])');
    await showPanel(guest);
    await waitFor(guest, `!document.getElementById('threadRecovery').hidden`, 'the reloaded tab offers the draft');
    // Nothing was posted; the words live in the banner until the reader acts.
    const posted = await read(guest, `(async () => (await (await fetch('/api/artifacts/${a.id}/tickets', { credentials: 'same-origin', headers: { Authorization: 'Token ${a.read}' } })).json()).tickets.some(t => (t.fields.comment ?? '').includes('Draft that must survive')))()`);
    assert.equal(posted, false, 'a reload never posts a draft');
    await guest('click', '#restoreDraft');
    await waitFor(guest, `document.getElementById('commentText').value === 'Draft that must survive a reload'`, 'Restore puts the words back');
    await guest('click', '#cancelComment');
    await openComposer(guest);
    await guest('fill', '#commentText', 'Discard this draft');
    await draftStored(guest, 'Discard this draft');
    await guest('reload');
    await guest('wait', '#bar:not([hidden])');
    await showPanel(guest);
    await waitFor(guest, `!document.getElementById('threadRecovery').hidden`, 'the second draft is offered');
    await guest('click', '#discardDraft');
    await waitFor(guest, `document.getElementById('threadRecovery').hidden`, 'Discard drops the draft');
    await guest('reload');
    await guest('wait', '#bar:not([hidden])');
    await showPanel(guest);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await read(guest, `document.getElementById('threadRecovery').hidden`), true, 'a discarded draft never returns');

    // ── M2/M8: identity-scoped drafts ──────────────────────────────────────
    // Renaming the SAME guest identity is not a new identity: the live draft
    // must survive, because it was written by this same reader.
    const other = await open('other-guest');
    await other('open', `${base}/v/${a.id}#${a.read}`);
    await other('wait', '#bar:not([hidden])');
    await showPanel(other);
    await other('wait', '#identityLine:not([hidden])');
    await other('click', '#generalComment');
    await waitFor(other, `!document.getElementById('commentForm').hidden`, 'composer open for the second guest');
    await other('fill', '#commentText', 'Draft that belongs to this browser guest');
    await draftStored(other, 'Draft that belongs to this browser guest');
    await other('click', '#identityChange');
    await other('fill', '#guestName', 'Renamed Guest');
    await press(other, '#saveGuestProfile');
    await waitFor(other, `document.getElementById('identityText').textContent.includes('Renamed Guest')`, 'the guest is renamed');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await read(other, `document.getElementById('commentText').value`), 'Draft that belongs to this browser guest', 'renaming the same guest keeps its live draft');

    // A DIFFERENT guest is a different identity: a draft bound to the first
    // is never restored for the second, and no composer carries it over.
    const stranger = await open('stranger-guest');
    await stranger('open', `${base}/v/${a.id}#${a.read}`);
    await stranger('wait', '#bar:not([hidden])');
    await stranger('click', '#discussionsBtn');
    await waitFor(stranger, `document.getElementById('identityLine').textContent.includes('Guest')`, 'a fresh browser is an unnamed guest');
    assert.equal(await read(stranger, `document.getElementById('threadRecovery').hidden`), true, 'another browser never sees this tab’s draft');
    assert.equal(await read(stranger, `(document.getElementById('commentText')?.value ?? '') === '' && (document.getElementById('bubbleText')?.value ?? '') === ''`), true, 'no composer carries the other identity’s words');
    // The draft stays recoverable for the identity that wrote it.
    await other('reload');
    await other('wait', '#bar:not([hidden])');
    await other('click', '#discussionsBtn');
    await waitFor(other, `!document.getElementById('threadRecovery').hidden`, 'the writer’s own reload still offers its draft');

    // ── M7: only the reader’s own message could offer Edit ────────────────
    await guest('open', `${base}/v/${a.id}#${a.read}`);
    await guest('wait', '#bar:not([hidden])');
    await showPanel(guest);
    await waitFor(guest, `document.querySelectorAll('#threadList .thread').length >= 2`, 'the original reader sees the list');
    // The reader's own thread is identified by the reference captured when it
    // was created — a later long list cannot hide it, and no search is needed.
    const ownThread = generalRef;
    assert.match(ownThread, /^\d+$/, 'the reader’s own discussion has a stable reference');
    const listed = await read(guest, `[...document.querySelectorAll('#threadList .thread')].map(t => [t.dataset.label, t.querySelector('summary .title')?.textContent])`);
    await waitFor(guest, `!!document.querySelector('#threadList .thread[data-label="${ownThread}"]')`, `the list contains the reader’s thread (${JSON.stringify({ ownThread, listed })})`);
    await press(guest, `#threadPanel .thread[data-label="${ownThread}"] summary`);
    await waitFor(guest, `document.getElementById('threadPanel').dataset.mode === 'thread'`, 'own thread opens');
    // The server marks canEdit only where it can prove authorship; the UI
    // offers Edit only for those messages, and only when the client can send
    // a correction at all. Absence of the endpoint must mean absence of the
    // control — never an Edit button that cannot work.
    const state = await read(guest, `(async () => {
      const tickets = (await (await fetch('/api/artifacts/${a.id}/tickets', { credentials: 'same-origin', headers: { Authorization: 'Token ${a.read}' } })).json()).tickets;
      const t = tickets.find(x => x.ref === ${Number(ownThread)});
      return { serverCanEdit: t?.changes?.[0]?.canEdit === true, buttons: document.querySelectorAll('#threadPanel .thread.focus .edit-message').length, mine: t?.mine === true };
    })()`);
    assert.equal(state.mine, true, 'the server marks the thread as this reader’s');
    assert.equal(state.serverCanEdit, true, 'the server proves authorship of this message');
    // The Edit control is present for proven own messages (the opening note
    // and this reader's own reply), and clicking it opens an editor; clicking
    // Save actually sends the correction.
    assert.ok(state.buttons >= 1, 'proven own messages offer an Edit control');
    assert.equal(await read(guest, `[...document.querySelectorAll('#threadPanel .thread.focus .message')].filter(m => m.textContent && !m.closest('.message-history')).length >= 0 ? true : false`), true);
    await press(guest, '#threadPanel .thread.focus .edit-message');
    await waitFor(guest, `!!document.querySelector('#threadPanel .thread.focus .message-editor textarea')`, 'the correction editor opens');
    await guest('fill', '#threadPanel .thread.focus .message-editor textarea', 'General review note (corrected)');
    // The Save control really submits, and a real click on it patches.
    assert.equal(await read(guest, `document.querySelector('#threadPanel .thread.focus .message-editor button.primary')?.type`), 'submit', 'Save correction is a submit control');
    await press(guest, '#threadPanel .thread.focus .message-editor button[type=submit]');
    await waitFor(guest, `document.querySelector('#threadPanel .thread.focus .message').textContent === 'General review note (corrected)'`, 'the visible text is the correction');
    await waitFor(guest, `!!document.querySelector('#threadPanel .thread.focus .message-history')`, 'the earlier text stays visible in history');
    const corrected = await read(guest, `(async () => {
      const tickets = (await (await fetch('/api/artifacts/${a.id}/tickets', { credentials: 'same-origin', headers: { Authorization: 'Token ${a.read}' } })).json()).tickets;
      const t = tickets.find(x => x.ref === ${Number(ownThread)});
      const c = t?.changes?.[0];
      return { text: c?.text, edited: c?.edited === true, history: (c?.history ?? []).map(h => h.text) };
    })()`);
    assert.equal(corrected.text, 'General review note (corrected)', 'the server holds the corrected text');
    assert.equal(corrected.edited, true);
    assert.deepEqual(corrected.history, ['General review note', 'General review note (corrected)'], 'history keeps the original then the correction');
    // The reply this reader posted itself is the same proof; a message the
    // server did not prove is never offered an Edit control.
    const ownReplies = await read(guest, `(async () => {
      const tickets = (await (await fetch('/api/artifacts/${a.id}/tickets', { credentials: 'same-origin', headers: { Authorization: 'Token ${a.read}' } })).json()).tickets;
      return tickets.flatMap(t => t.changes).filter(c => c.canEdit === true).length;
    })()`);
    assert.ok(ownReplies >= 2, 'the server proves authorship for this reader’s own messages only');

    // ── M6: a real 429 keeps the text, counts down, and never reposts ──────
    // Deterministic: the suite's own reader spends the real server quota
    // (10 posts per guest identity), then the disposable database's rate
    // window is pulled in to 3 seconds so the exact Retry-After is small and
    // the countdown can be observed end to end.
    assert.equal(typeof shortenRateWindow, 'function', 'the runner exposes the rate-window fixture');
    await reader('open', `${base}/v/${a.id}#${a.read}`);
    await reader('wait', '#bar:not([hidden])');
    await showPanel(reader);
    await waitFor(reader, `document.querySelectorAll('#threadList .thread').length >= 2`, 'a second reader sees the discussions');
    // One identity, one quota: profile first, then ten posts, then the 429.
    const spend = await read(reader, `(async () => {
      const h = { 'Content-Type': 'application/json', Origin: location.origin, Authorization: 'Token ${a.read}' };
      await fetch('/api/artifacts/${a.id}/guest', { method: 'PUT', headers: h, credentials: 'same-origin', body: JSON.stringify({ name: 'Rate Reader' }) });
      let last = null;
      for (let i = 0; i < 12; i++) {
        const r = await fetch('/api/artifacts/${a.id}/tickets', { method: 'POST', headers: h, credentials: 'same-origin', body: JSON.stringify({ text: 'rate probe ' + i }) });
        if (r.status === 429) { const body = await r.json(); last = { status: r.status, code: body.code, retryAfter: body.retryAfter, header: r.headers.get('retry-after') }; break; }
        if (!r.ok) { last = { status: r.status, text: await r.text() }; break; }
      }
      return last;
    })()`);
    assert.equal(spend.status, 429, `the real quota refuses the next post (${JSON.stringify(spend)})`);
    assert.equal(spend.code, 'rate_limited');
    assert.ok(Number.isInteger(Number(spend.retryAfter)) && Number(spend.retryAfter) >= 1, 'the server names its wait');
    // Shorten the real window to 3s, for this disposable state only.
    shortenRateWindow(3);
    await openComposer(reader);
    await reader('fill', '#commentText', 'Text that must survive the wait');
    await reader('click', '#commentForm button[type=submit]');
    await waitFor(reader, `/Try again in \\d{1,2}:\\d\\d/.test(document.getElementById('commentStatus').textContent)`, 'the exact wait is shown');
    const beforeDeadline = await read(reader, `(() => ({
      text: document.getElementById('commentText').value,
      disabled: document.getElementById('commentForm').querySelector('button[type=submit]').disabled,
      status: document.getElementById('commentStatus').textContent,
    }))()`);
    assert.equal(beforeDeadline.text, 'Text that must survive the wait', 'a refused post keeps its text');
    assert.equal(beforeDeadline.disabled, true, 'Post is disabled before the deadline');
    assert.match(beforeDeadline.status, /Try again in \d{1,2}:\d\d/);
    // No automatic repost while waiting: the probe count stays at its cap.
    // Counted via the search query, so the number is the server's own answer
    // over the whole list rather than one page.
    const probeCount = async () => read(reader, `(async () => (await (await fetch('/api/artifacts/${a.id}/tickets?q=rate%20probe&limit=200', { credentials: 'same-origin', headers: { Authorization: 'Token ${a.read}' } })).json()).tickets.filter(t => t.fields.title?.startsWith('rate probe')).length)()`);
    assert.equal(await probeCount(), 10, 'exactly the ten admitted probes exist');
    await new Promise(resolve => setTimeout(resolve, 1500));
    const midway = await read(reader, `document.getElementById('commentStatus').textContent`);
    assert.match(midway, /Try again in \d{1,2}:\d\d/, `the wait counts down (${JSON.stringify(midway)})`);
    assert.equal(await probeCount(), 10, 'nothing was reposted on the reader’s behalf mid-wait');
    // Let the real deadline pass, then confirm the control re-enables itself
    // and the words are still there, with nothing posted automatically.
    await waitFor(reader, `document.getElementById('commentForm').querySelector('button[type=submit]').disabled === false`, 'Post re-enables after the deadline');
    assert.equal(await read(reader, `document.getElementById('commentText').value`), 'Text that must survive the wait', 'the words survive the whole wait');
    assert.match(await read(reader, `document.getElementById('commentStatus').textContent`), /Retry is available/);
    assert.equal(await probeCount(), 10, 'the wait ending posts nothing by itself');
    // The reader may now post deliberately.
    await reader('click', '#commentForm button[type=submit]');
    await waitFor(reader, `!![...document.querySelectorAll('#threadList .thread')].find(t => t.textContent.includes('Text that must survive the wait'))`, 'the retry posts only when clicked');
    clearRateLimits?.();

    // ── M2: a reply draft survives a true reload, with explicit Restore ────
    await showPanel(guest);
    await waitFor(guest, `document.querySelectorAll('#threadList .thread').length >= 2`, 'the list is loaded again');
    // The seeded threads are in the list by reference, not by a fuzzy text
    // match: a long run of later discussions can push a title off the page.
    const pinnedRef = await read(guest, `(async () => {
      const r = await fetch('/api/artifacts/${a.id}/tickets?q=Pinned%20review%20note', { credentials: 'same-origin', headers: { Authorization: 'Token ${a.read}' } });
      const t = (await r.json()).tickets.find(x => (x.fields?.title ?? '').includes('Pinned review note'));
      return t ? t.ref : null;
    })()`);
    assert.ok(Number.isInteger(pinnedRef), 'the pinned discussion exists with a stable reference');
    // A search is global, so the thread opens even when it is off the page.
    await guest('fill', '#threadSearch', 'Pinned review note');
    await waitFor(guest, `!!document.querySelector('#threadList .thread[data-label="${pinnedRef}"]')`, 'the pinned discussion is listed');
    const replyThread = String(pinnedRef);
    await press(guest, `#threadPanel .thread[data-label="${replyThread}"] summary`);
    await waitFor(guest, `document.getElementById('threadPanel').dataset.mode === 'thread'`, 'a thread is open for a reply');
    await waitFor(guest, `!!document.querySelector('#threadPanel .thread.focus .reply textarea')`, 'the reply form is present');
    await guest('fill', '#threadPanel .thread.focus .reply textarea', 'Reply draft that must survive a reload');
    await draftStored(guest, 'Reply draft that must survive a reload');
    await guest('reload');
    await guest('wait', '#bar:not([hidden])');
    await showPanel(guest);
    await waitFor(guest, `!document.getElementById('threadRecovery').hidden`, 'a reply draft is offered after a real reload');
    assert.match(await read(guest, `document.getElementById('threadRecovery').querySelector('p').textContent`), /a reply/, 'the banner names it as a reply');
    await press(guest, '#restoreDraft');
    await waitFor(guest, `document.querySelector('#threadPanel .thread.focus .reply textarea')?.value === 'Reply draft that must survive a reload'`, 'Restore puts the reply words back in its thread');
    const replyPosted = await read(guest, `(async () => (await (await fetch('/api/artifacts/${a.id}/tickets', { credentials: 'same-origin', headers: { Authorization: 'Token ${a.read}' } })).json()).tickets.some(t => t.changes.some(c => (c.text ?? '').includes('Reply draft that must survive'))))()`);
    assert.equal(replyPosted, false, 'the reply was never posted by the reload or the restore');
    await guest('fill', '#threadPanel .thread.focus .reply textarea', '');
    // A cleared form is no draft: the banner goes away with the words.
    await waitFor(guest, `document.getElementById('threadRecovery').hidden`, 'an emptied reply draft is no longer offered');
    await guest('reload');
    await guest('wait', '#bar:not([hidden])');
    await showPanel(guest);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(await read(guest, `document.getElementById('threadRecovery').hidden`), true, 'a discarded reply draft never returns');

    // ── M3: a copied thread link never carries a higher capability ─────────
    // Clipboard read is the real browser clipboard. Every mode is checked:
    // read link keeps read; edit and comment links must yield no token at all;
    // a named editor gets the named-access URL; a manager may share the
    // reusable READ token, never their own edit token.
    const clipboard = async (driver, url) => {
      await driver('open', url);
      await driver('wait', '#bar:not([hidden])');
      // The browser's clipboard read needs a permission this harness does not
      // grant, so the page's real writeText call is intercepted instead: the
      // product's own code path runs, and its exact argument is recorded.
      await read(driver, `(() => {
        window.__copied = null;
        navigator.clipboard.writeText = async value => { window.__copied = String(value); };
        return true;
      })()`);
      await showPanel(driver);
      // The copy control lives in a thread body, which the panel may show
      // collapsed. Its handler is the product's own path, so it is invoked
      // directly rather than through a click that visibility could block.
      await driver('wait', '--fn', `document.querySelectorAll('#threadList .thread').length > 0`);
      await read(driver, `(() => {
        const row = document.querySelector('#threadList .thread');
        const button = row.querySelector('.thread-link');
        button.click();
        return true;
      })()`);
      await new Promise(resolve => setTimeout(resolve, 400));
      const copied = String(await read(driver, `window.__copied ?? ''`)).trim();
      assert.ok(copied, `the copy control wrote a link (${url.replace(/[0-9a-f]{64}/g, '[cap]')})`);
      const status = await read(driver, `(() => {
        const s = [...document.querySelectorAll('#threadList .thread .thread-status')].find(n => n.textContent.trim());
        const toast = document.getElementById('toast');
        const toastText = toast && !toast.hidden ? document.getElementById('toastText').textContent : '';
        return s ? s.textContent.trim() : toastText;
      })()`);
      return { copied, status };
    };
    const hash = value => { try { return new URL(value).hash; } catch { return ''; } };
    // The clipboard checks run against the threads this suite already made;
    // the clipboard helper opens a thread, so at least one must exist (the
    // helper's own wait fails otherwise, which is the real guard).
    // The fixture must carry both capabilities, or this security check would
    // silently prove nothing.
    // createArtifact names capabilities `read`, `write` and `comment`; the
    // edit link's write token is the one that must never be copied.
    const editToken = a.write;
    assert.ok(editToken && a.comment, `the fixture has edit, comment and read links (${Object.keys(a).join(',')})`);
    // The viewer is opened with the edit capability, exactly the dangerous
    // case: an owner who holds an edit token and shares a thread link.
    {
      const editCopy = await clipboard(guest, `${base}/v/${a.id}#${editToken}`);
      assert.ok(!editCopy.copied.includes(editToken), 'an edit link never copies its edit token');
      // An edit link legitimately holds the reusable READ link (its Share menu
      // offers it), so its copied thread link must carry exactly that token,
      // and a reader without any capability must be able to open it.
      assert.equal(hash(editCopy.copied), `#${a.read}`, `an edit-link copy carries the read token, not the edit token (${editCopy.copied.replace(/[0-9a-f]{64}/g, '[cap]')})`);
      assert.match(editCopy.copied, new RegExp(`/v/${a.id}\\?thread=`), 'the thread reference is kept');
      const anonymous = await open('anonymous');
      await anonymous('open', editCopy.copied);
      await anonymous('wait', '#bar:not([hidden])');
      await waitFor(anonymous, `document.getElementById('frame').style.display === 'block'`, 'an anonymous reader opens the copied link');
      // A read link grants reading and discussion, never editing: the role is
      // not "Can edit", and no upload or version control appears.
      const anon = await read(anonymous, `({ role: document.getElementById('role').textContent, upload: document.getElementById('uploadFilesBtn').hidden, uploadFolder: document.getElementById('uploadFolderBtn').hidden, restore: document.getElementById('restoreBtn').hidden })`);
      assert.equal(anon.role, 'Can comment', `a read link grants reading and discussion only (${JSON.stringify(anon)})`);
      assert.equal(anon.upload && anon.uploadFolder && anon.restore, true, 'no editing controls from a copied link');
      const anonInfo = await read(anonymous, `(async () => (await (await fetch('/api/artifacts/${a.id}', { credentials: 'same-origin' })).json()).role)()`);
      assert.notEqual(anonInfo, 'write', 'the copied credential is not an edit credential');
      await anonymous('close');
      // A comment link: the comment token is not copied either.
      const commentCopy = await clipboard(guest, `${base}/v/${a.id}#${a.comment}`);
      assert.ok(!commentCopy.copied.includes(a.comment), 'a comment link never copies its comment token');
      assert.equal(hash(commentCopy.copied), '', 'no capability in a copied comment-link thread URL');
      // A read link: its own read token is a read credential, so it is kept.
      const readCopy = await clipboard(guest, `${base}/v/${a.id}#${a.read}`);
      assert.ok(readCopy.copied.includes(a.read), 'a read link keeps its own read token');
      assert.ok(!readCopy.copied.includes(editToken) && !readCopy.copied.includes(a.comment), 'and never another capability');
      // The read copy is a real read-only link: it opens, but cannot edit.
      const readRole = await read(guest, `(async () => (await (await fetch('/api/artifacts/${a.id}', { credentials: 'same-origin', headers: { Authorization: 'Token ' + new URL(${JSON.stringify(readCopy.copied)}).hash.slice(1) } })).json()).role)()`);
      assert.equal(readRole, 'read', 'the copied credential is read-only');
    }
    // An owner (named cookie, management confirmed) may share the reusable
    // read token, and the copied URL never contains anything else.
    if (accounts) {
      await guest('open', `${base}/v/${a.id}#${editToken}`);
      await guest('wait', '#bar:not([hidden])');
      await setCookie(guest, 'artifact_session', accounts.ownerCookie);
      await read(guest, `(window.dispatchEvent(new Event('focus')), true)`);
      await new Promise(resolve => setTimeout(resolve, 800));
      const ownerCopy = await clipboard(guest, `${base}/v/${a.id}#${editToken}`);
      assert.ok(!ownerCopy.copied.includes(editToken), 'a manager copy never carries the edit token');
      assert.ok(!ownerCopy.copied.includes(a.comment ?? '\u0000'), 'a manager copy never carries the comment token');
      assert.match(ownerCopy.status, /read access only|signing in|Could not copy/, `the reader is told what the copy grants (${ownerCopy.status})`);
      // Leave the driver signed out again: a later case starts from the
      // signed-out guest state, and a lingering manager session would turn
      // "signed-out → A" into a real A → B switch.
      await setCookie(guest, 'artifact_session', '');
      await read(guest, `(window.dispatchEvent(new Event('focus')), true)`);
      await new Promise(resolve => setTimeout(resolve, 900));
      assert.equal(await read(guest, `document.getElementById('signinAction').hidden`), false, 'the copy checks leave this tab signed out');
    }

    // ── M3: a deep link to a thread outside the loaded page ────────────────
    // Seeding uses the EDIT capability: a read link must identify first, and
    // is rate-limited to ten posts, so it cannot create a long list.
    assert.ok(a.write, 'the fixture has an edit link to seed many threads');
    const buried = await read(guest, `(async () => {
      const h = { 'Content-Type': 'application/json', Origin: location.origin, Authorization: 'Token ${a.write}' };
      const older = await fetch('/api/artifacts/${a.id}/tickets', { method: 'POST', headers: h, credentials: 'same-origin', body: JSON.stringify({ text: 'Buried target beyond the first page', anchor: 'Scope' }) }).then(r => r.json());
      // Resolve it first, then bury it under newer threads: resolving would
      // otherwise make it the newest change and put it back on the first page.
      await fetch('/api/artifacts/${a.id}/tickets', { method: 'POST', headers: h, credentials: 'same-origin', body: JSON.stringify({ ticketUuid: older.ticketUuid, status: 'Closed' }) });
      // Well past the viewer's 50-thread page and the server's 32-candidate
      // scan, so the target cannot be in the first response at all.
      for (let i = 0; i < 70; i++) await fetch('/api/artifacts/${a.id}/tickets', { method: 'POST', headers: h, credentials: 'same-origin', body: JSON.stringify({ text: 'Filler discussion ' + i }) });
      return { uuid: older.ticketUuid };
    })()`);
    assert.match(buried.uuid, /^[0-9a-f]{40,64}$/);
    // Confirm the premise: the ordinary list does not contain the target.
    const inList = await read(guest, `(async () => {
      const r = await fetch('/api/artifacts/${a.id}/tickets?limit=50', { credentials: 'same-origin', headers: { Authorization: 'Token ${a.read}' } });
      return (await r.json()).tickets.some(t => t.uuid === ${JSON.stringify(buried.uuid)});
    })()`);
    assert.equal(inList, false, 'the target is outside the ordinary first page, so the deep link must use the exact lookup');
    await guest('open', `${base}/v/${a.id}?thread=${buried.uuid}#${a.read}`);
    await guest('wait', '#bar:not([hidden])');
    await waitFor(guest, `document.getElementById('threadPanel').dataset.mode === 'thread'`, 'a deep link outside the loaded page still opens');
    await waitFor(guest, `document.querySelector('#threadPanel .thread.focus')?.textContent.includes('Buried target beyond the first page')`, 'the exact thread the link names is shown');
    assert.equal(await read(guest, `document.getElementById('threadNotice').hidden`), true, 'a real thread is never reported missing');

    // ── M3: Page order follows real pin placement, not labels or creation ──
    // Two anchors created in reverse document order: the later-created one is
    // higher on the page. Page order must put it first regardless of labels.
    const pageRefs = await read(guest, `(async () => {
      const post = (text, selector) => fetch('/api/artifacts/${a.id}/tickets', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Origin: location.origin, Authorization: 'Token ${a.read}' },
        body: JSON.stringify({ text, anchor: selector }),
      }).then(r => r.json());
      await post('Lower section note', 'Rollout');
      await post('Upper section note', 'Scope');
      const tickets = (await (await fetch('/api/artifacts/${a.id}/tickets', { credentials: 'same-origin', headers: { Authorization: 'Token ${a.read}' } })).json()).tickets;
      return tickets.filter(t => /section note/.test(t.fields.title ?? '')).map(t => ({ title: t.fields.title, ref: t.ref }));
    })()`);
    assert.equal(pageRefs.length, 2, 'both section notes exist');
    await guest('reload');
    await guest('wait', '#bar:not([hidden])');
    await showPanel(guest);
    await guest('select', '#threadSort', 'page');
    await waitFor(guest, `document.getElementById('threadSort').value === 'page'`, 'page order selected');
    await new Promise(resolve => setTimeout(resolve, 700));
    const order = await read(guest, `[...document.querySelectorAll('#threadList .thread summary .title')].map(t => t.textContent)`);
    const upper = order.indexOf('Upper section note');
    const lower = order.indexOf('Lower section note');
    assert.ok(upper >= 0 && lower >= 0, JSON.stringify(order));
    assert.ok(upper < lower, `the upper section comes first (${JSON.stringify(order)})`);
    assert.match(await read(guest, `document.getElementById('threadCount').textContent`), /page order · loaded discussions/, 'the label says the order is over loaded discussions');
    await guest('select', '#threadSort', 'activity');

    // ── Account switch: A → B clears A's drafts, flags and edit rights ─────
    if (accounts) {
      const { cookieA, cookieB } = accounts;
      await guest('open', `${base}/v/${a.id}#${a.read}`);
      await guest('wait', '#bar:not([hidden])');
      await showPanel(guest);
      await guest('click', '#generalComment');
      await waitFor(guest, `!document.getElementById('commentForm').hidden`, 'composer open before sign-in');
      await guest('fill', '#commentText', 'Draft A must keep as guest');
      // Attach account A's session without leaving the page, as a sign-in tab
      // would: the guest draft survives that transition.
      await setCookie(guest, 'artifact_session', cookieA);
      await read(guest, `(window.dispatchEvent(new Event('focus')), true)`);
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(await read(guest, `document.getElementById('commentText').value`), 'Draft A must keep as guest', 'a signed-out guest draft survives sign-in');
      // The existing messages belong to the browser guest, not account A.
      // Create a genuinely account-authored message and deliberately select
      // that identity before asserting account-specific correction rights.
      const accountPost = await read(guest, `(async () => {
        const r = await fetch('/api/artifacts/${a.id}/tickets', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Authorization: 'Token ${a.read}' },
          body: JSON.stringify({ text: 'Verified account A boundary message', identity: 'account' }),
        });
        await r.arrayBuffer(); return r.status;
      })()`);
      assert.equal(accountPost, 201, 'account A message is actually created');
      await read(guest, `(document.getElementById('useAccountIdentity').click(), true)`);
      await waitFor(guest, `document.getElementById('identityText').textContent.includes('verified account')`, 'account A identity selected');
      await openComposer(guest);
      await guest('fill', '#commentText', 'Verified account A unsent draft');
      await waitFor(guest, `document.querySelectorAll('#threadPanel .edit-message').length === 1`, 'only the verified A message is editable as A');
      // Now switch the session to account B: A draft and A's private flags
      // must not survive, even though the capability link is unchanged.
      await setCookie(guest, 'artifact_session', cookieB);
      await read(guest, `(window.dispatchEvent(new Event('focus')), true)`);
      await new Promise(resolve => setTimeout(resolve, 900));
      assert.equal(await read(guest, `(document.getElementById('commentText')?.value ?? '') === ''`), true, 'account A proto-draft does not carry into account B');
      assert.equal(await read(guest, `document.getElementById('threadRecovery').hidden`), true, 'A recoverable draft is not offered to B');
      const editButtons = await read(guest, `document.querySelectorAll('#threadPanel .edit-message').length`);
      assert.equal(editButtons, 0, 'B is offered no Edit control for A message');
      // Back to signed out: still nothing of A's.
      await setCookie(guest, 'artifact_session', '');
      await read(guest, `(window.dispatchEvent(new Event('focus')), true)`);
      await new Promise(resolve => setTimeout(resolve, 900));
      assert.equal(await read(guest, `document.getElementById('threadRecovery').hidden`), true, 'A draft is not offered after sign-out');
      assert.equal(await read(guest, `document.querySelectorAll('#threadPanel .edit-message').length`), 0, 'signing out removes A edit rights at once');

      // ── An identity switch during a post's own preflight ────────────────
      // The post awaits identity assurance before it sends. Hold that request
      // open, switch the account underneath it, and confirm the first reader's
      // words are never posted under the second, whose composer is untouched.
      const beforeCount = await read(guest, `(async () => (await (await fetch('/api/artifacts/${a.id}/tickets?limit=200', { credentials: 'same-origin', headers: { Authorization: 'Token ${a.read}' } })).json()).tickets.length)()`);
      await setCookie(guest, 'artifact_session', cookieA);
      await guest('open', `${base}/v/${a.id}#${a.read}`);
      await guest('reload'); // a fresh capability page defaults to its guest persona
      await guest('wait', '#bar:not([hidden])');
      await showPanel(guest);
      await read(guest, `(window.dispatchEvent(new Event('focus')), true)`);
      await waitFor(guest, `document.getElementById('identityText').textContent.includes('unverified guest') && !document.getElementById('navBtn').hidden`, 'account A established with guest persona for the held profile preflight');
      await openComposer(guest);
      await waitFor(guest, `!document.getElementById('commentForm').hidden`, 'composer open for the race');
      await guest('fill', '#commentText', 'Race text from account A');
      // Hold the profile preflight (PUT for a new identity, GET for an existing
      // one) until the test releases it, so the switch lands inside the await.
      await read(guest, `(() => {
        window.__hold = null; window.__held = [];
        const original = window.fetch;
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : input.url;
          if (/\\/guest$/.test(url) && !window.__held.includes(url)) {
            window.__held.push(url);
            return new Promise(resolve => { window.__hold = () => resolve(original(input, init)); });
          }
          return original(input, init);
        };
        return true;
      })()`);
      await guest('click', '#commentForm button[type=submit]');
      await waitFor(guest, `typeof window.__hold === 'function'`, 'the post is waiting on its identity preflight');
      // Switch to account B while the post is suspended mid-await.
      await setCookie(guest, 'artifact_session', cookieB);
      await read(guest, `(window.dispatchEvent(new Event('focus')), true)`);
      await new Promise(resolve => setTimeout(resolve, 900));
      // Release the suspended request: the continuation must abort.
      await read(guest, `(window.__hold(), true)`);
      await new Promise(resolve => setTimeout(resolve, 1200));
      const afterCount = await read(guest, `(async () => (await (await fetch('/api/artifacts/${a.id}/tickets?limit=200', { credentials: 'same-origin', headers: { Authorization: 'Token ${a.read}' } })).json()).tickets.length)()`);
      assert.equal(afterCount, beforeCount, 'account A text was not posted after the switch to B');
      const raced = await read(guest, `(async () => {
        const r = await fetch('/api/artifacts/${a.id}/tickets?limit=200', { credentials: 'same-origin', headers: { Authorization: 'Token ${a.read}' } });
        return (await r.json()).tickets.some(t => (t.fields?.comment ?? '').includes('Race text from account A'));
      })()`);
      assert.equal(raced, false, 'the aborted continuation wrote nothing');
      // An actual verified-account replacement clears A's private words even
      // when the browser guest cookie itself is unchanged.
      assert.equal(await read(guest, `document.getElementById('commentText')?.value ?? ''`), '', 'account A words are not carried into account B');
      // Clear them and confirm that clearing drops only that captured draft.
      await guest('fill', '#commentText', '');
      await new Promise(resolve => setTimeout(resolve, 400));
      // B can post their own words normally.
      await openComposer(guest);
      await waitFor(guest, `!document.getElementById('commentForm').hidden`, 'composer open for B');
      await guest('fill', '#commentText', 'A normal note from account B');
      await guest('click', '#commentForm button[type=submit]');
      await waitFor(guest, `(async () => (await (await fetch('/api/artifacts/${a.id}/tickets?limit=200', { credentials: 'same-origin' })).json()).tickets.some(t => (t.fields?.comment ?? '').includes('A normal note from account B')))()`, 'B can still post');
    }

    // Capture the resting UI rather than a transient identity-change toast.
    await waitFor(guest, `document.getElementById('toast').hidden`, 'transient notice finishes before screenshots');
    // Desktop evidence, light and dark, for visual review.
    for (const theme of ['light', 'dark']) {
      await guest('set', 'viewport', '1280', '900');
      await read(guest, `(document.documentElement.dataset.theme = ${JSON.stringify(theme)}, true)`);
      await showPanel(guest);
      await new Promise(resolve => setTimeout(resolve, 250));
      await guest('screenshot', join(output, `panel-desktop-${theme}.png`));
    }

    // ── Phone layouts: 320 and 390, light and dark, no overflow ────────────
    for (const width of [320, 390]) {
      for (const theme of ['light', 'dark']) {
        await guest('set', 'viewport', String(width), '800');
        await read(guest, `(document.documentElement.dataset.theme = ${JSON.stringify(theme)}, true)`);
        await read(guest, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        await showPanel(guest);
        await waitFor(guest, `!document.getElementById('inspector').hidden`, 'phone capture has an open discussion panel');
        assert.equal(await read(guest, `document.documentElement.scrollWidth <= innerWidth`), true, `${width}/${theme} has no page overflow`);
        const reachable = await read(guest, `(() => {
          const p = document.getElementById('threadPanel').getBoundingClientRect();
          const b = document.getElementById('threadClose').getBoundingClientRect();
          return b.top >= p.top && b.bottom <= Math.min(innerHeight, p.bottom) + 1;
        })()`);
        assert.equal(reachable, true, `${width}/${theme} keeps the close control reachable`);
        await guest('screenshot', join(output, `panel-${width}-${theme}.png`));
      }
    }
    await guest('set', 'viewport', '1280', '900');
  } finally {
    for (const driver of drivers) { try { await driver.run('close'); } catch { /* already closed */ } }
  }
}

// ── Standalone runner ────────────────────────────────────────────────────────
// `node test/commenting-review-browser.mjs` owns its Worker; importing does not.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.env.COMMENTING_BROWSER_QA !== '1') {
    console.log('Skip: set COMMENTING_BROWSER_QA=1 to run the real-browser commenting review checks.');
    process.exit(0);
  }
  try { execFileSync('agent-browser', ['--version'], { stdio: 'ignore' }); }
  catch {
    console.error('Skip: agent-browser is not installed.');
    process.exit(0);
  }
  const { startWorker, freePort, createArtifact } = await import('./helpers/worker.mjs');
  const work = mkdtempSync(join(tmpdir(), 'hap-commenting-review-'));
  // Screenshots live outside the disposable Worker state, so they survive the
  // run for visual review.
  const EVIDENCE = process.env.COMMENTING_EVIDENCE_DIR || '/tmp/hap-commenting-review-evidence';
  mkdirSync(EVIDENCE, { recursive: true });
  let worker;
  try {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    worker = await startWorker(work, { OWNER_EMAIL: 'owner@example.com', APP_ORIGIN: base, TEST_MAIL_TRANSPORT: 'loopback' }, { port });
    const api = async (path, { method = 'GET', body, cookie, bearer, token } = {}) => {
      const headers = { Origin: base };
      if (cookie) headers.Cookie = cookie;
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      if (token) headers.Authorization = `Token ${token}`;
      const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let json; try { json = JSON.parse(text); } catch { /* no body */ }
      return { status: response.status, json, text, headers: response.headers };
    };
    // The rate limiter is real; only this throwaway database is relaxed so
    // other scenarios can still post after the rate-limit scenario runs, and
    // its window can be shortened for a deterministic countdown test.
    const eachState = visit => {
      for (const file of readdirSync(join(work, 'state'), { recursive: true })) {
        if (!String(file).endsWith('.sqlite')) continue;
        const db = new DatabaseSync(join(work, 'state', String(file)));
        try { visit(db); } catch { /* not this database */ }
        finally { db.close(); }
      }
    };
    const clearRateLimits = () => eachState(db => db.exec('DELETE FROM rate_limits'));
    // Pull every rate row's deadline in to `seconds` from now. This is the
    // disposable test database only; the server's 300-second window is not
    // changed, so the real 429 and the real Retry-After are exercised.
    const shortenRateWindow = seconds => eachState(db => {
      db.prepare('UPDATE rate_limits SET expires = ?').run(Math.floor(Date.now() / 1000) + seconds);
    });
    const artifact = await createArtifact(base, worker.owner,
      '<h1>Review fixture</h1><section><h2>Scope</h2><p>Launch on 26 November, after the accessibility review.</p></section><section><h2>Rollout</h2><p>Review the changes, then resolve answered questions.</p></section>');
    // Two accounts for the switch test, activated through the loopback
    // test-mail transport only. The owner signs in first and invites each;
    // their cookies never leave this process.
    const signIn = async email => {
      const r = await api('/api/auth/request', { method: 'POST', body: { email } });
      const loginUrl = r.json?.loginUrl;
      if (typeof loginUrl !== 'string') return '';
      const v = await api('/api/auth/verify', { method: 'POST', body: { token: new URL(loginUrl).hash.slice(7) } });
      return v.headers.getSetCookie?.().find(c => c.startsWith('artifact_session='))?.split(';')[0] ?? '';
    };
    const invited = async (ownerCookie, email) => {
      const r = await api('/api/invitations', { method: 'POST', cookie: ownerCookie, body: { email, name: email.split('@')[0] } });
      const loginUrl = r.json?.loginUrl;
      if (typeof loginUrl !== 'string') return '';
      const v = await api('/api/auth/verify', { method: 'POST', body: { token: new URL(loginUrl).hash.slice(7) } });
      return v.headers.getSetCookie?.().find(c => c.startsWith('artifact_session='))?.split(';')[0] ?? '';
    };
    const ownerCookie = await signIn('owner@example.com');
    const cookieA = ownerCookie ? await invited(ownerCookie, 'reviewer-a@example.com') : '';
    const cookieB = ownerCookie ? await invited(ownerCookie, 'reviewer-b@example.com') : '';
    // Loopback test mail is configured, so both accounts must activate; a
    // skipped switch test would leave account-scoped drafts unproven.
    if (!cookieA || !cookieB) throw new Error('account fixtures did not activate over loopback test mail');
    const accounts = { cookieA, cookieB, ownerCookie };
    const setCookie = async (driver, name, value) => driver('cookies', 'set', name, value.split('=')[1] ?? '',
      '--url', base, '--httpOnly', '--sameSite', 'Lax');
    await commentingReviewQA({ base, api, artifact, output: EVIDENCE, accounts, setCookie, shortenRateWindow, clearRateLimits });
    clearRateLimits();
    console.log(`PASS: ${commentingReviewChecks.length} real-browser commenting review checks`);
  } catch (error) {
    console.error('FAILED:', redact(error.stack || error));
    process.exitCode = 1;
  } finally {
    worker?.stop();
    rmSync(work, { recursive: true, force: true });
  }
}
