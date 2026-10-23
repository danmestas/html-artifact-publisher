// Static publication preparation. Parse inert documents, never run their scripts,
// and leave repository-relative assets intact for the public file server.
import { renderDiagrams } from './diagrams.js';
import { embedFonts } from './fonts.js';

const dec = new TextDecoder();
const TEXT = /\.(html?|css|m?js)$/i;
const APIS = new Set(['canWrite', 'files', 'read', 'bytes', 'history', 'publish', 'pikchr', 'data']);

/** Conservative static check of JavaScript, not the page's prose or code samples. */
export function usesArtifactRuntime(source) {
  const tokens = source.match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g) ?? [];
  const code = tokens.filter(t => !t.startsWith('//') && !t.startsWith('/*'));
  // Optional chaining is still a dependency on the private bridge.
  for (let i = code.length - 2; i >= 0; i--) if (code[i] === '?' && code[i + 1] === '.') code.splice(i, 1);
  const member = (i, name) => code[i] === '.' && code[i + 1] === name
    || code[i] === '[' && [JSON.stringify(name), `'${name}'`].includes(code[i + 1]) && code[i + 2] === ']';
  return code.some((token, i) => {
    if (['window', 'globalThis', 'self'].includes(token) && member(i + 1, 'artifact')) return true;
    if (token === 'artifact' && [...APIS].some(name => member(i + 1, name))) return true;
    // Expressions in template strings execute too; literal mentions elsewhere do not.
    return token.startsWith('`') && /\$\{/.test(token)
      && /(?:(?:window|globalThis|self)\s*\.\s*artifact|artifact\s*\.\s*(?:canWrite|files|read|bytes|history|publish|pikchr|data))\b/.test(token);
  });
}

function localPath(ref, from) {
  if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return null;
  return decodeURIComponent(new URL(ref, 'https://repo.invalid/' + from).pathname.slice(1));
}

/** Public CSP only permits local supporting files and selected inline data. */
export function validateResource(ref, kind, path) {
  const value = String(ref || '').trim();
  if (!value || value.startsWith('#')) return;
  if (/^data:/i.test(value) && ['image', 'font', 'media'].includes(kind)) return;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) {
    throw new Error(`Unsupported static export: ${path} loads a non-local ${kind} resource. Include local supporting files and use relative paths before publishing.`);
  }
}

export function validateCSS(source, path) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of css.matchAll(/@import\s+(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))|["']([^"']+)["'])/gi)) {
    validateResource(match[1] ?? match[2] ?? match[3] ?? match[4], 'stylesheet', path);
  }
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi)) {
    const ref = match[1] ?? match[2] ?? match[3];
    // data: images and fonts are permitted by both corresponding CSP directives.
    validateResource(ref, /^data:(?:image|font|application\/(?:font|x-font))/i.test(ref) ? 'image' : 'stylesheet asset', path);
  }
}

