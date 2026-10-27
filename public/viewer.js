// viewer.js — opens /v/<id>#<token>[@<check-in>]: loads the chosen check-in
// (trunk tip by default) from the artifact's Fossil repository and renders it
// in the sandboxed iframe. The page inside gets a small `window.artifact` API
// over postMessage; the access token never enters the iframe.

import { Artifact, ConflictError, parseFragment, fragment, readFileList } from './client.js';
import { renderDiagrams, renderPikchr } from './diagrams.js';
import { embedFonts } from './fonts.js';
import { zip } from './zip.js';
import { preparePublication } from './export.js';
import { anchorFor, arrange, controls, decodePointAnchor, encodePointAnchor, findQuotes, responderNote, thread } from './comments.js';
import { pagePins } from './page-pins.js';

const $ = id => document.getElementById(id);
const NONCE = document.querySelector('meta[name="artifact-nonce"]')?.content ?? '';
const WATCH_MS = 60_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function libraryReturnLocation(value) {
  if (!value || value.length > 4096) return '/';
  try {
    const target = new URL(value, location.origin);
    if (target.origin !== location.origin || target.pathname !== '/' || target.username || target.password) return '/';
    return target.pathname + target.search;
  } catch { return '/'; }
}
$('backLibrary').href = libraryReturnLocation(new URLSearchParams(location.search).get('returnTo'));

// Token links keep their original syntax. Session-only links may use #@<check-in>
// for history, without minting or revealing capability tokens.
function viewerFragment(hash) {
  if (!hash || hash === '#') return { token: '', at: '' };
  if (hash.startsWith('#@')) return { token: '', at: decodeURIComponent(hash.slice(2)) };
  return parseFragment(hash);
}

let art = null;      // the Artifact API client
let link = null;     // { token, at } from the fragment
let info = null;     // { title, role, tip, timeline } as last loaded
let shown = null;    // { checkin, files, blobs } being shown
let frameUrl = '';   // blob: URL of the rendered page, revoked on the next render
let renders = 0;     // a newer render() supersedes one still awaiting diagrams or fonts
let frameReady = false; // the page has loaded and can take pins

function fail(message) {
  $('msg').textContent = message;
  $('msg').className = 'err';
  $('ring').style.display = 'none';
  $('shell').style.display = '';
  $('frame').style.display = 'none';
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff',
  woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', mp4: 'video/mp4',
  webm: 'video/webm', wav: 'audio/wav', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
};
const mimeOf = name => MIME[name.split('.').pop().toLowerCase()] ?? 'application/octet-stream';

/** Path of `ref` relative to the file at `from`, or null if it leaves the repo. */
function resolvePath(ref, from) {
  if (!ref || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return null;
  const url = new URL(ref, 'https://repo.invalid/' + from);
  return decodeURIComponent(url.pathname.slice(1));
}

// Injected first into every page: the window.artifact bridge, in-page
// anchor scrolling (blob: documents do not scroll to #ids on their own) and
// the comment pins (page-pins.js).
const RUNTIME = `(function(){
  var n = 0, pending = {};
  addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== parent || !d || d.__artifact !== 1 || !pending[d.id]) return;
    var p = pending[d.id]; delete pending[d.id];
    d.error ? p[1](new Error(d.error)) : p[0](d.result);
  });
  function call(op) {
    var args = [].slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      var id = ++n; pending[id] = [resolve, reject];
      parent.postMessage({ __artifact: 1, id: id, op: op, args: args }, '*');
    });
  }
  window.artifact = {
    canWrite: function () { return call('canWrite'); },
    files: function () { return call('files'); },
    read: function (path) { return call('read', path); },
    bytes: function (path) { return call('bytes', path); },
    history: function () { return call('history'); },
    publish: function (files, message) { return call('publish', files, message); },
    pikchr: function (source) { return call('pikchr', source); },
    data: {
      get: function (name) { return call('dataGet', name); },
      set: function (name, value) { return call('dataSet', name, value); },
      list: function () { return call('dataList'); }
    }
  };
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var h = a.getAttribute('href') || '';
    if (h.charAt(0) !== '#' || h === '#') return;
    var id; try { id = decodeURIComponent(h.slice(1)); } catch (_) { id = h.slice(1); }
    var t = document.getElementById(id);
    if (!t) return;
    e.preventDefault();
    try { history.pushState(null, '', h); } catch (_) {}
    t.scrollIntoView({ block: 'start' });
  }, true);
})();
(${pagePins})(${findQuotes}, ${anchorFor}, ${encodePointAnchor}, ${decodePointAnchor});`;

// The page renders in a sandboxed iframe with an opaque origin, which cannot
// load this page's blob: URLs. So the other files of the check-in are inlined:
// scripts and stylesheets become inline tags, everything else a data: URL.
// Pikchr diagrams are rendered to SVG, and the fonts the page names embedded.
async function render() {
  const run = ++renders;
  const names = Object.keys(shown.files);
  const entry = names.includes('index.html') ? 'index.html' : names.find(n => /\.html?$/i.test(n));
  if (!entry) throw new Error('this version has no .html file to show');

  const bytes = name => shown.files[name];
  const text = name => dec.decode(bytes(name));
  const inRepo = (ref, from) => {
    const path = resolvePath(ref, from);
    return path != null && path !== entry && names.includes(path) ? path : null;
  };
  const dataUrls = new Map();
  const dataUrl = path => {
    // Images, media and fonts stored as blobs load through their signed links.
    const blob = shown.blobs?.[path];
    if (blob) return new URL(blob.url, location.origin).href;
    if (!dataUrls.has(path)) {
      const data = path.endsWith('.css') ? enc.encode(css(path)) : bytes(path);
      let bin = '';
      for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
      dataUrls.set(path, `data:${mimeOf(path)};base64,${btoa(bin)}`);
    }
    return dataUrls.get(path);
  };
  const urls = (cssText, from) => cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (m, q, ref) => { const p = inRepo(ref, from); return p ? `url("${dataUrl(p)}")` : m; });
  const css = path => urls(text(path), path);

  const doc = new DOMParser().parseFromString(text(entry), 'text/html');
  for (const el of doc.querySelectorAll('script[src]')) {
    const path = inRepo(el.getAttribute('src'), entry);
    if (!path) continue;
    el.removeAttribute('src');
    el.textContent = text(path).replace(/<\/script/gi, '<\\/script');
  }
  for (const el of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
    const path = inRepo(el.getAttribute('href'), entry);
    if (!path) continue;
    const style = doc.createElement('style');
    style.setAttribute('nonce', NONCE); // before the text, or Chrome checks it against the shell's CSP
    if (el.media) style.media = el.media;
    style.textContent = css(path).replace(/<\/style/gi, '<\\/style');
    el.replaceWith(style);
  }
  for (const el of doc.querySelectorAll('[src], link[href]')) {
    const attr = el.hasAttribute('src') ? 'src' : 'href';
    const path = inRepo(el.getAttribute(attr), entry);
    if (path) el.setAttribute(attr, dataUrl(path));
  }
  for (const el of doc.querySelectorAll('style')) el.textContent = urls(el.textContent, entry);
  for (const el of doc.querySelectorAll('[style]')) el.setAttribute('style', urls(el.getAttribute('style'), entry));
  await renderDiagrams(doc, NONCE);
  await embedFonts(doc, NONCE);
  if (run !== renders) return;

  // The iframe inherits this page's CSP: only nonce-stamped scripts and styles run.
  for (const el of doc.querySelectorAll('script, style, link[rel~="stylesheet"]')) el.setAttribute('nonce', NONCE);
  const runtime = doc.createElement('script');
  runtime.setAttribute('nonce', NONCE);
  runtime.textContent = RUNTIME;
  doc.head.prepend(runtime);

  if (frameUrl) URL.revokeObjectURL(frameUrl);
  frameUrl = URL.createObjectURL(new Blob(['<!DOCTYPE html>\n' + doc.documentElement.outerHTML], { type: 'text/html' }));
  const frame = $('frame');
  closePanel();
  setPlacement(false);
  frameReady = false;
  frame.onload = () => {
    $('shell').style.display = 'none';
    frame.style.display = 'block';
    frameReady = true;
    sendPins();
  };
  frame.src = frameUrl;
  document.title = doc.title || info.title || 'Artifact';
  renderChrome();
}

