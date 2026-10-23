import { publicationFile, publicationManifest, publicId, publicPath } from './publication-files';

interface PublicEnv { BLOBS: R2Bucket }
// No account bindings, credentials, history or runtime bridge exist on this origin.
const CSP = "sandbox allow-scripts; default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";
const headers = () => new Headers({
  'Cache-Control': 'no-store', 'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Access-Control-Allow-Origin': '*', 'X-Robots-Tag': 'noindex, nofollow',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
});
const absent = () => new Response('Not found', { status: 404, headers: headers() });

export default {
  async fetch(req: Request, env: PublicEnv): Promise<Response> {
    if (!['GET', 'HEAD'].includes(req.method)) return absent();
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return new Response(req.method === 'HEAD' ? null : '{"status":"ok"}', { headers: { ...Object.fromEntries(headers()), 'Content-Type': 'application/json' } });
    const match = /^\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match || !publicId(match[1]!)) return absent();
    const id = match[1]!;
    // Always check the visibility marker, even for assets and conditional requests.
    const manifest = await env.BLOBS.get(publicationManifest(id));
    if (!manifest) return absent();
    const site = await manifest.json<{ entry: string }>();
    if (!publicPath(site.entry)) return absent();
    if (match[2] === undefined) {
      const h = headers(); h.set('Location', `/${id}/`);
      return new Response(null, { status: 308, headers: h });
    }
    let path: string;
    try { path = match[2] ? decodeURIComponent(match[2]) : site.entry; } catch { return absent(); }
    if (!publicPath(path) || /%2f|%5c/i.test(match[2] ?? '')) return absent();
    const file = await env.BLOBS.get(publicationFile(id, path));
    if (!file) return absent();
    const h = headers();
    file.writeHttpMetadata(h);
    h.set('Cache-Control', 'no-store');
    h.set('Content-Length', String(file.size));
    h.set('ETag', file.httpEtag);
    return new Response(req.method === 'HEAD' ? null : file.body, { headers: h });
  },
};
