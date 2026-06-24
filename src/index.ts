/**
 * html-artifact-publisher — Cloudflare Worker
 * Host: your deployed Worker domain
 *
 * Routes:
 *   GET    /healthz           Health probe
 *   POST   /api/pages         Upload encrypted artifact  (Bearer)
 *   GET    /api/pages         List artifacts             (Bearer)
 *   DELETE /api/pages/:id     Delete artifact            (Bearer or X-Delete-Token)
 *   GET    /v/:idOrSlug       Client-side decryption viewer shell
 *   GET    /blob/:id          Raw encrypted bytes        (no auth — ciphertext only)
 *   OPTIONS /api/*            CORS preflight
 *
 * R2 key layout : pages/<id>.html.enc
 * Blob format   : iv[12] || AES-GCM ciphertext
 * Share URL     : https://<your-domain>/v/<id>#<base64url-raw-key>
 */

// ─── Types ───────────────────────────────────────────────────────────────────

interface UploadBody {
  encryptedPayload: string; // base64url AES-GCM ciphertext
  iv: string;               // base64url, must be exactly 12 bytes
  sha256: string;           // hex SHA-256 of ciphertext bytes (integrity check)
  title: string;
  sourceName: string;
  ttlSeconds?: number;
  slug?: string;            // optional 1-64 char [a-z0-9-] slug
}

interface PageRow {
  id: string;
  slug: string | null;
  title: string;
  source_name: string;
  sha256: string;
  iv: string;
  blob_size: number;
  expires_at: number | null;
  created_at: number;
  delete_token_hash: string;
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** 21-char URL-safe random ID (nanoid alphabet, crypto-random). */
function genId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  return Array.from(bytes, b => chars[b & 63]!).join('');
}

/** 32-byte random hex token for use as a delete credential. */
function genToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Decode base64url (no padding) → Uint8Array. Throws on malformed input. */
function b64urlDecode(s: string): Uint8Array {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = std.length % 4;
  const padded = pad ? std + '===='.slice(pad) : std;
  const bin = atob(padded);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/** SHA-256 of arbitrary bytes, returned as lowercase hex. */
async function sha256hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Timing-safe string equality for hex digests.
 * Both inputs should be the same length (SHA-256 hex = 64 chars).
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Clamp ttlSeconds into [1, maxTtl].
 * Returns defaultTtl when input is absent/invalid.
 * Returns null to signal "no expiry" when clamped value is 0.
 */
function clampTtl(
  ttlSeconds: number | undefined,
  defaultTtl: number,
  maxTtl: number,
): number | null {
  if (ttlSeconds == null || !Number.isFinite(ttlSeconds)) return defaultTtl;
  const v = Math.min(Math.max(Math.floor(ttlSeconds), 0), maxTtl);
  return v === 0 ? null : v;
}

/** Build a JSON Response with optional extra headers. */
function jsonRes(
  data: unknown,
  status = 200,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

/** Security headers applied to all responses. */
function secHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), microphone=(), payment=()',
  };
}

/** Minimal CORS headers for the upload/list/delete API. */
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Delete-Token',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Validate the Authorization: Bearer <token> header.
 * Returns null when valid, an error Response when not.
 */
function requireBearer(req: Request, expected: string): Response | null {
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) {
    return jsonRes({ error: 'Missing Authorization: Bearer header' }, 401);
  }
  const provided = auth.slice(7).trim();
  if (!timingSafeEqual(provided, expected)) {
    return jsonRes({ error: 'Invalid bearer token' }, 403);
  }
  return null;
}

// ─── Route handlers ──────────────────────────────────────────────────────────

function handleHealth(): Response {
  return new Response(JSON.stringify({ status: 'ok', ts: Date.now() }), {
    headers: { 'Content-Type': 'application/json', ...secHeaders() },
  });
}

