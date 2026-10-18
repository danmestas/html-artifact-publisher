// viewer.js — opens /v/<id>#<token>[@<check-in>]: loads the chosen check-in
// (trunk tip by default) from the artifact's Fossil repository and renders it
// in the sandboxed iframe. The page inside gets a small `window.artifact` API
// over postMessage; the access token never enters the iframe.

import { Artifact, ConflictError, parseFragment, fragment } from './client.js';

const $ = id => document.getElementById(id);
const NONCE = document.querySelector('meta[name="artifact-nonce"]')?.content ?? '';
const WATCH_MS = 60_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

let art = null;      // the Artifact API client
let link = null;     // { token, at } from the fragment
let info = null;     // { title, role, tip, timeline } as last loaded
let shown = null;    // { checkin, files } being shown
let frameUrl = '';   // blob: URL of the rendered page, revoked on the next render

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
function render() {
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
  renderHistory();
}

// ─── History panel ───────────────────────────────────────────────────────────

function renderHistory() {
  const list = $('historyList');
  list.replaceChildren();
  for (const c of info.timeline) {
    const a = document.createElement('a');
    a.href = fragment({ token: link.token, at: c.uuid === info.tip ? '' : c.uuid.slice(0, 16) });
    a.setAttribute('aria-current', String(c.uuid === shown.checkin));
    a.textContent = c.comment || '(no comment)';
    const meta = document.createElement('small');
    meta.textContent = `${new Date(c.time).toLocaleString()} · ${c.user} · ${c.uuid.slice(0, 10)}${c.uuid === info.tip ? ' · latest' : ''}`;
    a.append(meta);
    const li = document.createElement('li');
    li.append(a);
    list.append(li);
  }
  $('historyBtn').hidden = false;
}

$('historyBtn').addEventListener('click', () => { $('history').hidden = !$('history').hidden; });
$('historyClose').addEventListener('click', () => { $('history').hidden = true; });

// ─── The page's window.artifact API ──────────────────────────────────────────

const ops = {
  canWrite: () => info.role === 'write',
  files: () => Object.keys(shown.files),
  read: path => {
    if (!(path in shown.files)) throw new Error(`${path} is not in this version`);
    return dec.decode(shown.files[path]);
  },
  history: () => info.timeline,

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
  if (document.visibilityState !== 'visible' || !art) return;
  try {
    if ((await art.tip()) !== info.tip) $('banner').hidden = false;
  } catch { /* offline: try again next time */ }
}
setInterval(watch, WATCH_MS);
$('bannerShow').addEventListener('click', () => {
  $('banner').hidden = true;
  reload(true).catch(e => fail(e.message));
});

// ─── Start ───────────────────────────────────────────────────────────────────

/** Load the timeline, and with `show` the check-in the link names. */
async function reload(show) {
  info = await art.info();
  if (show) {
    shown = await art.bundle(link.at);
    if (shown.missing?.length) console.warn('missing from this version:', shown.missing.join(', '));
    render();
  } else {
    renderHistory();
  }
}

async function main() {
  const m = /^\/v\/([A-Za-z0-9_-]{1,64})$/.exec(location.pathname);
  if (!m || !NONCE) return fail('Open an artifact link: /v/<id>#<token>');
  try {
    link = parseFragment(location.hash);
  } catch (e) {
    return fail(e.message);
  }
  art = new Artifact(location.origin, m[1], link.token);
  await reload(true);
}

addEventListener('hashchange', () => {
  try {
    const next = parseFragment(location.hash);
    if (art && next.token === link.token) {
      link = next;
      $('history').hidden = true;
      reload(true).catch(e => fail(e.message));
    } else {
      location.reload();
    }
  } catch (e) {
    fail(e.message);
  }
});

main().catch(e => fail(e.status === 404 ? 'This artifact does not exist, has expired, or the link is wrong.' : String(e.message ?? e)));