// ─── Chrome: the bar above the page ─────────────────────────────────────────

const shortId = uuid => uuid.slice(0, 10);

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function linkWith(token, at = '') {
  return location.origin + location.pathname + fragment({ token, at });
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(c => c != null));
  return node;
}

function renderChrome() {
  const latest = shown.checkin === info.tip;
  const index = info.timeline.findIndex(c => c.uuid === shown.checkin);
  const current = info.timeline[index];
  const can = controls(info);
  const writer = can.edit;

  $('bar').hidden = false;
  $('title').textContent = info.title || 'Untitled';
  $('artifactDetails').textContent = info.title || 'Untitled';
  $('titleBtn').title = info.title || 'Untitled';
  $('readCue').hidden = info.role !== 'read';
  $('stage').classList.toggle('readonly', info.role === 'read');
  $('versionHash').textContent = shortId(shown.checkin);
  $('versionTag').textContent = latest ? 'Latest' : current ? ago(current.time) : '';
  $('versionTag').className = latest ? 'tag latest' : 'tag';
  $('versionBtn').classList.toggle('old', !latest);
  const head = info.timeline[0];
  $('updated').textContent = head ? `Updated ${ago(head.time)} by ${head.user}` : '';
  $('role').textContent = writer ? 'Can edit' : can.commentBox ? 'Can comment' : 'View only';
  $('role').className = `pill ${writer ? 'write' : 'read'}`;
  $('commentForm').hidden = !can.commentBox || $('threadPanel').dataset.mode !== 'draft';
  $('deleteBtn').hidden = !writer || (!link.token && !info.canManage);
  $('uploadFilesBtn').hidden = $('uploadFolderBtn').hidden = !writer;
  $('backLibrary').hidden = false;

  $('oldStrip').hidden = latest;
  $('restoreBtn').hidden = latest || !writer;
  $('backLatest').href = fragment({ token: link.token });
  if (!latest && current) {
    const when = new Date(current.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    $('oldText').textContent = `Viewing an older version · ${index} newer`;
    $('oldText').title = `“${current.comment || 'an untitled check-in'}” by ${current.user}, ${when}. `
      + `${index} newer version${index === 1 ? ' exists' : 's exist'}.`;
  }

  renderVersions();
  renderShare();
  renderThreads();
}

// ─── Comments: each thread is a ticket in the artifact's repository ─────────
//
// The panel lists the threads; the page draws a pin at each anchor it finds
// (page-pins.js) and tells the viewer which it placed. The page is sent
// anchors and labels only, never ticket text, and never a token.

let threads = [];
let threadsTruncated = false;
let pins = [];           // what the page was last sent
let placed = null;       // labels the page placed, or null before it answered
let selection = '';      // the anchor of the reader's selection in the page
let focused = '';        // uuid of the thread a pin opened
let markersVisible = true; // local to this viewer; threads and anchors remain available
let placing = false;     // explicit reader consent to pick a location
let panelPoint = null;   // active anchor in the iframe's viewport coordinates
let draftAnchor = '';    // a picked location survives closing the composer
let commentBusy = false;
let trackedAnchor = '';  // echoed by the page; stale position messages are ignored
const expanded = new Map(); // uuid -> open, once the reader toggled it
const drafts = new Map();   // uuid -> reply text not yet sent
const views = new Map();    // uuid -> its element in the panel

const quoted = s => `“${s}”`;
const anchorName = anchor => decodePointAnchor(anchor) ? 'Page location' : quoted(anchor);

function anchored(t) {
  if (!t.anchor) return 'none';
  if (!placed) return 'pending';
  return placed.has(t.label) ? 'yes' : 'no';
}

function anchorLine(t) {
  const state = anchored(t);
  if (state === 'none') return null;
  if (state === 'no') return el('p', { className: 'anchor unanchored', textContent: `Not found in this version: ${anchorName(t.anchor)}` });
  if (state === 'pending') return el('p', { className: 'anchor', textContent: `On ${anchorName(t.anchor)}` });
  const show = el('button', { type: 'button', textContent: `On ${anchorName(t.anchor)}` });
  show.addEventListener('click', () => post({ type: 'reveal', key: t.label }));
  return el('p', { className: 'anchor' }, show);
}

function threadView(t, can) {
  const view = el('details', { className: `thread${t.resolved ? ' resolved' : ''}${t.uuid === focused ? ' focus' : ''}` },
    el('summary', {},
      el('span', { className: 'num', textContent: String(t.label) }),
      el('span', { className: 'title', textContent: t.title }),
      el('span', { className: `tag${t.resolved ? ' latest' : ''}`, textContent: t.status })),
    el('div', { className: 'thread-body' },
      anchorLine(t),
      ...t.messages.filter((m, i) => i === 0 || m.text || m.status).map(m => el('div', {},
        el('div', { className: 'who', textContent: `${m.user} · ${ago(m.time)}${m.status ? ` · marked ${m.status}` : ''}` }),
        m.text ? el('p', { className: 'message', textContent: m.text }) : null)),
      t.checkins.length ? el('p', { className: 'checkins' }, 'Answered in ',
        ...t.checkins.flatMap((c, i) => [i ? ', ' : null, el('a', { href: fragment({ token: link.token, at: c }), textContent: shortId(c) })])) : null,
      can.commentBox ? replyForm(t) : null));
  view.dataset.label = String(t.label);
  view.dataset.anchored = anchored(t);
  view.open = expanded.get(t.uuid) ?? (!t.resolved && t.uuid === focused);
  view.querySelector('summary').addEventListener('click', e => {
    if ($('threadPanel').dataset.mode !== 'index') return;
    e.preventDefault();
    activateThread(t);
    if (anchored(t) === 'yes') post({ type: 'reveal', key: t.label });
  });
  // Remember only what the reader changed, so a thread resolved elsewhere still collapses.
  view.addEventListener('toggle', () => (view.open === !t.resolved ? expanded.delete(t.uuid) : expanded.set(t.uuid, view.open)));
  views.set(t.uuid, view);
  return view;
}

function replyForm(t) {
  const text = el('textarea', { rows: 2, maxLength: 8000, value: drafts.get(t.uuid) ?? '' });
  text.setAttribute('aria-label', `Reply to ${t.title}`);
  text.addEventListener('input', () => drafts.set(t.uuid, text.value));
  const status = el('span', { className: 'hint' });
  status.setAttribute('role', 'status');
  const resolve = el('button', { type: 'button', className: 'resolve', textContent: t.resolved ? 'Reopen' : 'Resolve' });
  const send = el('button', { type: 'submit', className: 'primary', textContent: 'Reply' });
  const form = el('form', { className: 'reply' }, text, el('div', { className: 'comment-actions' }, status, resolve, send));
  const change = async (body, doing) => {
    if (commentBusy) return;
    commentBusy = resolve.disabled = send.disabled = text.readOnly = true;
    status.textContent = doing;
    try {
      await art.comment({ ticketUuid: t.uuid, ...body });
      if (body.text) drafts.delete(t.uuid);
      if (body.status) expanded.delete(t.uuid);
      await loadThreads();
      // The thread moved (newest-changed first, resolved last): keep it in sight.
      views.get(t.uuid)?.scrollIntoView({ block: 'nearest' });
    } catch (err) {
      status.textContent = `Could not save: ${err.message}`;
    } finally {
      commentBusy = resolve.disabled = send.disabled = text.readOnly = false;
    }
  };
  form.addEventListener('submit', e => {
    e.preventDefault();
    const reply = text.value.trim();
    if (reply) change({ text: reply }, 'Posting…');
  });
  resolve.addEventListener('click', () => change({ status: t.resolved ? 'Open' : 'Closed' }, t.resolved ? 'Reopening…' : 'Resolving…'));
  return form;
}

function renderThreads() {
  const can = controls(info);
  renderResponder();
  const { open, resolved, pins: next } = arrange(threads);
  $('commentCount').textContent = threads.length ? `${threads.length}${threadsTruncated ? '+' : ''}` : '';
  $('commentsNote').textContent = [
    threadsTruncated ? `Showing the newest ${threads.length}` : '',
    can.commentBox ? '' : 'Read only',
  ].filter(Boolean).join(' · ');
  views.clear();
  $('threadList').replaceChildren(...open.map(t => threadView(t, can)));
  $('resolvedList').replaceChildren(...resolved.map(t => threadView(t, can)));
  $('resolvedHead').hidden = !resolved.length;
  renderAnchor();
  if (JSON.stringify(next) !== JSON.stringify(pins)) {
    pins = next;
    placed = null;
    sendPins();
  }
}

function renderAnchor() {
  const anchor = draftAnchor || selection;
  $('commentAnchor').textContent = anchor ? `On ${anchorName(anchor)}` : 'Comment on the page, select text, or place a comment anywhere.';
  $('anchorClear').hidden = !anchor;
  $('placeComment').hidden = $('generalComment').hidden = !controls(info).commentBox;
  $('placeComment').textContent = draftAnchor ? 'Continue draft' : 'Place a comment';
  $('generalComment').textContent = selection ? 'Comment on selection' : 'General comment';
}

/** A message to the page's pins (page-pins.js). The page's origin is opaque, so '*'. */
function post(message) {
  const page = $('frame').contentWindow;
  if (frameReady && page) page.postMessage({ __artifactPins: 1, ...message }, '*');
}

function trackAnchor(anchor) {
  trackedAnchor = anchor;
  post({ type: 'track', anchor });
}

function sendPins() {
  const style = getComputedStyle(document.documentElement);
  const colors = Object.fromEntries(['accent', 'surface', 'muted'].map(k => [k, style.getPropertyValue(`--${k}`).trim()]));
  placed = null;
  post({ type: 'pins', pins, colors, visible: markersVisible });
}

function setMarkerVisibility(visible) {
  markersVisible = visible;
  $('showCommentMarkers').setAttribute('aria-checked', String(visible));
  $('markerStatus').textContent = visible ? 'Markers visible on the page' : 'Markers hidden · comments still available';
  sendPins();
}
$('showCommentMarkers').addEventListener('click', () => setMarkerVisibility(!markersVisible));

// The theme changed: redraw the pins in its colours.
new MutationObserver(sendPins).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sendPins);