async function handleUpload(req: Request, env: Env): Promise<Response> {
  const authErr = requireBearer(req, env.BEARER_TOKEN);
  if (authErr) return authErr;

  let body: UploadBody;
  try {
    body = (await req.json()) as UploadBody;
  } catch {
    return jsonRes({ error: 'Request body must be valid JSON' }, 400);
  }

  const { encryptedPayload, iv, sha256, title, sourceName, ttlSeconds, slug } = body;

  if (!encryptedPayload || !iv || !sha256 || typeof title !== 'string' || typeof sourceName !== 'string') {
    return jsonRes(
      { error: 'Missing required fields: encryptedPayload, iv, sha256, title, sourceName' },
      400,
    );
  }

  // Decode and validate ciphertext
  let ciphertextBytes: Uint8Array;
  try {
    ciphertextBytes = b64urlDecode(encryptedPayload);
  } catch {
    return jsonRes({ error: 'encryptedPayload is not valid base64url' }, 400);
  }

  const maxBytes = parseInt(env.MAX_PAYLOAD_BYTES, 10);
  if (ciphertextBytes.length > maxBytes) {
    return jsonRes({ error: `Payload exceeds maximum size of ${maxBytes} bytes` }, 413);
  }

  // Decode and validate IV (must be exactly 12 bytes for AES-GCM)
  let ivBytes: Uint8Array;
  try {
    ivBytes = b64urlDecode(iv);
  } catch {
    return jsonRes({ error: 'iv is not valid base64url' }, 400);
  }
  if (ivBytes.length !== 12) {
    return jsonRes({ error: 'iv must be exactly 12 bytes (AES-GCM nonce)' }, 400);
  }

  // Integrity check: verify SHA-256 of ciphertext matches claimed sha256
  const computedHash = await sha256hex(ciphertextBytes);
  if (!timingSafeEqual(computedHash, sha256.toLowerCase())) {
    return jsonRes({ error: 'sha256 does not match encrypted payload' }, 400);
  }

  // Validate slug format and uniqueness
  if (slug != null) {
    if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
      return jsonRes({ error: 'slug must be 1-64 chars: lowercase letters, digits, hyphens' }, 400);
    }
    const existing = await env.DB
      .prepare('SELECT id FROM pages WHERE slug = ?')
      .bind(slug)
      .first<{ id: string }>();
    if (existing) {
      return jsonRes({ error: 'Slug already in use' }, 409);
    }
  }

  const id = genId();
  const deleteToken = genToken();
  const deleteTokenHash = await sha256hex(new TextEncoder().encode(deleteToken));

  const defaultTtl = parseInt(env.DEFAULT_TTL_SECONDS, 10);
  const maxTtl = parseInt(env.MAX_TTL_SECONDS, 10);
  const effectiveTtl = clampTtl(ttlSeconds, defaultTtl, maxTtl);
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = effectiveTtl != null ? nowSec + effectiveTtl : null;

  // Build R2 blob: iv (12 bytes) || ciphertext
  // The viewer extracts the IV from the first 12 bytes at decrypt time.
  const blobBytes = new Uint8Array(ivBytes.length + ciphertextBytes.length);
  blobBytes.set(ivBytes, 0);
  blobBytes.set(ciphertextBytes, ivBytes.length);

  const r2Key = `pages/${id}.html.enc`;

  await env.PAGES.put(r2Key, blobBytes.buffer as ArrayBuffer, {
    httpMetadata: {
      contentType: 'application/octet-stream',
      cacheControl: 'private, max-age=0, no-store',
    },
  });

  await env.DB
    .prepare(
      `INSERT INTO pages
         (id, slug, title, source_name, sha256, iv, blob_size, expires_at, created_at, delete_token_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      slug ?? null,
      title,
      sourceName,
      sha256.toLowerCase(),
      iv,
      blobBytes.length,
      expiresAt,
      nowSec,
      deleteTokenHash,
    )
    .run();

  const base = env.PUBLIC_BASE_URL;
  const viewId = slug ?? id;
  const expiresAtIso = expiresAt != null ? new Date(expiresAt * 1000).toISOString() : null;

  return jsonRes(
    {
      id,
      viewerUrl: `${base}/v/${viewId}`,
      blobUrl: `${base}/blob/${id}`,
      expiresAt: expiresAtIso,
      deleteToken,
    },
    201,
    { ...corsHeaders(), ...secHeaders() },
  );
}

async function handleList(req: Request, env: Env): Promise<Response> {
  const authErr = requireBearer(req, env.BEARER_TOKEN);
  if (authErr) return authErr;

  const url = new URL(req.url);
  const rawLimit = url.searchParams.get('limit');
  const limit = Math.min(Math.max(parseInt(rawLimit ?? '50', 10) || 50, 1), 200);

  const { results } = await env.DB
    .prepare(
      `SELECT id, slug, title, source_name, created_at, expires_at
         FROM pages
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<Pick<PageRow, 'id' | 'slug' | 'title' | 'source_name' | 'created_at' | 'expires_at'>>();

  const base = env.PUBLIC_BASE_URL;
  const pages = (results ?? []).map(r => ({
    id: r.id,
    title: r.title,
    sourceName: r.source_name,
    createdAt: new Date(r.created_at * 1000).toISOString(),
    expiresAt: r.expires_at != null ? new Date(r.expires_at * 1000).toISOString() : null,
    viewerUrl: `${base}/v/${r.slug ?? r.id}`,
  }));

  return jsonRes({ pages }, 200, { ...corsHeaders(), ...secHeaders() });
}

