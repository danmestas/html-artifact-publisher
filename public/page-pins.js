// page-pins.js — pins and explicit point placement inside the sandboxed page.
// All four anchor helpers are injected as source. No ticket text or token
// enters the page, and anchors are never used as selectors or markup.

export function pagePins(findQuotes, anchorFor, encodePointAnchor, decodePointAnchor) {
  const PIN = 28;
  const MAX_PINS = 500, MAX_ANCHOR = 500;
  const SETTLE_MS = 250, EVERY_MS = 1000;
  let wanted = [], colors = {}, targets = [], visible = true;
  let host = null, root = null, highlight = null, placementLayer = null;
  let placed = '', selected = '', frame = 0, relocating = 0, relocated = 0;
  let placing = false, tracked = '', trackedTarget = null;
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

  function pageBox() {
    const el = document.documentElement, body = document.body;
    return { left: -scrollX, top: -scrollY,
      width: Math.max(innerWidth, el.scrollWidth, body ? body.scrollWidth : 0),
      height: Math.max(innerHeight, el.scrollHeight, body ? body.scrollHeight : 0) };
  }

  function elementTarget(el, point) {
    return { node: el, box: () => {
      if (!el.isConnected || !el.getClientRects().length) return null;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return null;
      const r = point && el === document.documentElement ? pageBox() : el.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      return point ? { left: r.left + r.width * point.x, top: r.top + r.height * point.y, width: r.width, height: r.height } : r;
    } };
  }

  function locateAll(pins) {
    const found = new Map(), quotes = [];
    for (const pin of pins) {
      let el = document.getElementById(pin.anchor);
      if (el && el !== host) { found.set(pin, elementTarget(el)); continue; }
      const point = decodePointAnchor(pin.anchor);
      if (point) {
        if (point.id) el = document.getElementById(point.id);
        else {
          el = document.documentElement;
          for (const index of point.path) { el = el && el.children[index]; }
        }
        if (el && el !== host) found.set(pin, elementTarget(el, point));
      } else quotes.push(pin);
    }
    if (quotes.length) {
      const nodes = textNodes();
      findQuotes(nodes.map(n => n.data), quotes.map(p => p.anchor)).forEach((hit, i) => {
        if (!hit) return;
        const range = document.createRange();
        range.setStart(nodes[hit.start[0]], hit.start[1]);
        range.setEnd(nodes[hit.end[0]], hit.end[1]);
        const node = nodes[hit.start[0]].parentElement;
        found.set(quotes[i], { node, box: () => {
          if (!node.isConnected || getComputedStyle(node).visibility === 'hidden') return null;
          return range.getClientRects()[0] || range.getBoundingClientRect();
        } });
      });
    }
    return found;
  }

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('data-artifact-pins', '');
    Object.assign(host.style, { position: 'fixed', top: '0', left: '0', width: '0', height: '0', overflow: 'visible', pointerEvents: 'none', zIndex: '2147483647' });
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
      position: 'absolute', width: `${PIN}px`, height: `${PIN}px`, margin: '0', padding: '0', cursor: 'pointer', pointerEvents: 'auto',
      display: 'grid', placeItems: 'center', boxSizing: 'border-box', borderRadius: '50% 50% 50% 4px',
      border: `2px solid ${colors.surface || '#FFFFFF'}`, background: pin.resolved ? colors.muted || '#5F5E5A' : colors.accent || '#8F430B',
      color: colors.surface || '#FFFFFF', font: '600 12px/1 system-ui, sans-serif', boxShadow: '0 2px 6px rgba(0, 0, 0, 0.3)',
      opacity: pin.resolved ? '0.8' : '1',
    });
    b.addEventListener('click', e => {
      e.preventDefault(); e.stopImmediatePropagation();
      const r = b.getBoundingClientRect();
      send({ type: 'open', key: pin.key, x: r.left, y: r.bottom });
    });
    return b;
  }

  const resize = new ResizeObserver(() => schedule());
  function relocate() {
    relocated = Date.now();
    const track = { anchor: tracked };
    const found = locateAll(tracked ? [...wanted, track] : wanted);
    targets = wanted.filter(pin => found.has(pin)).map(pin => ({ pin, ...found.get(pin), el: null }));
    trackedTarget = tracked ? found.get(track) || null : null;
    ensureHost();
    root.replaceChildren(...targets.map(t => (t.el = button(t.pin))));
    placementLayer = highlight = null;
    if (placing) showPlacement();
    resize.disconnect();
    resize.observe(document.documentElement);
    if (document.body) resize.observe(document.body);
    for (const t of [...targets, trackedTarget].filter(Boolean)) resize.observe(t.node);
    draw();
  }

  function draw() {
    frame = 0;
    const keys = [], seen = new Map();
    for (const t of targets) {
      const r = t.box();
      const shown = r && (r.width > 0 || r.height > 0);
      t.el.style.display = shown && visible ? 'grid' : 'none';
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
    if (tracked) {
      const r = trackedTarget && trackedTarget.box();
      send(r && (r.width || r.height) ? { type: 'position', anchor: tracked, x: r.left, y: r.top } : { type: 'position', anchor: tracked, unavailable: true });
    }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };

  function showPlacement() {
    ensureHost();
    placementLayer = document.createElement('div');
    Object.assign(placementLayer.style, { position: 'fixed', inset: '0', cursor: 'crosshair', pointerEvents: 'auto' });
    highlight = document.createElement('div');
    Object.assign(highlight.style, { position: 'fixed', pointerEvents: 'none', border: `1px dashed ${colors.accent || '#8F430B'}`, boxSizing: 'border-box', display: 'none' });
    root.prepend(placementLayer);
    root.append(highlight);
  }

  function setPlacement(active) {
    placing = active;
    placementLayer?.remove(); highlight?.remove();
    placementLayer = highlight = null;
    if (placing) showPlacement();
  }

  function atPoint(x, y) {
    return document.elementsFromPoint(x, y).find(el => el !== host) || document.documentElement;
  }

  function place(x, y) {
    let el = atPoint(x, y);
    if (el === document.body) el = document.documentElement;
    const path = [];
    for (let node = el; node !== document.documentElement; node = node.parentElement) {
      if (!node || !node.parentElement || path.length >= 32) return;
      path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
    }
    const r = el === document.documentElement ? pageBox() : el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const clamp = n => Math.max(0, Math.min(1, n));
    const anchor = encodePointAnchor({ id: el === document.documentElement ? '' : el.id || '', path, x: clamp((x - r.left) / r.width), y: clamp((y - r.top) / r.height) });
    if (anchor) { setPlacement(false); send({ type: 'point', anchor, x, y }); }
  }

  addEventListener('message', e => {
    const d = e.data;
    if (e.source !== parent || !d || d.__artifactPins !== 1) return;
    if (d.type === 'pins' && Array.isArray(d.pins)) {
      wanted = d.pins.filter(p => p && Number.isInteger(p.key) && typeof p.anchor === 'string' && p.anchor && p.anchor.length <= MAX_ANCHOR && !p.anchor.includes('\0'))
        .slice(0, MAX_PINS).map(p => ({ key: p.key, anchor: p.anchor, resolved: p.resolved === true }));
      colors = d.colors && typeof d.colors === 'object' ? d.colors : {};
      visible = d.visible !== false;
      placed = null;
      relocate();
    } else if (d.type === 'placement' && typeof d.active === 'boolean') setPlacement(d.active);
    else if (d.type === 'track' && typeof d.anchor === 'string' && d.anchor.length <= MAX_ANCHOR && !d.anchor.includes('\0')) {
      tracked = d.anchor; relocate();
    } else if (d.type === 'reveal') {
      const t = targets.find(x => x.pin.key === d.key);
      if (t && t.node) t.node.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  });
  addEventListener('scroll', schedule, true);
  addEventListener('resize', schedule);
  new MutationObserver(records => {
    const external = records.some(r => r.target !== host && !host?.contains(r.target) &&
      (r.type !== 'childList' || [...r.addedNodes, ...r.removedNodes].some(n => n !== host)));
    if (!external) return;
    schedule();
    clearTimeout(relocating);
    const wait = Math.max(SETTLE_MS, relocated + EVERY_MS - Date.now());
    relocating = setTimeout(() => { if (wanted.length || tracked) relocate(); }, wait);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });

  document.addEventListener('pointermove', e => {
    if (!placing || !highlight) return;
    const r = atPoint(e.clientX, e.clientY).getBoundingClientRect();
    Object.assign(highlight.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }, true);
  document.addEventListener('click', e => {
    if (e.composedPath().some(n => n instanceof Element && n.getRootNode() === root && n.tagName === 'BUTTON')) return;
    if (placing) { e.preventDefault(); e.stopImmediatePropagation(); place(e.clientX, e.clientY); }
    else send({ type: 'dismiss' });
  }, true);
  document.addEventListener('keydown', e => {
    if (!placing) return;
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.key === 'Escape') { setPlacement(false); send({ type: 'cancel' }); }
      else place(innerWidth / 2, innerHeight / 2);
    }
  }, true);
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