// The sandbox is untrusted. It can suggest a position, never post a comment,
// confer permission, or take a draft away from the reader.
const pagePoint = d => Number.isFinite(d.x) && Number.isFinite(d.y)
  && Math.abs(d.x) <= 10_000_000 && Math.abs(d.y) <= 10_000_000 ? { x: d.x, y: d.y } : null;
function isTyping() {
  const active = document.activeElement;
  return active?.matches('#threadPanel textarea') && active.value.trim();
}
addEventListener('message', e => {
  const d = e.data;
  if (!info || !frameReady || e.source !== $('frame').contentWindow || !d || d.__artifactPins !== 1) return;
  if (d.type === 'placed' && Array.isArray(d.keys)) {
    placed = new Set(d.keys.filter(Number.isInteger).slice(0, 500));
    for (const view of document.querySelectorAll('#threadPanel .thread')) {
      const t = threads.find(x => String(x.label) === view.dataset.label);
      if (!t) continue;
      view.dataset.anchored = anchored(t);
      view.querySelector('.anchor')?.replaceWith(anchorLine(t) ?? '');
    }
  } else if (d.type === 'open' && Number.isInteger(d.key)) {
    const t = threads.find(x => x.label === d.key);
    if (!t || isTyping() || commentBusy) return;
    activateThread(t, pagePoint(d));
  } else if (d.type === 'selection' && typeof d.anchor === 'string' && controls(info).commentBox) {
    selection = Array.from(d.anchor).slice(0, 500).join('');
    renderAnchor();
  } else if (d.type === 'point' && placing && controls(info).commentBox && pagePoint(d)
    && decodePointAnchor(d.anchor)) {
    draftAnchor = d.anchor;
    selection = '';
    setPlacement(false);
    openPanel('draft', pagePoint(d));
    renderAnchor();
    trackAnchor(draftAnchor);
    $('commentText').focus();
  } else if (d.type === 'position' && !$('threadPanel').hidden && trackedAnchor && d.anchor === trackedAnchor) {
    if (d.unavailable === true) {
      panelPoint = null;
      $('threadPanel').style.left = $('threadPanel').style.top = $('threadPanel').style.right = '';
      $('commentsNote').textContent = 'Location not found';
    } else if (pagePoint(d)) {
      panelPoint = pagePoint(d);
      positionPanel();
    }
  } else if (d.type === 'cancel' && placing) {
    setPlacement(false);
    closePanel();
    $('commentsBtn').focus();
  } else if (d.type === 'dismiss' && !placing && !isTyping() && !commentBusy) {
    closePopovers();
  }
});

