// viewer.js — opens /v/<id>#<token>[@<check-in>]: loads the chosen check-in
// (trunk tip by default) from the artifact's Fossil repository and renders it
// in the sandboxed iframe. The page inside gets a small `window.artifact` API
// over postMessage; the access token never enters the iframe, and neither does
// any account identity.

import { Artifact, ConflictError, parseFragment, fragment, readFileList } from './client.js';
import { renderDiagrams, renderPikchr } from './diagrams.js';
import { embedFonts } from './fonts.js';
import { zip } from './zip.js';
import { setArtifactFavicon } from './icons.js';
setArtifactFavicon('document');
import { preparePublication } from './export.js';
import { anchorFor, arrange, attachmentDisplay, bubblePlacement, controls, decodePointAnchor, encodePointAnchor, findQuotes, responderNote, responderProgress, thread } from './comments.js';
import { guestPanel } from './guest-panel.js';
import { typeOf } from './blobs.js';
import { pagePins } from './page-pins.js';
import { pageAppearance } from './page-appearance.js';
import { backdropColor, pageBackdrop, chooseCanvas } from './backdrop.js';

const $ = id => document.getElementById(id);
const NONCE = document.querySelector('meta[name="artifact-nonce"]')?.content ?? '';
const WATCH_MS = 60_000;
const COMMENT_WATCH_MS = 5_000;
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

// ─── Account identity ────────────────────────────────────────────────────────
//
// Content can arrive by capability link without any cookie, so a working
// artifact is never evidence that anyone is signed in. Everything account-side
// (recent artifacts, people, snapshots, management) is keyed to the account id
// this page last confirmed with /api/session, and discarded when that identity
// is lost or changes. Checks are coalesced so polling does not flood the route.
//
// A request is answered for whoever the cookie was when it was sent, which may
// not be who the cookie is when it answers. `identityEpoch` names the confirmed
// identity a request was issued under; every account cache or panel write
// re-reads it after its awaits and is dropped if the epoch moved. A stale 401
// therefore cannot sign out an account that was confirmed after it was sent.
let accountId = null;   // null until /api/session answers, '' when signed out
let identityEpoch = 0;  // bumped whenever the confirmed identity changes
let sessionCheckedAt = 0;
let sessionCheckedEpoch = -1;
let sessionSeq = 0;      // newest /api/session request wins over older ones
let sessionInFlight = null;
const SESSION_FRESH_MS = 5_000;

function sessionRequest({ fresh = false } = {}) {
  if (sessionInFlight && !fresh) return sessionInFlight.promise;
  const seq = ++sessionSeq;
  const promise = fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
    .then(async response => {
      const data = response.ok ? await response.json().catch(() => null) : null;
      return typeof data?.user?.id === 'string' ? data.user.id : '';
    })
    .catch(() => null) // offline: unknown, not "signed out"
    .finally(() => { if (sessionInFlight?.seq === seq) sessionInFlight = null; });
  sessionInFlight = { seq, promise };
  return promise.then(id => ({ id, seq }));
}

/** The account this page is now acting as, or null when signed out or unknown. */
async function confirmAccount({ fresh = false } = {}) {
  if (!fresh && sessionCheckedEpoch === identityEpoch && sessionCheckedAt
    && Date.now() - sessionCheckedAt < SESSION_FRESH_MS) {
    return accountId || null;
  }
  const { id, seq } = await sessionRequest({ fresh });
  // A newer check already settled; its answer, not this one, is the identity.
  if (seq !== sessionSeq) return accountId || null;
  if (id === null) return accountId || null; // unknown: keep the last confirmed identity
  if (id !== accountId) {
    const adopted = accountId !== null;
    accountId = id;
    // A change drops the last account's cache, panels and rights, then asks
    // the server again for the role the new cookie actually has.
    if (adopted) forgetAccount(); else identityEpoch++;
  }
  sessionCheckedAt = Date.now();
  sessionCheckedEpoch = identityEpoch;
  return accountId || null;
}

/** A confirmed identity loss or change drops every account-scoped cache and panel. */
function forgetAccount() {
  const epoch = ++identityEpoch;
  libraryCache = { at: 0, items: null, error: '', accountId: null };
  people = { grants: [], users: [], ownerId: '' };
  peopleLoaded = false;
  publications = [];
  publicationCursor = '';
  sidebarUnavailable = true;
  setNav(false);
  $('navBtn').hidden = true;
  $('peopleSection').hidden = true;
  $('publicationSection').hidden = true;
  $('peopleList').replaceChildren();
  guestUI.resetManagement();
  $('recentList').replaceChildren();
  $('recentStatus').textContent = '';
  // The content role came from the link and still stands; management came from
  // the cookie and may not. Drop it now, then ask the server again rather than
  // trusting a page restored under another identity.
  if (info) { info.canManage = false; if (shown) renderChrome(); }
  if (art && info && shown) {
    art.info().then(next => {
      if (epoch !== identityEpoch) return; // a newer identity owns the page now
      info = next;
      renderChrome();
    }).catch(() => { /* the content link still governs */ });
  }
}

/** Whether an account request still speaks for the identity confirmed now. */
function stillCurrent(epoch, account = accountId) {
  return epoch === identityEpoch && account === accountId;
}

/**
 * Management writes revalidate the cookie first: a capability link that still
 * opens the content must not act on a management panel restored from a stale
 * page, and a signed-out or switched account writes nothing.
 */
