import { HTML_ENTITIES } from './search-entities';

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+;?|#\d+;?|[a-z][a-z0-9]*;?)/gi, (original, entity: string) => {
    if (!entity.startsWith('#')) return Object.hasOwn(HTML_ENTITIES,entity) ? HTML_ENTITIES[entity]! : original;
    const hex = entity[1]?.toLowerCase() === 'x';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1),hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

export type SearchStatus = 'complete' | 'partial' | 'pending' | 'error' | 'unsupported';
export type SearchChunk = { path: string; text: string };
export type SearchProjection = { id: string; version: number; status: SearchStatus; chunks: SearchChunk[] };
export const SEARCH_LIMITS = { files: 16, fileBytes: 512 * 1024, totalBytes: 2 * 1024 * 1024, text: 128 * 1024, chunk: 2048 };

export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const part of query.toLowerCase().matchAll(/"([^"]+)"|([^\s"]+)/gu)) {
    const words = (part[1] ?? part[2] ?? '').match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (part[1]) { if (words.length) terms.push(words.join(' ')); }
    else terms.push(...words);
  }
  return [...new Set(terms)];
}
export const ftsTerm = (term: string) => `"${term.replaceAll('"', '""')}"${term.includes(' ') ? '' : '*'}`;

/** Static readable HTML only. Attributes, comments, scripts and private form values never enter the index. */
export async function htmlSearchDocument(html: string): Promise<{ text:string; partial:boolean }> {
  let blocked = 0, head = 0, title = 0, text = '', dynamic = false;
  const blocks = new Set(['head','body','title','address','article','aside','blockquote','br','dd','div','dl','dt','figcaption','figure','footer','h1','h2','h3','h4','h5','h6','header','hr','li','main','nav','ol','p','pre','section','table','td','th','tr','ul']);
  const voids = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  const excluded = new Set(['script','style','template','noscript','form','input','textarea','select','button','iframe','object']);
  const rewriter = new HTMLRewriter().on('*', {
    element(element) {
      const tag = element.tagName.toLowerCase();
      if (tag === 'script') dynamic = true;
      const hidden = element.hasAttribute('hidden') || decodeEntities(element.getAttribute('aria-hidden') ?? '').toLowerCase() === 'true'
        || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(decodeEntities(element.getAttribute('style') ?? ''));
      const skip = excluded.has(tag) || hidden;
      if (tag === 'head') head++;
      if (tag === 'title') title++;
      if (skip && !voids.has(tag)) blocked++;
      if (blocks.has(tag) && !blocked && (!head || title)) text += ' ';
      if (!voids.has(tag)) element.onEndTag(() => {
        if (skip) blocked--;
        if (tag === 'head') head--;
        if (tag === 'title') title--;
        if (blocks.has(tag) && !blocked && !head) text += ' ';
      });
    },
    text(chunk) { if (!blocked && (!head || title) && text.length < SEARCH_LIMITS.text) text += chunk.text; },
  });
  await rewriter.transform(new Response(html)).arrayBuffer();
  return { text:decodeEntities(text).replace(/\s+/g, ' ').trim().slice(0, SEARCH_LIMITS.text),partial:dynamic || text.length >= SEARCH_LIMITS.text };
}
export function searchChunks(path: string, text: string): SearchChunk[] {
  const chunks: SearchChunk[] = [];
  for (let start = 0; start < text.length; start += SEARCH_LIMITS.chunk - 320) chunks.push({ path, text: text.slice(start, start + SEARCH_LIMITS.chunk) });
  return chunks;
}
export const normalizeSearchText = (text: string) => text.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
function foldedOffsets(text: string) {
  let value = '', offset = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const character of text) {
    const normalized = normalizeSearchText(character);
    for (let i = 0; i < normalized.length; i++) { starts.push(offset); ends.push(offset+character.length); }
    value += normalized; offset += character.length;
  }
  return { value,starts,ends };
}
export function searchSnippet(chunks: SearchChunk[], terms: string[]) {
  const needles = terms.map(normalizeSearchText);
  const ranked = chunks.map(chunk => ({ ...chunk, count: needles.filter(term => normalizeSearchText(chunk.text).includes(term)).length }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  const best = ranked[0];
  if (!best?.count) return null;
  const full = foldedOffsets(best.text);
  const first = Math.min(...needles.map(t => full.value.indexOf(t)).filter(i => i >= 0));
  let start = Math.max(0,full.starts[first]! - 70);
  if (start && /[\uDC00-\uDFFF]/.test(best.text[start]!)) start--;
  const text = best.text.slice(start,start+Math.max(240,...terms.map(t => t.length)));
  const normalized = foldedOffsets(text);
  const matches: { start: number; end: number }[] = [];
  for (const term of needles) {
    let from = 0, at: number;
    while ((at = normalized.value.indexOf(term,from)) >= 0) {
      matches.push({ start:normalized.starts[at]!,end:normalized.ends[at+term.length-1]! }); from = at+term.length;
    }
  }
  matches.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: typeof matches = [];
  for (const match of matches) { const last = merged.at(-1); if (last && match.start <= last.end) last.end = Math.max(last.end, match.end); else merged.push({ ...match }); }
  return { text, matches: merged, path: best.path };
}