async function loadThreads() {
  if (!controls(info).threads) return;
  try {
    const result = await art.tickets();
    threads = result.tickets.map(thread);
    threadsTruncated = result.truncated;
    renderThreads();
  } catch { /* offline or gone: keep what is shown */ }
}

function renderResponder() {
  const n = responderNote(info);
  $('responderNote').dataset.attached = String(n.attached);
  $('responderHead').textContent = n.headline;
  $('responderName').textContent = n.name;
  $('responderContact').textContent = n.contact ? `(${n.contact})` : '';
}

function positionPanel() {
  const panel = $('threadPanel'), stage = $('stage').getBoundingClientRect();
  if (panel.hidden || !panelPoint) return;
  const frame = $('frame').getBoundingClientRect();
  const x = frame.left - stage.left + panelPoint.x, y = frame.top - stage.top + panelPoint.y;
  const width = panel.offsetWidth, height = panel.offsetHeight;
  const clamp = (n, max) => Math.max(8, Math.min(n, max));
  const left = x + 32 + width <= stage.width - 8 ? x + 32 : x - width - 12;
  panel.style.left = `${clamp(left, stage.width - width - 8)}px`;
  panel.style.top = `${clamp(y - 12, stage.height - height - 8)}px`;
  panel.style.right = 'auto';
}
new ResizeObserver(positionPanel).observe($('stage'));
new ResizeObserver(positionPanel).observe($('threadPanel'));

