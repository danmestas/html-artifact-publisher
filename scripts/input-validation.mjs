// Input checks for the publish CLI: which external resources a page would
// actually try to load, and whether every served HTML file is a whole document.
//
// These are deliberately small, linear scans rather than an HTML parser: the
// CLI only needs the tags and CSS that cause network loads. They never fetch
// anything and never guess what JavaScript builds at runtime.

const HTML_FILE = /\.html?$/i;
const CSS_FILE = /\.css$/i;

// Tags whose content is text, not markup: a URL inside must not be mistaken
// for a tag or attribute. `style` is the one whose text is scanned as CSS.
const TAG = /<!--[\s\S]*?-->|<(script|style|textarea|title)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(?:<\/\1\s*>|$)|<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/gi;

// Attributes that request a resource, as opposed to a link the reader follows.
const RESOURCE_ATTRIBUTES = {
  img: ['src'],
  source: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  iframe: ['src'],
  frame: ['src'],
  embed: ['src'],
  object: ['data'],
  image: ['href', 'xlink:href'],
  use: ['href', 'xlink:href'],
};
const SRCSET_ATTRIBUTES = new Set(['srcset', 'imagesrcset']);
const STYLESHEET_LINKS = new Set(['stylesheet', 'icon', 'preload', 'modulepreload', 'prefetch', 'manifest', 'apple-touch-icon']);

function decodeEntities(value) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/** One attribute per name; a duplicate is ignored, as HTML parsers keep the first. */
function parseAttributes(source) {
  const attrs = new Map();
  for (const match of source.matchAll(/([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1].toLowerCase();
    if (attrs.has(name)) continue;
    attrs.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attrs;
}

/** A load across the network. Local paths, fragments and data:/blob: are not. */
function isExternalReference(value) {
  return /^(?:https?:)?\/\//i.test(String(value || '').trim());
}

function addUnique(list, value) {
  if (list.includes(value)) return;
  list.push(value);
}

/** The http(s) candidates in a srcset, ignoring data: entries and descriptors. */
function srcsetReferences(value) {
  const refs = [];
  for (const match of value.matchAll(/(?:^|,)\s*((?:https?:)?\/\/[^\s,]+)/gi)) addUnique(refs, match[1]);
  return refs;
}

/** External @import targets and url() loads in CSS, skipping comments. */
export function cssExternalReferences(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const refs = [];
  for (const match of css.matchAll(/@import\s+(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))|["']([^"']+)["'])/gi)) {
    const ref = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (ref && isExternalReference(ref)) addUnique(refs, ref.trim());
  }
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi)) {
    const ref = match[1] ?? match[2] ?? match[3];
    if (ref && isExternalReference(ref)) addUnique(refs, ref.trim());
  }
  return refs;
}

/** External resources an HTML document loads, in document order, deduplicated. */
export function htmlExternalReferences(html) {
  const refs = [];
  for (const match of html.matchAll(TAG)) {
    if (match[0].startsWith('<!--')) continue;
    if (match[1]) {
      const name = match[1].toLowerCase();
      const attrs = parseAttributes(match[2]);
      if (name === 'script') {
        const src = attrs.get('src');
        if (isExternalReference(src)) addUnique(refs, src.trim());
      } else if (name === 'style') {
        for (const ref of cssExternalReferences(match[3])) addUnique(refs, ref);
      }
      // textarea and title content is text; nothing in it loads.
      continue;
    }
    const name = match[4].toLowerCase();
    const attrs = parseAttributes(match[5]);
    const style = attrs.get('style');
    if (style) for (const ref of cssExternalReferences(style)) addUnique(refs, ref);
    if (name === 'link') {
      const rel = (attrs.get('rel') || '').toLowerCase().split(/\s+/);
      if (!rel.some(token => STYLESHEET_LINKS.has(token))) continue;
      const href = attrs.get('href');
      if (isExternalReference(href)) addUnique(refs, href.trim());
      continue;
    }
    for (const attribute of RESOURCE_ATTRIBUTES[name] ?? []) {
      const value = attrs.get(attribute);
      if (isExternalReference(value)) addUnique(refs, value.trim());
    }
    if (name === 'img' || name === 'source') {
      for (const attribute of SRCSET_ATTRIBUTES) {
        const value = attrs.get(attribute);
        if (value) for (const ref of srcsetReferences(value)) addUnique(refs, ref);
      }
    }
    // input[type=image] loads its src like an image.
    if (name === 'input' && (attrs.get('type') || '').toLowerCase() === 'image') {
      const value = attrs.get('src');
      if (isExternalReference(value)) addUnique(refs, value.trim());
    }
  }
  return refs;
}

/** Warning lines for the HTML and CSS files that will be served, one per URL. */
export function externalReferenceWarnings(files) {
  const warnings = [];
  const seen = new Set();
  for (const [name, data] of Object.entries(files)) {
    const refs = HTML_FILE.test(name) ? htmlExternalReferences(data.toString('utf8'))
      : CSS_FILE.test(name) ? cssExternalReferences(data.toString('utf8'))
      : [];
    for (const ref of refs) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      warnings.push(`external URL: ${ref}`);
    }
  }
  return warnings;
}

/**
 * Every served HTML document must be a whole document, not a fragment: the
 * viewer shows one of these files directly and never wraps them. A directory
 * gets the same check as a single file, so a stray partial cannot slip in.
 * `single` checks that one file whatever its extension: a single-file publish
 * is always stored as index.html, so it is always served as a document.
 */
export function htmlDocumentProblems(files, single = false) {
  const problems = [];
  for (const [name, data] of Object.entries(files)) {
    if (!single && !HTML_FILE.test(name)) continue;
    const head = data.toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
    if (/^<!doctype\s+html(?:[\s>]|$)/.test(head) || /^<html(?:[\s>/]|$)/.test(head)) continue;
    problems.push(`${name} does not appear to be a standalone HTML document.\n  Expected content to start with <!doctype html or <html`);
  }
  return problems;
}
