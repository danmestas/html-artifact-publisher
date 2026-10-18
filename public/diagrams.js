// Pikchr diagrams in pages. A page writes its diagram source in
// <pre class="pikchr">; the viewer renders each block to a light and a dark
// SVG before the page is shown. The renderer (a worker and ~56 KB of
// compressed wasm) is only fetched when a page has a diagram.

let worker = null;
let seq = 0;
const waiting = new Map();

function startWorker() {
  worker = new Worker('/pikchr/worker.js');
  worker.onmessage = ({ data }) => {
    const p = waiting.get(data.id);
    if (!p) return;
    waiting.delete(data.id);
    data.error ? p.reject(new Error(data.error)) : p.resolve(data);
  };
  worker.onerror = e => {
    for (const p of waiting.values()) p.reject(new Error(`Pikchr renderer failed to load${e.message ? ': ' + e.message : ''}`));
    waiting.clear();
    worker.terminate();
    worker = null;
  };
}

/** Renders Pikchr source: {light, dark, width, height}; rejects with Pikchr's error. */
export function renderPikchr(source) {
  if (!worker) startWorker();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, source: String(source) });
  });
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// Below 70% of natural size Pikchr's text is too small to read, so a wide
// diagram keeps that width and scrolls inside its box on a phone.
function svgMarkup(svg, cls, width, label) {
  return svg.trim()
    .replace(/ data-pikchr-date="[^"]*"/, '')
    .replace(/^<svg /, `<svg role="img" aria-label="${esc(label)}" `)
    .replace(/class="pikchr"/, `class="pikchr ${cls}"`)
    .replace(/style='font-size:initial;'/, `style='font-size:initial;max-width:${width}px;min-width:${Math.round(width * 0.7)}px'`);
}

const STYLE = `
:where(.pikchr-diagram){display:block;overflow-x:auto;margin:1.5em 0}
:where(.pikchr-diagram) svg{display:block;width:100%;height:auto;margin:0 auto}
:where(.pikchr-diagram) .pk-dark{display:none}
@media (prefers-color-scheme:dark){:where(.pikchr-diagram) .pk-light{display:none}:where(.pikchr-diagram) .pk-dark{display:block}}
:root[data-theme="light"] :where(.pikchr-diagram) .pk-light{display:block}
:root[data-theme="light"] :where(.pikchr-diagram) .pk-dark{display:none}
:root[data-theme="dark"] :where(.pikchr-diagram) .pk-light{display:none}
:root[data-theme="dark"] :where(.pikchr-diagram) .pk-dark{display:block}
:where(.pikchr-error){white-space:pre-wrap;border:2px solid #c0392b;border-radius:6px;padding:12px;color:inherit;font:13px/1.4 ui-monospace,monospace}`;

/**
 * Replaces each <pre class="pikchr"> in the parsed document with its rendering.
 * The pre's aria-label (or title) labels the SVG; data-theme="light" or "dark"
 * on the pre keeps only that rendering. A diagram with an error shows the
 * error in place. Returns the number of diagrams.
 */
export async function renderDiagrams(doc, nonce) {
  const blocks = [...doc.querySelectorAll('pre.pikchr')];
  if (!blocks.length) return 0;
  await Promise.all(blocks.map(async pre => {
    const label = pre.getAttribute('aria-label') || pre.getAttribute('title') || 'Diagram';
    const theme = pre.dataset.theme;
    let r;
    try {
      r = await renderPikchr(pre.textContent);
    } catch (e) {
      if (/failed to load/.test(e.message)) { console.warn(e.message); return; } // leave the source showing
      const err = doc.createElement('pre');
      err.className = 'pikchr-error';
      err.textContent = `Pikchr error:\n${e.message}`;
      pre.replaceWith(err);
      return;
    }
    const div = doc.createElement('div');
    for (const a of pre.attributes) if (!['class', 'aria-label', 'title', 'data-theme'].includes(a.name)) div.setAttribute(a.name, a.value);
    div.className = ['pikchr-diagram', ...pre.classList].filter(c => c !== 'pikchr').join(' ');
    div.innerHTML = theme === 'dark' ? svgMarkup(r.dark, '', r.width, label)
      : theme === 'light' ? svgMarkup(r.light, '', r.width, label)
      : svgMarkup(r.light, 'pk-light', r.width, label) + svgMarkup(r.dark, 'pk-dark', r.width, label);
    pre.replaceWith(div);
  }));
  const style = doc.createElement('style');
  style.setAttribute('nonce', nonce);
  style.textContent = STYLE;
  doc.head.prepend(style);
  return blocks.length;
}