function setPlacement(active) {
  placing = active && !commentBusy && !!info && controls(info).commentBox;
  $('placementHint').hidden = !placing;
  $('cancelPlacement').hidden = !placing;
  post({ type: 'placement', active: placing });
}
function closePanel(restore = false) {
  const wasOpen = !$('threadPanel').hidden;
  $('threadPanel').hidden = true;
  $('commentsBtn').setAttribute('aria-expanded', 'false');
  panelPoint = null;
  trackAnchor('');
  if (restore && wasOpen) $('commentsBtn').focus();
}
function openPanel(mode = 'index', point = null) {
  closePopovers('threadPanel');
  setPlacement(false);
  const panel = $('threadPanel');
  panel.dataset.mode = mode;
  panelPoint = point;
  panel.style.left = panel.style.top = panel.style.right = '';
  panel.hidden = false;
  $('panelTitle').textContent = mode === 'draft' ? 'New comment' : mode === 'thread' ? 'Comment' : 'Comments';
  $('allComments').hidden = mode === 'index';
  $('commentForm').hidden = !controls(info).commentBox || mode !== 'draft';
  $('commentsBtn').setAttribute('aria-expanded', 'true');
  if (mode === 'index') {
    focused = '';
    for (const view of views.values()) view.classList.remove('focus');
    trackAnchor('');
  }
  positionPanel();
}
function activateThread(t, point = null) {
  const view = views.get(t.uuid);
  if (!view) return;
  focused = t.uuid;
  expanded.set(t.uuid, true);
  for (const other of views.values()) other.classList.toggle('focus', other === view);
  view.open = true;
  openPanel('thread', point || { x: $('frame').clientWidth / 2, y: 40 });
  $('panelTitle').textContent = `Comment ${t.label}`;
  trackAnchor(t.anchor);
}
$('commentsBtn').addEventListener('click', e => {
  e.stopPropagation();
  if ($('threadPanel').hidden || $('threadPanel').dataset.mode !== 'index') {
    openPanel();
    loadThreads();
  } else closePanel(true);
});
$('threadClose').addEventListener('click', () => closePanel(true));
$('allComments').addEventListener('click', () => openPanel());
$('threadPanel').addEventListener('click', e => e.stopPropagation());
$('anchorClear').addEventListener('click', () => {
  if (commentBusy) return;
  selection = draftAnchor = '';
  panelPoint = null;
  trackAnchor('');
  renderAnchor();
});
$('generalComment').addEventListener('click', () => {
  if (commentBusy || !controls(info).commentBox) return;
  if (draftAnchor && $('commentText').value.trim()) {
    $('placeComment').click();
    return;
  }
  draftAnchor = '';
  openPanel('draft');
  $('commentText').focus();
});
$('placeComment').addEventListener('click', () => {
  if (commentBusy || !controls(info).commentBox) return;
  if (!markersVisible) setMarkerVisibility(true);
  if (draftAnchor) {
    openPanel('draft', { x: $('frame').clientWidth / 2, y: 40 });
    trackAnchor(draftAnchor);
    $('commentText').focus();
    return;
  }
  closePopovers();
  setPlacement(true);
  $('frame').focus();
});
$('cancelPlacement').addEventListener('click', e => { e.stopPropagation(); setPlacement(false); openPanel(); });
$('cancelComment').addEventListener('click', () => {
  if (commentBusy) return;
  $('commentText').value = '';
  selection = draftAnchor = '';
  $('commentStatus').textContent = '';
  closePanel(true);
  renderAnchor();
});
$('threadPanel').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.stopPropagation(); closePanel(true); }
});

$('commentForm').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('commentText').value.trim();
  if (!text || commentBusy || !controls(info).commentBox) return;
  const anchor = draftAnchor || selection, point = panelPoint;
  const button = $('commentForm').querySelector('button[type=submit]');
  commentBusy = button.disabled = $('commentText').readOnly = true;
  $('commentStatus').textContent = 'Posting…';
  try {
    const result = await art.comment(anchor ? { text, anchor } : { text });
    $('commentText').value = '';
    selection = draftAnchor = '';
    $('commentStatus').textContent = 'Posted.';
    await loadThreads();
    const posted = threads.find(t => t.uuid === result.ticketUuid);
    if (posted && point) activateThread(posted, point);
    else openPanel();
  } catch (err) {
    $('commentStatus').textContent = `Could not post: ${err.message}`;
  } finally {
    commentBusy = button.disabled = $('commentText').readOnly = false;
  }
});

function renderVersions() {
  $('versionCount').textContent = `${info.timeline.length} check-in${info.timeline.length === 1 ? '' : 's'}`;
  $('versionList').replaceChildren(...info.timeline.map(c => {
    const item = el('a', {
      className: 'version',
      href: fragment({ token: link.token, at: c.uuid === info.tip ? '' : c.uuid.slice(0, 16) }),
    },
      el('span', { className: 'mono', textContent: shortId(c.uuid) }),
      el('span', { className: 'what' },
        el('span', { textContent: c.comment || '(no comment)' }),
        el('span', { className: 'who', textContent: `${c.user} · ${ago(c.time)}` })),
      c.uuid === info.tip ? el('span', { className: 'tag latest', textContent: 'Latest' }) : el('span'));
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(c.uuid === shown.checkin));
    return item;
  }));
}

