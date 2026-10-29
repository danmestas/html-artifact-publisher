// Opt-in real Chromium QA for the viewer's comment pins and thread panel,
// invoked by VIEWER_BROWSER_QA=1 node --test test/e2e.test.mjs. Requires the
// agent-browser executable. The e2e suite owns the Wrangler lifecycle and the
// fixture artifact; this drives the viewer as each link holder would.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { frameEval } from './helpers/frame-eval.mjs';

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
  const run = (...args) => {
    const exec = (...command) => execFileSync('agent-browser', ['--session', session, ...command], {
      encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '600000' },
    });
    try {
      if (viewerTab && !['close', 'tab', 'get'].includes(args[0])) exec('tab', viewerTab);
      const result = exec(...args);
      if (args[0] === 'open') {
        const tabs = JSON.parse(exec('--json', 'tab', 'list')).data.tabs;
        viewerTab = tabs.find(t => t.url.startsWith(`${base}/v/${a.id}#`))?.tabId ?? '';
        assert.ok(viewerTab, 'the fixture viewer has its own browser tab');
      }
      return result;
    } catch (e) {
      const command = args[0] === 'open' ? 'open [private fixture]' : args.join(' ');
      throw new Error(`agent-browser ${command} (${e.code ?? e.status ?? 'failed'}, ${e.signal ?? 'no signal'}): ${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 2000));
    }
  };
  const evaluate = source => {
    run('frame', 'main');
    const result = JSON.parse(run('--json', 'eval', `({ top: window === top, viewer: !!document.getElementById('bar'), protocol: location.protocol, value: (${source}) })`));
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.result.top && result.data.result.viewer, true, JSON.stringify(result.data.result));
    return result.data.result.value;
  };
  const wait = selector => run('wait', selector);
  // agent-browser does not scroll the panel, an inner scroller, to what it clicks.
  const press = selector => {
    evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
    run('click', selector);
  };
  const tickets = async () => {
    // Let Node drain closed keep-alive sockets after synchronous browser commands.
    await new Promise(resolve => setImmediate(resolve));
    return (await api(`/api/artifacts/${a.id}/tickets`, { token: a.read })).json.tickets;
  };
  const byTitle = async title => (await tickets()).find(t => t.fields.title === title);
  // agent-browser cannot enter the opaque-origin page frame; DevTools can.
  let page = null;
  const inFrame = async (source, wanted) => {
    page ??= await frameEval(run('get', 'cdp-url').trim());
    return page.eval(source, wanted);
  };
  // The thread a label names, as the panel shows it.
  const panel = label => evaluate(`(() => {
    const t = document.querySelector('#threadPanel .thread[data-label="${label}"]');
    if (!t) return null;
    return { open: t.open, anchored: t.dataset.anchored, focus: t.classList.contains('focus'),
      text: t.textContent, replies: t.querySelectorAll('.reply textarea').length, resolve: t.querySelector('.resolve')?.textContent ?? null,
      checkins: [...t.querySelectorAll('.checkins a')].map(x => x.getAttribute('href')) };
  })()`);
  const labelOf = title => evaluate(`[...document.querySelectorAll('#threadPanel .thread')].find(t => t.querySelector('summary .title').textContent === ${JSON.stringify(title)})?.dataset.label ?? null`);
  // Pins as the page draws them: label, resolved, and the viewport box.
  const pins = () => inFrame(`[...(document.querySelector('[data-artifact-pins]')?.shadowRoot?.querySelectorAll('button') ?? [])]
    .filter(b => getComputedStyle(b).display !== 'none')
    .map(b => { const r = b.getBoundingClientRect(); return { label: b.textContent, resolved: b.dataset.resolved === 'true', x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })`);
  // Clicks a pin with real mouse events at its centre, through the iframe.
  const clickPin = async label => {
    const pin = (await pins()).find(p => p.label === String(label));
    assert.ok(pin, `pin ${label}`);
    const frame = evaluate(`(() => { const r = document.getElementById('frame').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
    run('mouse', 'move', String(Math.round(frame.x + pin.x)), String(Math.round(frame.y + pin.y)));
    run('mouse', 'down');
    run('mouse', 'up');
    return pin;
  };
  const download = selector => {
    const path = join(output, `download-${process.pid}.zip`);
    run('download', selector, path);
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
    run('set', 'viewport', '1280', '900');
    run('open', `${base}/v/${a.id}#${a.comment}`);
    wait('#bar:not([hidden])');
    evaluate(`(window.__qaErrors = [], addEventListener('error', e => window.__qaErrors.push(e.message)), addEventListener('unhandledrejection', e => window.__qaErrors.push(String(e.reason))), true)`);
    evaluate(`document.documentElement.dataset.theme = 'light'`);
    const toolbar = evaluate(`(() => { const b = document.getElementById('bar').getBoundingClientRect(); return { height: b.height, overflow: document.documentElement.scrollWidth > innerWidth, back: !document.getElementById('backLibrary').hidden }; })()`);
    assert.deepEqual(toolbar, { height: 45, overflow: false, back: true }, 'one compact toolbar row with a library return');
    run('click', '#titleBtn');
    wait('#titleMenu:not([hidden])');
    assert.equal(evaluate(`document.querySelectorAll('#titleMenu #versionBtn, #titleMenu #shareBtn').length`), 0, 'version and sharing controls have one home');
    assert.equal(evaluate(`document.querySelector('#titleMenu #downloadFilesBtn')?.textContent`), 'Download files…', 'commenters can download from artifact details');
    run('press', 'Escape');
    assert.equal(evaluate(`document.getElementById('titleMenu').hidden`), true, 'Escape closes title details without navigating');
    run('click', '#shareBtn');
    run('click', '#exportTab');
    wait('#exportPane:not([hidden])');
    assert.equal(evaluate(`document.getElementById('downloadBtn').closest('[role=tabpanel]').id`), 'exportPane');
    run('press', 'ArrowLeft');
    assert.equal(evaluate(`document.activeElement.id`), 'shareTab', 'Share/Export tabs support keyboard navigation');
    run('press', 'Escape');
    assert.equal(evaluate(`document.getElementById('shareMenu').hidden`), true, 'Escape closes Share without navigating');
    run('click', '#moreBtn');
    assert.equal(evaluate(`document.getElementById('moreMenu').querySelectorAll('button').length`), 0, 'More owns appearance only');
    run('press', 'Escape');
    run('click', '#commentsBtn');
    wait('#threadPanel:not([hidden])');
    wait('#threadPanel .thread[data-anchored="no"]');
    settle();

    const heading = labelOf('About the heading');
    const fox = labelOf('About the fox');
    const gone = labelOf('Where did it go');
    const xss = labelOf(XSS.text.split('\n')[0].trim());
    const general = labelOf('No anchor at all');
    assert.ok(heading && fox && gone && xss && general, `every thread is listed: ${JSON.stringify({ heading, fox, gone, xss, general, state: evaluate(`({ titles: [...document.querySelectorAll('#threadPanel summary .title')].map(e => e.textContent), errors: window.__qaErrors, mode: document.getElementById('threadPanel')?.dataset.mode, list: document.getElementById('threadList')?.innerHTML.slice(0, 160), protocol: location.protocol, isTop: window === top, title: document.title, path: location.protocol === 'blob:' ? '(artifact frame)' : location.pathname })`) })}`);

    // Anchor resolution: element id, then quote; a stale anchor is unanchored, not a broken pin.
    assert.equal(panel(heading).anchored, 'yes');
    assert.equal(panel(fox).anchored, 'yes', 'a quote across an <em> still matches');
    assert.equal(panel(gone).anchored, 'no');
    assert.match(panel(gone).text, /Not found in this version/);
    assert.match(panel(gone).text, /a sentence that is gone/);
    assert.equal(panel(general).anchored, 'none');
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
    const countBefore = evaluate(`document.getElementById('commentCount').textContent`);
    press('#showCommentMarkers');
    settle();
    assert.equal(evaluate(`document.getElementById('showCommentMarkers').getAttribute('aria-checked')`), 'false');
    assert.equal((await pins()).length, 0, 'hidden markers are not visible or focusable');
    assert.equal(panel(heading).anchored, 'yes', 'hiding markers preserves anchor resolution');
    press(`#threadList .thread[data-label="${heading}"] > summary`);
    assert.equal(panel(heading).focus, true, 'threads still open while markers are hidden');
    assert.equal((await pins()).length, 0, 'opening a thread does not restore markers');
    run('click', '#commentsBtn');
    assert.equal(evaluate(`getComputedStyle(document.getElementById('commentsBtn')).backgroundColor`), 'rgba(0, 0, 0, 0)', 'open Comments has no filled active highlight');
    assert.equal(evaluate(`getComputedStyle(document.getElementById('commentCount')).position`), 'static', 'count is inline, not a badge');
    assert.equal(evaluate(`document.getElementById('commentCount').textContent`), countBefore);
    evaluate(`document.documentElement.dataset.theme = 'dark'`);
    settle();
    assert.equal((await pins()).length, 0, 'theme redraw retains hidden markers');
    press('#placeComment');
    assert.equal(evaluate(`document.getElementById('showCommentMarkers').getAttribute('aria-checked')`), 'true', 'placement restores markers');
    settle();
    assert.equal((await pins()).length, drawn.length);
    press('#cancelPlacement');

    // What the page is told: anchors, numbers, resolved flags and colours; no ticket text, no token.
    await inFrame(`(window.__told = [], addEventListener('message', e => { if (e.data && e.data.__artifactPins === 1) window.__told.push(e.data); }), true)`);
    evaluate(`document.documentElement.dataset.theme = 'dark'`); // a theme change sends the pins again
    run('wait', '--fn', `document.documentElement.dataset.theme === 'dark'`);
    evaluate(`document.documentElement.dataset.theme = 'light'`);
    settle();
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
    evaluate(`window.postMessage(${JSON.stringify(forged)}, '*')`);
    await inFrame(`new Promise(r => { const f = document.createElement('iframe'); f.id = 'nested'; f.srcdoc = '<p>nested</p>'; f.onload = r; document.body.append(f); })`);
    await inFrame(`(parent.parent.postMessage(${JSON.stringify(forged)}, '*'),
      parent.parent.postMessage({ __artifactPins: 1, type: 'placed', keys: [] }, '*'),
      parent.parent.postMessage({ __artifactPins: 1, type: 'open', key: ${gone} }, '*'), true)`, f => f.url === 'about:srcdoc');
    settle();
    assert.ok(!evaluate(`document.getElementById('commentAnchor').textContent`).includes('FORGED'));
    assert.equal(panel(heading).anchored, 'yes', 'a forged placement changes nothing');
    assert.equal(panel(gone).focus, false, 'a forged pin click opens nothing');
    await inFrame(`(document.getElementById('nested').remove(), parent.postMessage({ __artifactPins: 1, type: 'selection', anchor: 'FROM THE PAGE' }, '*'), true)`);
    run('wait', '--fn', `document.getElementById('commentAnchor').textContent.includes('FROM THE PAGE')`);
    run('click', '#generalComment');
    run('click', '#anchorClear');
    run('click', '#cancelComment');
    run('click', '#commentsBtn');
    wait('#threadPanel .thread');

    // A page sending pin clicks never takes focus from a reply being written.
    press(`#threadPanel .thread[data-label="${general}"] summary`);
    press(`#threadPanel .thread[data-label="${general}"] .reply textarea`);
    run('keyboard', 'type', 'half a reply');
    const typingBefore = evaluate(`({ active: document.activeElement.tagName, value: document.activeElement.value, mode: document.getElementById('threadPanel').dataset.mode, focused: document.querySelector('#threadPanel .thread.focus')?.dataset.label })`);
    assert.equal(typingBefore.value, 'half a reply', JSON.stringify(typingBefore));
    await inFrame(`(parent.postMessage({ __artifactPins: 1, type: 'open', key: ${gone} }, '*'), parent.postMessage({ __artifactPins: 1, type: 'open', key: ${gone} }, '*'), parent.postMessage({ __artifactPins: 1, type: 'cancel' }, '*'), true)`);
    settle();
    assert.equal(evaluate(`(() => { const t = document.activeElement; return t.matches('#threadPanel .thread[data-label="${general}"] .reply textarea') && t.value; })()`), 'half a reply', JSON.stringify(evaluate(`({ active: document.activeElement.tagName, value: document.activeElement.value, mode: document.getElementById('threadPanel').dataset.mode, focused: document.querySelector('#threadPanel .thread.focus')?.dataset.label })`)));
    assert.equal(panel(gone).focus, false, 'a page message cannot replace the thread being written');
    evaluate(`(() => { const t = document.activeElement; t.value = ''; t.dispatchEvent(new Event('input')); t.blur(); })()`);

    // Untrusted text, titles, anchors and authors render as text, in the panel and the page.
    assert.equal(evaluate('window.__xss ?? null'), null);
    assert.equal(await inFrame('window.__xss ?? null'), null);
    assert.equal(evaluate('document.querySelectorAll("#threadPanel img, #threadPanel script").length'), 0);
    assert.ok(panel(xss).text.includes(XSS.text.split('\n')[1]), 'the payload shows as text');
    assert.equal(panel(xss).anchored, 'no', 'an anchor that is not on the page');
    assert.ok(panel(xss).text.includes(XSS.anchor), 'the anchor shows as text');
    if (a.authorXss) assert.ok(evaluate('document.getElementById("threadPanel").textContent').includes(XSS.author), 'the author shows as text');

    // The reply that names a check-in links that version.
    assert.deepEqual(panel(heading).checkins, [`#${a.comment}@${a.tip.slice(0, 12)}`]);

    // A pin, hit with the mouse, opens its thread in the panel.
    run('click', '#threadClose');
    await clickPin(fox);
    wait(`#threadPanel .thread.focus[data-label="${fox}"]`);
    assert.equal(panel(fox).open, true);
    run('screenshot', join(output, 'comment-link-desktop-light.png'));

    // Reply, resolve and reopen through the panel.
    const thread = `#threadPanel .thread[data-label="${fox}"]`;
    run('fill', `${thread} .reply textarea`, 'Agreed, shortened.');
    // Hold the real request at the network boundary to exercise pending replies.
    evaluate(`(() => { const fetch = window.fetch; window.fetch = (...args) => args[1]?.method === 'POST' && String(args[0]).endsWith('/tickets') ? new Promise(resolve => { window.__releaseReply = () => { window.fetch = fetch; resolve(fetch(...args)); }; }) : fetch(...args); })()`);
    press(`${thread} .reply button[type=submit]`);
    run('wait', '--fn', `typeof window.__releaseReply === 'function'`);
    await inFrame(`(parent.postMessage({ __artifactPins: 1, type: 'open', key: ${gone} }, '*'), parent.postMessage({ __artifactPins: 1, type: 'dismiss' }, '*'), true)`);
    settle();
    assert.equal(evaluate(`!document.getElementById('threadPanel').hidden && document.querySelector('#threadPanel .thread.focus')?.dataset.label`), fox, 'page messages cannot replace or hide a pending reply');
    evaluate(`(window.__releaseReply(), delete window.__releaseReply, true)`);
    run('wait', '--fn', `[...document.querySelectorAll('#threadPanel .thread .message')].some(m => m.textContent === 'Agreed, shortened.')`);
    let t = await byTitle('About the fox');
    assert.equal(t.changes.at(-1).comment, 'Agreed, shortened.');
    assert.equal(t.changes.at(-1).user, 'comment-link');
    const foxNow = labelOf('About the fox');
    press(`#threadPanel .thread[data-label="${foxNow}"] .resolve`);
    run('wait', '--fn', `document.querySelector('#threadPanel .thread.resolved summary .title')?.textContent === 'About the fox'`);
    assert.equal((await byTitle('About the fox')).status, 'Closed');
    const resolvedLabel = labelOf('About the fox');
    assert.equal(panel(resolvedLabel).open, false, 'resolved threads are collapsed');
    assert.equal(panel(resolvedLabel).resolve, 'Reopen');
    settle();
    assert.equal((await pins()).find(p => p.label === resolvedLabel)?.resolved, true, 'the pin shows it resolved');
    press(`#threadPanel .thread[data-label="${resolvedLabel}"] summary`);
    press(`#threadPanel .thread[data-label="${resolvedLabel}"] .resolve`);
    run('wait', '--fn', `!document.querySelector('#threadPanel .thread.resolved')`);
    assert.equal((await byTitle('About the fox')).status, 'Open');

    // A new comment on selected text anchors to the quote and gets a pin.
    run('click', '#commentsBtn');
    await inFrame(`(() => {
      const t = document.querySelector('p').lastChild;
      const r = document.createRange(); r.setStart(t, t.data.indexOf('lazy')); r.setEnd(t, t.data.indexOf('dog') + 3);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    })()`);
    run('wait', '--fn', `document.getElementById('commentAnchor').textContent.includes('lazy dog')`);
    press('#generalComment');
    run('fill', '#commentText', 'Which dog?');
    run('click', '#commentForm button[type=submit]');
    run('wait', '--fn', `[...document.querySelectorAll('#threadPanel .thread summary .title')].some(e => e.textContent === 'Which dog?')`);
    assert.equal((await byTitle('Which dog?')).fields.subsystem, 'lazy dog');
    settle();
    const dog = labelOf('Which dog?');
    assert.equal(panel(dog).anchored, 'yes');
    assert.ok((await pins()).some(p => p.label === dog));

    // Explicit placement accepts blank space; writing and reopening use real tickets.
    const frameBox = () => evaluate(`(() => { const r = document.getElementById('frame').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
    const mouseAt = (x, y) => {
      const f = frameBox();
      run('mouse', 'move', String(Math.round(f.x + x)), String(Math.round(f.y + y)));
      run('mouse', 'down'); run('mouse', 'up');
    };
    press('#placeComment');
    wait('#placementHint:not([hidden])');
    mouseAt(1000, 280);
    wait('#threadPanel[data-mode="draft"]:not([hidden])');
    run('fill', '#commentText', 'Comment in blank space');
    run('press', 'Escape');
    run('click', '#commentsBtn');
    assert.equal(evaluate(`document.getElementById('placeComment').textContent`), 'Continue draft');
    press('#placeComment');
    assert.equal(evaluate(`document.getElementById('commentText').value`), 'Comment in blank space', 'closing preserves a draft');
    run('click', '#commentForm button[type=submit]');
    run('wait', '--fn', `document.getElementById('threadPanel').dataset.mode === 'thread'`);
    const blank = await byTitle('Comment in blank space');
    assert.ok(blank.fields.subsystem.startsWith('hap-point:'), 'a real location anchor is persisted');
    let blankLabel = labelOf('Comment in blank space');
    settle();
    assert.equal(panel(blankLabel).anchored, 'yes');
    assert.ok((await pins()).some(p => p.label === blankLabel), 'a marker remains at the posted location');
    const popover = evaluate(`(() => { const r = document.getElementById('threadPanel').getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom }; })()`);
    assert.ok(popover.x > 500 && popover.right <= 1280 && popover.y >= 45 && popover.bottom <= 900, JSON.stringify(popover));
    run('click', '#threadClose');
    await clickPin(blankLabel);
    wait('#threadPanel[data-mode="thread"]:not([hidden])');
    assert.ok(panel(blankLabel).text.includes('Comment in blank space'));
    run('reload');
    wait('#bar:not([hidden])');
    run('click', '#commentsBtn');
    run('wait', '--fn', `[...document.querySelectorAll('#threadPanel summary .title')].some(e => e.textContent === 'Comment in blank space')`);
    blankLabel = labelOf('Comment in blank space');
    settle();
    assert.ok((await pins()).some(p => p.label === blankLabel), 'the marker survives reload');

    // Page messages alone cannot start placement, and explicit cancel clears drafts.
    const beforePoint = (await tickets()).length;
    await inFrame(`(parent.postMessage({ __artifactPins: 1, type: 'point', anchor: ${JSON.stringify(blank.fields.subsystem)}, x: 20, y: 20 }, '*'), true)`);
    settle();
    assert.equal(evaluate(`document.getElementById('threadPanel').dataset.mode`), 'index');
    assert.equal((await tickets()).length, beforePoint);
    press('#placeComment');
    run('press', 'Enter');
    wait('#threadPanel[data-mode="draft"]:not([hidden])');
    run('fill', '#commentText', 'Discard this draft');
    run('click', '#cancelComment');
    run('click', '#commentsBtn');
    assert.equal(evaluate(`document.getElementById('commentText').value`), '');
    assert.equal((await tickets()).length, beforePoint);

    // An element location follows reflow, rather than staying at a viewport pixel.
    press('#placeComment');
    const headingBox = await inFrame(`(() => { const r = document.getElementById('intro').getBoundingClientRect(); return { x: r.left + 45, y: r.top + 12 }; })()`);
    mouseAt(headingBox.x, headingBox.y);
    wait('#threadPanel[data-mode="draft"]:not([hidden])');
    run('fill', '#commentText', 'Location on heading');
    run('click', '#commentForm button[type=submit]');
    run('wait', '--fn', `document.getElementById('threadPanel').dataset.mode === 'thread'`);
    const located = await byTitle('Location on heading');
    assert.equal(JSON.parse(located.fields.subsystem.slice('hap-point:'.length)).id, 'intro');
    const locatedLabel = labelOf('Location on heading');
    settle();
    const beforeMove = (await pins()).find(p => p.label === locatedLabel);
    await inFrame(`(document.getElementById('intro').style.marginTop = '220px', true)`);
    settle();
    const afterMove = (await pins()).find(p => p.label === locatedLabel);
    assert.ok(afterMove.y - beforeMove.y > 100, JSON.stringify({ beforeMove, afterMove }));
    await inFrame(`(document.getElementById('intro').style.marginTop = '', true)`);
    run('click', '#commentsBtn');

    // Dark theme: the panel follows the viewer's tokens.
    evaluate(`document.documentElement.dataset.theme = 'dark'`);
    const dark = evaluate(`(() => { const s = getComputedStyle(document.getElementById('threadPanel')); return { bg: s.backgroundColor, ink: s.color }; })()`);
    assert.equal(dark.bg, 'rgb(35, 35, 33)', 'surface token, dark');
    assert.equal(dark.ink, 'rgb(237, 235, 230)', 'ink token, dark');
    run('screenshot', join(output, 'comment-link-desktop-dark.png'));
    evaluate(`document.documentElement.dataset.theme = 'light'`);

    // Phone width: comments stay in a bounded dropdown, pins still hit.
    run('set', 'viewport', '390', '844');
    settle();
    const dropdown = evaluate(`(() => { const p = document.getElementById('threadPanel'); const s = getComputedStyle(p); const r = p.getBoundingClientRect();
      return { position: s.position, top: r.top, bottom: r.bottom, width: r.width, overflow: document.documentElement.scrollWidth > innerWidth, toolbar: document.getElementById('bar').offsetHeight }; })()`);
    assert.equal(dropdown.position, 'absolute', JSON.stringify(dropdown));
    assert.ok(dropdown.top >= 45 && dropdown.bottom <= 844 && dropdown.width <= 390 && !dropdown.overflow && dropdown.toolbar === 45, JSON.stringify(dropdown));
    run('screenshot', join(output, 'comment-link-phone-dropdown.png'));
    run('click', '#threadClose');
    settle();
    const headingNow = labelOf('About the heading'); // labels moved: new threads come first
    await clickPin(headingNow);
    wait(`#threadPanel .thread.focus[data-label="${headingNow}"]`);
    run('screenshot', join(output, 'comment-link-phone-pin.png'));

    // A reply from another client appears in the open thread, even while typing.
    press('#threadPanel .thread.focus .reply textarea');
    run('keyboard', 'type', 'Keep this unfinished reply');
    evaluate(`(() => { const t = document.activeElement; window.__draft = t; t.setSelectionRange(5, 9); })()`);
    const remoteThread = await byTitle('About the heading');
    const remote = await api(`/api/artifacts/${a.id}/tickets`, {
      method: 'POST', token: a.write, body: { ticketUuid: remoteThread.uuid, text: 'A live reply from another client.' },
    });
    assert.equal(remote.status, 200, remote.text);
    assert.equal((await api(`/api/artifacts/${a.id}`, { token: a.read })).json.tip, a.tip, 'comments do not publish a version');
    run('wait', '--fn', `document.querySelector('#threadPanel .thread.focus')?.textContent.includes('A live reply from another client.')`);
    assert.deepEqual(evaluate(`(() => { const t = document.activeElement; return { same: t === window.__draft, value: t.value, start: t.selectionStart, end: t.selectionEnd, mode: document.getElementById('threadPanel').dataset.mode }; })()`),
      { same: true, value: 'Keep this unfinished reply', start: 5, end: 9, mode: 'thread' }, 'live replies preserve the active draft and selection');
    run('screenshot', join(output, 'comment-live-reply-with-draft.png'));
    for (const status of ['Closed', 'Open']) {
      await new Promise(resolve => setImmediate(resolve));
      const changed = await api(`/api/artifacts/${a.id}/tickets`, {
        method: 'POST', token: a.write, body: { ticketUuid: remoteThread.uuid, status },
      });
      assert.equal(changed.status, 200, changed.text);
      run('wait', '--fn', `document.querySelector('#threadPanel .thread.focus summary .tag')?.textContent === ${JSON.stringify(status)}`);
      assert.deepEqual(evaluate(`(() => { const t = document.activeElement, view = document.querySelector('#threadPanel .thread.focus'); return { open: view.open, same: t === window.__draft, value: t.value, start: t.selectionStart, end: t.selectionEnd, action: view.querySelector('.resolve').textContent }; })()`),
        { open: true, same: true, value: 'Keep this unfinished reply', start: 5, end: 9, action: status === 'Closed' ? 'Reopen' : 'Resolve' }, 'remote status changes do not collapse an active draft');
    }

    // ── The read link: threads and pins, no comment box, reply or resolve ──
    run('set', 'viewport', '1280', '900');
    run('open', `${base}/v/${a.id}#${a.read}`);
    wait('#bar:not([hidden])');
    run('click', '#titleBtn');
    download('#downloadFilesBtn');
    assert.equal(evaluate(`document.getElementById('titleMenu').hidden`), true, 'downloading closes artifact details');
    run('click', '#commentsBtn');
    wait('#threadPanel .thread');
    settle();
    const readOnly = evaluate(`({ form: document.getElementById('commentForm').hidden, replies: document.querySelectorAll('#threadPanel .reply').length,
      resolves: document.querySelectorAll('#threadPanel .resolve').length, threads: document.querySelectorAll('#threadPanel .thread').length,
      note: document.getElementById('commentsNote').textContent })`);
    assert.deepEqual({ ...readOnly, threads: readOnly.threads > 0 }, { form: true, replies: 0, resolves: 0, threads: true, note: 'Read only' });
    assert.ok((await pins()).length >= 3, 'readers see the pins');
    press('#showCommentMarkers');
    settle();
    assert.equal((await pins()).length, 0, 'read-only viewers can hide markers');
    assert.equal(evaluate(`document.getElementById('commentForm').hidden`), true, 'visibility does not grant commenting');
    press('#showCommentMarkers');
    settle();
    assert.ok((await pins()).length >= 3, 'read-only viewers can restore markers');
    const cue = evaluate(`(() => { const c = document.getElementById('readCue'), f = document.getElementById('frame'); return { visible: !c.hidden, clear: c.getBoundingClientRect().bottom <= f.getBoundingClientRect().top, placeHidden: document.getElementById('placeComment').hidden, sandbox: f.getAttribute('sandbox') }; })()`);
    assert.ok(cue.visible && cue.clear && cue.placeHidden && !cue.sandbox.includes('allow-same-origin'), JSON.stringify(cue));
    await inFrame(`(parent.postMessage({ __artifactPins: 1, type: 'point', anchor: ${JSON.stringify(blank.fields.subsystem)}, x: 20, y: 20 }, '*'), true)`);
    settle();
    assert.equal(evaluate(`document.getElementById('threadPanel').dataset.mode`), 'index', 'a read link cannot be made a composer by page messages');
    run('set', 'viewport', '360', '780');
    assert.equal(evaluate(`document.getElementById('bar').offsetHeight === 45 && document.documentElement.scrollWidth <= innerWidth`), true, 'long title remains one row at 360px');
    run('set', 'viewport', '1280', '900');
    run('screenshot', join(output, 'read-link-desktop.png'));

    // ── The responder banner above the threads: from attached.json, no republish ──
    const banner = () => evaluate(`(() => { const n = document.getElementById('responderNote'); return { attached: n.dataset.attached, text: n.textContent.trim().replace(/\\s+/g, ' '), kids: n.querySelectorAll('*:not(strong):not(span)').length }; })()`);
    assert.deepEqual(banner(), { attached: 'false', text: 'No responder is registered. Comments remain available for later review.', kids: 0 });
    if (attach) {
      attach(JSON.stringify({ responder: XSS.text.split('\n')[0], contact: XSS.author }));
      run('reload');
      wait('#bar:not([hidden])');
      run('click', '#commentsBtn');
      wait('#responderNote[data-attached="true"]');
      assert.deepEqual(banner(), { attached: 'true', text: `A responder is registered. Registration does not verify that it is online. ${XSS.text.split('\n')[0]} (${XSS.author})`, kids: 0 });
      assert.deepEqual(evaluate('[window.__xss]'), [null], 'markup in the file never ran');
      run('screenshot', join(output, 'responder-attached.png'));
      attach(null);
      run('reload');
      wait('#bar:not([hidden])');
      run('click', '#commentsBtn');
      wait('#responderNote[data-attached="false"]');
    }
    // Editors keep management in the title dropdown and can restore old versions.
    const update = await api(`/api/artifacts/${a.id}`, { method: 'PUT', token: a.write, body: { parent: a.tip, message: 'Toolbar version check', files: { 'version.txt': Buffer.from('second version').toString('base64') } } });
    assert.equal(update.status, 200);
    run('set', 'viewport', '360', '780');
    run('open', `${base}/v/${a.id}#${a.write}@${a.tip}`);
    wait('#bar:not([hidden])');
    wait('#oldStrip:not([hidden])');
    assert.equal(evaluate(`document.getElementById('oldStrip').offsetHeight`), 26);
    assert.equal(evaluate(`document.getElementById('restoreBtn').hidden`), false);
    assert.equal(evaluate(`document.getElementById('readCue').hidden`), true);
    run('click', '#titleBtn');
    assert.equal(evaluate(`['uploadFilesBtn','uploadFolderBtn','deleteBtn'].every(id => !document.getElementById(id).hidden && document.getElementById('titleMenu').contains(document.getElementById(id)))`), true);
    assert.equal(evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
    run('screenshot', join(output, 'edit-link-phone-old-version.png'));
    assert.equal(download('#downloadFilesBtn').includes(Buffer.from('version.txt')), false, 'artifact details downloads the selected old version, not the latest');
    run('click', '#backLatest');
    run('wait', '--fn', `document.getElementById('oldStrip').hidden`);
    run('click', '#titleBtn');
    assert.ok(download('#downloadFilesBtn').includes(Buffer.from('version.txt')), 'artifact details downloads files added in the latest version');
    run('click', '#shareBtn');
    // Replacing the comment link takes two clicks and cuts off the old one.
    const leaked = evaluate(`document.getElementById('commentLink').value.split('#')[1]`);
    press('#shareRows .renew');
    assert.equal(evaluate(`document.getElementById('commentLink').value.split('#')[1]`), leaked, 'one click only asks');
    press('#shareRows .renew');
    run('wait', '--fn', `document.getElementById('commentLink')?.value.split('#')[1] !== ${JSON.stringify(leaked)}`);
    const renewed = evaluate(`document.getElementById('commentLink').value.split('#')[1]`);
    assert.equal((await api(`/api/artifacts/${a.id}`, { token: leaked })).status, 404, 'the old comment link stops working');
    assert.equal((await api(`/api/artifacts/${a.id}`, { token: renewed })).json.role, 'comment');
    run('click', '#exportTab');
    assert.ok(download('#downloadBtn').includes(Buffer.from('version.txt')), 'Share export retains its download action');
    run('click', '#moreBtn');
    run('select', '#viewer-theme', 'dark');
    assert.equal(evaluate(`document.documentElement.dataset.theme`), 'dark');
    run('select', '#viewer-theme', 'light');
    assert.equal(evaluate(`document.documentElement.dataset.theme`), 'light');
    run('select', '#viewer-theme', 'system');
    assert.equal(evaluate(`document.documentElement.hasAttribute('data-theme')`), false);
    return { output };
  } catch (error) {
    failure = error;
    try {
      run('screenshot', join(output, 'failure.png'));
      console.error(run('--json', 'eval', `({ top: window === top, protocol: location.protocol, title: document.title, viewer: !!document.getElementById('bar'), panel: document.getElementById('threadPanel')?.hidden, threads: document.querySelectorAll('.thread').length, errors: window.__qaErrors })`));
    } catch { /* preserve the original failure if the browser stopped responding */ }
    throw error;
  } finally {
    page?.close();
    try { run('close'); } catch (error) { if (!failure) throw error; }
  }
}