async function handleDelete(req: Request, env: Env, id: string): Promise<Response> {
  const deleteTokenHeader = req.headers.get('X-Delete-Token');
  const authHeader = req.headers.get('Authorization') ?? '';
  let authorized = false;

  // Path 1: Bearer token (owner/admin)
  if (authHeader.startsWith('Bearer ')) {
    authorized = timingSafeEqual(authHeader.slice(7).trim(), env.BEARER_TOKEN);
  }

  // Path 2: per-page delete token (self-service, no secret needed)
  if (!authorized && deleteTokenHeader) {
    const row = await env.DB
      .prepare('SELECT delete_token_hash FROM pages WHERE id = ?')
      .bind(id)
      .first<Pick<PageRow, 'delete_token_hash'>>();

    if (row) {
      const providedHash = await sha256hex(new TextEncoder().encode(deleteTokenHeader));
      authorized = timingSafeEqual(providedHash, row.delete_token_hash);
    }
    // If row is null we still fall through to 401 rather than 404 to avoid enumeration.
  }

  if (!authorized) {
    return jsonRes({ error: 'Unauthorized' }, 401, corsHeaders());
  }

  const r2Key = `pages/${id}.html.enc`;
  await Promise.all([
    env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(id).run(),
    env.PAGES.delete(r2Key),
  ]);

  return new Response(null, { status: 204, headers: { ...corsHeaders(), ...secHeaders() } });
}

async function handleBlob(env: Env, id: string): Promise<Response> {
  // Check expiry before serving — blob is ciphertext but we don't want
  // to serve data for a page that has logically expired.
  const meta = await env.DB
    .prepare('SELECT expires_at FROM pages WHERE id = ?')
    .bind(id)
    .first<Pick<PageRow, 'expires_at'>>();

  if (!meta) {
    return new Response('Not Found', { status: 404, headers: secHeaders() });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (meta.expires_at != null && meta.expires_at < nowSec) {
    return new Response('Gone', { status: 410, headers: secHeaders() });
  }

  const r2Key = `pages/${id}.html.enc`;
  const obj = await env.PAGES.get(r2Key);
  if (!obj) {
    // R2 and D1 are out of sync — treat as not found
    return new Response('Not Found', { status: 404, headers: secHeaders() });
  }

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'private, max-age=0, no-store',
      'Content-Length': String(obj.size),
      ...secHeaders(),
    },
  });
}

