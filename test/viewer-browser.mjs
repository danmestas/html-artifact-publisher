// Opt-in real Chromium QA for the viewer's comment pins and thread panel,
// invoked by VIEWER_BROWSER_QA=1 node --test test/e2e.test.mjs. Requires the
// agent-browser executable. The e2e suite owns the Wrangler lifecycle and the
// fixture artifact; this drives the viewer as each link holder would.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
  const session = 'viewer-comments-qa';
  const run = (...args) => {
    try {
      return execFileSync('agent-browser', ['--session', session, ...args], {
        encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '60000' },
      });
    } catch (e) {
      throw new Error(`agent-browser ${args.join(' ')}: ${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 2000));
    }
  };
  const evaluate = source => {
    const result = JSON.parse(run('--json', 'eval', source));
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data.result;
  };
  const wait = selector => run('wait', selector);
  // agent-browser does not scroll the panel, an inner scroller, to what it clicks.
  const press = selector => {
    evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
    run('click', selector);
  };
  const tickets = async () => (await api(`/api/artifacts/${a.id}/tickets`, { token: a.read })).json.tickets;
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
  const settle = () => run('wait', '400');

  try {
    // ── The comment link: pins, panel, reply, resolve, reopen, new anchored comment ──
    run('set', 'viewport', '1280', '900');
    run('open', `${base}/v/${a.id}#${a.comment}`);
    wait('#bar:not([hidden])');
    evaluate(`document.documentElement.dataset.theme = 'light'`);
    run('click', '#commentsBtn');
    wait('#threadPanel:not([hidden])');
    wait('#threadPanel .thread[data-anchored="no"]');
    settle();

    const heading = labelOf('About the heading');
    const fox = labelOf('About the fox');
    const gone = labelOf('Where did it go');
    const xss = labelOf(XSS.text.split('\n')[0].trim());
    const general = labelOf('No anchor at all');
    assert.ok(heading && fox && gone && xss && general, 'every thread is listed');

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

    // What the page is told: anchors, numbers, resolved flags and colours; no ticket text, no token.
    await inFrame(`(window.__told = [], addEventListener('message', e => { if (e.data && e.data.__artifactPins === 1) window.__told.push(e.data); }), true)`);
    evaluate(`document.documentElement.dataset.theme = 'dark'`); // a theme change sends the pins again
    run('wait', '--fn', `document.documentElement.dataset.theme === 'dark'`);
    evaluate(`document.documentElement.dataset.theme = 'light'`);
    settle();
    const told = await inFrame('window.__told');
    assert.ok(told.length >= 2, JSON.stringify(told));
    for (const m of told) {
      assert.deepEqual(Object.keys(m).sort(), ['__artifactPins', 'colors', 'pins', 'type'], JSON.stringify(m));
      assert.equal(m.type, 'pins');
      assert.deepEqual(Object.keys(m.colors).sort(), ['accent', 'muted', 'surface']);
      assert.ok(Object.values(m.colors).every(c => /^#[0-9A-Fa-f]{6}$/.test(c)), JSON.stringify(m.colors));
      for (const pin of m.pins) {
        assert.deepEqual(Object.keys(pin).sort(), ['anchor', 'key', 'resolved']);
        assert.ok(Number.isInteger(pin.key) && typeof pin.anchor === 'string' && typeof pin.resolved === 'boolean');
      }
      const raw = JSON.stringify(m);
      for (const secret of [a.read, a.write, a.comment, 'About the fox', 'first line', 'Shortened in']) assert.ok(!raw.includes(secret), `the page is not told ${secret.slice(0, 12)}`);
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
    run('click', '#anchorClear');

    // A page sending pin clicks never takes focus from a reply being written.
    press(`#threadPanel .thread[data-label="${general}"] .reply textarea`);
    run('keyboard', 'type', 'half a reply');
    await inFrame(`(parent.postMessage({ __artifactPins: 1, type: 'open', key: ${gone} }, '*'), parent.postMessage({ __artifactPins: 1, type: 'open', key: ${gone} }, '*'), true)`);
    settle();
    assert.equal(evaluate(`(() => { const t = document.activeElement; return t.matches('#threadPanel .thread[data-label="${general}"] .reply textarea') && t.value; })()`), 'half a reply');
    assert.equal(panel(gone).focus, true, 'the pin still marks its thread');
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
    press(`${thread} .reply button[type=submit]`);
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
    await inFrame(`(() => {
      const t = document.querySelector('p').lastChild;
      const r = document.createRange(); r.setStart(t, t.data.indexOf('lazy')); r.setEnd(t, t.data.indexOf('dog') + 3);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    })()`);
    run('wait', '--fn', `document.getElementById('commentAnchor').textContent.includes('lazy dog')`);
    run('fill', '#commentText', 'Which dog?');
    run('click', '#commentForm button[type=submit]');
    run('wait', '--fn', `[...document.querySelectorAll('#threadPanel .thread summary .title')].some(e => e.textContent === 'Which dog?')`);
    assert.equal((await byTitle('Which dog?')).fields.subsystem, 'lazy dog');
    settle();
    const dog = labelOf('Which dog?');
    assert.equal(panel(dog).anchored, 'yes');
    assert.ok((await pins()).some(p => p.label === dog));

    // Dark theme: the panel follows the viewer's tokens.
    evaluate(`document.documentElement.dataset.theme = 'dark'`);
    const dark = evaluate(`(() => { const s = getComputedStyle(document.getElementById('threadPanel')); return { bg: s.backgroundColor, ink: s.color }; })()`);
    assert.equal(dark.bg, 'rgb(35, 35, 33)', 'surface token, dark');
    assert.equal(dark.ink, 'rgb(237, 235, 230)', 'ink token, dark');
    run('screenshot', join(output, 'comment-link-desktop-dark.png'));
    evaluate(`document.documentElement.dataset.theme = 'light'`);

    // Phone width: the panel is a sheet, nothing overflows, pins still hit.
    run('set', 'viewport', '390', '844');
    settle();
    const sheet = evaluate(`(() => { const p = document.getElementById('threadPanel'); const s = getComputedStyle(p); const r = p.getBoundingClientRect();
      return { position: s.position, bottom: Math.round(innerHeight - r.bottom), width: Math.round(r.width), overflow: document.documentElement.scrollWidth > innerWidth }; })()`);
    assert.equal(sheet.position, 'fixed', JSON.stringify(sheet));
    assert.ok(sheet.bottom >= 0 && sheet.bottom <= 16 && sheet.width <= 390 && !sheet.overflow, JSON.stringify(sheet));
    run('screenshot', join(output, 'comment-link-phone-sheet.png'));
    run('click', '#threadClose');
    settle();
    const headingNow = labelOf('About the heading'); // labels moved: new threads come first
    await clickPin(headingNow);
    wait(`#threadPanel .thread.focus[data-label="${headingNow}"]`);
    run('screenshot', join(output, 'comment-link-phone-pin.png'));

    // ── The read link: threads and pins, no comment box, reply or resolve ──
    run('set', 'viewport', '1280', '900');
    run('open', `${base}/v/${a.id}#${a.read}`);
    wait('#bar:not([hidden])');
    run('click', '#commentsBtn');
    wait('#threadPanel .thread');
    settle();
    const readOnly = evaluate(`({ form: document.getElementById('commentForm').hidden, replies: document.querySelectorAll('#threadPanel .reply').length,
      resolves: document.querySelectorAll('#threadPanel .resolve').length, threads: document.querySelectorAll('#threadPanel .thread').length,
      note: document.getElementById('commentsNote').textContent })`);
    assert.deepEqual({ ...readOnly, threads: readOnly.threads > 0 }, { form: true, replies: 0, resolves: 0, threads: true, note: 'Read only' });
    assert.ok((await pins()).length >= 3, 'readers see the pins');
    run('screenshot', join(output, 'read-link-desktop.png'));

    // ── The responder banner above the threads: from attached.json, no republish ──
    const banner = () => evaluate(`(() => { const n = document.getElementById('responderNote'); return { attached: n.dataset.attached, text: n.textContent.trim().replace(/\\s+/g, ' '), kids: n.querySelectorAll('*:not(strong):not(span)').length }; })()`);
    assert.deepEqual(banner(), { attached: 'false', text: 'Comments are recorded; nothing is listening right now', kids: 0 });
    if (attach) {
      attach(JSON.stringify({ responder: XSS.text.split('\n')[0], contact: XSS.author }));
      run('reload');
      wait('#bar:not([hidden])');
      run('click', '#commentsBtn');
      wait('#responderNote[data-attached="true"]');
      assert.deepEqual(banner(), { attached: 'true', text: `A responder is attached ${XSS.text.split('\n')[0]} (${XSS.author})`, kids: 0 });
      assert.deepEqual(evaluate('[window.__xss]'), [null], 'markup in the file never ran');
      run('screenshot', join(output, 'responder-attached.png'));
      attach(null);
      run('reload');
      wait('#bar:not([hidden])');
      run('click', '#commentsBtn');
      wait('#responderNote[data-attached="false"]');
    }
    return { output };
  } finally {
    page?.close();
    run('close');
  }
}
