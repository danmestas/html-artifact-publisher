// page-pins.js — comment pins, drawn inside the sandboxed page. viewer.js
// injects pagePins as source, after the window.artifact bridge, with findQuotes
// and anchorFor from comments.js as its arguments, so it uses nothing else.
//
// The viewer sends only what a pin needs: each anchored thread's label, its
// anchor and whether it is resolved, and the viewer's colours. No ticket text
// and no token enter the page. The page answers with the labels it placed,
// asks the viewer to open a thread when a pin is clicked, and reports the
// reader's selection as an anchor for a new comment.
//
// An anchor is an element id, found with getElementById, else a quote of the
// page's text; it is never used as a selector or as markup.

export function pagePins(findQuotes, anchorFor) {
  const PIN = 28;
  const MAX_PINS = 500, MAX_ANCHOR = 500; // the ticket route's anchor limit
  const SETTLE_MS = 250, EVERY_MS = 1000;  // re-find anchors after a change, at most once a second
  let wanted = [];     // [{ key, anchor, resolved }] from the viewer
  let colors = {};
  let targets = [];    // [{ pin, node, box, el }]: box() is the anchor's viewport rectangle
  let host = null, root = null, placed = '', selected = '', frame = 0, relocating = 0, relocated = 0;

  const send = message => parent.postMessage({ __artifactPins: 1, ...message }, '*');

  function textNodes() {
    const skip = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA)$/;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement && skip.test(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    return nodes;
  }

  /**
   * Each wanted anchor's element and rectangle, or nothing when it is not on
   * this page: ids first, then every quote against the page's text, collapsed once.
   */
  function locateAll() {
    const found = new Map();
    const quotes = [];
    for (const pin of wanted) {
      const el = document.getElementById(pin.anchor);
      if (el) found.set(pin, { node: el, box: () => el.getBoundingClientRect() });
      else quotes.push(pin);
    }
    if (quotes.length) {
      const nodes = textNodes();
      findQuotes(nodes.map(n => n.data), quotes.map(p => p.anchor)).forEach((hit, i) => {
        if (!hit) return;
        const range = document.createRange();
        range.setStart(nodes[hit.start[0]], hit.start[1]);
        range.setEnd(nodes[hit.end[0]], hit.end[1]);
        found.set(quotes[i], { node: nodes[hit.start[0]].parentElement, box: () => range.getClientRects()[0] || range.getBoundingClientRect() });
      });
    }
    return found;
  }

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('data-artifact-pins', '');
    Object.assign(host.style, { position: 'fixed', top: '0', left: '0', width: '0', height: '0', overflow: 'visible', zIndex: '2147483647' });
    root = host.attachShadow({ mode: 'open' });
    document.documentElement.append(host);
  }

  function button(pin) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = String(pin.key);
    b.dataset.resolved = String(pin.resolved);
    b.setAttribute('aria-label', `Comment ${pin.key}${pin.resolved ? ', resolved' : ''}`);
    Object.assign(b.style, {
      position: 'absolute', width: `${PIN}px`, height: `${PIN}px`, margin: '0', padding: '0', cursor: 'pointer',
      display: 'grid', placeItems: 'center', boxSizing: 'border-box', borderRadius: '50% 50% 50% 4px',
      border: `2px solid ${colors.surface || '#FFFFFF'}`, background: pin.resolved ? colors.muted || '#5F5E5A' : colors.accent || '#8F430B',
      color: colors.surface || '#FFFFFF', font: '600 12px/1 system-ui, sans-serif', boxShadow: '0 2px 6px rgba(0, 0, 0, 0.3)',
      opacity: pin.resolved ? '0.8' : '1',
    });
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); send({ type: 'open', key: pin.key }); });
    return b;
  }

  // Find every anchor again (after new threads or a change to the page), then draw.
  function relocate() {
    relocated = Date.now();
    const found = locateAll();
    targets = wanted.filter(pin => found.has(pin)).map(pin => ({ pin, ...found.get(pin), el: null }));
    ensureHost();
    root.replaceChildren(...targets.map(t => (t.el = button(t.pin))));
    draw();
  }

  // A pin's tail (its square corner) sits on its anchor's top-left corner,
  // the pin above the text, in viewport coordinates, so it follows the page
  // and any inner scroller. An anchor with no box (a hidden element) is not placed.
  function draw() {
    frame = 0;
    const keys = [], seen = new Map();
    for (const t of targets) {
      const r = t.box();
      const shown = r && (r.width > 0 || r.height > 0);
      t.el.style.display = shown ? 'grid' : 'none';
      if (!shown) continue;
      keys.push(t.pin.key);
      const spot = `${Math.round(r.left)},${Math.round(r.top)}`;
      const stack = seen.get(spot) || 0;
      seen.set(spot, stack + 1);
      const left = Math.min(Math.max(r.left - 2 + stack * (PIN - 4), 2), Math.max(2, innerWidth - PIN - 2));
      t.el.style.left = `${left}px`;
      t.el.style.top = `${Math.max(r.top - PIN + 4, Math.min(r.top, 2))}px`;
    }
    const now = keys.sort((a, b) => a - b).join(',');
    if (now !== placed) { placed = now; send({ type: 'placed', keys }); }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };

  addEventListener('message', e => {
    const d = e.data;
    if (e.source !== parent || !d || d.__artifactPins !== 1) return;
    if (d.type === 'pins' && Array.isArray(d.pins)) {
      wanted = d.pins.filter(p => p && Number.isInteger(p.key) && typeof p.anchor === 'string' && p.anchor && p.anchor.length <= MAX_ANCHOR)
        .slice(0, MAX_PINS).map(p => ({ key: p.key, anchor: p.anchor, resolved: p.resolved === true }));
      colors = d.colors && typeof d.colors === 'object' ? d.colors : {};
      placed = null;
      relocate();
    } else if (d.type === 'reveal') {
      const t = targets.find(x => x.pin.key === d.key);
      if (t && t.node) t.node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  });
  addEventListener('scroll', schedule, true);
  addEventListener('resize', schedule);
  // A page that builds itself with script: find the anchors again once it
  // settles, and no more than once a second however often it changes.
  new MutationObserver(() => {
    clearTimeout(relocating);
    const wait = Math.max(SETTLE_MS, relocated + EVERY_MS - Date.now());
    relocating = setTimeout(() => { if (wanted.length) relocate(); }, wait);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  document.addEventListener('selectionchange', () => {
    const sel = getSelection();
    let anchor = '';
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      let el = sel.getRangeAt(0).commonAncestorContainer;
      if (el.nodeType !== 1) el = el.parentElement;
      const owner = el && el.closest('[id]');
      anchor = anchorFor({ text: sel.toString(), id: owner ? owner.id : '', idText: owner ? owner.textContent : '' });
    }
    if (anchor !== selected) { selected = anchor; send({ type: 'selection', anchor }); }
  });
}