async function managementAuthorization() {
  const current = await confirmAccount({ fresh: true });
  if (!current || !info?.canManage) return false;
  return true;
}

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
(${pagePins})(${findQuotes}, ${anchorFor}, ${encodePointAnchor}, ${decodePointAnchor});
(${pageBackdrop})(${chooseCanvas}, ${backdropColor});`;

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
  // Carry the choice into the sandbox before paint, retaining the author's
  // original root theme so System can restore it without changing saved files.
  const theme = document.documentElement.dataset.theme;
  const preference = theme === 'light' || theme === 'dark' ? theme : 'system';
  runtime.textContent = `(${pageAppearance})(${JSON.stringify(preference)});\n${RUNTIME}`;
  doc.head.prepend(runtime);
  if (frameUrl) URL.revokeObjectURL(frameUrl);
  frameUrl = URL.createObjectURL(new Blob(['<!DOCTYPE html>\n' + doc.documentElement.outerHTML], { type: 'text/html' }));
  const frame = $('frame');
  closeInspector();
  setPlacement(false);
  closeBubbleForPage();
  frameReady = false;
  pageCanvas = null; // the new page reports its own canvas once it loads
  paintBackdrop();
  frame.onload = () => {
    $('shell').style.display = 'none';
    frame.style.display = 'block';
    frameReady = true;
    sendAppearance();
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
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    // Hyphenated names are attributes, not properties: assigning them would
    // create a stray JS field and leave an element with no accessible name.
    if (key.includes('-') || key.includes(':')) node.setAttribute(key, value);
    else node[key] = value;
  }
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
  $('readCue').setAttribute('aria-label', can.commentBox ? 'Page is view only; comments are available in the discussion panel' : 'View only');
  $('stage').classList.toggle('readonly', info.role === 'read');
  $('versionHash').textContent = shortId(shown.checkin);
  $('versionTag').textContent = latest ? 'Latest' : current ? ago(current.time) : '';
  $('versionTag').className = latest ? 'tag latest' : 'tag';
  $('versionBtn').classList.toggle('old', !latest);
  const head = info.timeline[0];
  $('updated').textContent = head ? `Updated ${ago(head.time)} by ${head.user}` : '';
  const role = writer ? 'Can edit' : can.commentBox ? 'Can comment' : 'View only';
  $('role').textContent = role;
  $('role').className = writer ? 'role-write' : 'role-read';
  $('titleHint').textContent = role;
  $('titleHint').hidden = false;
  $('commentForm').hidden = !can.commentBox || $('threadPanel').dataset.mode !== 'draft';
  // Named viewers and editors see an account role; capability links manage by token.
  const accountManage = !!info.canManage;
  $('deleteBtn').hidden = !writer || (!link.token && !accountManage);
  $('uploadFilesBtn').hidden = $('uploadFolderBtn').hidden = !writer;
  $('renameBtn').hidden = $('expirationBtn').hidden = $('archiveBtn').hidden = !accountManage;
  $('renameBtn').disabled = $('expirationBtn').disabled = $('archiveBtn').disabled = !accountManage;
  $('archiveBtn').textContent = 'Archive';
  $('backLibrary').hidden = false;
  renderAuthority();

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
  if (!$('threadPanel').hidden) placeInspector();
}

/**
 * Who is acting here: a capability link, a signed-in account, or both. The
 * content role a reader sees comes from the link they hold; management comes
 * from the account cookie. Saying so avoids implying one upgraded the other.
 */
function renderAuthority() {
  const note = $('authorityNote');
  const accountManage = !!info.canManage;
  const viaLink = !!link.token;
  let text = '';
  if (accountManage && viaLink) text = 'Signed in with management access. This link also grants its own access on its own.';
  else if (accountManage) text = 'Signed in with management access.';
  else if (viaLink && info.role === 'write') text = 'Opened with an edit link. Renaming and expiration belong to the artifact owner in the library.';
  else if (viaLink) text = 'Opened with a capability link. People and snapshots are managed by the owner in the library.';
  note.textContent = text;
  note.hidden = !text;
}

// ─── Comments: each thread is a ticket in the artifact's repository ─────────
//
// The panel lists the threads; the page draws a pin at each anchor it finds
// (page-pins.js) and tells the viewer which it placed. The page is sent
// anchors and labels only, never ticket text, and never a token.

let threads = [];
let threadsTruncated = false;
let responderStatus = { threads: {} }; // GET …/tickets `responder`, as last loaded
let threadSnapshot = '';
let threadRequest = 0;
let threadsLoading = 0;
let pins = [];           // what the page was last sent
let placed = null;       // labels the page placed, or null before it answered
let selection = '';      // the anchor of the reader's selection in the page
let focused = '';        // uuid of the thread a pin opened
let markersVisible = true; // local to this viewer; threads and anchors remain available
let placing = false;     // the placement toggle: the page takes the next click
let panelPoint = null;   // active anchor in the iframe's viewport coordinates
let bubblePoint = null;  // where the comment bubble was opened, in iframe coordinates
let bubbleAnchor = '';   // the bubble's own anchor, bound when it opens
let bubbleVersion = '';  // the check-in the bubble's draft was started on
let draftAnchor = '';    // a picked location survives closing the composer
let commentBusy = false;
let trackedAnchor = '';  // echoed by the page; stale position messages are ignored
const expanded = new Map(); // uuid -> open, once the reader toggled it
const drafts = new Map();   // uuid -> reply text not yet sent
const views = new Map();    // uuid -> its element in the panel
const attached = new Map(); // uuid -> its attachments, once loaded
const images = new Map();   // attachment link -> object URL of its image

async function loadAttachments(uuid) {
  let list = [];
  try { list = (await art.attachments(uuid)).attachments; } catch { /* offline or gone: show none */ }
  attached.set(uuid, list);
  const t = threads.find(item => item.uuid === uuid);
  if (t) threadView(t, controls(info));
}

// Fetched rather than linked: the viewer's CSP loads images only from blob: and data:.
async function showImage(img, url) {
  let src = images.get(url);
  if (!src) {
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) return;
    src = URL.createObjectURL(await res.blob());
    images.set(url, src);
  }
  img.src = src;
}

function attachmentItem(t, a, can) {
  const d = attachmentDisplay(a);
  const item = el('li', {});
  if (d.missing) item.append(el('span', { className: 'missing', textContent: `${d.label} · unavailable` }));
  else {
    item.append(el('a', { href: new URL(a.url, location.origin).href, download: a.name, rel: 'noopener', textContent: d.label }));
    if (d.inline) {
      const img = el('img', { alt: a.name });
      item.append(img);
      showImage(img, a.url);
    }
  }
  // A comment link may remove only what comment links attached (src/index.ts, Attachments).
  if (can.edit || (can.attach && a.user === 'comment-link')) {
    const remove = el('button', { type: 'button', className: 'detach', textContent: 'Remove' });
    remove.setAttribute('aria-label', `Remove ${a.name}`);
    remove.addEventListener('click', async () => {
      if (commentBusy) return;
      commentBusy = remove.disabled = true;
      try { await art.detach(t.uuid, a.name); await loadAttachments(t.uuid); }
      catch { remove.disabled = false; }
      finally { commentBusy = false; }
    });
    item.append(remove);
  }
  return item;
}

function attachmentList(t, can) {
  const list = attached.get(t.uuid);
  if (!list?.length) return null;
  return el('ul', { className: 'attachments' }, ...list.map(a => attachmentItem(t, a, can)));
}

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
  let view = views.get(t.uuid);
  if (!view) {
    view = el('details', {}, el('summary'), el('div', { className: 'thread-body' }));
    view.querySelector('summary').addEventListener('click', e => {
      if ($('threadPanel').dataset.mode !== 'index') return;
      e.preventDefault();
      const current = threads.find(item => item.uuid === t.uuid);
      if (!current) return;
      activateThread(current);
      if (anchored(current) === 'yes') post({ type: 'reveal', key: current.label });
    });
    // Remember only what the reader changed, using the latest status after a refresh.
    view.addEventListener('toggle', () => {
      if (view.open) loadAttachments(t.uuid);
      const current = threads.find(item => item.uuid === t.uuid);
      if (current) view.open === !current.resolved ? expanded.delete(t.uuid) : expanded.set(t.uuid, view.open);
    });
    views.set(t.uuid, view);
  }
  view.className = `thread${t.resolved ? ' resolved' : ''}${t.uuid === focused ? ' focus' : ''}`;
  view.querySelector('summary').replaceChildren(
    el('span', { className: 'num', textContent: String(t.label) }),
    el('span', { className: 'title', textContent: t.title }),
    el('span', { className: `tag${t.resolved ? ' latest' : ''}`, textContent: t.status }));
  const body = view.querySelector('.thread-body');
  let reply = body.querySelector('.reply');
  if (!can.commentBox) { reply?.remove(); reply = null; }
  if (can.commentBox && !reply) { reply = replyForm(t); body.append(reply); }
  // Keep the form itself: drafts, selection, focus, and pending/error state belong to it.
  for (const child of [...body.children]) if (child !== reply) child.remove();
  const content = [anchorLine(t),
    ...t.messages.filter((m, i) => i === 0 || m.text || m.status).map(m => {
      const item = el('div', {},
        el('div', { className: 'who', textContent: `${m.user} · ${ago(m.time)}${m.status ? ` · marked ${m.status}` : ''}` }),
        m.text ? el('p', { className: 'message', textContent: m.text }) : null);
      item.dataset.change = m.change;
      return item;
    }),
    t.checkins.length ? el('p', { className: 'checkins' }, 'Answered in ',
      ...t.checkins.flatMap((c, i) => [i ? ', ' : null, el('a', { href: fragment({ token: link.token, at: c }), textContent: shortId(c) })])) : null,
    attachmentList(t, can)];
  for (const child of content) if (child) body.insertBefore(child, reply);
  if (reply) {
    reply.querySelector('textarea').setAttribute('aria-label', `Reply to ${t.title}`);
    reply.querySelector('.resolve').textContent = t.resolved ? 'Reopen' : 'Resolve';
    reply.querySelector('.resolve').hidden = !can.moderate;
    reply.querySelector('.attach').hidden = !can.attach;
  }
  view.dataset.label = String(t.label);
  view.dataset.anchored = anchored(t);
  view.open = expanded.get(t.uuid) ?? (!t.resolved && t.uuid === focused);
  if (view.open && !attached.has(t.uuid)) loadAttachments(t.uuid);
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
  const files = el('input', { type: 'file', multiple: true, hidden: true });
  const attach = el('button', { type: 'button', className: 'attach', textContent: 'Attach' });
  attach.setAttribute('aria-label', `Attach files to ${t.title}`);
  attach.addEventListener('click', () => files.click());
  files.addEventListener('change', async () => {
    const chosen = [...files.files];
    files.value = '';
    if (!chosen.length || commentBusy) return;
    commentBusy = attach.disabled = true;
    status.textContent = 'Attaching…';
    try {
      for (const f of chosen) await art.attach(t.uuid, f.name, new Uint8Array(await f.arrayBuffer()), f.type || typeOf(f.name));
      status.textContent = '';
      await loadAttachments(t.uuid);
    } catch (err) {
      status.textContent = `Could not attach: ${err.message}`;
    } finally {
      commentBusy = attach.disabled = false;
    }
  });
  const form = el('form', { className: 'reply' }, text, files, el('div', { className: 'comment-actions' }, status, attach, resolve, send));
  const change = async (body, doing) => {
    if (commentBusy) return;
    commentBusy = resolve.disabled = send.disabled = text.readOnly = true;
    showPosting(status, doing, !!body.text);
    try {
      if (body.text) await guestUI.ensureProfile();
      await art.comment({ ticketUuid: t.uuid, ...body });
      if (body.text) { drafts.delete(t.uuid); text.value = ''; }
      if (body.status) expanded.delete(t.uuid);
      status.textContent = '';
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
  resolve.addEventListener('click', () => {
    const current = threads.find(item => item.uuid === t.uuid);
    if (current) change({ status: current.resolved ? 'Open' : 'Closed' }, current.resolved ? 'Reopening…' : 'Resolving…');
  });
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
  const active = document.activeElement;
  if (active?.matches('.reply textarea')) {
    const editing = [...views].find(([, view]) => view.contains(active));
    if (editing) expanded.set(editing[0], true);
  }
  const scroll = panelScroller()?.scrollTop ?? 0;
  const inputScroll = active?.scrollTop;
  for (const [id, items] of [['threadList', open], ['resolvedList', resolved]]) {
    const list = $(id), nodes = items.map(t => threadView(t, can));
    nodes.forEach((node, i) => { if (list.children[i] !== node) list.insertBefore(node, list.children[i] ?? null); });
    const keep = new Set(nodes);
    for (const child of [...list.children]) if (!keep.has(child)) child.remove();
  }
  for (const uuid of views.keys()) if (!threads.some(t => t.uuid === uuid)) views.delete(uuid);
  $('resolvedHead').hidden = !resolved.length;
  if ($('threadPanel').dataset.mode === 'thread') {
    const current = threads.find(t => t.uuid === focused);
    if (current) $('panelTitle').textContent = `Comment ${current.label}`;
  }
  // Moving a thread between groups can blur its form on browsers without moveBefore.
  if (active?.isConnected && active.closest('.reply')) {
    if (document.activeElement !== active) active.focus({ preventScroll: true });
    active.scrollTop = inputScroll;
  }
  if (panelScroller()) panelScroller().scrollTop = scroll;
  paintProgress();
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
  $('bubbleAnchor').textContent = anchorName(anchor) || 'This page location';
  $('placeComment').hidden = $('generalComment').hidden = !controls(info).commentBox;
  $('commentsBtn').hidden = !controls(info).commentBox;
  if (!controls(info).commentBox && placing) setPlacement(false);
  $('placeComment').textContent = draftAnchor ? 'Continue draft' : 'Place a comment';
  $('generalComment').textContent = selection ? 'Comment on selection' : 'General comment';
  $('bubbleGeneral').hidden = !controls(info).commentBox;
}

/** A message to the page's pins (page-pins.js). The page's origin is opaque, so '*'. */
function post(message) {
  const page = $('frame').contentWindow;
  if (frameReady && page) page.postMessage({ __artifactPins: 1, ...message }, '*');
}

// ─── Backdrop: what shows behind and beyond the page ───────────────────────

// The page's canvas as it last reported it (backdrop.js), or null. #frame is
// painted with it: that is what shows wherever the page's own canvas does not
// reach, such as a transparent document and the strip a rubber-band scroll
// reveals. With no canvas, #frame keeps the viewer's ground (viewer.css), and
// the page itself follows the viewer's scheme, so a transparent page is never a
// light slab in a dark viewer or the reverse.
let pageCanvas = null;

function paintBackdrop() {
  const frame = $('frame');
  if (pageCanvas) frame.style.backgroundColor = pageCanvas;
  else frame.style.removeProperty('background-color');
}

addEventListener('message', e => {
  const d = e.data;
  if (e.source !== $('frame').contentWindow || !d || d.__artifactBackdrop !== 1) return;
  // Only a computed colour crosses the boundary; a page cannot set a
  // declaration, a URL or markup here.
  pageCanvas = backdropColor(d.color);
  paintBackdrop();
});

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

function sendAppearance() {
  if (frameReady) $('frame').contentWindow.postMessage({
    __artifactAppearance: 1, theme: document.documentElement.dataset.theme || 'system',
  }, '*');
}
// Keep the page instance, form state and scroll position while switching.
new MutationObserver(() => { sendAppearance(); sendPins(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sendPins);

// The sandbox is untrusted. It can suggest a position, never post a comment,
// confer permission, or take a draft away from the reader.
const pagePoint = d => Number.isFinite(d.x) && Number.isFinite(d.y)
  && Math.abs(d.x) <= 10_000_000 && Math.abs(d.y) <= 10_000_000 ? { x: d.x, y: d.y } : null;
function isTyping() {
  const active = document.activeElement;
  return active?.matches('#threadPanel textarea, #bubbleText') && active.value.trim();
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
    // A pin opens its thread where the reader clicked it, as an anchored card,
    // and placement stays armed: the next blank-page click starts a new one.
    activateThread(t, pagePoint(d) ?? { x: $('frame').clientWidth / 2, y: 40 }, { keepPlacement: true, card: true });
  } else if (d.type === 'selection' && typeof d.anchor === 'string' && controls(info).commentBox) {
    selection = Array.from(d.anchor).slice(0, 500).join('');
    renderAnchor();
  } else if (d.type === 'point' && placing && controls(info).commentBox && pagePoint(d)
    && decodePointAnchor(d.anchor)) {
    draftAnchor = d.anchor;
    selection = '';
    // Placement is a mode, not one shot: taking a point opens the bubble and
    // leaves the toggle on, so another click moves the bubble without re-arming.
    openBubble(pagePoint(d));
    renderAnchor();
    trackAnchor(draftAnchor);
  } else if (d.type === 'position' && !$('threadPanel').hidden && trackedAnchor && d.anchor === trackedAnchor) {
    if (d.unavailable === true) {
      panelPoint = null;
      $('commentsNote').textContent = 'Location not found';
    } else if (pagePoint(d)) {
      panelPoint = pagePoint(d);
      placeInspector();
    }
  } else if (d.type === 'cancel' && placing) {
    setPlacement(false);
    closeBubble(true);
    closeInspector(true);
  } else if (d.type === 'dismiss' && !placing && !isTyping() && !commentBusy) {
    closePopovers();
  }
});

async function loadThreads(background = false) {
  if (!controls(info).threads || (background && (commentBusy || threadsLoading))) return;
  const request = ++threadRequest;
  threadsLoading++;
  try {
    const result = await art.tickets();
    if (request !== threadRequest || (background && commentBusy)) return;
    const snapshot = JSON.stringify(result);
    if (snapshot === threadSnapshot) return;
    threads = result.tickets.map(thread);
    threadsTruncated = result.truncated;
    responderStatus = result.responder ?? { threads: {} };
    threadSnapshot = snapshot;
    renderThreads();
  } catch { /* offline or gone: keep what is shown */ }
  finally { threadsLoading--; }
}

function refreshThreads() {
  if (document.visibilityState === 'visible' && art && info && !$('threadPanel').hidden) loadThreads(true);
}
setInterval(refreshThreads, COMMENT_WATCH_MS);
document.addEventListener('visibilitychange', refreshThreads);

// Content polling says nothing about the cookie, so re-read it on its own
// schedule: a signed-out or switched account loses the sidebar and management
// panel instead of keeping either from a page it loaded earlier.
const SESSION_WATCH_MS = 60_000;
function revalidateAccount() {
  if (document.visibilityState !== 'visible') return;
  confirmAccount({ fresh: true }).then(id => {
    if (!id) return;
    // A page restored for another account (or a first confirmation) has no
    // account chrome or inventory yet: build both, never reuse the old ones.
    if (sidebarUnavailable) { showAccountChrome(); loadLibrary(); }
    else if (navOpen) loadLibrary();
    if (!$('shareMenu').hidden && !$('guestManagement').hidden) guestUI.loadGuests(false, { revalidateOnly: true });
  });
}
setInterval(revalidateAccount, SESSION_WATCH_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') revalidateAccount(); });
// A page restored from the back/forward cache may hide a sign-out that happened
// elsewhere; its account UI is revalidated before it is trusted again.
addEventListener('pageshow', e => { if (e.persisted) revalidateAccount(); });

/** A comment on its way: "Sending…" with dots when a responder will get it, else `doing`. */
function showPosting(status, doing, comment) {
  if (comment && info?.attached?.responder) status.replaceChildren(dots(), ' Sending…');
  else status.textContent = doing;
}

/** Dots that say "in progress"; still under prefers-reduced-motion (viewer.css). */
const dots = () => {
  const d = el('span', { className: 'dots' }, el('i'), el('i'), el('i'));
  d.setAttribute('aria-hidden', 'true');
  return d;
};

/**
 * One node that shows `p`. While its `key` is unchanged the node stays, so its
 * dots keep their rhythm, and only its text and elapsed time are refreshed.
 */
function progressNode(old, cls, key, p, build) {
  if (old?.dataset.key === key) {
    const fresh = build();
    for (const part of ['.text', '.elapsed']) {
      const was = old.querySelector(part), now = fresh.querySelector(part);
      if (was && now && was.textContent !== now.textContent) was.replaceWith(now);
    }
    return old;
  }
  const node = build();
  node.classList.add(cls);
  node.dataset.key = key;
  old?.replaceWith(node);
  return node;
}

function receiptNode(r) {
  return el('p', {}, el('span', { className: `ticks${r.on ? ' on' : ''}`, textContent: r.ticks }), el('span', { className: 'text', textContent: r.text }));
}

function activityNode(a) {
  const text = el('span', { className: 'text' }, a.who ? el('strong', { textContent: a.who }) : null, a.who ? ` ${a.text}` : a.text);
  // Announce what changes, not the clock ticking every second.
  const elapsed = a.elapsed ? el('span', { className: 'elapsed', textContent: a.elapsed }) : null;
  elapsed?.setAttribute('aria-hidden', 'true');
  const node = el('div', { className: `tone-${a.tone}` }, a.dots ? dots() : null, text, elapsed);
  node.setAttribute('role', 'status');
  return node;
}

function rowNode(r) {
  return el('span', {}, r.dots ? dots() : null, r.ticks ? el('span', { className: 'ticks', textContent: r.ticks }) : null, el('span', { className: 'text', textContent: r.text }));
}

/**
 * The attached responder's progress on each thread: receipts under the
 * reader's latest comment, an activity line above the reply box and a word
 * in the list row. Derived again on every poll and every second; only the
 * nodes whose content changed are replaced, never the reply form.
 */
function paintProgress() {
  const name = info?.attached?.responder;
  const progress = responderProgress({ threads, status: responderStatus, responder: typeof name === 'string' ? name : '', now: Date.now(), guestDiscussion: !!info.guestDiscussion });
  for (const [uuid, view] of views) {
    const p = progress.get(uuid);
    const body = view.querySelector('.thread-body');
    const receiptAt = p?.receipt && [...body.children].find(c => c.dataset.change === p.receipt.change);
    const oldReceipt = body.querySelector('.receipts');
    if (receiptAt) {
      const node = progressNode(oldReceipt, 'receipts', JSON.stringify(p.receipt), p.receipt, () => receiptNode(p.receipt));
      if (node.parentNode !== receiptAt) receiptAt.append(node);
    } else oldReceipt?.remove();
    const oldActivity = body.querySelector('.activity');
    if (p?.activity) {
      const a = p.activity;
      const node = progressNode(oldActivity, 'activity', JSON.stringify([a.tone, a.dots, a.who, !!a.elapsed]), a, () => activityNode(a));
      const reply = body.querySelector('.reply');
      if (node.nextSibling !== reply || node.parentNode !== body) body.insertBefore(node, reply);
    } else oldActivity?.remove();
    const summary = view.querySelector('summary'), oldRow = summary.querySelector('.progress');
    if (p?.row) {
      const node = progressNode(oldRow, 'progress', JSON.stringify(p.row), p.row, () => rowNode(p.row));
      if (node.parentNode !== summary) summary.insertBefore(node, summary.querySelector('.tag'));
    } else oldRow?.remove();
  }
}
// The elapsed time ticks locally; the 5-second poll above is the only request.
setInterval(() => {
  if (document.visibilityState === 'visible' && info?.attached && !$('threadPanel').hidden) paintProgress();
}, 1000);

function renderResponder() {
  const n = responderNote(info);
  $('responderNote').dataset.attached = String(n.attached);
  $('responderHead').textContent = n.headline;
  $('responderName').textContent = n.name;
  $('responderContact').textContent = n.contact ? `(${n.contact})` : '';
}

// ─── The inspector: version history or comments, one at a time ─────────────
//
// Two comment shapes, one element. The discussion index overlays the page;
// version history alone docks beside it on wide screens. A thread opened
// from a pin is instead an anchored card: the
// same panel, positioned by the click, clamped to the page area, and never
// reshaping the iframe. Opening, switching, closing or resizing any of them
// never reloads the page: the iframe keeps its document, scroll position and
// selection, and the panel keeps its drafts and expanded threads because they
// live in this module, not in the DOM.
//
// Comments are two different motions. The comments button is a placement
// toggle: while it is on, a click on the page drops a comment bubble right
// where the reader clicked, over the page, without opening the inspector or
// reflowing anything. A click on an existing pin opens that thread's card at
// the pin, and leaves the toggle alone.

const inspectorQuery = matchMedia('(max-width: 1050px)');
let inspectorMode = ''; // '' when closed, else 'comments' or 'history'
let inspectorReturn = null; // the control that opened it, focused again on close
let inspectorCard = false;  // a thread opened from a pin, anchored over the page

function panelScroller() {
  return $('threadPanel').hidden ? ($('historyPanel').hidden ? null : $('historyPanel').querySelector('.panel-scroll')) : $('threadPanel').querySelector('.panel-scroll');
}

/** A thread opened from a pin reads as a card; the index and history do not. */
const cardMode = () => inspectorCard && inspectorMode === 'comments' && $('threadPanel').dataset.mode === 'thread';

const CARD_WIDE = 380, CARD_NARROW = 360, CARD_MAX_H = 640, CARD_HINT = 420;

/**
 * The visible area an anchored card may occupy: the page's box, trimmed by the
 * keyboard or URL bar the visual viewport reports. Position is fixed, so
 * visualViewport offsets are added back to viewport coordinates.
 */
function overlayBounds() {
  const frame = pageBounds();
  const vv = visualViewport;
  if (!vv) return frame;
  const left = Math.max(frame.left, vv.offsetLeft);
  const top = Math.max(frame.top, vv.offsetTop);
  const right = Math.min(frame.left + frame.width, vv.offsetLeft + vv.width);
  const bottom = Math.min(frame.top + frame.height, vv.offsetTop + vv.height);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** The panel's card geometry for the anchor at `point`, or null when it is not a card. */
function cardPlacement(point) {
  if (!cardMode() || !point) return null;
  const bounds = overlayBounds();
  const width = Math.min(innerWidth <= 640 ? CARD_NARROW : CARD_WIDE, Math.max(0, bounds.width));
  const maxHeight = Math.min(CARD_MAX_H, Math.max(0, bounds.height - 24));
  // A hidden panel has no height to measure; a card that is already showing
  // gives its real one, so a flip decision matches what the reader sees.
  const inspector = $('inspector');
  const measured = inspector.hidden ? 0 : inspector.getBoundingClientRect().height;
  const height = Math.min(maxHeight, measured > 0 ? measured : CARD_HINT);
  const frame = pageBounds();
  const origin = { x: frame.left + point.x, y: frame.top + point.y };
  const spot = bubblePlacement(origin, { width, height }, bounds);
  return { ...spot, width, maxHeight };
}

/** Place the card, or clear stale geometry when the panel is docked. Also keeps the bubble in view. */
function placeInspector() {
  const card = cardPlacement(panelPoint);
  const inspector = $('inspector');
  inspector.classList.toggle('card', !!card);
  for (const property of ['top', 'left', 'width', 'max-height']) inspector.style.removeProperty(property);
  if (card) {
    // Fixed in viewport coordinates: the card stands over the page and takes
    // no room in the viewer's flex row, so the iframe keeps its width.
    Object.assign(inspector.style, {
      top: `${card.y}px`, left: `${card.x}px`, width: `${card.width}px`, maxHeight: `${card.maxHeight}px`,
    });
  }
  if (bubbleVisible()) placeBubble();
}

/** Frame and keyboard changes move the card with the page; it never moves the page. */
function placeOverlays() {
  placeInspector();
  if (bubbleVisible()) placeBubble();
}
new ResizeObserver(placeOverlays).observe($('frame'));
visualViewport?.addEventListener('resize', placeOverlays);
visualViewport?.addEventListener('scroll', placeOverlays);

// ─── The comment bubble: an overlay at the reader's click ──────────────────
//
// The bubble is a card in the viewer, not the page: it floats over the page's
// box and never changes the iframe's size, so the page itself does not reflow
// when someone comments. Posting still uses the same ticket route; the anchor
// is the clicked location, already decoded by the page and re-validated here.

const bubble = () => $('commentBubble');

function bubbleVisible() { return !!bubblePoint && !$('commentBubble').hidden; }

/** The page's visible area in the viewer's viewport, as the bubble's bounds. */
function pageBounds() {
  const r = $('frame').getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function placeBubble() {
  if (!bubbleVisible()) return;
  const bounds = overlayBounds();
  // A phone keyboard can leave less space than the composer's natural height.
  // Bound the box first, then measure it; its contents remain scrollable.
  bubble().style.maxHeight = `${Math.max(0, bounds.height - 16)}px`;
  bubble().style.maxWidth = `${Math.max(0, bounds.width - 16)}px`;
  const rect = bubble().getBoundingClientRect();
  const size = { width: rect.width || 320, height: rect.height || 200 };
  const frame = pageBounds();
  const point = { x: frame.left + bubblePoint.x, y: frame.top + bubblePoint.y };
  const spot = bubblePlacement(point, size, bounds);
  bubble().style.left = `${spot.x}px`;
  bubble().style.top = `${spot.y}px`;
}

function openBubble(point) {
  bubblePoint = point;
  bubbleAnchor = draftAnchor;
  bubbleVersion = shown?.checkin ?? '';
  $('bubbleStatus').textContent = '';
  closeInspector();
  $('commentBubble').hidden = false;
  renderAnchor();
  placeBubble();
  requestAnimationFrame(placeBubble);
  $('bubbleText').focus({ preventScroll: true });
}

/**
 * Close the bubble. The words go to the panel draft for "Continue draft"
 * only when no post is in flight: during a post they belong to the request,
 * and copying them would leave a second, unsent comment behind.
 * `keepAnchor` false is for a page swap, where the old anchor and version are
 * meaningless; the words still survive as a draft.
 */
function closeBubble(restore = false, { keepPlacing = false, keepAnchor = true } = {}) {
  if (!bubbleVisible()) return;
  const text = $('bubbleText').value;
  const panelDraft = $('commentText').value;
  // Transfer into an empty panel draft, but keep a second draft in its own
  // textarea when both contain different words. The next placed bubble resumes it.
  const separateDraft = !commentBusy && text.trim() && panelDraft.trim() && text !== panelDraft;
  if (!commentBusy && text.trim() && !panelDraft.trim()) $('commentText').value = text;
  if (!keepAnchor) { draftAnchor = ''; bubbleVersion = ''; }
  if (!separateDraft) $('bubbleText').value = '';
  $('bubbleStatus').textContent = '';
  bubblePoint = null;
  bubbleAnchor = '';
  $('commentBubble').hidden = true;
  if (!keepPlacing) setPlacement(false);
  if (restore) $('commentsBtn').focus({ preventScroll: true });
}

/** A new check-in replaces the page under the bubble: keep the words, drop its location. */
function closeBubbleForPage() {
  closeBubble(false, { keepPlacing: false, keepAnchor: false });
}

/** Ask the page to accept a comment location, or stop asking. */
function setPlacement(active) {
  placing = active && !commentBusy && !!info && controls(info).commentBox;
  $('commentsBtn').setAttribute('aria-pressed', String(placing));
  $('commentsBtn').setAttribute('aria-label', placing ? 'Stop placing comments' : 'Place comments on the page');
  $('commentsBtn').title = placing ? 'Stop placing comments' : 'Place comments on the page';
  $('placementHint').hidden = !placing;
  $('cancelPlacement').hidden = !placing;
  post({ type: 'placement', active: placing });
}

function openInspector(mode, threadMode = 'index', point = null, { keepPlacement = false, card = false } = {}) {
  const wasOpen = !!inspectorMode;
  // The control that opened the inspector is where focus returns on close.
  const returnTo = wasOpen ? inspectorReturn : document.activeElement;
  closePopovers('inspector', { keepPlacement });
  if (!keepPlacement) setPlacement(false);
  closeBubble(false, { keepPlacing: keepPlacement });
  inspectorReturn = returnTo;
  inspectorMode = mode;
  inspectorCard = card && !!point;
  $('inspector').classList.toggle('comments-overlay', mode === 'comments');
  $('inspector').hidden = false;
  $('threadPanel').hidden = mode !== 'comments';
  $('historyPanel').hidden = mode !== 'history';
  $('versionBtn').setAttribute('aria-expanded', String(mode === 'history'));
  $('discussionsBtn').setAttribute('aria-expanded', String(mode === 'comments'));
  if (mode === 'comments') {
    const panel = $('threadPanel');
    panel.dataset.mode = threadMode;
    panelPoint = point;
    $('panelTitle').textContent = threadMode === 'draft' ? 'New comment' : threadMode === 'thread' ? 'Comment' : 'Comments';
    $('allComments').hidden = threadMode === 'index';
    $('commentForm').hidden = !controls(info).commentBox || threadMode !== 'draft';
    if (threadMode === 'index') {
      focused = '';
      for (const view of views.values()) view.classList.remove('focus');
      trackAnchor('');
    }
    // The card's geometry is chosen in the same task as the unhide, before any
    // paint, so a pin-opened thread never flashes the docked column.
    placeInspector();
    loadThreads(true);
    if (!wasOpen && threadMode === 'index') $('threadClose').focus({ preventScroll: true });
  } else {
    renderVersions();
  }
  requestAnimationFrame(placeInspector);
}

function closeInspector(restore = false) {
  if (!inspectorMode) return;
  inspectorMode = '';
  inspectorCard = false;
  $('inspector').hidden = true;
  $('inspector').classList.remove('card');
  for (const property of ['top', 'left', 'width', 'max-height']) $('inspector').style.removeProperty(property);
  $('threadPanel').hidden = true;
  $('historyPanel').hidden = true;
  $('versionBtn').setAttribute('aria-expanded', 'false');
  $('discussionsBtn').setAttribute('aria-expanded', 'false');
  panelPoint = null;
  trackAnchor('');
  const back = restore ? inspectorReturn : null;
  inspectorReturn = null;
  if (back?.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
}

function activateThread(t, point = null, { keepPlacement = false, card = false } = {}) {
  const view = views.get(t.uuid);
  if (!view) return;
  focused = t.uuid;
  expanded.set(t.uuid, true);
  for (const other of views.values()) other.classList.toggle('focus', other === view);
  view.open = true;
  openInspector('comments', 'thread', point, { keepPlacement, card });
  $('panelTitle').textContent = `Comment ${t.label}`;
  trackAnchor(t.anchor);
  const target = views.get(t.uuid);
  if (target && panelScroller()) panelScroller().scrollTop = 0;
  requestAnimationFrame(() => { placeInspector(); target?.scrollIntoView({ block: 'nearest' }); });
}

/** The placement toggle: on asks the page for the next click; off stops asking. */
$('commentsBtn').addEventListener('click', e => {
  e.stopPropagation();
  if (commentBusy || !info || !controls(info).commentBox) return;
  if (placing) { setPlacement(false); return; }
  if (!markersVisible) setMarkerVisibility(true);
  closePopovers('inspector');
  closeBubble();
  closeInspector();
  setPlacement(true);
  $('frame').focus();
});
$('discussionsBtn').addEventListener('click', e => {
  e.stopPropagation();
  if (inspectorMode === 'comments' && $('threadPanel').dataset.mode === 'index') closeInspector(true);
  else openInspector('comments');
});
$('versionBtn').addEventListener('click', e => {
  e.stopPropagation();
  if (inspectorMode === 'history') closeInspector(true);
  else openInspector('history');
});
$('threadClose').addEventListener('click', () => closeInspector(true));
$('historyClose').addEventListener('click', () => closeInspector(true));
$('allComments').addEventListener('click', () => openInspector('comments'));
$('inspector').addEventListener('click', e => e.stopPropagation());
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
  openInspector('comments', 'draft');
  $('commentText').focus();
});
$('placeComment').addEventListener('click', () => {
  if (commentBusy || !controls(info).commentBox) return;
  if (!markersVisible) setMarkerVisibility(true);
  if (draftAnchor) {
    openInspector('comments', 'draft', { x: $('frame').clientWidth / 2, y: 40 });
    trackAnchor(draftAnchor);
    $('commentText').focus();
    return;
  }
  closePopovers();
  setPlacement(true);
  $('frame').focus();
});
$('cancelPlacement').addEventListener('click', e => {
  e.stopPropagation();
  setPlacement(false);
  $('commentsBtn').focus({ preventScroll: true });
});
$('bubbleClose').addEventListener('click', () => { if (!commentBusy) closeBubble(true); });
$('bubbleCancel').addEventListener('click', () => {
  if (commentBusy) return;
  $('bubbleText').value = '';
  selection = draftAnchor = '';
  closeBubble(true);
  renderAnchor();
});
$('bubbleGeneral').addEventListener('click', () => {
  if (commentBusy || !controls(info).commentBox) return;
  const text = $('bubbleText').value;
  const panelDraft = $('commentText').value;
  if (panelDraft.trim() && panelDraft !== text) {
    $('bubbleStatus').textContent = 'Another draft is in Discussions. Post or cancel it before moving this comment.';
    return;
  }
  closeBubble();
  selection = draftAnchor = '';
  $('bubbleText').value = '';
  openInspector('comments', 'draft');
  // The bubble is gone, so closing the panel returns to the control that
  // still exists rather than to a hidden form.
  inspectorReturn = $('discussionsBtn');
  $('commentText').value = text;
  $('commentText').focus();
});
$('cancelComment').addEventListener('click', () => {
  if (commentBusy) return;
  $('commentText').value = '';
  selection = draftAnchor = '';
  $('commentStatus').textContent = '';
  closeInspector(true);
  renderAnchor();
});
$('inspector').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeInspector(true); }
});
$('commentBubble').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!commentBusy) closeBubble(true); }
});
$('commentBubble').addEventListener('click', e => e.stopPropagation());
addEventListener('resize', placeBubble);

/** Post a comment from either composer. `fromBubble` keeps the bubble's flow. */
async function postComment({ text, anchor, version, status, button, inputs, fromBubble }) {
  if (!text || commentBusy || !controls(info).commentBox) return;
  commentBusy = button.disabled = true;
  for (const input of inputs) input.readOnly = true;
  showPosting(status, 'Posting…', true);
  let posted = null;
  try {
    await guestUI.ensureProfile();
    // The version on screen, so a responder can read the page as the reader saw it.
    const result = await art.comment({ text, ...(anchor ? { anchor } : {}), ...(version ? { version } : {}) });
    for (const input of inputs) input.value = '';
    selection = draftAnchor = '';
    status.textContent = 'Posted.';
    if (fromBubble) closeBubble(false, { keepPlacing: true });
    await loadThreads();
    posted = threads.find(t => t.uuid === result.ticketUuid);
    if (fromBubble && posted) {
      // The bubble is done; the posted thread is one click away in the panel.
      if (markersVisible) post({ type: 'reveal', key: posted.label });
      $('commentsBtn').focus({ preventScroll: true });
      notice(`Comment ${posted.label} posted.`);
    } else if (posted && panelPoint && !fromBubble) activateThread(posted, panelPoint);
    else if (!fromBubble) openInspector('comments');
  } catch (err) {
    status.textContent = `Could not post: ${err.message}`;
  } finally {
    commentBusy = button.disabled = false;
    for (const input of inputs) input.readOnly = false;
  }
}

$('commentBubble').addEventListener('submit', e => {
  e.preventDefault();
  postComment({
    text: $('bubbleText').value.trim(),
    anchor: bubbleAnchor,
    version: bubbleVersion,
    status: $('bubbleStatus'),
    button: $('commentBubble').querySelector('button[type=submit]'),
    inputs: [$('bubbleText')],
    fromBubble: true,
  });
});

$('commentForm').addEventListener('submit', e => {
  e.preventDefault();
  postComment({
    text: $('commentText').value.trim(),
    anchor: draftAnchor || selection,
    version: shown?.checkin,
    status: $('commentStatus'),
    button: $('commentForm').querySelector('button[type=submit]'),
    inputs: [$('commentText')],
    fromBubble: false,
  });
});

function renderVersions() {
  const count = info.timeline.length;
  $('versionCount').textContent = `${count} check-in${count === 1 ? '' : 's'}`;
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
    item.setAttribute('aria-current', String(c.uuid === shown.checkin));
    return item;
  }));
  // The version the reader is on, so a long history opens where they are.
  const active = $('versionList').querySelector('[aria-current="true"]');
  if (active && inspectorMode === 'history') $('historyPanel').querySelector('.panel-scroll').scrollTop = Math.max(0, active.offsetTop - 48);
}

// ─── Manage: rename, expiration, archive (signed-in management only) ───────

/** A same-origin cookie call. Never a capability Authorization header. */
async function manageRequest(path, { method = 'GET', body } = {}) {
  // Reads may use the page's last confirmed identity; a write revalidates it
  // first so a restored page cannot change an artifact after sign-out.
  if (method !== 'GET' && !(await managementAuthorization())) {
    throw new Error('Sign in again to manage this artifact.');
  }
  const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
  const response = await fetch(path, {
    method, headers, credentials: 'same-origin', cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const detail = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof detail?.error === 'string' ? detail.error : `Request failed (HTTP ${response.status}).`);
  return detail;
}
const managePath = suffix => `/api/artifacts/${encodeURIComponent(art.id)}/${suffix}`;

function dialogClose(dialog) { if (dialog.open) dialog.close(); }
for (const dialog of [$('renameDialog'), $('expirationDialog')]) {
  dialog.addEventListener('click', e => { if (e.target === dialog) dialogClose(dialog); });
  for (const button of dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => dialogClose(dialog));
}

function localDateTimeValue(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

$('renameBtn').addEventListener('click', () => {
  closePopovers();
  $('renameTitle').value = info.title || '';
  $('renameStatus').textContent = '';
  $('renameDialog').showModal();
  $('renameTitle').focus();
  $('renameTitle').select();
});
$('renameForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!info.canManage) return;
  const title = $('renameTitle').value.trim();
  if (!title) { $('renameStatus').textContent = 'A title is required.'; return; }
  const submit = $('renameForm').querySelector('[type=submit]');
  submit.disabled = $('renameTitle').readOnly = true;
  $('renameStatus').textContent = 'Saving…';
  const epoch = identityEpoch, owner = accountId;
  try {
    await manageRequest(managePath('manage'), { method: 'PATCH', body: { title } });
    if (!stillCurrent(epoch, owner)) return; // another account owns this page now
    info.title = title;
    $('renameStatus').textContent = 'Saved.';
    renderChrome();
    dialogClose($('renameDialog'));
    notice('Title saved.');
  } catch (err) {
    if (!stillCurrent(epoch, owner)) return;
    $('renameStatus').textContent = `Could not rename: ${err.message}`;
  } finally {
    submit.disabled = $('renameTitle').readOnly = false;
  }
});

$('expirationBtn').addEventListener('click', () => {
  closePopovers();
  $('expiryMode').value = info.expiresAt ? 'date' : 'never';
  $('expiryDate').value = info.expiresAt ? localDateTimeValue(info.expiresAt) : '';
  $('expiryDate').disabled = $('expiryMode').value === 'never';
  $('expiryDateLabel').hidden = $('expiryMode').value === 'never';
  $('expirationStatus').textContent = info.expiresAt
    ? `Currently expires ${new Date(info.expiresAt).toLocaleString()}.`
    : 'This artifact does not expire.';
  $('expirationDialog').showModal();
  if ($('expiryMode').value === 'date') $('expiryDate').focus(); else $('expiryMode').focus();
});
$('expiryMode').addEventListener('change', () => {
  const never = $('expiryMode').value === 'never';
  $('expiryDate').disabled = never;
  $('expiryDateLabel').hidden = never;
  if (!never) $('expiryDate').focus();
});
$('expirationForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!info.canManage) return;
  let expiresAt;
  if ($('expiryMode').value === 'never') expiresAt = null;
  else {
    const chosen = new Date($('expiryDate').value);
    if (!chosen.getTime()) { $('expirationStatus').textContent = 'Choose a date and time, or choose Never expires.'; return; }
    if (chosen.getTime() <= Date.now()) { $('expirationStatus').textContent = 'Choose a time in the future.'; return; }
    expiresAt = chosen.toISOString();
  }
  const submit = $('expirationForm').querySelector('[type=submit]');
  submit.disabled = true;
  $('expirationStatus').textContent = 'Saving…';
  const epoch = identityEpoch, owner = accountId;
  try {
    const result = await manageRequest(managePath('manage'), { method: 'PATCH', body: { expiresAt } });
    if (!stillCurrent(epoch, owner)) return;
    info.expiresAt = expiresAt;
    renderShare();
    dialogClose($('expirationDialog'));
    notice(result?.expirationPending ? 'Expiration update accepted. The library is still updating.' : expiresAt ? 'Expiration saved.' : 'Expiration cleared.');
  } catch (err) {
    if (!stillCurrent(epoch, owner)) return;
    $('expirationStatus').textContent = `Could not save: ${err.message}`;
  } finally {
    submit.disabled = false;
  }
});

$('archiveBtn').addEventListener('click', async () => {
  closePopovers();
  if (!info.canManage) return;
  // The artifact info carries no archive flag, so archive is a one-way action
  // here; Archived in the library is where it is restored.
  if (!confirm(`Archive “${info.title}”? It leaves the library but its links keep working. Restore it from Archived in the library.`)) return;
  const button = $('archiveBtn');
  button.disabled = true;
  try {
    await manageRequest(managePath('manage'), { method: 'PATCH', body: { archived: true } });
    notice('Archived. It leaves the library and its links keep working.');
    loadLibrary(true);
  } catch (err) {
    notice(`Could not archive: ${err.message}`);
  } finally {
    button.disabled = false;
  }
});

// ─── People: named access, from the sharing endpoint ───────────────────────

let people = { grants: [], users: [], ownerId: '' };
let peopleLoading = false; // a refresh of the list is in flight
let peopleSaving = false;  // a grant change is in flight
let peopleError = '';
let peopleLoaded = false;

function personName(user) {
  return user.name && user.name !== user.email ? user.name : user.email || 'Signed-in account';
}

async function loadPeople(refetch = false) {
  if (!info?.canManage) return false;
  if (peopleLoading) return false;
  if (peopleLoaded && !refetch) { renderPeople(); return true; }
  peopleLoading = true;
  $('peopleError').hidden = true;
  $('peopleStatus').textContent = peopleSaving ? 'Saving access…' : 'Loading people…';
  const epoch = identityEpoch, owner = accountId;
  let ok = false;
  try {
    // People are account data: confirm the cookie still owns this page first.
    if (!(await confirmAccount({ fresh: true }))) throw new Error('Sign in again to see who has access.');
    if (!stillCurrent(epoch, owner)) return false; // a newer identity owns this panel now
    const next = await manageRequest(managePath('sharing'));
    if (!stillCurrent(epoch, owner)) return false;
    people = next;
    peopleLoaded = true;
    peopleError = '';
    ok = true;
  } catch (err) {
    if (!stillCurrent(epoch, owner)) return false;
    peopleError = err.message;
  } finally {
    peopleLoading = false;
    $('peopleStatus').textContent = peopleSaving ? 'Saving access…' : '';
    renderPeople();
  }
  return ok;
}

function renderPeople() {
  $('peopleSection').hidden = !info?.canManage;
  if (!info?.canManage) return;
  const busy = peopleLoading || peopleSaving;
  $('peopleError').textContent = peopleError;
  $('peopleError').hidden = !peopleError;
  const byId = new Map(people.users.map(u => [u.id, u]));
  $('peopleList').replaceChildren(...people.grants.map(grant => {
    const user = byId.get(grant.userId) ?? grant;
    const permission = el('select', { className: 'permission', 'aria-label': `Permission for ${personName(user)}` },      el('option', { value: 'read', textContent: 'Can view' }), el('option', { value: 'write', textContent: 'Can edit' }));
    permission.value = grant.permission;
    permission.disabled = busy;
    permission.addEventListener('change', () => saveGrant(grant.userId, permission.value, permission));
    const remove = el('button', { type: 'button', className: 'remove', textContent: 'Remove', disabled: busy });
    remove.setAttribute('aria-label', `Remove access for ${personName(user)}`);
    remove.addEventListener('click', () => saveGrant(grant.userId, null, remove));
    return el('div', { className: 'person-row' },
      el('span', { className: 'person-name' }, el('strong', { textContent: personName(user) }), el('small', { textContent: user.email && user.email !== personName(user) ? user.email : '' })),
      permission, remove);
  }));
  if (!people.grants.length) $('peopleList').append(el('p', { className: 'hint', textContent: 'No one else has named access yet.' }));

  // Only people who could actually be granted access, from the same endpoint.
  const granted = new Set(people.grants.map(g => g.userId));
  $('peoplePick').replaceChildren(el('option', { value: '', textContent: 'Choose a person…' }),
    ...people.users.filter(u => !granted.has(u.id)).map(u => el('option', { value: u.id, textContent: personName(u) })));
  const eligible = people.users.some(u => !granted.has(u.id));
  $('peopleForm').hidden = !eligible;
  $('peoplePick').disabled = busy;
  $('peoplePermission').disabled = busy;
  $('peopleForm').querySelector('[type=submit]').disabled = busy;
}

async function saveGrant(userId, permission, control) {
  if (peopleLoading || peopleSaving || !info.canManage) return;
  peopleSaving = true;
  peopleError = '';
  control.disabled = true;
  $('peopleStatus').textContent = permission ? 'Saving access…' : 'Removing access…';
  const epoch = identityEpoch, owner = accountId;
  renderPeople();
  try {
    await manageRequest(managePath('sharing'), { method: 'PUT', body: { userId, permission } });
    if (!stillCurrent(epoch, owner)) return; // a newer identity owns this panel now
    // The save is authoritative for its own row: show it at once, then confirm
    // it against the server. The refresh is a separate read, not blocked by
    // this write's lock, so the successful change is never left stale.
    applyGrant(userId, permission);
    renderPeople();
    const refreshed = await loadPeople(true);
    if (!stillCurrent(epoch, owner)) return;
    $('peopleStatus').textContent = refreshed
      ? (permission ? 'Access saved.' : 'Access removed. Any capability link they hold keeps working.')
      : 'Saved. The list could not be refreshed; reopen Share to reload it.';
    notice(permission ? 'Named access saved.' : 'Named access removed.');
  } catch (err) {
    if (!stillCurrent(epoch, owner)) return;
    peopleError = err.message;
    $('peopleStatus').textContent = '';
  } finally {
    peopleSaving = false;
    renderPeople();
  }
}

/** The row state a confirmed grant change implies, shown before the refresh. */
function applyGrant(userId, permission) {
  const user = people.users.find(u => u.id === userId) ?? people.grants.find(g => g.userId === userId);
  const grant = { userId, permission, ...(user?.email ? { email: user.email } : {}), ...(user?.name ? { name: user.name } : {}) };
  people = {
    ...people,
    grants: permission ? [...people.grants.filter(g => g.userId !== userId), grant] : people.grants.filter(g => g.userId !== userId),
  };
  peopleLoaded = true;
}

$('peopleForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (peopleLoading || peopleSaving || !info.canManage) return;
  const userId = $('peoplePick').value;
  if (!userId) { peopleError = 'Choose a person to add.'; renderPeople(); return; }
  await saveGrant(userId, $('peoplePermission').value, $('peopleForm').querySelector('[type=submit]'));
  $('peoplePick').value = '';
});

// ─── Share and export ──────────────────────────────────────────────────────

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

/**
 * The comment link, with a way to replace it when it leaks. The first click
 * asks; a second, within ten seconds, cuts off the old link. The state lives
 * outside the row because the Share menu re-renders while it is open.
 */
let commentRenew = { state: 'idle', timer: 0, error: '' };
function commentLinkRow() {
  const row = shareRow('commentLink', 'Comment link', 'Can view every version and comment, not edit.', linkWith(info.commentToken), { secret: true });
  const label = { idle: commentRenew.error || 'New link', asking: 'Old link stops working. Replace?', busy: 'Replacing…' }[commentRenew.state];
  const renew = el('button', { type: 'button', className: 'renew', textContent: label, disabled: commentRenew.state === 'busy' });
  renew.addEventListener('click', async () => {
    clearTimeout(commentRenew.timer);
    if (commentRenew.state === 'idle') {
      commentRenew = { state: 'asking', error: '', timer: setTimeout(() => { commentRenew = { state: 'idle', timer: 0, error: '' }; renderShare(); }, 10000) };
      renderShare();
      return;
    }
    commentRenew = { state: 'busy', timer: 0, error: '' };
    renderShare();
    try {
      info.commentToken = (await art.newCommentLink()).commentToken;
      commentRenew = { state: 'idle', timer: 0, error: '' };
    } catch (e) {
      commentRenew = { state: 'idle', timer: 0, error: `Could not replace: ${e.message}` };
    }
    renderShare();
  });
  row.append(renew);
  return row;
}

let publications = [];
let publicationCursor = '';
let publicationBusy = false;
let publicationLoading = false;

async function publicationRequest(path, { method = 'GET', body } = {}) {
  // Snapshots belong to a signed-in account. The cookie decides, exactly as it
  // does for sharing; a capability token in the link grants nothing here. A
  // write revalidates the account, so a stale page publishes nothing.
  if (method !== 'GET' && !(await managementAuthorization())) {
    throw new Error('Sign in again to manage public snapshots.');
  }
  const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
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
      const epoch = identityEpoch, owner = accountId;
      try {
        await publicationRequest(`/api/publications/${encodeURIComponent(publication.id)}`, { method: 'DELETE' });
        if (!stillCurrent(epoch, owner)) return;
        publications = publications.filter(item => item.id !== publication.id);
        publicationStatus('Public snapshot deleted. The private artifact is unchanged.');
      } catch (e) {
        if (!stillCurrent(epoch, owner)) return;
        publicationStatus(e.message, true);
      }
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
  const epoch = identityEpoch, owner = accountId;
  renderPublications();
  try {
    const query = new URLSearchParams({ artifactId: art.id });
    if (append && publicationCursor) query.set('cursor', publicationCursor);
    const result = await publicationRequest(`/api/publications?${query}`);
    // A late answer lists whoever owned the cookie when it was sent.
    if (!stillCurrent(epoch, owner)) return;
    publications = append ? [...publications, ...result.publications] : result.publications;
    publicationCursor = result.nextCursor || '';
  } catch (e) {
    if (!stillCurrent(epoch, owner)) return;
    publicationStatus(e.message, true);
  }
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
  const epoch = identityEpoch, owner = accountId;
  try {
    const bundle = await art.bundle(at);
    if (bundle.checkin !== at) throw new Error('The selected version could not be loaded exactly. Please reload and try again.');
    const documents = await preparePublication(art, bundle);
    if (!stillCurrent(epoch, owner)) return;
    publicationStatus('Publishing public snapshot…');
    const publication = await publicationRequest(`${art.base}/publications`, { method: 'POST', body: { at, documents } });
    if (!stillCurrent(epoch, owner)) return;
    publications = [publication, ...publications.filter(item => item.id !== publication.id)];
    publicationStatus(publication.status === 'live' && publication.url
      ? 'Published. Copy or open the public link below.' : `Snapshot status: ${publication.status}. Reopen Share to refresh.`);
  } catch (e) {
    if (!stillCurrent(epoch, owner)) return;
    publicationStatus(e.message, true);
  }
  finally { publicationBusy = false; renderShare(); renderPublications(); }
});

function renderShare() {
  const can = controls(info);
  // Named access and public snapshots belong to signed-in management only.
  $('peopleSection').hidden = !info.canManage;
  guestUI.render();
  $('publicationSection').hidden = !info.canManage;
  $('publishPublic').disabled = publicationBusy;
  $('publishPublic').textContent = publicationBusy ? 'Working…' : `Publish version ${shortId(shown.checkin)}`;
  if (info.canManage) { renderPeople(); renderPublications(); }
  if (!link.token) {
    $('shareRows').replaceChildren(...[
      shareRow('libraryLink', 'Library link',
        'Only the owner, instance owner, and people with named access can open this link after signing in.',
        location.origin + location.pathname),
      can.commentLink ? commentLinkRow() : null,
    ].filter(Boolean));
    $('shareFoot').textContent = 'This link does not grant access on its own.';
    return;
  }
  const writer = can.edit;
  // A comment link is not a Fossil login, and holders of one see no other link.
  const reader = info.role === 'read';
  const readToken = writer ? info.readToken : reader ? link.token : null;
  const login = writer ? 'editor' : 'viewer';
  const clone = `fossil clone ${location.origin.replace('://', `://${login}:${link.token}@`)}/r/${art.id}`;
  $('shareRows').replaceChildren(...[
    readToken ? shareRow('readLink', 'Read link', 'Anyone with it can view every version.', linkWith(readToken)) : null,
    can.commentLink ? commentLinkRow() : null,
    writer ? shareRow('editLink', 'Edit link', 'Can publish new versions and delete. Share only with editors.', linkWith(link.token), { secret: true }) : null,
    writer || reader ? shareRow('cloneCmd', 'Clone with Fossil', writer ? 'The whole history, to edit locally and push back.' : 'The whole history, read-only.', clone, { secret: writer }) : null,
  ].filter(Boolean));
  $('shareFoot').textContent = info.expiresAt
    ? `Expires ${new Date(info.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}`
    : 'Does not expire';
}

// ─── Popovers: one open at a time; Escape or a click elsewhere closes it ────
const popovers = [['titleBtn', 'titleMenu'], ['shareBtn', 'shareMenu'], ['moreBtn', 'moreMenu']];
function closePopovers(except, { keepPlacement = false } = {}) {
  if (except !== 'inspector') closeInspector();
  if (!keepPlacement) setPlacement(false);
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
    if (open && menu === 'shareMenu') {
      shareTab('share');
      loadPublications();
      loadPeople();
      guestUI.loadGuests();
    }
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
    if (open || inspectorMode || placing || bubbleVisible()) e.preventDefault();
    if (bubbleVisible() && !open) { if (!commentBusy) closeBubble(true); return; }
    closePopovers();
    if (open) $(open[0]).focus();
  }
});

function shareTab(which, focus = false) {
  for (const name of ['share', 'export']) {
    const active = name === which;
    $(`${name}Tab`).setAttribute('aria-selected', String(active));
    $(`${name}Tab`).tabIndex = active ? 0 : -1;
    $(`${name}Pane`).hidden = !active;
  }
  if (focus) $(`${which}Tab`).focus();
  if (which === 'export') closeInspector();
}
for (const name of ['share', 'export']) {
  $(`${name}Tab`).addEventListener('click', () => shareTab(name));
  $(`${name}Tab`).addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    shareTab(e.key === 'Home' ? 'share' : e.key === 'End' ? 'export' : name === 'share' ? 'export' : 'share', true);
  });
}

// ─── The library sidebar: an optional, honest map of the reader's library ──
//
// Signed-in accounts get their real recent artifacts from the existing
// authorized endpoint, cached briefly. Anonymous capability readers get no
// inventory: only the existing library routes, which ask them to sign in.

const RECENT_LIMIT = 8;
const LIBRARY_CACHE_MS = 30_000;
let libraryCache = { at: 0, items: null, error: '', accountId: null };
let navOpen = false;
let sidebarUnavailable = false;

function setNav(open, restore = false) {
  navOpen = open && !sidebarUnavailable;
  $('librarySidebar').hidden = sidebarUnavailable ? true : !navOpen;
  $('navScrim').hidden = !navOpen;
  $('navBtn').setAttribute('aria-expanded', String(navOpen));
  if (!navOpen && restore) $('navBtn').focus({ preventScroll: true });
}

function renderRecent() {
  const { items, error } = libraryCache;
  const list = $('recentList');
  if (error) {
    $('recentStatus').textContent = `Recent artifacts could not load: ${error}`;
    list.replaceChildren();
    return;
  }
  if (!items) { $('recentStatus').textContent = 'Loading recent artifacts…'; return; }
  $('recentStatus').textContent = items.length ? '' : 'No artifacts yet.';
  list.replaceChildren(...items.map(item => {
    const link = el('a', { className: 'recent-item', href: item.viewerUrl },
      el('strong', { textContent: item.title || 'Untitled' }),
      el('small', { textContent: [item.ownerName, item.updatedAt ? ago(item.updatedAt) : ''].filter(Boolean).join(' · ') }));
    if (item.id === art?.id) link.setAttribute('aria-current', 'page');
    link.addEventListener('click', e => outgoingGuard(e));
    return link;
  }));
}

async function loadLibrary(force = false) {
  if (sidebarUnavailable) return renderRecent();
  // The cache belongs to one account; another identity never reads it.
  if (libraryCache.accountId !== accountId) libraryCache = { at: 0, items: null, error: '', accountId };
  if (!force && libraryCache.items && Date.now() - libraryCache.at < LIBRARY_CACHE_MS) return renderRecent();
  if (!force && !navOpen) { renderRecent(); return; }
  const epoch = identityEpoch, owner = accountId;
  try {
    const response = await fetch('/api/library?sort=recent&limit=' + RECENT_LIMIT, { credentials: 'same-origin', cache: 'no-store' });
    // A late answer belongs to whoever the cookie was when it was sent. If the
    // identity moved, this is another account's inventory (or a stale 401);
    // writing either would be wrong.
    if (!stillCurrent(epoch, owner)) return;
    if (response.status === 401) {
      // Signed out: there is no inventory to show, only the routes that ask for sign-in.
      accountId = '';
      forgetAccount();
      libraryCache = { at: Date.now(), items: [], error: '', accountId: '' };
      return;
    }
    if (!response.ok) throw new Error(`Library request failed (HTTP ${response.status}).`);
    const data = await response.json();
    if (!stillCurrent(epoch, owner)) return;
    libraryCache = { at: Date.now(), items: (data.artifacts ?? []).slice(0, RECENT_LIMIT), error: '', accountId: owner };
  } catch (err) {
    if (!stillCurrent(epoch, owner)) return;
    libraryCache = { ...libraryCache, at: Date.now(), error: err.message };
  }
  renderRecent();
}

async function startSidebar() {
  try {
    const id = await confirmAccount({ fresh: true });
    if (!id) {
      // Anonymous capability readers: no inventory, only the library routes that
      // ask them to sign in. No toggle appears for a sidebar they cannot have.
      sidebarUnavailable = true;
      setNav(false);
      return;
    }
    showAccountChrome();
    await loadLibrary();
  } catch {
    // Offline or no accounts on this instance: the artifact itself still works.
    sidebarUnavailable = true;
    setNav(false);
  }
}

/** A confirmed account gets the library toggle and, wide, the docked sidebar. */
function showAccountChrome() {
  sidebarUnavailable = false;
  $('navBtn').hidden = false;
  if (matchMedia('(min-width: 1051px)').matches) setNav(true);
}

$('navBtn').addEventListener('click', e => {
  e.stopPropagation();
  setNav(!navOpen);
  if (navOpen) loadLibrary();
});
$('navScrim').addEventListener('click', () => setNav(false, true));
$('librarySidebar').addEventListener('click', e => e.stopPropagation());
// Find is an existing route; leaving the page is navigation, so drafts and open
// management forms are never silently thrown away.
for (const link of [$('navAll'), $('navFind'), $('navStarred'), $('navShared')]) {
  link.addEventListener('click', e => outgoingGuard(e));
}
addEventListener('resize', () => {
  if (sidebarUnavailable) return;
  if (matchMedia('(min-width: 1051px)').matches && !navOpen) setNav(true);
  if (matchMedia('(max-width: 1050px)').matches && navOpen) setNav(false);
  placeInspector();
});
inspectorQuery.addEventListener('change', placeInspector);

/** A page that would lose a draft or an unsaved management form asks first. */
function hasUnsavedWork() {
  if ($('renameDialog').open || $('expirationDialog').open) return true;
  if ($('commentText').value.trim()) return true;
  if ($('bubbleText').value.trim()) return true;
  for (const value of drafts.values()) if (value && value.trim()) return true;
  if (peopleLoaded || !$('peopleForm').hidden) {
    if ($('peoplePick').value) return true;
    if ([...document.querySelectorAll('#peopleList select')].some(s => s.dataset.dirty === 'true')) return true;
  }
  return false;
}
function confirmLeave(event) {
  if (hasUnsavedWork() && !confirm('Leave this artifact? Unsaved comment drafts and open forms will be lost.')) event.preventDefault();
}
/**
 * The one guard for links that leave this viewer for another same-tab page:
 * static library/Find links and the dynamic Recent rows alike, so a draft is
 * never discarded by one door and protected at the other. A new tab, a
 * modifier-click or a changed version hash is not leaving the page, so it is
 * never prompted for.
 */
function outgoingGuard(event) {
  if (event.defaultPrevented) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.currentTarget;
  if (anchor.target && anchor.target !== '_self') return;
  let next;
  try { next = new URL(anchor.href, location.href); } catch { return; }
  if (next.origin !== location.origin) return;
  // Another version of this same page swaps in place (the viewer listens for
  // the hash change), so there is no page to leave and nothing to lose. The
  // same URL is a reload; a different capability token is a different
  // authority. Both reload, so both are guarded.
  if (next.pathname === location.pathname && next.search === location.search
    && next.hash !== location.hash) {
    try {
      if (viewerFragment(next.hash).token === viewerFragment(location.hash).token) return;
    } catch { /* a malformed fragment is not a page change to sneak past the guard */ }
  }
  confirmLeave(event);
}
$('backLibrary').addEventListener('click', e => confirmLeave(e));

// ─── Restore, delete, upload, download ─────────────────────────────────────

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
for (const id of ['downloadBtn', 'downloadFilesBtn']) $(id).addEventListener('click', async () => {
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

// ─── The page's window.artifact API ────────────────────────────────────────

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

// ─── Watching for new versions ──────────────────────────────────────────────

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

// ─── Start ──────────────────────────────────────────────────────────────────

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
  setArtifactFavicon(info.icon);
  if (show) {
    shown = await art.bundle(link.at);
    await fetchTextBlobs(shown);
    if (shown.missing?.length) console.warn('missing from this version:', shown.missing.join(', '));
    await render();
  } else {
    renderChrome();
  }
}

const guestUI = guestPanel({
  artifact: () => art,
  info: () => info,
  account: () => confirmAccount({ fresh: true }),
  current: async expected => (await confirmAccount({ fresh: true })) === expected,
  manage: manageRequest,
  path: managePath,
  refresh: () => loadPeople(true),
});

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
  await guestUI.loadProfile();
  await loadThreads();
  startSidebar();
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
