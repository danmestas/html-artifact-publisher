import { parseFragment } from '../public/client.js';

function checkedOrigin(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('HTML_PUBLISHER_URL must be an HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('HTML_PUBLISHER_URL must be a bare HTTP(S) origin');
  return url.origin;
}

function access({ base, credential, artifactUrl }) {
  if (artifactUrl !== undefined) {
    let url;
    try { url = new URL(artifactUrl); } catch { throw new Error('--artifact needs an artifact capability link'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search) throw new Error('Invalid artifact capability link');
    const match = /^\/v\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    if (!match) throw new Error('--artifact needs /v/<id>#<capability>');
    let parts;
    try { parts = parseFragment(url.hash); } catch { throw new Error('--artifact needs a valid read, comment, or edit capability'); }
    if (parts.at) throw new Error('Body search covers the current version; remove @version from the supplied link');
    return { origin: url.origin, authorization: 'Token ' + parts.token, secret: parts.token, artifactId: match[1] };
  }
  const origin = checkedOrigin(base);
  if (!credential || /\s/.test(credential)) throw new Error('HTML_PUBLISHER_TOKEN is required for remote search');
  return { origin, authorization: 'Bearer ' + credential, secret: credential };
}

function safeText(value, secret) {
  return String(value ?? '').replaceAll(secret, '[credential]')
    .replace(/https?:\/\/[^\s<>"']+:[^\s<>"']+@[^\s<>"']+/gi, '[private access link]')
    .replace(/https?:\/\/[^\s<>"']+\/v\/[A-Za-z0-9_-]+#[a-f0-9]{64}(?:@[a-f0-9]{10,64})?/gi, '[artifact access link]');
}

function resultRow(row, auth) {
  if (!row || !/^[A-Za-z0-9_-]{1,64}$/.test(row.id)) throw new Error('Search returned an invalid artifact identifier');
  let viewerUrl = new URL('/v/' + encodeURIComponent(row.id), auth.origin);
  try {
    const supplied = new URL(row.viewerUrl, auth.origin);
    if (supplied.origin === auth.origin && /^\/v\/[A-Za-z0-9_-]{1,64}$/.test(supplied.pathname)) viewerUrl = supplied;
  } catch { /* identifiers still give a safe tokenless viewer link */ }
  viewerUrl.hash = ''; viewerUrl.search = ''; viewerUrl.username = ''; viewerUrl.password = '';
  const out = { id: row.id, title: safeText(row.title, auth.secret), viewerUrl: viewerUrl.href };
  for (const key of ['tip', 'createdAt', 'updatedAt', 'expiresAt', 'accessLabel', 'permission']) {
    if (row[key] === null) out[key] = null;
    else if (typeof row[key] === 'string') out[key] = safeText(row[key], auth.secret);
  }
  if (row.searchIndex && typeof row.searchIndex === 'object') out.searchIndex = {
    status: ['complete', 'partial', 'pending', 'error', 'unsupported'].includes(row.searchIndex.status) ? row.searchIndex.status : 'error',
    version: Number.isSafeInteger(row.searchIndex.version) ? row.searchIndex.version : null,
  };
  if (row.search && typeof row.search === 'object') {
    const s = row.search;
    out.search = {
      matchedTerms: Array.isArray(s.matchedTerms) ? s.matchedTerms.map(term => safeText(term, auth.secret)) : [],
      totalTerms: s.totalTerms, partial: s.partial === true,
      ...(typeof s.matchedIn === 'string' ? { matchedIn: s.matchedIn } : {}), snippet: null,
    };
    if (typeof s.snippet?.text === 'string') {
      const text = safeText(s.snippet.text, auth.secret);
      out.search.snippet = { text, path: safeText(s.snippet.path, auth.secret),
        matches: text === s.snippet.text && Array.isArray(s.snippet.matches) ? s.snippet.matches : [] };
    }
  }
  return out;
}

async function responseJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`Search returned no response body (HTTP ${response.status})`);
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error('Search response is too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error(`Search returned invalid JSON (HTTP ${response.status})`); }
}

// The credential authenticates the request; results contain no new grants.
export async function remoteSearch({ base, credential, artifactUrl, query, limit = 25, cursor }) {
  const q = String(query ?? '').trim();
  if (!q || q.length > 300) throw new Error('search needs a query of 1–300 characters');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be 1–100');
  if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 16384)) throw new Error('Invalid search cursor');
  const auth = access({ base, credential, artifactUrl });
  const url = new URL('/api/search', auth.origin);
  url.searchParams.set('q', q); url.searchParams.set('limit', String(limit));
  if (auth.artifactId) url.searchParams.set('artifactId', auth.artifactId);
  if (cursor) url.searchParams.set('cursor', cursor);
  const response = await fetch(url, { headers: { Authorization: auth.authorization }, credentials: 'omit',
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) });
  const data = await responseJson(response);
  if (!response.ok) throw new Error(`Search failed (HTTP ${response.status}): ${safeText(typeof data.error === 'string' ? data.error : 'request rejected', auth.secret)}`);
  if (!Array.isArray(data.artifacts) || !Number.isSafeInteger(data.total) || data.total < 0 || data.artifacts.length > limit
    || !(data.nextCursor == null || (typeof data.nextCursor === 'string' && data.nextCursor.length > 0 && data.nextCursor.length <= 16384))) throw new Error('Search returned an invalid result page');
  return { artifacts: data.artifacts.map(row => resultRow(row, auth)), total: data.total, nextCursor: data.nextCursor ?? null,
    ...(data.searchCoverage ? { searchCoverage: data.searchCoverage } : {}) };
}