async function handleViewer(env: Env, idOrSlug: string): Promise<Response> {
  const row = await env.DB
    .prepare(
      `SELECT id, title, expires_at
         FROM pages
        WHERE id = ? OR slug = ?
        LIMIT 1`,
    )
    .bind(idOrSlug, idOrSlug)
    .first<Pick<PageRow, 'id' | 'title' | 'expires_at'>>();

  if (!row) {
    return new Response('Artifact not found', { status: 404, headers: secHeaders() });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (row.expires_at != null && row.expires_at < nowSec) {
    return new Response('Artifact has expired', { status: 410, headers: secHeaders() });
  }

  // Per-request nonce for CSP; the script body changes per request (id is injected),
  // so a hash-based CSP would need recomputation — nonce is simpler.
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...nonceBytes));

  return new Response(buildViewerHtml(row.id, row.title, nonce), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      // The decrypted artifact is rendered as a sandboxed blob: iframe. Blob
      // documents inherit this response CSP, so the viewer injects this nonce
      // into inline artifact <style> and inline <script> tags before rendering.
      // External network fetches remain blocked unless explicitly allowed below.
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "style-src-attr 'unsafe-inline'",
        "img-src data: blob:",
        "font-src data:",
        "media-src data: blob:",
        "connect-src 'self'",
        "frame-src blob:",
        "object-src 'none'",
        "base-uri 'none'",
      ].join('; '),
      ...secHeaders(),
    },
  });
}

// ─── Viewer HTML shell ───────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildViewerHtml(id: string, title: string, nonce: string): string {
  const safeTitle = esc(title) || 'Artifact Viewer';
  const safeId = esc(id); // IDs only contain [A-Za-z0-9_-] but escape for safety

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${safeTitle}</title>
<style nonce="${nonce}">
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#0f1117;color:#e2e2e2;font:15px/1.5 system-ui,sans-serif}
#shell{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  height:100%;gap:1rem;user-select:none;
}
#msg{font-size:.85rem;opacity:.55;letter-spacing:.04em}
#msg.err{color:#ff6b6b;opacity:1;max-width:36ch;text-align:center}
#ring{
  width:38px;height:38px;border-radius:50%;
  border:3px solid rgba(255,255,255,.1);border-top-color:#7c6af7;
  animation:spin .65s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
#frame{
  display:none;position:fixed;inset:0;width:100%;height:100%;
  border:none;background:#fff;
}
</style>
</head>
<body>
<div id="shell">
  <div id="ring"></div>
  <div id="msg">Decrypting\u2026</div>
</div>
<iframe id="frame"
  sandbox="allow-scripts allow-forms allow-modals allow-popups"
  referrerpolicy="no-referrer"
  title="${safeTitle}"></iframe>
