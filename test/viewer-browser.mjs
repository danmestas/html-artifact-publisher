// Opt-in real Chromium QA for the viewer's comment pins and thread panel,
// invoked by VIEWER_BROWSER_QA=1 node --test test/e2e.test.mjs. Requires the
// agent-browser executable. The e2e suite owns the Wrangler lifecycle and the
// fixture artifact; this drives the viewer as each link holder would.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { frameEval } from './helpers/frame-eval.mjs';

const execFileAsync = promisify(execFile);

// Strings that would run, or break out of a selector, if rendered as markup.
export const XSS = {
  text: '<img src=x onerror="window.__xss=1"> first line\n<script>window.__xss=2</script>',
  anchor: '"]<img src=x onerror="window.__xss=3">',
  author: '<img src=x onerror=window.__xss=4>',
};

export async function viewerQA({ base, a, api, output, attach }) {
  mkdirSync(output, { recursive: true });
  const session = `viewer-comments-qa-${process.pid}`;
  let viewerTab = '';
  // Awaiting agent-browser keeps Node's event loop free to drain the Worker's
  // pipes; a synchronous wait starves them and the page looks stalled.
  const run = async (...args) => {
    const exec = async (...command) => (await execFileAsync('agent-browser', ['--session', session, ...command], {
      encoding: 'utf8', timeout: 45000, env: { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '600000' },
    })).stdout;
    try {
      if (viewerTab && !['close', 'tab', 'get'].includes(args[0])) await exec('tab', viewerTab);
      const result = await exec(...args);
      if (args[0] === 'open') {
        const tabs = JSON.parse(await exec('--json', 'tab', 'list')).data.tabs;
        viewerTab = tabs.find(t => t.url.startsWith(`${base}/v/${a.id}#`))?.tabId ?? '';
        assert.ok(viewerTab, 'the fixture viewer has its own browser tab');
      }
      return result;
    } catch (e) {
      const command = args[0] === 'open' ? 'open [private fixture]' : args.join(' ');
      const diagnostic = `agent-browser ${command} (${e.code ?? e.status ?? 'failed'}, ${e.signal ?? 'no signal'}): ${e.stdout ?? ''}${e.stderr ?? ''}`;
      throw new Error(diagnostic.replace(/\b[0-9a-f]{64}\b/gi, '[private capability]').slice(0, 2000));
    }
  };
  const evaluate = async source => {
    await run('frame', 'main');
    const result = JSON.parse(await run('--json', 'eval', `({ top: window === top, viewer: !!document.getElementById('bar'), protocol: location.protocol, value: (${source}) })`));
    assert.equal(result.success, true, String(result.error ?? 'browser evaluation failed'));
    assert.equal(result.data.result.top && result.data.result.viewer, true, JSON.stringify(result.data.result));
    return result.data.result.value;
  };
  const wait = selector => run('wait', selector);
  // agent-browser does not scroll the panel, an inner scroller, to what it clicks.
  const press = async selector => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
    await run('click', selector);
  };
  const tickets = async () => (await api(`/api/artifacts/${a.id}/tickets`, { token: a.read })).json.tickets;
  const byTitle = async title => (await tickets()).find(t => t.fields.title === title);
  // agent-browser cannot enter the opaque-origin page frame; DevTools can.
  let page = null;
  const inFrame = async (source, wanted) => {
    page ??= await frameEval((await run('get', 'cdp-url')).trim());
    return page.eval(source, wanted);
  };
  // The thread a label names, as the panel shows it.
  const panel = async label => evaluate(`(() => {
    const t = document.querySelector('#threadPanel .thread[data-label="${label}"]');
    if (!t) return null;
    return { open: t.open, anchored: t.dataset.anchored, focus: t.classList.contains('focus'),
      text: t.textContent, replies: t.querySelectorAll('.reply textarea').length, resolve: t.querySelector('.resolve')?.textContent ?? null,
      checkins: [...t.querySelectorAll('.checkins a')].map(x => x.getAttribute('href')) };
  })()`);
  const labelOf = async title => evaluate(`[...document.querySelectorAll('#threadPanel .thread')].find(t => t.querySelector('summary .title').textContent === ${JSON.stringify(title)})?.dataset.label ?? null`);
  // Pins as the page draws them: label, resolved, and the viewport box.
  const pins = async () => inFrame(`[...(document.querySelector('[data-artifact-pins]')?.shadowRoot?.querySelectorAll('button') ?? [])]
    .filter(b => getComputedStyle(b).display !== 'none')
    .map(b => { const r = b.getBoundingClientRect(); return { label: b.textContent, resolved: b.dataset.resolved === 'true', x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })`);
  // Clicks a pin with real mouse events at its centre, through the iframe.
  const clickPin = async label => {
    const pin = (await pins()).find(p => p.label === String(label));
    assert.ok(pin, `pin ${label}`);
    const frame = await evaluate(`(() => { const r = document.getElementById('frame').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
    await run('mouse', 'move', String(Math.round(frame.x + pin.x)), String(Math.round(frame.y + pin.y)));
    await run('mouse', 'down');
    await run('mouse', 'up');
    return pin;
  };
  const download = async selector => {
    const path = join(output, `download-${process.pid}.zip`);
    await run('download', selector, path);
    const bytes = readFileSync(path);
    rmSync(path);
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'download is a ZIP archive');
    assert.ok(bytes.includes(Buffer.from('index.html')), 'download includes the artifact page');
    return bytes;
  };
  const settle = () => run('wait', '400');
  let failure;

  try {
    // ── The comment link: pins, panel, reply, resolve, reopen, new anchored comment ──
    await run('set', 'viewport', '1280', '900');
    await run('open', `${base}/v/${a.id}#${a.comment}`);
    await wait('#bar:not([hidden])');
    await evaluate(`(window.__qaErrors = [], addEventListener('error', e => window.__qaErrors.push(e.message)), addEventListener('unhandledrejection', e => window.__qaErrors.push(String(e.reason))), true)`);
    await evaluate(`document.documentElement.dataset.theme = 'light'`);
    const toolbar = await evaluate(`(() => { const b = document.getElementById('bar').getBoundingClientRect(); return { height: b.height, overflow: document.documentElement.scrollWidth > innerWidth, back: !document.getElementById('backLibrary').hidden }; })()`);
    assert.deepEqual(toolbar, { height: 45, overflow: false, back: true }, 'one compact toolbar row with a library return');
    await run('click', '#titleBtn');
    await wait('#titleMenu:not([hidden])');
    assert.equal(await evaluate(`document.querySelectorAll('#titleMenu #versionBtn, #titleMenu #shareBtn').length`), 0, 'version and sharing controls have one home');
    assert.equal(await evaluate(`document.querySelector('#titleMenu #downloadFilesBtn')?.textContent`), 'Download files…', 'commenters can download from artifact details');
    await run('press', 'Escape');
    assert.equal(await evaluate(`document.getElementById('titleMenu').hidden`), true, 'Escape closes title details without navigating');
    await run('click', '#shareBtn');
    await run('click', '#exportTab');
    await wait('#exportPane:not([hidden])');
    assert.equal(await evaluate(`document.getElementById('downloadBtn').closest('[role=tabpanel]').id`), 'exportPane');
    await run('press', 'ArrowLeft');
    assert.equal(await evaluate(`document.activeElement.id`), 'shareTab', 'Share/Export tabs support keyboard navigation');
    await run('press', 'Escape');
    assert.equal(await evaluate(`document.getElementById('shareMenu').hidden`), true, 'Escape closes Share without navigating');
    await run('click', '#moreBtn');
    assert.equal(await evaluate(`document.getElementById('moreMenu').querySelectorAll('button').length`), 0, 'More owns appearance only');
    await run('press', 'Escape');
    await run('click', '#discussionsBtn');
    await wait('#threadPanel:not([hidden])');
    await wait('#threadPanel .thread[data-anchored="no"]');
    await settle();

    const heading = await labelOf('About the heading');
    const fox = await labelOf('About the fox');
    const gone = await labelOf('Where did it go');
    const xss = await labelOf(XSS.text.split('\n')[0].trim());
    const general = await labelOf('No anchor at all');
    assert.ok(heading && fox && gone && xss && general, `every thread is listed: ${JSON.stringify({ heading, fox, gone, xss, general, state: await evaluate(`({ titles: [...document.querySelectorAll('#threadPanel summary .title')].map(e => e.textContent), errors: window.__qaErrors, mode: document.getElementById('threadPanel')?.dataset.mode, list: document.getElementById('threadList')?.innerHTML.slice(0, 160), protocol: location.protocol, isTop: window === top, title: document.title, path: location.protocol === 'blob:' ? '(artifact frame)' : location.pathname })`) })}`);

    // Anchor resolution: element id, then quote; a stale anchor is unanchored, not a broken pin.
    assert.equal((await panel(heading)).anchored, 'yes');
    assert.equal((await panel(fox)).anchored, 'yes', 'a quote across an <em> still matches');
    assert.equal((await panel(gone)).anchored, 'no');
    assert.match((await panel(gone)).text, /Not found in this version/);
    assert.match((await panel(gone)).text, /a sentence that is gone/);
    assert.equal((await panel(general)).anchored, 'none');
    const drawn = await pins();
    assert.deepEqual(drawn.map(p => p.label).sort(), [heading, fox].sort(), 'pins only for anchors that match');
    const near = await inFrame(`(() => {
      const h = document.getElementById('intro').getBoundingClientRect();
      const t = document.querySelector('p').firstChild;
      const r = document.createRange(); r.setStart(t, t.data.indexOf('brown')); r.setEnd(t, t.data.length);
      const q = r.getClientRects()[0];
      return { h: { x: h.left, y: h.top }, q: { x: q.left, y: q.top } };
    })()`);
    const pinOf = label => drawn.find(p => p.label === label);
    assert.ok(Math.abs(pinOf(heading).x - near.h.x) < 40 && Math.abs(pinOf(heading).y - near.h.y) < 40, JSON.stringify({ pin: pinOf(heading), at: near.h }));
    assert.ok(Math.abs(pinOf(fox).x - near.q.x) < 40 && Math.abs(pinOf(fox).y - near.q.y) < 40, JSON.stringify({ pin: pinOf(fox), at: near.q }));
    assert.ok(drawn.every(p => p.w >= 24 && p.h >= 24), 'pins are big enough to hit');

    // Marker visibility is local presentation, not thread access or anchor resolution.
    const countBefore = await evaluate(`document.getElementById('commentCount').textContent`);
    await press('#showCommentMarkers');
    await settle();
    assert.equal(await evaluate(`document.getElementById('showCommentMarkers').getAttribute('aria-checked')`), 'false');
    assert.equal((await pins()).length, 0, 'hidden markers are not visible or focusable');
    assert.equal((await panel(heading)).anchored, 'yes', 'hiding markers preserves anchor resolution');
    await press(`#threadList .thread[data-label="${heading}"] > summary`);
    assert.equal((await panel(heading)).focus, true, 'threads still open while markers are hidden');
    assert.equal((await pins()).length, 0, 'opening a thread does not restore markers');
    await run('click', '#discussionsBtn');
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('commentsBtn')).backgroundColor`), 'rgba(0, 0, 0, 0)', 'the idle placement toggle is not filled');
    assert.equal(await evaluate(`document.getElementById('commentsBtn').getAttribute('aria-pressed')`), 'false', 'opening the discussion panel does not arm placement');
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('commentCount')).position`), 'static', 'count is inline, not a badge');
    assert.equal(await evaluate(`document.getElementById('commentCount').textContent`), countBefore);
    await evaluate(`document.documentElement.dataset.theme = 'dark'`);
    await settle();
    assert.equal((await pins()).length, 0, 'theme redraw retains hidden markers');
    await press('#placeComment');
    assert.equal(await evaluate(`document.getElementById('showCommentMarkers').getAttribute('aria-checked')`), 'true', 'placement restores markers');
    await settle();
    assert.equal((await pins()).length, drawn.length);
    await press('#cancelPlacement');

    // What the page is told: anchors, numbers, resolved flags and colours; no ticket text, no token.
    await inFrame(`(window.__told = [], addEventListener('message', e => { if (e.data && e.data.__artifactPins === 1) window.__told.push(e.data); }), true)`);
    await evaluate(`document.documentElement.dataset.theme = 'dark'`); // a theme change sends the pins again
    await run('wait', '--fn', `document.documentElement.dataset.theme === 'dark'`);
    await evaluate(`document.documentElement.dataset.theme = 'light'`);
    await settle();
    const told = await inFrame('window.__told');
    assert.ok(told.length >= 2, JSON.stringify(told));
    for (const m of told) {
      const raw = JSON.stringify(m);
      for (const secret of [a.read, a.write, a.comment, 'About the fox', 'first line', 'Shortened in']) assert.ok(!raw.includes(secret), 'the page is told no tokens or ticket text');
      if (m.type !== 'pins') continue;
      assert.deepEqual(Object.keys(m).sort(), ['__artifactPins', 'colors', 'pins', 'type', 'visible'], JSON.stringify(m));
      assert.equal(m.type, 'pins');
      assert.deepEqual(Object.keys(m.colors).sort(), ['accent', 'muted', 'surface']);
      assert.ok(Object.values(m.colors).every(c => /^#[0-9A-Fa-f]{6}$/.test(c)), JSON.stringify(m.colors));
      for (const pin of m.pins) {
        assert.deepEqual(Object.keys(pin).sort(), ['anchor', 'key', 'resolved']);
        assert.ok(Number.isInteger(pin.key) && typeof pin.anchor === 'string' && typeof pin.resolved === 'boolean');
      }
    }

    // Only the page's own frame speaks for the pins: the viewer's window, or a
    // frame nested in the page, is ignored. The same message from the page is taken.
    const forged = { __artifactPins: 1, type: 'selection', anchor: 'FORGED' };
    await evaluate(`window.postMessage(${JSON.stringify(forged)}, '*')`);
    await inFrame(`new Promise(r => { const f = document.createElement('iframe'); f.id = 'nested'; f.srcdoc = '<p>nested</p>'; f.onload = r; document.body.append(f); })`);
    await inFrame(`(parent.parent.postMessage(${JSON.stringify(forged)}, '*'),
      parent.parent.postMessage({ __artifactPins: 1, type: 'placed', keys: [] }, '*'),
      parent.parent.postMessage({ __artifactPins: 1, type: 'open', key: ${gone} }, '*'), true)`, f => f.url === 'about:srcdoc');
    await settle();
    assert.ok(!(await evaluate(`document.getElementById('commentAnchor').textContent`)).includes('FORGED'));
    assert.equal((await panel(heading)).anchored, 'yes', 'a forged placement changes nothing');
    assert.equal((await panel(gone)).focus, false, 'a forged pin click opens nothing');
    await inFrame(`(document.getElementById('nested').remove(), parent.postMessage({ __artifactPins: 1, type: 'selection', anchor: 'FROM THE PAGE' }, '*'), true)`);
    await run('wait', '--fn', `document.getElementById('commentAnchor').textContent.includes('FROM THE PAGE')`);
    // The panel is a separate control from placement now, so open it to reach
    // its draft actions; the page's selection is kept either way.
    await run('click', '#discussionsBtn');
    await wait('#threadPanel:not([hidden])');
    await run('click', '#generalComment');
    await run('click', '#anchorClear');
    await run('click', '#cancelComment');
    await run('click', '#discussionsBtn');
    await wait('#threadPanel .thread');

    // A page sending pin clicks never takes focus from a reply being written.
    await press(`#threadPanel .thread[data-label="${general}"] summary`);
    await press(`#threadPanel .thread[data-label="${general}"] .reply textarea`);
    await run('keyboard', 'type', 'half a reply');
    const typingBefore = await evaluate(`({ active: document.activeElement.tagName, value: document.activeElement.value, mode: document.getElementById('threadPanel').dataset.mode, focused: document.querySelector('#threadPanel .thread.focus')?.dataset.label })`);
    assert.equal(typingBefore.value, 'half a reply', JSON.stringify(typingBefore));
    await inFrame(`(parent.postMessage({ __artifactPins: 1, type: 'open', key: ${gone} }, '*'), parent.postMessage({ __artifactPins: 1, type: 'open', key: ${gone} }, '*'), parent.postMessage({ __artifactPins: 1, type: 'cancel' }, '*'), true)`);
    await settle();
    assert.equal(await evaluate(`(() => { const t = document.activeElement; return t.matches('#threadPanel .thread[data-label="${general}"] .reply textarea') && t.value; })()`), 'half a reply', JSON.stringify(await evaluate(`({ active: document.activeElement.tagName, value: document.activeElement.value, mode: document.getElementById('threadPanel').dataset.mode, focused: document.querySelector('#threadPanel .thread.focus')?.dataset.label })`)));
    assert.equal((await panel(gone)).focus, false, 'a page message cannot replace the thread being written');
    await evaluate(`(() => { const t = document.activeElement; t.value = ''; t.dispatchEvent(new Event('input')); t.blur(); })()`);

    // Untrusted text, titles, anchors and authors render as text, in the panel and the page.
    assert.equal(await evaluate('window.__xss ?? null'), null);
    assert.equal(await inFrame('window.__xss ?? null'), null);
    assert.equal(await evaluate('document.querySelectorAll("#threadPanel img, #threadPanel script").length'), 0);
    assert.ok((await panel(xss)).text.includes(XSS.text.split('\n')[1]), 'the payload shows as text');
    assert.equal((await panel(xss)).anchored, 'no', 'an anchor that is not on the page');
    assert.ok((await panel(xss)).text.includes(XSS.anchor), 'the anchor shows as text');
    if (a.authorXss) assert.ok((await evaluate('document.getElementById("threadPanel").textContent')).includes(XSS.author), 'the author shows as text');

    // The reply that names a check-in links that version.
    assert.deepEqual((await panel(heading)).checkins, [`#${a.comment}@${a.tip.slice(0, 12)}`]);

    // A pin, hit with the mouse, opens its thread in the panel.
    await run('click', '#threadClose');
    await clickPin(fox);
    await wait(`#threadPanel .thread.focus[data-label="${fox}"]`);
    assert.equal((await panel(fox)).open, true);
    await run('screenshot', join(output, 'comment-link-desktop-light.png'));

    // Reply, resolve and reopen through the panel.
    const thread = `#threadPanel .thread[data-label="${fox}"]`;
    await run('fill', `${thread} .reply textarea`, 'Agreed, shortened.');
    // Hold the real request at the network boundary to exercise pending replies.
    await evaluate(`(() => { const fetch = window.fetch; window.fetch = (...args) => args[1]?.method === 'POST' && String(args[0]).endsWith('/tickets') ? new Promise(resolve => { window.__releaseReply = () => { window.fetch = fetch; resolve(fetch(...args)); }; }) : fetch(...args); })()`);
    await press(`${thread} .reply button[type=submit]`);
    await run('wait', '--fn', `typeof window.__releaseReply === 'function'`);
    await inFrame(`(parent.postMessage({ __artifactPins: 1, type: 'open', key: ${gone} }, '*'), parent.postMessage({ __artifactPins: 1, type: 'dismiss' }, '*'), true)`);
    await settle();
    assert.equal(await evaluate(`!document.getElementById('threadPanel').hidden && document.querySelector('#threadPanel .thread.focus')?.dataset.label`), fox, 'page messages cannot replace or hide a pending reply');
    await evaluate(`(window.__releaseReply(), delete window.__releaseReply, true)`);
    await run('wait', '--fn', `[...document.querySelectorAll('#threadPanel .thread .message')].some(m => m.textContent === 'Agreed, shortened.')`);
    let t = await byTitle('About the fox');
    assert.equal(t.changes.at(-1).comment, 'Agreed, shortened.');
    assert.equal(t.changes.at(-1).user, 'comment-link');
    const foxNow = await labelOf('About the fox');
    await press(`#threadPanel .thread[data-label="${foxNow}"] .resolve`);
    await run('wait', '--fn', `document.querySelector('#threadPanel .thread.resolved summary .title')?.textContent === 'About the fox'`);
    assert.equal((await byTitle('About the fox')).status, 'Closed');
    const resolvedLabel = await labelOf('About the fox');
    assert.equal((await panel(resolvedLabel)).open, false, 'resolved threads are collapsed');
    assert.equal((await panel(resolvedLabel)).resolve, 'Reopen');
    await settle();
    assert.equal((await pins()).find(p => p.label === resolvedLabel)?.resolved, true, 'the pin shows it resolved');
    await press(`#threadPanel .thread[data-label="${resolvedLabel}"] summary`);
    await press(`#threadPanel .thread[data-label="${resolvedLabel}"] .resolve`);
    await run('wait', '--fn', `!document.querySelector('#threadPanel .thread.resolved')`);
    assert.equal((await byTitle('About the fox')).status, 'Open');

    // A new comment on selected text anchors to the quote and gets a pin.
    await run('click', '#discussionsBtn');
    await inFrame(`(() => {
      const t = document.querySelector('p').lastChild;
      const r = document.createRange(); r.setStart(t, t.data.indexOf('lazy')); r.setEnd(t, t.data.indexOf('dog') + 3);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    })()`);
    await run('wait', '--fn', `document.getElementById('commentAnchor').textContent.includes('lazy dog')`);
    await press('#generalComment');
    await run('fill', '#commentText', 'Which dog?');
    await run('click', '#commentForm button[type=submit]');
    await run('wait', '--fn', `[...document.querySelectorAll('#threadPanel .thread summary .title')].some(e => e.textContent === 'Which dog?')`);
    assert.equal((await byTitle('Which dog?')).fields.subsystem, 'lazy dog');
    await settle();
    const dog = await labelOf('Which dog?');
    assert.equal((await panel(dog)).anchored, 'yes');
    assert.ok((await pins()).some(p => p.label === dog));

    // Explicit placement is the toggle: a click on the page drops a bubble at
    // that point, over the page. The inspector stays shut and the page's box
    // keeps the width it had, so the artifact does not reflow.
    const frameBox = async () => evaluate(`(() => { const r = document.getElementById('frame').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
    const mouseAt = async (x, y) => {
      const f = await frameBox();
      await run('mouse', 'move', String(Math.round(f.x + x)), String(Math.round(f.y + y)));
      await run('mouse', 'down'); await run('mouse', 'up');
    };
    await run('click', '#threadClose');
    await settle();
    const widthBefore = (await frameBox()).width;
    await press('#commentsBtn');
    await wait('#placementHint:not([hidden])');
    assert.equal(await evaluate(`document.getElementById('commentsBtn').getAttribute('aria-pressed')`), 'true', 'the comments button is an on/off placement switch');
    await mouseAt(900, 280);
    await wait('#commentBubble:not([hidden])');
    assert.equal(await evaluate(`document.getElementById('inspector').hidden`), true, 'placing a comment does not open the inspector');
    assert.equal((await frameBox()).width, widthBefore, 'placing a comment does not reshape the page');
    const bubble = await evaluate(`(() => {
      const b = document.getElementById('commentBubble').getBoundingClientRect(), f = document.getElementById('frame').getBoundingClientRect();
      return { inside: b.left >= f.left && b.top >= f.top && b.right <= f.right && b.bottom <= f.bottom, left: b.left, top: b.top, width: b.width };
    })()`);
    assert.ok(bubble.inside, JSON.stringify(bubble));
    assert.equal(await evaluate(`document.getElementById('commentsBtn').getAttribute('aria-pressed')`), 'true', 'placement stays on after a point, so the mode is not one shot');
    // A second click moves the bubble without re-arming the toggle.
    await mouseAt(700, 420);
    await wait('#commentBubble:not([hidden])');
    assert.equal(await evaluate(`document.getElementById('commentsBtn').getAttribute('aria-pressed')`), 'true', 'the mode survives a second click');
    assert.equal((await frameBox()).width, widthBefore, 'moving the bubble does not reshape the page');
    await run('fill', '#bubbleText', 'Comment in blank space');
    await run('press', 'Escape');
    assert.equal(await evaluate(`document.getElementById('commentBubble').hidden`), true, 'Escape closes the bubble');
    assert.equal(await evaluate(`document.getElementById('commentsBtn').getAttribute('aria-pressed')`), 'false', 'Escape ends the placement mode');
    await run('click', '#discussionsBtn');
    assert.equal(await evaluate(`document.getElementById('placeComment').textContent`), 'Continue draft', 'the anchor survives closing the bubble');
    // The discussion index overlays the page, including when resuming a draft.
    const widthOpen = (await frameBox()).width;
    await press('#placeComment');
    assert.equal(await evaluate(`document.getElementById('commentText').value`), 'Comment in blank space', 'closing preserves a draft');
    assert.equal((await frameBox()).width, widthOpen, 'reopening the draft does not reshape the page again');
    await run('click', '#commentForm button[type=submit]');
    await run('wait', '--fn', `document.getElementById('threadPanel').dataset.mode === 'thread'`);
    assert.equal((await frameBox()).width, widthOpen, 'posting does not reshape the page');
    const blank = await byTitle('Comment in blank space');
    assert.ok(blank.fields.subsystem.startsWith('hap-point:'), 'a real location anchor is persisted');
    let blankLabel = await labelOf('Comment in blank space');
    await settle();
    assert.equal((await panel(blankLabel)).anchored, 'yes');
    assert.ok((await pins()).some(p => p.label === blankLabel), 'a marker remains at the posted location');
    // Posting from the general composer keeps its overlay open. Pin clicks
    // instead open a contextual card at the pin.
    const popover = await evaluate(`(() => { const r = document.getElementById('threadPanel').getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, card: document.getElementById('inspector').classList.contains('card') }; })()`);
    assert.equal(popover.card, false, 'a general reply stays in the discussion overlay');
    assert.ok(popover.x > 500 && popover.right <= 1280 && popover.y >= 45 && popover.bottom <= 900, JSON.stringify(popover));
    await run('click', '#threadClose');
    const pin = await clickPin(blankLabel);
    await wait('#threadPanel[data-mode="thread"]:not([hidden])');
    assert.ok((await panel(blankLabel)).text.includes('Comment in blank space'));
    // A pin opens its thread as a card at the pin, over the page: the same
    // click coordinates, near the pin, inside the page box, and the frame
    // keeps the width it had with no panel open.
    await settle();
    const card = await evaluate(`(() => {
      const r = document.getElementById('inspector').getBoundingClientRect(), f = document.getElementById('frame').getBoundingClientRect();
      return { card: document.getElementById('inspector').classList.contains('card'), x: r.left, y: r.top, right: r.right, bottom: r.bottom, width: r.width,
        frame: { x: f.left, y: f.top, right: f.right, bottom: f.bottom, width: f.width } };
    })()`);
    assert.equal(card.card, true, 'a thread from a pin is an anchored card');
    assert.equal(card.frame.width, widthBefore, 'opening a pin thread does not reshape the page');
    // Anchored at the pin: the card's near horizontal edge sits about one gap
    // from the clicked pin, and its top is just under the pin's bottom edge,
    // rather than parked at the screen's right edge.
    const gapX = Math.min(Math.abs(card.x - (card.frame.x + pin.x)), Math.abs(card.right - (card.frame.x + pin.x)));
    const gapY = card.y - (card.frame.y + pin.y + pin.h / 2);
    assert.ok(gapX <= 30 && gapY >= -30 && gapY <= 100, JSON.stringify({ card, pin, gapX, gapY }));
    assert.ok(card.x >= card.frame.x && card.y >= card.frame.y && card.right <= card.frame.right && card.bottom <= card.frame.bottom, JSON.stringify(card));
    // A reply typed into the card stays there, and a page message cannot take it.
    await run('fill', '#threadPanel .thread.focus .reply textarea', 'Card reply in progress');
    await inFrame(`(parent.postMessage({ __artifactPins: 1, type: 'open', key: ${Number(blankLabel) + 1} }, '*'), parent.postMessage({ __artifactPins: 1, type: 'dismiss' }, '*'), true)`);
    await settle();
    assert.equal(await evaluate(`document.querySelector('#threadPanel .thread.focus .reply textarea')?.value`), 'Card reply in progress', 'a pin message cannot replace a reply being written');
    assert.equal(await evaluate(`document.getElementById('inspector').classList.contains('card') && !document.getElementById('inspector').hidden`), true, 'the card stays open');
    await run('fill', '#threadPanel .thread.focus .reply textarea', '');
    await run('click', '#threadClose');
    await run('reload');
    await wait('#bar:not([hidden])');
    await run('click', '#discussionsBtn');
    await run('wait', '--fn', `[...document.querySelectorAll('#threadPanel summary .title')].some(e => e.textContent === 'Comment in blank space')`);
    blankLabel = await labelOf('Comment in blank space');
    await settle();
    assert.ok((await pins()).some(p => p.label === blankLabel), 'the marker survives reload');

    // The discussion index is an overlay too: moving from it to a pin card
    // must not widen the artifact, even for a reader who left the index open.
    assert.equal((await frameBox()).width, widthBefore, 'the discussion index never narrows the page');
    await clickPin(blankLabel);
    await wait('#inspector.card:not([hidden])');
    assert.equal((await frameBox()).width, widthBefore, 'index-to-pin navigation never reshapes the page');
    await run('click', '#threadClose');

    // Opening an existing pin while placement is armed keeps the mode on.
    // Closing its card still lets the very next blank-page click place a bubble.
    await press('#commentsBtn');
    await clickPin(blankLabel);
    await wait('#inspector.card:not([hidden])');
    assert.equal(await evaluate(`document.getElementById('commentsBtn').getAttribute('aria-pressed')`), 'true', 'a pin click preserves the placement switch');
    await run('click', '#threadClose');
    await mouseAt(820, 360);
    await wait('#commentBubble:not([hidden])');
    await run('click', '#bubbleCancel');

    // A bubble cannot overwrite an unrelated discussion draft. Both sets of
    // words remain available when Discuss instead is refused, and closing the
    // bubble preserves its own words as well.
    await run('click', '#discussionsBtn');
    await press('#generalComment');
    await run('fill', '#commentText', 'Unrelated general draft');
    await press('#commentsBtn');
    await mouseAt(820, 360);
    await wait('#commentBubble:not([hidden])');
    await run('fill', '#bubbleText', 'Separate anchored draft');
    await run('click', '#bubbleGeneral');
    assert.deepEqual(await evaluate(`({ bubble: document.getElementById('bubbleText').value, general: document.getElementById('commentText').value, open: !document.getElementById('commentBubble').hidden })`), {
      bubble: 'Separate anchored draft', general: 'Unrelated general draft', open: true,
    }, 'Discuss instead preserves both independent drafts');
    await run('click', '#bubbleClose');
    await press('#commentsBtn');
    await mouseAt(820, 360);
    await wait('#commentBubble:not([hidden])');
    assert.equal(await evaluate(`document.getElementById('bubbleText').value`), 'Separate anchored draft', 'closing a bubble does not lose its words when another draft exists');
    await run('click', '#bubbleCancel');
    await run('click', '#discussionsBtn');
    await press('#generalComment');
    assert.equal(await evaluate(`document.getElementById('commentText').value`), 'Unrelated general draft');
    await run('click', '#cancelComment');

    // A failed post keeps its text and visible error even if X or Escape is
    // pressed while the request is in flight. Hold only this fixture request.
    await press('#commentsBtn');
    await mouseAt(820, 360);
    await wait('#commentBubble:not([hidden])');
    await run('fill', '#bubbleText', 'Keep these words if posting fails');
    await evaluate(`(() => {
      window.__originalCommentFetch = window.fetch;
      window.fetch = function(input, init) {
        if (String(input).includes('/tickets') && init?.method === 'POST') {
          return new Promise((resolve, reject) => { window.__rejectCommentPost = () => reject(new Error('Fixture offline')); });
        }
        return window.__originalCommentFetch.call(this, input, init);
      };
    })()`);
    await run('click', '#commentBubble button[type=submit]');
    await run('wait', '--fn', `typeof window.__rejectCommentPost === 'function' && document.getElementById('bubbleText').readOnly`);
    await run('click', '#bubbleClose');
    assert.equal(await evaluate(`document.getElementById('commentBubble').hidden`), false, 'X cannot discard an in-flight comment');
    await run('press', 'Escape');
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await evaluate(`document.getElementById('commentBubble').hidden`), false, 'neither Escape path discards an in-flight comment');
    await evaluate(`(window.fetch = window.__originalCommentFetch, window.__rejectCommentPost(), true)`);
    await run('wait', '--fn', `document.getElementById('bubbleStatus').textContent.includes('Could not post:')`);
    assert.deepEqual(await evaluate(`({ open: !document.getElementById('commentBubble').hidden, text: document.getElementById('bubbleText').value, editable: !document.getElementById('bubbleText').readOnly })`), {
      open: true, text: 'Keep these words if posting fails', editable: true,
    }, 'a failed request leaves the comment visible and recoverable');
    await run('click', '#bubbleCancel');

    // Posting from the bubble ends that bubble but not the mode: the reader can
    // place the next comment without arming the toggle again.
    await press('#commentsBtn');
    await mouseAt(820, 360);
    await wait('#commentBubble:not([hidden])');
    await run('fill', '#bubbleText', 'Second comment while placing');
    await run('click', '#commentBubble button[type=submit]');
    await run('wait', '--fn', `document.getElementById('commentBubble').hidden`);
    assert.equal(await evaluate(`document.getElementById('commentsBtn').getAttribute('aria-pressed')`), 'true', 'posting from the bubble keeps placement on');
    assert.equal((await frameBox()).width, widthBefore, 'posting from the bubble does not reshape the page');
    await press('#commentsBtn');
    assert.equal(await evaluate(`document.getElementById('commentsBtn').getAttribute('aria-pressed')`), 'false');
    const second = await byTitle('Second comment while placing');
    assert.ok(second.fields.subsystem.startsWith('hap-point:'), 'the second placed comment is anchored too');
    await run('click', '#discussionsBtn');
    await wait('#threadPanel .thread');
    await settle();
    const beforePoint = (await tickets()).length;
    await inFrame(`(parent.postMessage({ __artifactPins: 1, type: 'point', anchor: ${JSON.stringify(blank.fields.subsystem)}, x: 20, y: 20 }, '*'), true)`);
    await settle();
    assert.equal(await evaluate(`document.getElementById('commentBubble').hidden`), true, 'a page message alone cannot open the bubble');
    assert.equal((await tickets()).length, beforePoint);
    await press('#commentsBtn');
    await run('press', 'Enter');
    await wait('#commentBubble:not([hidden])');
    await run('fill', '#bubbleText', 'Discard this draft');
    await run('click', '#bubbleCancel');
    assert.equal(await evaluate(`document.getElementById('commentBubble').hidden`), true);
    assert.equal(await evaluate(`document.getElementById('bubbleText').value`), '');
    await run('click', '#discussionsBtn');
    assert.equal(await evaluate(`document.getElementById('commentText').value`), '');
    assert.equal((await tickets()).length, beforePoint);

    // An element location follows reflow, rather than staying at a viewport pixel.
    await press('#commentsBtn');
    const headingBox = await inFrame(`(() => { const r = document.getElementById('intro').getBoundingClientRect(); return { x: r.left + 45, y: r.top + 12 }; })()`);
    await mouseAt(headingBox.x, headingBox.y);
    await wait('#commentBubble:not([hidden])');
    assert.equal(await evaluate(`document.getElementById('inspector').hidden`), true, 'the bubble stands in for the inspector');
    await run('fill', '#bubbleText', 'Location on heading');
    await run('click', '#commentBubble button[type=submit]');
    await run('wait', '--fn', `document.getElementById('commentBubble').hidden`);
    await run('wait', '--fn', `[...document.querySelectorAll('#threadPanel summary .title')].some(e => e.textContent === 'Location on heading')`);
    assert.equal(await evaluate(`document.getElementById('inspector').hidden`), true, 'posting from the bubble leaves the page in place');
    const located = await byTitle('Location on heading');
    assert.equal(JSON.parse(located.fields.subsystem.slice('hap-point:'.length)).id, 'intro');
    const locatedLabel = await labelOf('Location on heading');
    await settle();
    const beforeMove = (await pins()).find(p => p.label === locatedLabel);
    await inFrame(`(document.getElementById('intro').style.marginTop = '220px', true)`);
    await settle();
    const afterMove = (await pins()).find(p => p.label === locatedLabel);
    assert.ok(afterMove.y - beforeMove.y > 100, JSON.stringify({ beforeMove, afterMove }));
    await inFrame(`(document.getElementById('intro').style.marginTop = '', true)`);
    await run('click', '#discussionsBtn');

    // Dark theme: the panel follows the viewer's tokens.
    await evaluate(`document.documentElement.dataset.theme = 'dark'`);
    const dark = await evaluate(`(() => { const s = getComputedStyle(document.getElementById('threadPanel')); return { bg: s.backgroundColor, ink: s.color }; })()`);
    assert.equal(dark.bg, 'rgb(35, 35, 33)', 'surface token, dark');
    assert.equal(dark.ink, 'rgb(237, 235, 230)', 'ink token, dark');
    await run('screenshot', join(output, 'comment-link-desktop-dark.png'));
    await evaluate(`document.documentElement.dataset.theme = 'light'`);

    // Phone width: comments stay in a bounded dropdown, pins still hit.
    await run('set', 'viewport', '390', '844');
    await settle();
    const dropdown = await evaluate(`(() => { const p = document.getElementById('threadPanel'); const s = getComputedStyle(p); const r = p.getBoundingClientRect();
      return { position: s.position, top: r.top, bottom: r.bottom, width: r.width, overflow: document.documentElement.scrollWidth > innerWidth, toolbar: document.getElementById('bar').offsetHeight }; })()`);
    assert.equal(dropdown.position, 'absolute', JSON.stringify(dropdown));
    assert.ok(dropdown.top >= 89 && dropdown.bottom <= 844 && dropdown.width <= 390 && !dropdown.overflow && dropdown.toolbar === 89, JSON.stringify(dropdown));
    await run('screenshot', join(output, 'comment-link-phone-dropdown.png'));
    await run('click', '#threadClose');
    await settle();
    // On a phone the bubble is still an overlay over the page: it fits the
    // page's box, and neither placing nor cancelling resizes the iframe.
    const phoneFrame = await frameBox();
    await press('#commentsBtn');
    await mouseAt(190, 300);
    await wait('#commentBubble:not([hidden])');
    const phoneBubble = await evaluate(`(() => {
      const b = document.getElementById('commentBubble').getBoundingClientRect(), f = document.getElementById('frame').getBoundingClientRect();
      return { inside: b.left >= f.left && b.top >= f.top && b.right <= f.right && b.bottom <= f.bottom,
        overflow: document.documentElement.scrollWidth > innerWidth, width: b.width, frame: f.width, toolbar: document.getElementById('bar').offsetHeight };
    })()`);
    assert.ok(phoneBubble.inside && !phoneBubble.overflow, JSON.stringify(phoneBubble));
    assert.equal(phoneBubble.frame, phoneFrame.width, 'a phone comment bubble does not reshape the page');
    assert.equal(phoneBubble.toolbar, 89, 'the placement toggle fits the two-row phone header');
    await run('screenshot', join(output, 'comment-link-phone-bubble.png'));
    await run('fill', '#bubbleText', 'Typing with a short visible viewport');
    // A keyboard-sized visible band must bound the composer and provide its
    // own scrolling, rather than placing Comment below the visible page.
    await run('set', 'viewport', '390', '280');
    await settle();
    const keyboardBubble = await evaluate(`(() => {
      const b = document.getElementById('commentBubble'), r = b.getBoundingClientRect(), f = document.getElementById('frame').getBoundingClientRect();
      b.scrollTop = b.scrollHeight;
      const submit = b.querySelector('[type=submit]').getBoundingClientRect();
      return { inside: r.top >= f.top && r.bottom <= f.bottom, scrollable: b.scrollHeight > b.clientHeight && getComputedStyle(b).overflowY === 'auto', submitVisible: submit.top >= r.top && submit.bottom <= r.bottom };
    })()`);
    assert.ok(keyboardBubble.inside && keyboardBubble.scrollable && keyboardBubble.submitVisible, JSON.stringify(keyboardBubble));
    await run('set', 'viewport', '390', '844');
    await run('press', 'Escape');
    assert.equal(await evaluate(`document.getElementById('commentBubble').hidden`), true, 'Escape closes the phone bubble');
    assert.equal((await frameBox()).width, phoneFrame.width, 'cancelling does not reshape the page');
    const headingNow = await labelOf('About the heading'); // labels moved: new threads come first
    await clickPin(headingNow);
    await wait(`#threadPanel .thread.focus[data-label="${headingNow}"]`);
    await settle();
    // On a phone the pin's card is bounded too: it fits the visible area, the
    // frame keeps its width, and the header keeps one row count.
    const phoneCard = await evaluate(`(() => {
      const i = document.getElementById('inspector'), r = i.getBoundingClientRect(), f = document.getElementById('frame').getBoundingClientRect();
      return { card: i.classList.contains('card'), inside: r.left >= f.left - 1 && r.top >= f.top - 1 && r.right <= f.right + 1 && r.bottom <= f.bottom + 1,
        frame: f.width, height: r.height, overflow: document.documentElement.scrollWidth > innerWidth };
    })()`);
    assert.ok(phoneCard.height > 100, 'a phone thread card contains its visible content');
    assert.equal(phoneCard.card, true, 'a phone pin opens an anchored card');
    assert.ok(phoneCard.inside && !phoneCard.overflow, JSON.stringify(phoneCard));
    assert.equal(phoneCard.frame, phoneFrame.width, 'a phone pin card does not reshape the page');
    await run('screenshot', join(output, 'comment-link-phone-pin.png'));

    // A reply from another client appears in the open thread, even while typing.
    await press('#threadPanel .thread.focus .reply textarea');
    await run('keyboard', 'type', 'Keep this unfinished reply');
    await evaluate(`(() => { const t = document.activeElement; window.__draft = t; t.setSelectionRange(5, 9); })()`);
    const remoteThread = await byTitle('About the heading');
    const remote = await api(`/api/artifacts/${a.id}/tickets`, {
      method: 'POST', token: a.write, body: { ticketUuid: remoteThread.uuid, text: 'A live reply from another client.' },
    });
    assert.equal(remote.status, 200, remote.text);
    assert.equal((await api(`/api/artifacts/${a.id}`, { token: a.read })).json.tip, a.tip, 'comments do not publish a version');
    await run('wait', '--fn', `document.querySelector('#threadPanel .thread.focus')?.textContent.includes('A live reply from another client.')`);
    assert.deepEqual(await evaluate(`(() => { const t = document.activeElement; return { same: t === window.__draft, value: t.value, start: t.selectionStart, end: t.selectionEnd, mode: document.getElementById('threadPanel').dataset.mode }; })()`),
      { same: true, value: 'Keep this unfinished reply', start: 5, end: 9, mode: 'thread' }, 'live replies preserve the active draft and selection');
    await run('screenshot', join(output, 'comment-live-reply-with-draft.png'));
    for (const status of ['Closed', 'Open']) {
      await new Promise(resolve => setImmediate(resolve));
      const changed = await api(`/api/artifacts/${a.id}/tickets`, {
        method: 'POST', token: a.write, body: { ticketUuid: remoteThread.uuid, status },
      });
      assert.equal(changed.status, 200, changed.text);
      await run('wait', '--fn', `document.querySelector('#threadPanel .thread.focus summary .tag')?.textContent === ${JSON.stringify(status)}`);
      assert.deepEqual(await evaluate(`(() => { const t = document.activeElement, view = document.querySelector('#threadPanel .thread.focus'); return { open: view.open, same: t === window.__draft, value: t.value, start: t.selectionStart, end: t.selectionEnd, action: view.querySelector('.resolve').textContent }; })()`),
        { open: true, same: true, value: 'Keep this unfinished reply', start: 5, end: 9, action: status === 'Closed' ? 'Reopen' : 'Resolve' }, 'remote status changes do not collapse an active draft');
    }

    // ── The read link: threads and pins, no comment box, reply or resolve ──
    await run('set', 'viewport', '1280', '900');
    await run('open', `${base}/v/${a.id}#${a.read}`);
    await wait('#bar:not([hidden])');
    await run('click', '#titleBtn');
    await download('#downloadFilesBtn');
    assert.equal(await evaluate(`document.getElementById('titleMenu').hidden`), true, 'downloading closes artifact details');
    await run('click', '#discussionsBtn');
    await wait('#threadPanel .thread');
    await settle();
    const readOnly = await evaluate(`({ form: document.getElementById('commentForm').hidden, replies: document.querySelectorAll('#threadPanel .reply').length,
      resolves: document.querySelectorAll('#threadPanel .resolve:not([hidden])').length, threads: document.querySelectorAll('#threadPanel .thread').length,
      note: document.getElementById('commentsNote').textContent })`);
    assert.deepEqual({ ...readOnly, replies: readOnly.replies > 0, threads: readOnly.threads > 0 }, { form: true, replies: true, resolves: 0, threads: true, note: '' });
    assert.ok((await pins()).length >= 3, 'readers see the pins');
    await press('#showCommentMarkers');
    await settle();
    assert.equal((await pins()).length, 0, 'read-only viewers can hide markers');
    assert.equal(await evaluate(`document.getElementById('commentForm').hidden`), true, 'visibility does not grant commenting');
    await press('#showCommentMarkers');
    await settle();
    assert.ok((await pins()).length >= 3, 'read-only viewers can restore markers');
    // Placement is offered exactly to readers who may comment. This read link
    // may discuss as a guest, so both comment controls are positively present:
    // the page stays view-only while the comment controls stand beside it.
    const cue = await evaluate(`(() => { const c = document.getElementById('readCue'), f = document.getElementById('frame'); return { visible: !c.hidden, clear: c.getBoundingClientRect().bottom <= f.getBoundingClientRect().top, placeVisible: !document.getElementById('commentsBtn').hidden, generalVisible: !document.getElementById('placeComment').hidden, sandbox: f.getAttribute('sandbox') }; })()`);
    assert.equal(cue.placeVisible, true, 'a guest reader can place comments');
    assert.equal(cue.generalVisible, true, 'a guest reader can write a general comment');
    assert.ok(cue.visible && cue.clear && !cue.sandbox.includes('allow-same-origin'), JSON.stringify(cue));
    await inFrame(`(parent.postMessage({ __artifactPins: 1, type: 'point', anchor: ${JSON.stringify(blank.fields.subsystem)}, x: 20, y: 20 }, '*'), true)`);
    await settle();
    assert.equal(await evaluate(`document.getElementById('threadPanel').dataset.mode`), 'index', 'a read link cannot be made a composer by page messages');
    await run('set', 'viewport', '360', '780');
    assert.equal(await evaluate(`document.getElementById('bar').offsetHeight === 89 && document.documentElement.scrollWidth <= innerWidth`), true, 'long title stays within the two-row phone header at 360px');
    await run('set', 'viewport', '1280', '900');
    await run('screenshot', join(output, 'read-link-desktop.png'));

    // ── The responder banner above the threads: from attached.json, no republish ──
    const banner = async () => evaluate(`(() => { const n = document.getElementById('responderNote'); return { attached: n.dataset.attached, text: n.textContent.trim().replace(/\\s+/g, ' '), kids: n.querySelectorAll('*:not(strong):not(span)').length }; })()`);
    assert.deepEqual(await banner(), { attached: 'false', text: 'No responder is registered. Comments remain available for later review.', kids: 0 });
    if (attach) {
      attach(JSON.stringify({ responder: XSS.text.split('\n')[0], contact: XSS.author }));
      await run('reload');
      await wait('#bar:not([hidden])');
      await run('click', '#discussionsBtn');
      await wait('#responderNote[data-attached="true"]');
      assert.deepEqual(await banner(), { attached: 'true', text: `A responder is registered. Registration does not verify that it is online. ${XSS.text.split('\n')[0]} (${XSS.author})`, kids: 0 });
      assert.deepEqual(await evaluate('[window.__xss]'), [null], 'markup in the file never ran');
      await run('screenshot', join(output, 'responder-attached.png'));
      attach(null);
      await run('reload');
      await wait('#bar:not([hidden])');
      await run('click', '#discussionsBtn');
      await wait('#responderNote[data-attached="false"]');
    }
    // Editors keep management in the title dropdown and can restore old versions.
    const update = await api(`/api/artifacts/${a.id}`, { method: 'PUT', token: a.write, body: { parent: a.tip, message: 'Toolbar version check', files: { 'version.txt': Buffer.from('second version').toString('base64') } } });
    assert.equal(update.status, 200);
    await run('set', 'viewport', '360', '780');
    await run('open', `${base}/v/${a.id}#${a.write}@${a.tip}`);
    await wait('#bar:not([hidden])');
    await wait('#oldStrip:not([hidden])');
    assert.equal(await evaluate(`document.getElementById('oldStrip').offsetHeight`), 26);
    assert.equal(await evaluate(`document.getElementById('restoreBtn').hidden`), false);
    assert.equal(await evaluate(`document.getElementById('readCue').hidden`), true);
    await run('click', '#titleBtn');
    assert.equal(await evaluate(`['uploadFilesBtn','uploadFolderBtn','deleteBtn'].every(id => !document.getElementById(id).hidden && document.getElementById('titleMenu').contains(document.getElementById(id)))`), true);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
    await run('screenshot', join(output, 'edit-link-phone-old-version.png'));
    assert.equal((await download('#downloadFilesBtn')).includes(Buffer.from('version.txt')), false, 'artifact details downloads the selected old version, not the latest');
    await run('click', '#backLatest');
    await run('wait', '--fn', `document.getElementById('oldStrip').hidden`);
    await run('click', '#titleBtn');
    assert.ok((await download('#downloadFilesBtn')).includes(Buffer.from('version.txt')), 'artifact details downloads files added in the latest version');
    await run('click', '#shareBtn');
    // Replacing the comment link takes two clicks and cuts off the old one.
    const leaked = await evaluate(`document.getElementById('commentLink').value.split('#')[1]`);
    await press('#shareRows .renew');
    assert.equal(await evaluate(`document.getElementById('commentLink').value.split('#')[1]`), leaked, 'one click only asks');
    await press('#shareRows .renew');
    await run('wait', '--fn', `document.getElementById('commentLink')?.value.split('#')[1] !== ${JSON.stringify(leaked)}`);
    const renewed = await evaluate(`document.getElementById('commentLink').value.split('#')[1]`);
    assert.equal((await api(`/api/artifacts/${a.id}`, { token: leaked })).status, 404, 'the old comment link stops working');
    assert.equal((await api(`/api/artifacts/${a.id}`, { token: renewed })).json.role, 'comment');
    await run('click', '#exportTab');
    assert.ok((await download('#downloadBtn')).includes(Buffer.from('version.txt')), 'Share export retains its download action');
    await run('click', '#moreBtn');
    await run('select', '#viewer-theme', 'dark');
    assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'dark');
    await run('select', '#viewer-theme', 'light');
    assert.equal(await evaluate(`document.documentElement.dataset.theme`), 'light');
    await run('select', '#viewer-theme', 'system');
    assert.equal(await evaluate(`document.documentElement.hasAttribute('data-theme')`), false);
    return { output };
  } catch (error) {
    failure = error;
    try {
      await run('screenshot', join(output, 'failure.png'));
      const diagnostic = JSON.parse(await run('--json', 'eval', `({ top: window === top, protocol: location.protocol, viewer: !!document.getElementById('bar'), panel: document.getElementById('threadPanel')?.hidden, threads: document.querySelectorAll('.thread').length })`));
      console.error(diagnostic.data?.result); // The CLI envelope contains the private fixture URL.
    } catch { /* preserve the original failure if the browser stopped responding */ }
    throw error;
  } finally {
    page?.close();
    try { await run('close'); } catch (error) { if (!failure) throw error; }
  }
}
