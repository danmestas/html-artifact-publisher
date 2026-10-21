import type { FossilReply } from './fossil';
import { artifactCaller } from './accounts';
import { b64decode } from './util';

// Defense in depth: no executable markup, navigation or runtime bridge, and a
// response sandbox that applies even if the document is opened outside a frame.
const CSP = "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const TAGS = new Set('html head title body style div span p h1 h2 h3 h4 h5 h6 main section article header footer nav aside ul ol li dl dt dd blockquote pre code b strong i em small s u br hr table thead tbody tfoot tr th td caption colgroup col img figure figcaption a details summary time'.split(' '));
const ATTRS = new Set('id class style title lang dir width height colspan rowspan scope alt open'.split(' '));

export async function preview(req: Request, env: Env, id: string): Promise<Response> {
  const who = await artifactCaller(req, env, id);
  const result = await env.REPO.getByName(id).op(who, { op: 'preview' }) as FossilReply<{ data?: string; reason?: string }>;
  const headers = {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store',
    'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
  };
  if (!result.ok) return new Response('Preview unavailable', { status: 404, headers });
  const fallback = () => new Response('<!doctype html><html><head><style>:root{color-scheme:light dark}body{font:36px/1.5 system-ui;padding:40px;background:#fff;color:#202d40}@media(prefers-color-scheme:dark){body{background:#1d2633;color:#e7edf6}}</style></head><body><p>Static preview unavailable.</p><p>Open the artifact to view its content.</p></body></html>', { headers });
  if (!result.result?.data) return fallback();
  const html = new TextDecoder().decode(b64decode(result.result.data));
  const sanitized = await new HTMLRewriter().on('*', {
    element(el) {
      if (!TAGS.has(el.tagName)) { el.remove(); return; }
      for (const [name, value] of [...el.attributes]) {
        if (name === undefined || value === undefined) continue;
        if (el.tagName === 'img' && name === 'src' && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value)) continue;
        if (!ATTRS.has(name)) el.removeAttribute(name);
      }
    },
  }).transform(new Response(html)).text();
  // A script-only shell (or an unsupported canvas/SVG-only document) is not a
  // thumbnail. Check the already-sanitized, bounded payload for static content.
  let hasImage = false;
  const text = await new HTMLRewriter().on('*', {
    element(el) {
      if (['head', 'style', 'title'].includes(el.tagName)) el.remove();
      else {
        if (el.tagName === 'img' && el.getAttribute('src')) hasImage = true;
        el.removeAndKeepContent();
      }
    },
  }).onDocument({ comments(comment) { comment.remove(); } }).transform(new Response(sanitized)).text();
  const visibleText = text.replace(/<!doctype[^>]*>/gi, '').replace(/&(?:nbsp|#160|#xa0);/gi, ' ').trim();
  if (!visibleText && !hasImage) return fallback();
  return new Response(sanitized, { headers });
}