<script nonce="${nonce}">
(async()=>{
'use strict';
const ID='${safeId}';
const msgEl=document.getElementById('msg');
const ringEl=document.getElementById('ring');
const frameEl=document.getElementById('frame');
const ARTIFACT_NONCE='${nonce}';

function addArtifactRuntime(html){
  const linkScript='<script nonce="'+ARTIFACT_NONCE+'">(function(){document.addEventListener("click",function(e){const a=e.target.closest&&e.target.closest("a[href]");if(!a||e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;const h=a.getAttribute("href")||"";if(!h.startsWith("#")||h==="#")return;let id;try{id=decodeURIComponent(h.slice(1));}catch{id=h.slice(1);}const t=document.getElementById(id);if(!t)return;e.preventDefault();try{history.pushState(null,"",h);}catch{}t.scrollIntoView({block:"start"});},true);})();<\\/script>';
  const withNonces=html
    .replace(/<style\\b([^>]*)>/gi,(tag,attrs)=>/\\bnonce\\s*=/.test(attrs)?tag:'<style nonce="'+ARTIFACT_NONCE+'"'+attrs+'>')
    .replace(/<script\\b([^>]*)>/gi,(tag,attrs)=>{
      if(/\\bnonce\\s*=/.test(attrs)||/\\bsrc\\s*=/.test(attrs)) return tag;
      return '<script nonce="'+ARTIFACT_NONCE+'"'+attrs+'>';
    });
  return /<\\/body>/i.test(withNonces)
    ? withNonces.replace(/<\\/body>/i,linkScript+'</body>')
    : withNonces+linkScript;
}

function fail(m){msgEl.textContent=m;msgEl.className='err';ringEl.style.display='none';}

function b64url(s){
  const p=s.replace(/-/g,'+').replace(/_/g,'/');
  const pad=p.length%4;
  const s2=pad?p+'===='.slice(pad):p;
  const bin=atob(s2);
  const out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);
  return out;
}

try{
  const frag=location.hash.slice(1);
  if(!frag){fail('No decryption key \u2014 the share URL must include a #fragment.');return;}

  const res=await fetch('/blob/'+ID);
  if(!res.ok){fail('Artifact not found or expired (HTTP '+res.status+').');return;}

  const buf=await res.arrayBuffer();
  if(buf.byteLength<13){fail('Blob is too short \u2014 artifact may be corrupt.');return;}

  // Blob layout: iv[12] || AES-GCM ciphertext
  const iv=new Uint8Array(buf,0,12);
  const ct=new Uint8Array(buf,12);

  let keyBytes;
  try{keyBytes=b64url(frag);}catch{fail('Malformed key in URL fragment.');return;}
  if(keyBytes.length!==32){fail('Key must be 32 bytes (AES-256-GCM).');return;}

  const ck=await crypto.subtle.importKey('raw',keyBytes,{name:'AES-GCM',length:256},false,['decrypt']);

  let plain;
  try{plain=await crypto.subtle.decrypt({name:'AES-GCM',iv},ck,ct);}
  catch{fail('Decryption failed \u2014 wrong key or corrupt data.');return;}

  const html=addArtifactRuntime(new TextDecoder().decode(plain));
  const blob=new Blob([html],{type:'text/html'});
  const burl=URL.createObjectURL(blob);

  frameEl.onload=()=>{
    document.getElementById('shell').style.display='none';
    frameEl.style.display='block';
  };
  // Keep the blob URL live while the viewer is open; same-document
  // fragment links resolve against it and stop working if it is revoked.
  addEventListener('pagehide',()=>URL.revokeObjectURL(burl),{once:true});
  frameEl.src=burl;
}catch(e){fail('Unexpected error: '+String(e));}
})();
</script>
</body>
</html>`;
}

// ─── Scheduled cleanup ───────────────────────────────────────────────────────

async function runCleanup(env: Env): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);

  const { results } = await env.DB
    .prepare('SELECT id FROM pages WHERE expires_at IS NOT NULL AND expires_at <= ?')
    .bind(nowSec)
    .all<{ id: string }>();

  if (!results?.length) return;

  const ids = results.map(r => r.id);

  // Delete R2 objects in parallel batches of 100
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    await Promise.all(chunk.map(id => env.PAGES.delete(`pages/${id}.html.enc`)));
  }

  // Delete D1 rows in batches (SQLite IN clause limit well within 100)
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const ph = chunk.map(() => '?').join(',');
    await env.DB
      .prepare(`DELETE FROM pages WHERE id IN (${ph})`)
      .bind(...chunk)
      .run();
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS preflight for API routes
    if (method === 'OPTIONS' && path.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (method === 'GET' && path === '/healthz') {
      return handleHealth();
    }

    if (path === '/api/pages') {
      if (method === 'POST') return handleUpload(req, env);
      if (method === 'GET') return handleList(req, env);
      return jsonRes({ error: 'Method Not Allowed' }, 405, corsHeaders());
    }

    const deleteMatch = /^\/api\/pages\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (deleteMatch && method === 'DELETE') {
      return handleDelete(req, env, deleteMatch[1]!);
    }

    const viewerMatch = /^\/v\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (viewerMatch && method === 'GET') {
      return handleViewer(env, viewerMatch[1]!);
    }

    const blobMatch = /^\/blob\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (blobMatch && method === 'GET') {
      return handleBlob(env, blobMatch[1]!);
    }

    return new Response('Not Found', { status: 404, headers: secHeaders() });
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await runCleanup(env);
  },
};
