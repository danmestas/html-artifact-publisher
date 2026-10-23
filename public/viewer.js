// viewer.js — opens /v/<id>#<token>[@<check-in>]: loads the chosen check-in
// (trunk tip by default) from the artifact's Fossil repository and renders it
// in the sandboxed iframe. The page inside gets a small `window.artifact` API
// over postMessage; the access token never enters the iframe.

import { Artifact, ConflictError, parseFragment, fragment } from './client.js';
import { renderDiagrams, renderPikchr } from './diagrams.js';
import { embedFonts } from './fonts.js';

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

// Injected first into every page: the window.artifact bridge and in-page
// anchor scrolling (blob: documents do not scroll to #ids on their own).
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
})();`;

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
  frame.onload = () => {
    $('shell').style.display = 'none';
    frame.style.display = 'block';
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
  const writer = info.role === 'write';

  $('bar').hidden = false;
  $('title').textContent = info.title || 'Untitled';
  $('versionHash').textContent = shortId(shown.checkin);
  $('versionTag').textContent = latest ? 'Latest' : current ? ago(current.time) : '';
  $('versionTag').className = latest ? 'tag latest' : 'tag';
  $('versionBtn').classList.toggle('old', !latest);
  const head = info.timeline[0];
  $('updated').textContent = head ? `Updated ${ago(head.time)} by ${head.user}` : '';
  $('role').textContent = writer ? 'Can edit' : 'View only';
  $('role').className = `pill ${writer ? 'write' : 'read'}`;
  $('deleteBtn').hidden = !writer || (!link.token && !info.canManage);
  $('backLibrary').hidden = !!link.token;

  $('oldStrip').hidden = latest;
  $('restoreBtn').hidden = latest || !writer;
  $('backLatest').href = fragment({ token: link.token });
  if (!latest && current) {
    const when = new Date(current.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    $('oldText').textContent = `You are viewing “${current.comment || 'an untitled check-in'}” by ${current.user}, ${when}. `
      + `${index} newer version${index === 1 ? ' exists' : 's exist'}.`;
  }

  renderVersions();
  renderShare();
}

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

function renderShare() {
  if (!link.token) {
    $('shareRows').replaceChildren(shareRow('libraryLink', 'Library link',
      'Only the owner, instance owner, and people with named access can open this link after signing in.',
      location.origin + location.pathname));
    $('shareFoot').textContent = 'Manage named access from your library. This link does not grant access.';
    return;
  }
  const writer = info.role === 'write';
  const readToken = writer ? info.readToken : link.token;
  const login = writer ? 'editor' : 'viewer';
  const clone = `fossil clone ${location.origin.replace('://', `://${login}:${link.token}@`)}/r/${art.id}`;
  $('shareRows').replaceChildren(...[
    readToken ? shareRow('readLink', 'Read link', 'Anyone with it can view every version.', linkWith(readToken)) : null,
    writer ? shareRow('editLink', 'Edit link', 'Can publish new versions and delete. Share only with editors.', linkWith(link.token), { secret: true }) : null,
    shareRow('cloneCmd', 'Clone with Fossil', writer ? 'The whole history, to edit locally and push back.' : 'The whole history, read-only.', clone, { secret: writer }),
  ].filter(Boolean));
  $('shareFoot').textContent = info.expiresAt
    ? `Expires ${new Date(info.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}`
    : 'Does not expire';
}

// One popover open at a time; Escape or a click elsewhere closes it.
const popovers = [['versionBtn', 'versionMenu'], ['shareBtn', 'shareMenu'], ['moreBtn', 'moreMenu']];
function closePopovers(except) {
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
  });
  $(menu).addEventListener('click', e => e.stopPropagation());
}
document.addEventListener('click', () => closePopovers());
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePopovers(); });
$('versionList').addEventListener('click', () => closePopovers());

$('openLatest').addEventListener('click', () => {
  closePopovers();
  location.hash = fragment({ token: link.token });
});

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
  if (!confirm(`Delete “${info.title}” and its whole history? Its links stop working.`)) return;
  try {
    await art.remove();
    $('bar').hidden = true;
    $('oldStrip').hidden = true;
    fail('This artifact was deleted.');
  } catch (e) {
    fail(`Could not delete: ${e.message}`);
  }
});

// ─── The page's window.artifact API ──────────────────────────────────────────

const ops = {
  canWrite: () => info.role === 'write',
  files: () => Object.keys(shown.files),
  read: path => {
    if (!(path in shown.files)) throw new Error(`${path} is not in this version`);
    return dec.decode(shown.files[path]);
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