export function validateScriptResources(source, path) {
  const validate = (ref, kind) => {
    validateResource(ref, kind, path);
    if (ref.startsWith('/')) throw new Error(`Unsupported static export: ${path} uses a root-relative JavaScript load. Use document/module-relative paths before publishing; public snapshots do not rewrite JavaScript URLs.`);
  };
  // Only inspect literal load/import operands, not arbitrary prose in strings.
  const patterns = [
    /\b(?:import|export)\s+(?:[^;"'\n]*?\s+from\s*)?["']([^"']+)["']/g,
    /\b(import|fetch|Worker|SharedWorker|WebSocket|EventSource|importScripts)\s*\(\s*["'`]([^"'`]+)["'`]/g,
  ];
  for (const match of source.matchAll(patterns[0])) {
    validate(match[1], 'module');
    if (!/^(?:\.\.?\/|\/)/.test(match[1])) throw new Error(`Unsupported static export: ${path} uses a bare module import. Include local supporting files and use relative module paths before publishing.`);
  }
  for (const match of source.matchAll(patterns[1])) {
    validate(match[2], match[1] === 'import' ? 'module' : 'script/network');
    if (match[1] === 'import' && !/^(?:\.\.?\/|\/)/.test(match[2])) throw new Error(`Unsupported static export: ${path} uses a bare module import. Include local supporting files and use relative module paths before publishing.`);
  }
}

/** `bundle` must be fresh: the viewer consumes its own blob metadata while rendering. */
export async function preparePublication(art, bundle) {
  if (bundle.missing?.length) throw new Error('Cannot publish: this version has missing files.');
  const files = { ...bundle.files };
  await Promise.all(Object.entries(bundle.blobs ?? {}).filter(([path, entry]) => TEXT.test(path) || /(?:html|css|javascript|ecmascript)/i.test(entry.type)).map(async ([path, entry]) => {
    files[path] = await art.blob(entry);
  }));
  const text = path => dec.decode(files[path]);
  const unsupported = path => { throw new Error(`Unsupported static export: ${path} depends on the private artifact runtime. Remove that dependency before publishing.`); };
  for (const path of Object.keys(files)) {
    if (/\.m?js$/i.test(path)) {
      if (usesArtifactRuntime(text(path))) unsupported(path);
      validateScriptResources(text(path), path);
    }
    if (/\.css$/i.test(path)) validateCSS(text(path), path);
  }

  const documents = Object.create(null);
  for (const path of Object.keys(files).filter(name => /\.html?$/i.test(name))) {
    const doc = new DOMParser().parseFromString(text(path), 'text/html');
    if (doc.querySelector('base[href]')) throw new Error(`Unsupported static export: ${path} uses a base URL. Use document-relative asset paths before publishing.`);
    for (const script of doc.querySelectorAll('script')) {
      const type = (script.getAttribute('type') || '').trim().toLowerCase();
      if (type === 'importmap') {
        let map;
        try { map = JSON.parse(script.textContent); } catch { throw new Error(`Cannot publish: ${path} has an invalid import map.`); }
        const inspect = value => {
          if (typeof value === 'string') {
            validateResource(value, 'module', path);
            if (value.startsWith('/')) throw new Error(`Unsupported static export: ${path} uses a root-relative import-map URL. Use document/module-relative paths before publishing.`);
          }
          else if (value && typeof value === 'object') for (const child of Object.values(value)) inspect(child);
        };
        inspect(map);
      }
      if (type && type !== 'module' && !/(?:java|ecma)script/.test(type)) continue;
      if (usesArtifactRuntime(script.textContent)) unsupported(path);
      validateScriptResources(script.textContent, path);
      const src = localPath(script.getAttribute('src'), path);
      if (src !== null) {
        if (!(src in files)) throw new Error(`Cannot publish: ${path} references a missing script.`);
        if (bundle.blobs?.[src] && files[src] === bundle.files[src]) files[src] = await art.blob(bundle.blobs[src]);
        if (usesArtifactRuntime(text(src))) unsupported(src);
        validateScriptResources(text(src), src);
      }
    }
    for (const node of doc.querySelectorAll('*')) {
      const tag = node.localName.toLowerCase();
      if (['iframe', 'frame', 'object', 'embed'].includes(tag)) throw new Error(`Unsupported static export: ${path} embeds a frame or object blocked on public pages. Include its content directly before publishing.`);
      const kind = ['img', 'image', 'use'].includes(tag) || tag === 'link' && /\bicon\b/i.test(node.getAttribute('rel') || '') ? 'image'
        : tag === 'link' && node.getAttribute('as') === 'font' ? 'font'
        : ['audio', 'video', 'source', 'track'].includes(tag) ? 'media' : tag;
      for (const attr of node.attributes) {
        const name = attr.name.toLowerCase();
        const source = /^on/i.test(name) ? attr.value : /^javascript:/i.test(attr.value) ? attr.value.slice(11) : '';
        if (source && usesArtifactRuntime(source)) unsupported(path);
        if (source) validateScriptResources(source, path);
        if (name === 'style') validateCSS(attr.value, path);
        if (name === 'src' || name === 'poster') validateResource(attr.value, name === 'poster' ? 'image' : kind, path);
        if (['href', 'xlink:href'].includes(name) && (['image', 'use'].includes(tag)
          || tag === 'link' && /\b(?:stylesheet|icon|preload|modulepreload|prefetch|manifest)\b/i.test(node.getAttribute('rel') || ''))) validateResource(attr.value, kind, path);
        if (['srcset', 'imagesrcset'].includes(name)) {
          for (const match of attr.value.matchAll(/(?:^|[,\s])((?:[a-z][a-z0-9+.-]*:|\/\/)[^\s,]*)/gi)) validateResource(match[1], kind, path);
        }
      }
    }

    // embedFonts inspects inline CSS. Supply local stylesheets and their imports
    // temporarily for discovery, then remove them: relative CSS URLs keep working.
    const seen = new Set();
    const css = [];
    const collect = (source, from) => {
      validateCSS(source, from);
      css.push(source);
      for (const match of source.matchAll(/@import\s+(?:url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))|["']([^"']+)["'])/gi)) {
        load(match[1] ?? match[2] ?? match[3] ?? match[4], from);
      }
    };
    const load = (ref, from) => {
      const name = localPath(ref, from);
      if (name === null || seen.has(name)) return;
      if (!(name in files)) throw new Error(`Cannot publish: ${path} references a missing stylesheet.`);
      seen.add(name);
      collect(text(name), name);
    };
    for (const style of doc.querySelectorAll('style')) collect(style.textContent, path);
    for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) load(link.getAttribute('href'), path);
    await renderDiagrams(doc, '');
    if (doc.querySelector('pre.pikchr, .pikchr-error')) throw new Error(`Cannot publish: ${path} has a diagram that could not be rendered.`);
    const discovery = doc.createElement('style');
    discovery.textContent = css.join('\n');
    doc.head.append(discovery);
    try { await embedFonts(doc, '', { strict: true }); } finally { discovery.remove(); }
    documents[path] = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }
  if (!Object.keys(documents).length) throw new Error('Cannot publish: this version has no HTML document.');
  return documents;
}