/** One labelled, read-only value with a Copy button. */
function shareRow(id, label, hint, value, { secret = false } = {}) {
  const input = el('input', { id, readOnly: true, value });
  const copy = el('button', { type: 'button', textContent: 'Copy' });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    } catch {
      input.select();
    }
  });
  return el('div', { className: 'share-row' },
    el('label', { htmlFor: id },
      el('span', {}, label, secret ? el('span', { className: 'private', textContent: 'Private' }) : null),
      el('span', { className: 'hint', textContent: hint })),
    el('div', { className: 'copy' }, input, copy));
}

let publications = [];
let publicationCursor = '';
let publicationBusy = false;
let publicationLoading = false;

async function publicationRequest(path, { method = 'GET', body } = {}) {
  const headers = art.auth ? { Authorization: art.auth } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method, headers, credentials: 'same-origin', cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(typeof detail?.error === 'string' ? detail.error : `Publication request failed (HTTP ${response.status}).`);
  }
  return response.status === 204 ? null : response.json();
}

function publicationStatus(message, error = false) {
  $('publicationStatus').textContent = message;
  $('publicationStatus').className = error ? 'hint danger' : 'hint';
}

function renderPublications() {
  $('publicationList').replaceChildren(...publications.map(publication => {
    const label = `Version ${shortId(publication.checkin)}`;
    const hint = `${publication.status} · ${new Date(publication.createdAt).toLocaleDateString()}`;
    const live = publication.status === 'live' && typeof publication.url === 'string' && publication.url;
    const row = live ? shareRow(`public-${publication.id}`, label, hint, publication.url)
      : el('div', { className: 'share-row' }, el('strong', { textContent: label }), el('span', { className: 'hint', textContent: hint }));
    const actions = el('div', { className: 'publication-actions' });
    if (live) actions.append(el('a', { textContent: 'Open', href: publication.url, target: '_blank', rel: 'noopener noreferrer' }));
    const remove = el('button', { type: 'button', className: 'danger', textContent: 'Delete', disabled: publicationBusy });
    remove.addEventListener('click', async () => {
      if (publicationBusy || !info.canManage) return;
      if (!confirm(`Unpublish snapshot ${shortId(publication.checkin)}? Its public link will stop working. The private artifact and history will not change. Copies already downloaded cannot be recalled.`)) return;
      publicationBusy = true;
      renderShare();
      renderPublications();
      publicationStatus('Deleting public snapshot…');
      try {
        await publicationRequest(`/api/publications/${encodeURIComponent(publication.id)}`, { method: 'DELETE' });
        publications = publications.filter(item => item.id !== publication.id);
        publicationStatus('Public snapshot deleted. The private artifact is unchanged.');
      } catch (e) { publicationStatus(e.message, true); }
      finally { publicationBusy = false; renderShare(); renderPublications(); }
    });
    actions.append(remove);
    row.append(actions);
    return row;
  }));
  if (!publications.length) $('publicationList').append(el('p', { className: 'hint', textContent: publicationLoading ? 'Loading snapshots…' : 'No published snapshots.' }));
  $('publicationMore').hidden = !publicationCursor;
  $('publicationMore').disabled = publicationLoading || publicationBusy;
}

async function loadPublications(append = false) {
  if (!info?.canManage || publicationLoading) return;
  publicationLoading = true;
  renderPublications();
  try {
    const query = new URLSearchParams({ artifactId: art.id });
    if (append && publicationCursor) query.set('cursor', publicationCursor);
    const result = await publicationRequest(`/api/publications?${query}`);
    publications = append ? [...publications, ...result.publications] : result.publications;
    publicationCursor = result.nextCursor || '';
  } catch (e) { publicationStatus(e.message, true); }
  finally { publicationLoading = false; renderPublications(); }
}

$('publicationMore').addEventListener('click', () => loadPublications(true));
$('publishPublic').addEventListener('click', async () => {
  if (publicationBusy || !info.canManage) return;
  const at = shown.checkin;
  if (!confirm(`Make version ${shortId(at)} PUBLIC? Every file in this version, including images, scripts, and supporting files, will be available to anyone without signing in. Other versions and private page data are not included.`)) return;
  publicationBusy = true;
  renderShare();
  renderPublications();
  publicationStatus('Preparing standalone snapshot…');
  try {
    const bundle = await art.bundle(at);
    if (bundle.checkin !== at) throw new Error('The selected version could not be loaded exactly. Please reload and try again.');
    const documents = await preparePublication(art, bundle);
    publicationStatus('Publishing public snapshot…');
    const publication = await publicationRequest(`${art.base}/publications`, { method: 'POST', body: { at, documents } });
    publications = [publication, ...publications.filter(item => item.id !== publication.id)];
    publicationStatus(publication.status === 'live' && publication.url
      ? 'Published. Copy or open the public link below.' : `Snapshot status: ${publication.status}. Reopen Share to refresh.`);
  } catch (e) { publicationStatus(e.message, true); }
  finally { publicationBusy = false; renderShare(); renderPublications(); }
});

