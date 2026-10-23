import { identity, readBody } from './accounts';
import { pointersIn } from './blobs';
import type { FossilReply } from './fossil';
import type { Publication } from './registry';
import { b64decode } from './util';
import { deletePublicationFiles, publicationFile, publicPath } from './publication-files';

const MAX_FILES = 250;
const MAX_BYTES = 250 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const htmlPath = (path: string) => /\.html?$/i.test(path);
const mime = (path: string, fallback = 'application/octet-stream') => ({ html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', wasm: 'application/wasm', txt: 'text/plain; charset=utf-8', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg' } as Record<string, string>)[path.split('.').at(-1)!.toLowerCase()] ?? fallback;

function origin(req: Request, env: Env): string | null {
  try {
    const url = new URL(env.PUBLIC_ORIGIN);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.origin === new URL(req.url).origin || (env.APP_ORIGIN && url.origin === new URL(env.APP_ORIGIN).origin)) return null;
    return url.origin;
  } catch { return null; }
}

function cssUrls(css: string, root: string): string {
  return css.replace(/(url\(\s*["']?)(\/(?!\/)[^\s)'";]*)/gi, (_all, before, path) => before + root + path)
    .replace(/(@import\s*["'])(\/(?!\/)[^"']*)/gi, (_all, before, path) => before + root + path);
}

async function prepareHtml(html: string, path: string, root: string, publicOrigin: string): Promise<string> {
  // Keep fragment/query-only links on this document, not its directory's entry page.
  const documentPath = path === 'index.html' ? '' : path.split('/').map(encodeURIComponent).join('/');
  const base = `<base href="${publicOrigin}${root}/${documentPath}">`;
  let head = false, styleText = '';
  const rewritten = await new HTMLRewriter().on('base', { element(el) { el.remove(); } })
    .on('head', { element(el) { head = true; el.prepend(base, { html: true }); } })
    .on('*', { element(el) {
      if (el.tagName === 'meta' && el.getAttribute('name') === 'artifact-nonce') { el.remove(); return; }
      for (const attr of ['src', 'href', 'poster', 'action', 'formaction', 'data']) {
        const value = el.getAttribute(attr);
        if (value?.startsWith('/') && !value.startsWith('//')) el.setAttribute(attr, root + value);
      }
      const srcset = el.getAttribute('srcset');
      if (srcset) el.setAttribute('srcset', srcset.replace(/(^|\s+)(\S+)/g, (_all, space, token: string) => space +
        (/^data:/i.test(token) ? token : token.replace(/(^|,)(\/(?!\/)[^,]*)/g, (_match, before, value) => before + root + value))));
      const style = el.getAttribute('style');
      if (style) el.setAttribute('style', cssUrls(style, root));
    } })
    .on('style', { text(chunk) {
      // HTMLRewriter may split a CSS URL across chunks.
      styleText += chunk.text;
      if (chunk.lastInTextNode) { chunk.replace(cssUrls(styleText, root), { html: true }); styleText = ''; }
      else chunk.remove();
    } }).transform(new Response(html)).text();
  return head ? rewritten : base + rewritten;
}

export async function publicationRoutes(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url), path = url.pathname;
  const create = /^\/api\/artifacts\/([A-Za-z0-9_-]{1,64})\/publications$/.exec(path);
  const item = /^\/api\/publications\/([A-Za-z0-9_-]{12})$/.exec(path);
  if (!create && !item && path !== '/api/publications' && path !== '/api/publications/cleanup') return null;
  const actor = await identity(req, env), reg = env.REGISTRY.getByName('registry');
  if (!actor.legacy && !actor.user) return json({ error: 'Sign in to manage published links' }, 401);
  const admin = actor.legacy || actor.user?.role === 'owner';
  const publicOrigin = origin(req, env);
  const withUrl = (row: Publication) => ({ ...row, ...(row.status === 'live' && publicOrigin ? { url: `${publicOrigin}/${row.id}/` } : {}) });
  if (path === '/api/publications' && req.method === 'GET') {
    const cursor = url.searchParams.get('cursor');
    if (cursor && !/^\d{4}-\d\d-\d\dT[\d:.]+Z\/[A-Za-z0-9_-]{12}$/.test(cursor)) return json({ error: 'Invalid cursor' }, 400);
    const result = await reg.publications(admin ? null : actor.user!.id, url.searchParams.get('artifactId'), cursor);
    return json({ ...result, publications: result.publications.map(withUrl) });
  }
  if (path === '/api/publications/cleanup' && req.method === 'POST') {
    if (!admin) return json({ error: 'Instance owner required' }, 403);
    return json(await reg.cleanupPublications());
  }
  if (item && req.method === 'DELETE') {
    const row = await reg.publication(item[1]!);
    if (!row || (!admin && row.ownerId !== actor.user!.id)) return json({ error: 'Not found' }, 404);
    await reg.revokePublication(row.id);
    return json({ ok: true });
  }
  if (!create || req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
  if (!publicOrigin) return json({ error: 'A separate PUBLIC_ORIGIN must be configured before publishing' }, 503);
  const id = await reg.resolve(create[1]!);
  const source = id ? await reg.get(id) : null;
  if (!source) return json({ error: 'Artifact not found' }, 404);
  if (!admin && source.ownerId !== actor.user!.id) return json({ error: 'Only the artifact owner can publish it' }, 403);
  const input = await readBody(req, parseInt(env.MAX_PAYLOAD_BYTES, 10)) as { at?: unknown; documents?: unknown } | null;
  if (!input || typeof input.at !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.at) || !input.documents || typeof input.documents !== 'object' || Array.isArray(input.documents)) return json({ error: 'A full lowercase check-in hash and prepared HTML documents are required' }, 400);
  const documents = input.documents as Record<string, unknown>;
  const reply = await env.REPO.getByName(id!).op({ owner: true, token: '' }, { op: 'bundle', at: input.at }) as FossilReply<{ checkin: string; files: Record<string, string>; missing?: string[] }>;
  const bundle = reply.result;
  if (!reply.ok || !bundle || bundle.checkin !== input.at) return json({ error: 'Check-in not found' }, 404);
  const paths = Object.keys(bundle.files), htmlPaths = paths.filter(htmlPath);
  if (!htmlPaths.length || bundle.missing?.length || !paths.every(publicPath) || paths.length > MAX_FILES) return json({ error: `Snapshot needs complete, safe files and at least one HTML document (at most ${MAX_FILES} files)` }, 400);
  if (Object.keys(documents).length !== htmlPaths.length || !Object.keys(documents).every(p => htmlPaths.includes(p) && typeof documents[p] === 'string') || !htmlPaths.every(p => Object.hasOwn(documents, p))) return json({ error: 'Prepare exactly every HTML document in the selected version' }, 400);
  const pointers = pointersIn(bundle.files), hashes = Object.values(pointers).map(p => p.sha256);
  const allowed = new Set(await reg.allowedBlobs(id!, [`artifact:${id}`], hashes));
  let expected = 0;
  for (const p of paths) {
    if (pointers[p] && !allowed.has(pointers[p]!.sha256)) return json({ error: 'Snapshot contains an unavailable blob' }, 400);
    expected += htmlPath(p) ? encoder.encode(documents[p] as string).length : pointers[p]?.size ?? b64decode(bundle.files[p]!).byteLength;
  }
  if (expected > MAX_BYTES) return json({ error: 'Snapshot exceeds the 250 MiB publication limit' }, 413);
  const row = await reg.beginPublication(id!, source.ownerId ?? 'instance-owner', source.title, input.at);
  let bytes = 0;
  try {
    for (const p of paths) {
      const pointer = pointers[p];
      let content: Uint8Array | ReadableStream;
      let type = mime(p, pointer?.type);
      if (htmlPath(p)) content = encoder.encode(await prepareHtml(documents[p] as string, p, `/${row.id}`, publicOrigin));
      else if (pointer) {
        const blob = await env.BLOBS.get(`b/${pointer.sha256}`);
        if (!blob || blob.size !== pointer.size) throw new Error('Source blob is missing; no snapshot was published');
        if (/\.css$/i.test(p)) content = encoder.encode(cssUrls(await blob.text(), `/${row.id}`));
        else content = blob.body;
      } else {
        content = b64decode(bundle.files[p]!);
        if (/\.css$/i.test(p)) content = encoder.encode(cssUrls(decoder.decode(content), `/${row.id}`));
      }
      bytes += content instanceof Uint8Array ? content.byteLength : pointer!.size;
      if (bytes > MAX_BYTES) throw new Error('Prepared snapshot exceeds the 250 MiB publication limit');
      const key = publicationFile(row.id, p);
      await env.BLOBS.put(key, content, { httpMetadata: { contentType: type } });
      if ((await reg.publication(row.id))?.status !== 'building') {
        await env.BLOBS.delete(key);
        throw new Error('Publication was cancelled; publish again');
      }
    }
    const live = await reg.activatePublication(row.id, paths.includes('index.html') ? 'index.html' : htmlPaths[0]!, paths.length, bytes);
    if (!live) throw new Error('Publication was cancelled or timed out; publish again');
    return json(withUrl(live), 201);
  } catch (error) {
    await reg.failPublication(row.id);
    try { await deletePublicationFiles(env.BLOBS, row.id); } catch { /* Retained failed row lets admin cleanup retry. */ }
    return json({ error: error instanceof Error ? error.message : 'Snapshot could not be published' }, 422);
  }
}
