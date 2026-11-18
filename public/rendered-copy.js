// A rendered copy is inert HTML, not a second live artifact or an access grant.
export const COPY_MAX_BYTES = 24 * 1024 * 1024;
// Browsers may omit page backgrounds when printing. Use legible paper colors
// for prose while leaving images, canvas snapshots and SVG shapes intact.
export const COPY_PRINT_CSS = `@media print {
  :root, body { color-scheme: light !important; background: white !important; color: #111 !important; }
  *, *::before, *::after { color: #111 !important; background-color: transparent !important; box-shadow: none !important; text-shadow: none !important; }
  svg text { fill: #111 !important; }
}`;

// Serialized into the existing opaque frame. Only the parent can request a
// copy; the parent revalidates and sanitizes the returned HTML independently.
export function pageRenderedCopy(render) {
  function capture() {
    const root = document.documentElement.cloneNode(true);
    const source = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
    const copied = [root, ...root.querySelectorAll('*')];
    if (source.length > 30000) throw new Error('This document is too large for a rendered copy. Download its files instead.');
    for (let i = 0; i < source.length; i++) {
      const original = source[i], clone = copied[i];
      if (original instanceof HTMLCanvasElement) {
        try {
          if (original.width * original.height > 8_388_608 || original.width > 8192 || original.height > 8192) throw new Error('Canvas exceeds the snapshot bound');
          const raster = document.createElement('canvas'); raster.width = original.width; raster.height = original.height;
          const context = raster.getContext('2d');
          context.fillStyle = getComputedStyle(document.documentElement).colorScheme.includes('dark') ? '#151514' : '#fff';
          context.fillRect(0, 0, raster.width, raster.height);
          const layers = []; for (let node = original; node; node = node.parentElement) layers.push(node);
          for (const layer of layers.reverse()) { context.fillStyle = getComputedStyle(layer).backgroundColor; context.fillRect(0, 0, raster.width, raster.height); }
          context.drawImage(original, 0, 0);
          const image = document.createElement('img');
          image.src = raster.toDataURL('image/png'); image.width = original.width; image.height = original.height;
          image.alt = original.getAttribute('aria-label') || 'Canvas snapshot'; clone.replaceWith(image);
        } catch { clone.replaceWith(document.createTextNode('[Canvas cannot be included in this copy]')); }
      } else if (original instanceof HTMLInputElement) {
        if (['password', 'hidden', 'file'].includes(original.type)) clone.remove();
        else { clone.setAttribute('value', original.value); clone.toggleAttribute('checked', original.checked); }
      } else if (original instanceof HTMLTextAreaElement) clone.textContent = original.value;
      else if (original instanceof HTMLSelectElement) {
        [...clone.options].forEach((option, n) => option.toggleAttribute('selected', original.options[n].selected));
      }
      // Unroll scrollable prose, not image/canvas/SVG geometry. The copy has its
      // own layout; changing it never reflows the live page or moves its scroll.
      if (!['IMG', 'CANVAS', 'SVG', 'VIDEO', 'AUDIO'].includes(original.tagName)
        && original.scrollHeight > original.clientHeight + 2 && original.clientHeight > 0) {
        const overflow = getComputedStyle(original).overflowY;
        if (['auto', 'scroll', 'hidden'].includes(overflow)) {
          clone.style.height = 'auto'; clone.style.maxHeight = 'none'; clone.style.overflowY = 'visible';
        }
      }
    }
    root.querySelectorAll('script, [data-artifact-pins]').forEach(node => node.remove());
    const html = '<!doctype html>\n' + root.outerHTML;
    if (new TextEncoder().encode(html).byteLength > 24 * 1024 * 1024) throw new Error('This document is too large for a rendered copy. Download its files instead.');
    return html;
  }
  addEventListener('message', event => {
    const d = event.data;
    if (event.source !== parent || d?.__artifactRenderedCopy !== 1 || d.render !== render || typeof d.request !== 'string') return;
    try { parent.postMessage({ __artifactRenderedCopy: 1, render, request: d.request, html: capture() }, '*'); }
    catch (error) { parent.postMessage({ __artifactRenderedCopy: 1, render, request: d.request, error: String(error.message || 'Cannot copy this page') }, '*'); }
  });
  addEventListener('keydown', event => {
    if (!event.isTrusted || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    const action = event.key.toLowerCase() === 's' ? 'save' : event.key.toLowerCase() === 'p' ? 'print' : '';
    if (!action) return;
    event.preventDefault();
    if (!event.repeat) parent.postMessage({ __artifactCopyShortcut: 1, render, action }, '*');
  }, true);
}

/** Parent-side sanitizer and resource packer. Never fetch a URL supplied by HTML:
 * only exact signed asset URLs from the already authorized bundle are eligible. */
export async function prepareRenderedCopy(html, { origin, blobs = {}, nonce = '', omit = [] } = {}) {
  if (typeof html !== 'string' || new TextEncoder().encode(html).byteLength > COPY_MAX_BYTES) throw new Error('Rendered copy exceeds the 24 MiB limit. Download its files instead.');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, template, noscript, meta, base, iframe, frame, frameset, object, embed, link, [data-artifact-pins], input[type="password"], input[type="hidden"], input[type="file"]').forEach(node => node.remove());
  for (const form of doc.querySelectorAll('form')) {
    const replacement = doc.createElement('div'); replacement.append(...form.childNodes); form.replaceWith(replacement);
  }
  for (const node of doc.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name) || ['nonce', 'srcdoc', 'autofocus', 'autoplay', 'action', 'formaction', 'ping', 'download'].includes(attr.name)) node.removeAttribute(attr.name);
    }
    for (const attr of ['href', 'xlink:href']) {
      const value = node.getAttribute(attr);
      if (value && !/^(?:#|https?:|mailto:|tel:)/i.test(value.trim())) node.removeAttribute(attr);
    }
    if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
    if (node.hasAttribute('contenteditable')) node.removeAttribute('contenteditable');
  }
  const known = new Map();
  for (const entry of Object.values(blobs)) {
    try { const url = new URL(entry.url, origin); if (url.origin === origin) known.set(url.href, entry); } catch { /* invalid bundle entry is not a fetch target */ }
  }
  const cache = new Map(), warnings = [];
  let resourceBytes = 0;
  function warn() { if (!warnings.length) warnings.push('Some media could not be included. Download the original files to retain every resource.'); }
  async function resource(ref) {
    const value = String(ref || '').trim();
    if (!value || value.startsWith('#')) return value;
    if (/^data:(?:image\/(?!svg\+xml)[^;,]+|image\/svg\+xml|font\/[^;,]+|application\/(?:font|x-font)[^;,]*|audio\/[^;,]+|video\/[^;,]+)[;,]/i.test(value)) return value;
    let url; try { url = new URL(value, origin).href; } catch { warn(); return ''; }
    if (!known.has(url)) { warn(); return ''; }
    if (cache.has(url)) return cache.get(url);
    const entry = known.get(url);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || resourceBytes + entry.size > COPY_MAX_BYTES) throw new Error('Rendered copy media exceeds the 24 MiB limit. Download its files instead.');
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('An artifact resource could not be read. Refresh the artifact and try again.');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (resourceBytes + size > COPY_MAX_BYTES || size > entry.size) { await reader.cancel(); throw new Error('Rendered copy media exceeds its declared size or export limit.'); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    if (size !== entry.size) throw new Error('An artifact resource changed while preparing the copy. Try again.');
    resourceBytes += size;
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    let binary = ''; for (let start = 0; start < size; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    const type = /^(?:image|font|audio|video)\/[a-z0-9.+-]+$/i.test(entry.type || '') ? entry.type : 'application/octet-stream';
    const data = `data:${type};base64,${btoa(binary)}`; cache.set(url, data); return data;
  }
  async function css(source) {
    // The live viewer already inlined local styles. Do not revive an import
    // that its CSP blocked, or turn an untrusted declaration into a fetch.
    let out = source.replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])[^;]*;?/gi, '');
    const matches = [...out.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)];
    for (const match of matches.reverse()) {
      const value = await resource(match[2]);
      const encoded = value.replace(/["'\\<>\r\n]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
      out = out.slice(0, match.index) + `url("${encoded}")` + out.slice(match.index + match[0].length);
    }
    return out;
  }
  for (const node of doc.querySelectorAll('[src], [poster]')) {
    node.removeAttribute('srcset');
    for (const attr of ['src', 'poster']) if (node.hasAttribute(attr)) {
      const value = await resource(node.getAttribute(attr));
      if (value) node.setAttribute(attr, value); else node.removeAttribute(attr);
    }
  }
  for (const node of doc.querySelectorAll('[srcset]')) node.removeAttribute('srcset');
  for (const node of doc.querySelectorAll('[href], [xlink\\:href]')) {
    for (const attr of ['href', 'xlink:href']) {
      const ref = node.getAttribute(attr); if (!ref || ref.startsWith('#')) continue;
      let url; try { url = new URL(ref, origin).href; } catch { continue; }
      if (known.has(url)) {
        const embedded = await resource(ref);
        if (embedded) node.setAttribute(attr, embedded); else node.removeAttribute(attr);
      } else if (['image', 'use'].includes(node.localName)) {
        const embedded = await resource(ref);
        if (embedded) node.setAttribute(attr, embedded); else node.removeAttribute(attr);
      }
    }
  }
  for (const style of doc.querySelectorAll('style')) {
    style.textContent = (await css(style.textContent)).replace(/<\/style/gi, '<\\/style');
    if (nonce) style.setAttribute('nonce', nonce);
  }
  for (const node of doc.querySelectorAll('[style]')) node.setAttribute('style', await css(node.getAttribute('style')));
  const printStyle = doc.createElement('style'); printStyle.textContent = COPY_PRINT_CSS;
  if (nonce) printStyle.setAttribute('nonce', nonce); doc.head.append(printStyle);
  const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; object-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
  const charset = doc.createElement('meta'); charset.setAttribute('charset', 'utf-8');
  const viewport = doc.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1';
  doc.head.prepend(charset, policy, viewport);
  if (warnings.length) {
    const note = doc.createElement('p'); note.textContent = warnings[0]; note.setAttribute('role', 'note'); doc.body.prepend(note);
  }
  // An author may have echoed an image's signed URL as prose or a label.
  // Keep the embedded bytes, not the expiring grant, in every serialized field.
  const grants = [...known.keys()].flatMap(value => {
    const url = new URL(value); return [value, url.pathname + url.search];
  }).sort((a, b) => b.length - a.length);
  const scrub = value => grants.reduce((text, grant) => text.split(grant).join('[embedded resource]'), value);
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) walker.currentNode.nodeValue = scrub(walker.currentNode.nodeValue);
  for (const node of doc.querySelectorAll('*')) for (const attr of [...node.attributes]) {
    const value = scrub(attr.value); if (value !== attr.value) node.setAttribute(attr.name, value);
  }
  let output = '<!doctype html>\n' + doc.documentElement.outerHTML;
  for (const token of omit.filter(value => typeof value === 'string' && value.length >= 32)) output = output.split(token).join('[access credential omitted]');
  if (new TextEncoder().encode(output).byteLength > COPY_MAX_BYTES) throw new Error('Rendered copy exceeds the 24 MiB limit. Download its files instead.');
  return { html: output, title: doc.title || 'Artifact', warnings };
}