function renderShare() {
  $('publicationSection').hidden = !info.canManage;
  $('publishPublic').disabled = publicationBusy;
  $('publishPublic').textContent = publicationBusy ? 'Working…' : `Publish version ${shortId(shown.checkin)}`;
  $('shareMenu').querySelector('.collaboration').open = !info.canManage;
  if (!link.token) {
    $('shareRows').replaceChildren(shareRow('libraryLink', 'Library link',
      'Only the owner, instance owner, and people with named access can open this link after signing in.',
      location.origin + location.pathname));
    $('shareFoot').textContent = 'Manage named access from your library. This link does not grant access.';
    return;
  }
  const can = controls(info);
  const writer = can.edit;
  // A comment link is not a Fossil login, and holders of one see no other link.
  const reader = info.role === 'read';
  const readToken = writer ? info.readToken : reader ? link.token : null;
  const login = writer ? 'editor' : 'viewer';
  const clone = `fossil clone ${location.origin.replace('://', `://${login}:${link.token}@`)}/r/${art.id}`;
  $('shareRows').replaceChildren(...[
    readToken ? shareRow('readLink', 'Read link', 'Anyone with it can view every version.', linkWith(readToken)) : null,
    can.commentLink ? shareRow('commentLink', 'Comment link', 'Can view every version and comment, not edit.', linkWith(info.commentToken), { secret: true }) : null,
    writer ? shareRow('editLink', 'Edit link', 'Can publish new versions and delete. Share only with editors.', linkWith(link.token), { secret: true }) : null,
    writer || reader ? shareRow('cloneCmd', 'Clone with Fossil', writer ? 'The whole history, to edit locally and push back.' : 'The whole history, read-only.', clone, { secret: writer }) : null,
  ].filter(Boolean));
  $('shareFoot').textContent = info.expiresAt
    ? `Expires ${new Date(info.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}`
    : 'Does not expire';
}

// One popover open at a time; Escape or a click elsewhere closes it.
const popovers = [['titleBtn', 'titleMenu'], ['versionBtn', 'versionMenu'], ['shareBtn', 'shareMenu'], ['moreBtn', 'moreMenu']];
function closePopovers(except) {
  if (except !== 'threadPanel') { closePanel(); setPlacement(false); }
  for (const [btn, menu] of popovers) {
    if (menu === except) continue;
    $(menu).hidden = true;
    $(btn).setAttribute('aria-expanded', 'false');
  }
}
for (const [btn, menu] of popovers) {
  $(btn).addEventListener('click', e => {
    e.stopPropagation();
    const open = $(menu).hidden;
    closePopovers(menu);
    $(menu).hidden = !open;
    $(btn).setAttribute('aria-expanded', String(open));
    if (open && menu === 'shareMenu') loadPublications();
  });
  $(menu).addEventListener('click', e => e.stopPropagation());
  const items = () => [...$(menu).querySelectorAll('button:not(:disabled), a[href], select')].filter(n => n.getClientRects().length);
  $(btn).addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    if ($(menu).hidden) $(btn).click();
    items()[0]?.focus();
  });
  $(menu).addEventListener('keydown', e => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key) || e.target.matches('select, input, textarea')) return;
    e.preventDefault();
    const choices = items(), index = choices.indexOf(document.activeElement);
    choices[(index + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]?.focus();
  });
}
document.addEventListener('click', () => closePopovers());
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const open = popovers.find(([, menu]) => !$(menu).hidden);
    if (open || !$('threadPanel').hidden || placing) e.preventDefault();
    closePopovers();
    if (open) $(open[0]).focus();
  }
});
$('versionList').addEventListener('click', () => closePopovers());

function shareTab(which, focus = false) {
  for (const name of ['share', 'export']) {
    const active = name === which;
    $(`${name}Tab`).setAttribute('aria-selected', String(active));
    $(`${name}Tab`).tabIndex = active ? 0 : -1;
    $(`${name}Pane`).hidden = !active;
  }
  if (focus) $(`${which}Tab`).focus();
}
for (const name of ['share', 'export']) {
  $(`${name}Tab`).addEventListener('click', () => shareTab(name));
  $(`${name}Tab`).addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    shareTab(e.key === 'Home' ? 'share' : e.key === 'End' ? 'export' : name === 'share' ? 'export' : 'share', true);
  });
}

$('restoreBtn').addEventListener('click', async () => {
  const btn = $('restoreBtn');
  btn.disabled = true;
  try {
    // Re-commits this version's files on top of the tip; files added since stay.
    await art.publish(info.tip, shown.files, `Restore ${shortId(shown.checkin)}`);
    location.hash = fragment({ token: link.token });
  } catch (e) {
    btn.disabled = false;
    $('oldText').textContent = e instanceof ConflictError
      ? 'Someone published while you were looking. Open the latest version and try again.'
      : `Could not restore: ${e.message}`;
  }
});

$('deleteBtn').addEventListener('click', async () => {
  closePopovers();
  if (!confirm(`Delete the private artifact “${info.title}” and its whole history? Private collaboration links will stop working. Published public snapshots remain available until explicitly unpublished.`)) return;
  try {
    await art.remove();
    $('bar').hidden = true;
    $('oldStrip').hidden = true;
    fail('This artifact was deleted.');
  } catch (e) {
    fail(`Could not delete: ${e.message}`);
  }
});

// Editors add or replace files: a new version on top of the latest, keeping
// the files they didn't choose. A folder's files keep their paths inside it.
for (const [btn, input] of [['uploadFilesBtn', 'uploadFiles'], ['uploadFolderBtn', 'uploadFolder']]) {
  $(btn).addEventListener('click', () => { closePopovers(); $(input).value = ''; $(input).click(); });
  $(input).addEventListener('change', async () => {
    const chosen = await readFileList($(input).files);
    const paths = Object.keys(chosen);
    if (!paths.length) return;
    const what = paths.length === 1 ? paths[0] : `${paths.length} files`;
    notice(`Uploading ${what}…`);
    try {
      await art.publish(info.tip, chosen, `Upload ${what}`);
      if (link.at) location.hash = fragment({ token: link.token });
      else await reload(true);
      notice(`Uploaded ${what}.`);
    } catch (e) {
      notice(e instanceof ConflictError
        ? 'Someone published while you were looking. Open the latest version and upload again.'
        : `Could not upload: ${e.message}`);
    }
  });
}

