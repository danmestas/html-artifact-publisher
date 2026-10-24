// Fonts the viewer embeds into a page when, and only when, the page's CSS
// names the family and doesn't bring its own @font-face for it. The page
// iframe may only load fonts from data: URLs, so the woff2 files (served from
// /fonts/, cached by the browser) are inlined as base64.

const FACES = {
  'Instrument Sans': [
    { file: 'instrument-sans.woff2', weight: '400 700', style: 'normal' },
    { file: 'instrument-sans-italic.woff2', weight: '400 700', style: 'italic' },
  ],
  'IBM Plex Sans': [
    { file: 'ibm-plex-sans.woff2', weight: '100 700', style: 'normal' },
    { file: 'ibm-plex-sans-italic.woff2', weight: '100 700', style: 'italic' },
  ],
  'IBM Plex Mono': [
    { file: 'ibm-plex-mono-400.woff2', weight: '100 500', style: 'normal' },
    { file: 'ibm-plex-mono-600.woff2', weight: '550 900', style: 'normal', bold: true },
    { file: 'ibm-plex-mono-400-italic.woff2', weight: '100 900', style: 'italic' },
  ],
  'IBM Plex Serif': [
    { file: 'ibm-plex-serif-400.woff2', weight: '100 500', style: 'normal' },
    { file: 'ibm-plex-serif-600.woff2', weight: '550 900', style: 'normal', bold: true },
    { file: 'ibm-plex-serif-400-italic.woff2', weight: '100 900', style: 'italic' },
  ],
};

const ITALIC_TAGS = 'em, i, cite, dfn, var, address, [font-style="italic"]';
const BOLD_TAGS = 'b, strong, th, h1, h2, h3, h4, h5, h6, [font-weight="bold"]';
const cache = new Map(); // file -> Promise<data: URL>

function dataUrl(file) {
  if (!cache.has(file)) {
    cache.set(file, fetch(`/fonts/${file}`).then(async r => {
      if (!r.ok) throw new Error(`font ${file}: HTTP ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `data:font/woff2;base64,${btoa(bin)}`;
    }));
  }
  return cache.get(file);
}

// The family name, whole: "IBM Plex Sans" must not match "IBM Plex Sans Condensed".
const pattern = family => new RegExp(`(^|[\\s,:"'(])${family.replace(/ /g, '\\s+')}(?=\\s*($|[,;"')!}]))`, 'i');

/** The families of FACES that cssText names, minus those it declares itself. */
export function fontsUsed(cssText) {
  const own = [...cssText.matchAll(/@font-face\s*{[^}]*font-family\s*:\s*(["']?)([^;"'}]+)\1/gi)].map(m => m[2].trim().toLowerCase());
  return Object.keys(FACES).filter(f => !own.includes(f.toLowerCase()) && pattern(f).test(cssText));
}

/**
 * Adds @font-face rules for the fonts the page names to the parsed document
 * `doc`, before its own styles. Italic faces only ship when the page can show
 * italic text, and separate bold files only when it can show bold. A font
 * that fails to load is skipped; the page falls back. Static exports pass
 * { strict: true } to reject instead of publishing an incomplete rendering.
 */
export async function embedFonts(doc, nonce, { strict = false } = {}) {
  const cssText = [...doc.querySelectorAll('style')].map(s => s.textContent)
    .concat([...doc.querySelectorAll('[style]')].map(e => e.getAttribute('style'))).join('\n');
  const families = fontsUsed(cssText);
  if (!families.length) return [];
  const italic = /italic|oblique/i.test(cssText) || !!doc.querySelector(ITALIC_TAGS);
  const bold = /bold|weight\s*:\s*[5-9]00/i.test(cssText) || !!doc.querySelector(BOLD_TAGS);
  const faces = families.flatMap(f => FACES[f]
    .filter(x => (italic || x.style === 'normal') && (bold || !x.bold))
    .map(x => ({ family: f, ...x })));
  const rules = await Promise.all(faces.map(async x => {
    try {
      return `@font-face{font-family:"${x.family}";src:url("${await dataUrl(x.file)}") format("woff2");` +
        `font-weight:${x.weight};font-style:${x.style};font-display:swap}`;
    } catch (e) {
      if (strict) throw new Error(`Cannot embed font ${x.family}: ${e.message}`);
      console.warn(e.message);
      return '';
    }
  }));
  const style = doc.createElement('style');
  style.setAttribute('nonce', nonce);
  style.textContent = rules.join('\n');
  doc.head.prepend(style);
  return families;
}