// Every file of the version shown, with the real bytes of images and other blobs.
$('downloadBtn').addEventListener('click', async () => {
  closePopovers();
  notice('Preparing the download…');
  try {
    const files = {};
    for (const [path, bytes] of Object.entries(shown.files)) files[path] = shown.blobs?.[path] ? await art.blob(shown.blobs[path]) : bytes;
    const name = (info.title || 'artifact').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact';
    const a = el('a', { href: URL.createObjectURL(zip(files)), download: `${name}-${shortId(shown.checkin)}.zip` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    notice(`Downloaded ${a.download}.`);
  } catch (e) {
    notice(`Could not download: ${e.message}`);
  }
});

/** A short message in the toast, without its "Show it" button. One still in progress (…) stays. */
let noticeTimer;
function notice(text) {
  clearTimeout(noticeTimer);
  $('toastText').textContent = text;
  $('toastShow').hidden = true;
  $('toast').hidden = false;
  if (!text.endsWith('…')) noticeTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}

// ─── The page's window.artifact API ──────────────────────────────────────────

const ops = {
  canWrite: () => info.role === 'write',
  files: () => Object.keys(shown.files),
  read: path => {
    if (!(path in shown.files)) throw new Error(`${path} is not in this version`);
    return dec.decode(shown.files[path]);
  },
  // A file's raw bytes, for binary files such as .wasm modules or SQLite
  // databases: blobs (stored in R2) are fetched through their signed link.
  async bytes(path) {
    if (!(path in shown.files)) throw new Error(`${path} is not in this version`);
    const blob = shown.blobs?.[path];
    return blob ? art.blob(blob) : shown.files[path].slice();
  },
  history: () => info.timeline,
  // Renders Pikchr source to SVG: {light, dark, width, height}.
  pikchr: source => renderPikchr(source),

  // A new check-in on top of the latest version. It refuses when someone else
  // published since this page loaded, rather than overwrite their work; the
  // viewer then knows the new tip, so calling again builds on it.
  async publish(files, message) {
    try {
      const r = await art.publish(info.tip, files ?? {}, String(message || 'Edited in the page'));
      await reload(false);
      return { uuid: r.tip };
    } catch (e) {
      if (e instanceof ConflictError) await reload(false);
      throw e;
    }
  },

  // Page data: small JSON values outside the history, last writer wins per name.
  dataGet: name => art.dataGet(name),
  dataList: () => art.dataList(),
  async dataSet(name, value) {
    await art.dataSet(name, value);
    return true;
  },
};

addEventListener('message', async e => {
  const d = e.data;
  if (e.source !== $('frame').contentWindow || !d || d.__artifact !== 1 || !(d.op in ops)) return;
  const reply = msg => e.source.postMessage({ __artifact: 1, id: d.id, ...msg }, '*');
  try {
    reply({ result: await ops[d.op](...(d.args ?? [])) });
  } catch (err) {
    reply({ error: err.message });
  }
});

// ─── Watching for new versions ───────────────────────────────────────────────

async function watch() {
  if (document.visibilityState !== 'visible' || !art || !info) return;
  try {
    if ((await art.tip()) === info.tip) return;
    const by = (await art.info()).timeline[0]?.user;
    $('toastText').textContent = by ? `${by} published a new version` : 'A new version was published';
    clearTimeout(noticeTimer);
    $('toastShow').hidden = false;
    $('toast').hidden = false;
  } catch { /* offline: try again next time */ }
}
setInterval(watch, WATCH_MS);
$('toastShow').addEventListener('click', () => {
  $('toast').hidden = true;
  if (link.at) location.hash = fragment({ token: link.token });
  else reload(true).catch(e => fail(e.message));
});

// ─── Start ───────────────────────────────────────────────────────────────────

/** Load the timeline, and with `show` the check-in the link names. */
// A large script, stylesheet or document stored as a blob is fetched and then
// handled like any other text file: scripts and styles must be inlined.
const INLINED = /\.(css|m?js|html?|json|svg|txt|md)$/i;
async function fetchTextBlobs(bundle) {
  const text = Object.entries(bundle.blobs ?? {}).filter(([path]) => INLINED.test(path));
  await Promise.all(text.map(async ([path, entry]) => {
    bundle.files[path] = await art.blob(entry);
    delete bundle.blobs[path];
  }));
}

async function reload(show) {
  info = await art.info();
  if (show) {
    shown = await art.bundle(link.at);
    await fetchTextBlobs(shown);
    if (shown.missing?.length) console.warn('missing from this version:', shown.missing.join(', '));
    await render();
  } else {
    renderChrome();
  }
}

async function main() {
  const m = /^\/v\/([A-Za-z0-9_-]{1,64})$/.exec(location.pathname);
  if (!m || !NONCE) return fail('Open an artifact link: /v/<id>#<token>');
  try {
    link = viewerFragment(location.hash);
  } catch (e) {
    return fail(e.message);
  }
  art = new Artifact(location.origin, m[1], link.token);
  await reload(true);
  await loadThreads();
}

addEventListener('hashchange', () => {
  try {
    const next = viewerFragment(location.hash);
    if (art && next.token === link.token) {
      link = next;
      closePopovers();
      reload(true).catch(e => fail(e.message));
    } else {
      location.reload();
    }
  } catch (e) {
    fail(e.message);
  }
});

main().catch(e => fail(e.status === 404 ? 'This artifact does not exist, has expired, or the link is wrong.' : String(e.message ?? e)));
