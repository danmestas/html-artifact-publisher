import type { Account } from './registry';
import { searchTerms } from './search';
import type { Caller } from './repo';
import { ACTIVITY_KINDS, LOGIN_TTL, LOGIN_CODE_TTL, SESSION_TTL, REMEMBERED_SESSION_TTL, parseExpiration } from './registry';
import { safeReturnTo } from '../public/auth-return.js';
import { genId, genToken, isoOrNull, sha256hex, timingSafeEqual } from './util';

export const registry = (env: Env) => env.REGISTRY.getByName('registry');
export const publicUser = (u: Account) => ({ id:u.id,email:u.email,name:u.name,role:u.role });
const cookieName = 'artifact_session';
export function json(data: unknown, status = 200, extra: Record<string,string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...extra } });
}
export const error = (message: string, status = 400) => json({ error:message },status);
function sessionToken(req: Request): string { return /(?:^|;\s*)artifact_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.get('Cookie') ?? '')?.[1] ?? ''; }
export async function identity(req: Request, env: Env): Promise<{ user: Account | null; legacy: boolean; explicit: boolean }> {
  const r = registry(env);
  const ownerEmail = email(env.OWNER_EMAIL);
  if (ownerEmail) await r.seed(ownerEmail);
  const auth = req.headers.get('Authorization') ?? '';
  if (auth) {
    if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      if (env.BEARER_TOKEN && timingSafeEqual(token,env.BEARER_TOKEN)) return { user:null,legacy:true,explicit:true };
      return { user:await r.authenticate(await sha256hex(token),true),legacy:false,explicit:true };
    }
    return { user:null,legacy:false,explicit:true };
  }
  const token = sessionToken(req);
  return { user:token ? await r.authenticate(await sha256hex(token)) : null,legacy:false,explicit:false };
}
export async function needsReauthentication(req: Request, env: Env, actor: Awaited<ReturnType<typeof identity>>): Promise<boolean> {
  return !actor.explicit && await registry(env).sessionNeedsReauth(await sha256hex(sessionToken(req)));
}
export const reauthenticationError = () => json({ error:'Sign in again to confirm this security change. Nothing was changed.',reauthRequired:true },403);

export async function artifactCaller(req: Request, env: Env, id: string): Promise<Caller> {
  const actor = await identity(req,env);
  if (actor.legacy) return { owner:true,token:'' };
  if (actor.user) return { owner:false,token:'',permission:await registry(env).permission(id,actor.user) ?? undefined };
  const auth = req.headers.get('Authorization') ?? '';
  return { owner:false,token:auth.startsWith('Token ') ? auth.slice(6).trim() : '' };
}
export function csrf(req: Request): boolean {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return true;
  const origin = req.headers.get('Origin');
  // A supplied Origin must always match, even with an explicit credential.
  if (origin !== null) return origin === new URL(req.url).origin;
  return !!req.headers.get('Authorization');
}
export async function smallBody(req: Request): Promise<Record<string,unknown> | null> {
  return readBody(req,16384);
}
export async function readBody(req: Request, maxBytes: number): Promise<Record<string,unknown> | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || Number(req.headers.get('Content-Length') ?? 0)>maxBytes) return null;
  try {
    const reader = req.body?.getReader();
    if (!reader) return null;
    let text = ''; let length = 0; const decoder = new TextDecoder();
    for (;;) { const { done,value } = await reader.read(); if (done) break; length+=value.length; if (length>maxBytes) { await reader.cancel(); return null; } text+=decoder.decode(value,{stream:true}); }
    text+=decoder.decode(); const b: unknown = JSON.parse(text);
    return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string,unknown> : null;
  } catch { return null; }
}
function email(value: unknown): string | null { return typeof value === 'string' && value.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : null; }
function appOrigin(env: Env): URL | null {
  try { const url = new URL(env.APP_ORIGIN); return url.origin === env.APP_ORIGIN && !url.username && !url.password && (url.protocol==='https:' || loopback(url)) ? url : null; } catch { return null; }
}
const loopback = (url: URL) => url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
function testMail(req: Request, env: Env): boolean {
  const app = appOrigin(env); const url = new URL(req.url);
  // Miniflare also supplies CF-Connecting-IP. Only an actual loopback client
  // may use this transport, alongside both exact loopback origins. A public
  // Cloudflare client cannot select the provider's connecting-IP header.
  const ip = req.headers.get('CF-Connecting-IP');
  return env.TEST_MAIL_TRANSPORT==='loopback' && !!app && loopback(app) && loopback(url) && url.origin===app.origin && (ip===null || ip==='127.0.0.1' || ip==='::1');
}
function loginCode(): string {
  // Reject the incomplete final range instead of biasing a modulo reduction.
  let value: number;
  do { value = crypto.getRandomValues(new Uint32Array(1))[0]!; } while (value >= 4_200_000_000);
  return String(value % 100_000_000).padStart(8,'0');
}
async function sendLogin(req: Request, env: Env, user: Account, returnTo = '/', challenge?: string): Promise<Response> {
  const origin = appOrigin(env);
  if (!origin || (!testMail(req,env) && (!env.EMAIL_FROM || !env.EMAIL))) return error('Email sign-in is not configured',503);
  const token = genToken(); const hash = await sha256hex(token);
  const target = safeReturnTo(returnTo);
  const code = challenge ? loginCode() : undefined;
  const stored = await registry(env).login(hash,user.id,target,challenge && code ? {
    challengeHash:await sha256hex(challenge),codeHash:await sha256hex(challenge + ':' + code),
  } : undefined);
  if (!stored) return json({ ok:true });
  const loginUrl = `${origin.origin}/login${target === '/' ? '' : '?returnTo=' + encodeURIComponent(target)}#token=${token}`;
  if (testMail(req,env)) return json({ ok:true,loginUrl,...(code ? { loginCode:code } : {}) });
  try {
    const alternative = code ? `\n\nOr enter this code in the browser where you requested it: ${code}\nThe code works for ${LOGIN_CODE_TTL/60} minutes, with at most five attempts.` : '';
    await env.EMAIL.send({ from:env.EMAIL_FROM,to:user.email,subject:target.startsWith('/v/') ? 'Sign in to open your artifact' : 'Sign in to your artifact library',text:`Use this one-time link within ${LOGIN_TTL/60} minutes:\n${loginUrl}${alternative}\n\nIf you did not request this, ignore this message.` });
  } catch {
    // Invalidate a failed delivery; do not reveal provider errors or tokens.
    await registry(env).discardLogin(hash);
    return error('Email delivery is unavailable',503);
  }
  return json({ ok:true });
}
function sessionCookie(req: Request, token: string, clear = false, rememberDevice = false): string {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : rememberDevice ? REMEMBERED_SESSION_TTL : SESSION_TTL}${new URL(req.url).protocol==='https:' ? '; Secure' : ''}`;
}
const limitOf = (url: URL) => Math.min(100,Math.max(1,Number.parseInt(url.searchParams.get('limit') ?? '25',10)||25));

async function libraryResults(req: Request, env: Env, user: Account | null, admin: boolean, scope: { artifactId?:string; artifactPermission?:'read' | 'comment' | 'write'; credentialKey?:string } = {}): Promise<Response> {
  const url = new URL(req.url);
  let pagination: { page:number; pageSize:number } | undefined;
  if (url.searchParams.has('page') || url.searchParams.has('pageSize')) {
    if (!['/api/library','/api/admin/artifacts'].includes(url.pathname)) return error('Numbered pages are limited to library and inventory');
    if (url.searchParams.getAll('page').length !== 1 || url.searchParams.getAll('pageSize').length > 1
      || url.searchParams.has('cursor') || url.searchParams.has('limit')) return error('Invalid pagination');
    const page = url.searchParams.get('page') ?? '', pageSize = url.searchParams.get('pageSize') ?? '25';
    if (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page))
      || !['10','25','50','100'].includes(pageSize)) return error('Invalid pagination');
    pagination = { page:Number(page), pageSize:Number(pageSize) };
  }
  const view = url.searchParams.get('view') ?? 'all', status = url.searchParams.get('status') ?? 'all';
  if (!['all','mine','shared','starred','archived'].includes(view) || !['all','active','archived'].includes(status)) return error('Invalid filter');
  let cursor = url.searchParams.get('cursor') ?? '';
  const q = (url.searchParams.get('q') ?? '').slice(0,300).trim();
  if (searchTerms(q).length > 12) return error('Search supports at most 12 terms');
  const sort = url.searchParams.get('sort') ?? (q ? 'relevance' : 'recent');
  const accountLibrary = url.pathname === '/api/library' && !!user;
  if (sort !== 'recent' && sort !== 'name' && sort !== 'relevance' && !((admin || accountLibrary) && sort === 'expiry')) return error('Invalid sort');
  const expiry = url.searchParams.get('expiry') ?? 'all';
  if (expiry !== 'all' && expiry !== 'soon') return error('Invalid expiry');
  if (!admin && expiry !== 'all') return error('Invalid expiry');
  if (sort === 'relevance' && !q) return error('Relevance requires a search');
  const ownerId = (url.searchParams.get('ownerId') ?? '').slice(0,64);
  const cursorKind = pagination ? '' : accountLibrary ? 'library' : q ? 'search' : '';
  const queryKey = cursorKind ? await sha256hex(JSON.stringify([searchTerms(q),sort,admin,view,status,expiry,ownerId,user?.id ?? scope.credentialKey ?? 'instance',scope.artifactId ?? '',...(accountLibrary ? [url.pathname] : [])])) : '';
  if (cursor && cursorKind) {
    try {
      const wrapped = JSON.parse(cursor);
      if (!Array.isArray(wrapped) || wrapped.length !== 3 || wrapped[0] !== cursorKind || wrapped[1] !== queryKey || typeof wrapped[2] !== 'string') return error('Invalid cursor');
      cursor = wrapped[2];
    } catch { return error('Invalid cursor'); }
  }
  if (cursor) {
    try {
      const v: unknown = JSON.parse(cursor);
      if (!Array.isArray(v) || (sort === 'relevance'
        ? v.length !== 4 || v[0] !== 'relevance' || !Number.isSafeInteger(v[1]) || v[1] < 0 || v[1] > 12120 || !Number.isSafeInteger(v[2]) || v[2] < 0
        : sort === 'name'
          ? v.length !== 3 || v[0] !== 'name' || typeof v[1] !== 'string' || v[1].length > 300
          : sort === 'expiry'
            ? v.length !== 3 || v[0] !== 'expiry' || !(v[1] === null || (Number.isSafeInteger(v[1]) && (v[1] as number) >= 0))
            : v.length !== 2 || !Number.isSafeInteger(v[0]) || v[0] < 0)
        || typeof v.at(-1) !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v.at(-1))) return error('Invalid cursor');
    } catch { return error('Invalid cursor'); }
  }
  const includeSharingSummary = accountLibrary && !req.headers.has('Authorization') && !!sessionToken(req);
  const result = await registry(env).library(user,{admin,view,status,cursor,sort,expiry,q,ownerId,limit:pagination?.pageSize ?? limitOf(url),...(pagination ? {page:pagination.page} : {}),...scope,includeSharingSummary});
  const artifacts = result.artifacts.map(e => {
    const document = {id:e.id,slug:e.slug,title:e.title,tip:e.tip,icon:e.icon,searchIndex:e.searchIndex,...(e.search ? {search:e.search} : {}),
      createdAt:isoOrNull(e.createdAt),updatedAt:isoOrNull(e.updatedAt),expiresAt:isoOrNull(e.expiresAt),viewerUrl:`${url.origin}/v/${e.slug ?? e.id}`};
    return scope.artifactPermission ? {...document,permission:scope.artifactPermission,canManage:false} : {...e,...document};
  });
  return json({...result,artifacts,nextCursor:result.nextCursor && cursorKind ? JSON.stringify([cursorKind,queryKey,result.nextCursor]) : result.nextCursor});
}

/** Account routes; null leaves the existing artifact/sync API in charge. */
export async function accountRoutes(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url), path = url.pathname, method = req.method;
  if (!/^\/api\/(session$|auth\/|library$|search$|admin\/|people(?:\/|$)|invitations$|credentials(?:\/|$)|artifacts\/[^/]+\/(sharing|manage|star|expiration-state)$)/.test(path)) return null;
  const r = registry(env); const actor = await identity(req,env);
  if (path==='/api/session' && method==='GET') return json({ user:actor.user ? publicUser(actor.user) : null });
  if (path==='/api/search') {
    if (method!=='GET') return error('Method not allowed',405);
    const authorization = req.headers.get('Authorization') ?? '';
    if (authorization.startsWith('Token ')) {
      const key = url.searchParams.get('artifactId') ?? '';
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return error('Artifact Token search requires artifactId');
      const artifactId = await r.resolve(key);
      if (!artifactId) return error('Not found',404);
      const token = authorization.slice(6).trim();
      const permission = await env.REPO.getByName(artifactId).role({owner:false,token});
      if (!permission) return error('Not found',404);
      if ((url.searchParams.has('scope') && url.searchParams.get('scope') !== 'library')
        || ['ownerId','status','expiry'].some(name => url.searchParams.has(name))
        || !['all','archived'].includes(url.searchParams.get('view') ?? 'all')) return error('Artifact Token search is limited to one artifact',403);
      return libraryResults(req,env,null,false,{artifactId,artifactPermission:permission,credentialKey:await sha256hex(token)});
    }
    if (!actor.legacy && !actor.user) return error('Sign in required',401);
    const scope = url.searchParams.get('scope') ?? (actor.legacy ? 'inventory' : 'library');
    if (scope !== 'library' && scope !== 'inventory') return error('Invalid scope');
    if (scope === 'inventory' && !actor.legacy && actor.user?.role !== 'owner') return error('Instance owner required',403);
    if (actor.legacy && scope !== 'inventory') return error('Instance access requires inventory scope');
    if (scope !== 'inventory' && (url.searchParams.has('ownerId') || url.searchParams.has('status') || url.searchParams.has('expiry'))) return error('Inventory filters require inventory scope',403);
    const key = url.searchParams.get('artifactId');
    let artifactId: string | undefined;
    if (key !== null) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return error('Not found',404);
      artifactId = await r.resolve(key) ?? undefined;
      if (!artifactId || (actor.user && !await r.permission(artifactId,actor.user))) return error('Not found',404);
    }
    return libraryResults(req,env,actor.user,scope === 'inventory',{artifactId});
  }
  if (path==='/api/auth/request' && method==='POST') {
    const b = await smallBody(req); const address = email(b?.email);
    if (b?.challenge !== undefined && (typeof b.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(b.challenge))) return error('Invalid sign-in challenge');
    if (!address) return json({ ok:true });
    const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
    // 5 links per address keep one inbox from being flooded; 60 per client address lets an office behind one NAT sign in.
    if (!(await r.rate([`email:${await sha256hex(address)}`,[`ip:${await sha256hex(ip)}`,60]]))) return json({ ok:true });
    const user = await r.byEmail(address);
    return user && user.status!=='disabled' ? sendLogin(req,env,user,safeReturnTo(b?.returnTo),b?.challenge as string | undefined) : json({ ok:true });
  }
  if (path==='/api/auth/verify' && method==='POST') {
    const b = await smallBody(req);
    const invalid = () => error('Invalid or expired sign-in link or code',401);
    if (!b) return invalid();
    if (b.rememberDevice !== undefined && typeof b.rememberDevice !== 'boolean') return error('rememberDevice must be boolean');
    const byLink = b.token !== undefined;
    const byCode = b.challenge !== undefined || b.code !== undefined;
    if (byLink === byCode) return invalid();
    if (byLink && (typeof b.token !== 'string' || !/^[a-f0-9]{64}$/.test(b.token))) return invalid();
    if (byCode && (typeof b.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(b.challenge) || typeof b.code !== 'string' || !/^\d{8}$/.test(b.code))) return invalid();
    if (byCode) {
      const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
      if (!(await r.rate([[`code-ip:${await sha256hex(ip)}`,60]]))) return invalid();
    }
    const token = genToken(); const sessionHash = await sha256hex(token);
    const verified = byLink
      ? await r.verify(await sha256hex(b.token as string),sessionHash,b.rememberDevice === true)
      : await r.verifyCode(await sha256hex(b.challenge as string),await sha256hex(b.challenge + ':' + b.code),sessionHash,b.rememberDevice === true);
    if (!verified) return invalid();
    // Reauthentication rotates this browser's prior session rather than
    // leaving an overwritten remembered credential valid for another month.
    const previous = sessionToken(req);
    if (previous) await r.logout(await sha256hex(previous));
    await r.audit(verified.user.id,'sign_in');
    return json({ user:publicUser(verified.user), returnTo:safeReturnTo(verified.returnTo) },200,{ 'Set-Cookie':sessionCookie(req,token,false,b.rememberDevice === true) });
  }
  if (path==='/api/auth/logout' && method==='POST') {
    await r.logout(await sha256hex(sessionToken(req)));
    return json({ ok:true },200,{ 'Set-Cookie':sessionCookie(req,'',true) });
  }
  // The legacy instance credential already owns artifact content, but has no
  // account identity. Permit only expiration here, not account management,
  // sharing, transfers, archive or rename. Edit-link credentials stay excluded.
  const legacyManage = /^\/api\/artifacts\/([A-Za-z0-9_-]{1,64})\/manage$/.exec(path);
  if (actor.legacy && legacyManage && method==='PATCH') {
    const b = await smallBody(req);
    if (!b) return error('Invalid management request');
    if (Object.keys(b).length!==1 || !Object.hasOwn(b,'expiresAt')) return error('Instance automation may change only expiresAt',403);
    const requested = parseExpiration(b.expiresAt,Number.parseInt(env.MAX_TTL_SECONDS,10),Math.floor(Date.now()/1000));
    if ('error' in requested) return error(requested.error);
    const id = await r.resolve(legacyManage[1]!);
    const entry = id ? await r.get(id) : null;
    if (!id || !entry) return error('Not found',404);
    const expiration = await env.REPO.getByName(id).setExpiration(requested.expiresAt,'instance-owner',entry.title);
    if (!expiration.found) return error('Not found',404);
    return expiration.projected ? json({ ok:true }) : json({ ok:true,expirationPending:true },202);
  }
  if (path==='/api/admin/search-index') {
    // Existing instance authority owns this inventory operation, not an account
    // identity. It gains no access to people, grants or credential issuance.
    if (!actor.legacy && !actor.user) return error('Sign in required',401);
    if (!actor.legacy && actor.user?.role!=='owner') return error('Instance owner required',403);
    if (method==='GET') return json(await r.searchBackfillStatus());
    if (method==='POST') {
      const input = await smallBody(req);
      if (!input || Object.keys(input).length) return error('Expected an empty object');
      return json(await r.startSearchBackfill(),202);
    }
    return error('Method not allowed',405);
  }
  const user = actor.user;
  if (!user) return error('Sign in required',401);
  const admin = user.role==='owner';
  // Ordinary reads and emergency revocations never require a new email. Only
  // authority-increasing actions step up an old remembered browser session.
  const needsReauth = () => needsReauthentication(req,env,actor);
  const reauth = reauthenticationError;
  if (path.startsWith('/api/admin/') || path.startsWith('/api/people') || path==='/api/invitations') {
    if (!admin) return error('Instance owner required',403);
  }
  if ((path==='/api/library' || path==='/api/admin/artifacts') && method==='GET') return libraryResults(req,env,user,path==='/api/admin/artifacts');
  if (path==='/api/people' && method==='GET') {
    // Counts come from one grouped pass, not a query per person.
    const counts = await r.artifactCounts();
    const users = [];
    for (const u of await r.people()) {
      const invited = u.status==='invited';
      users.push({ ...publicUser(u),status:u.status,createdAt:isoOrNull(u.created_at ?? null),
        artifactCount:counts[u.id] ?? 0,
        // null means no recorded sign-in (an account that never signed in, or
        // one that predates sign-in auditing); it does not claim it never did.
        lastSignInAt:isoOrNull(u.last_sign_in_at),
        ...(invited ? { resendAfter:await r.rateWait(`email:${await sha256hex(u.email)}`),inviteExpiresAt:isoOrNull(await r.loginExpiry(u.id)) } : {}) });
    }
    return json({ users });
  }
  if (path==='/api/invitations' && method==='POST') {
    const b = await smallBody(req); const address = email(b?.email);
    if (!address || (b?.name!==undefined && (typeof b.name!=='string' || b.name.length>100))) return error('Valid email and name required');
    const existing = await r.byEmail(address);
    if (existing && existing.status!=='invited') return error('Account already exists',409);
    if (await needsReauth()) return reauth();
    if (!(await r.rate([`email:${await sha256hex(address)}`]))) { const retryAfter = await r.rateWait(`email:${await sha256hex(address)}`); return json({ error:`Please wait ${Math.max(1,Math.ceil(retryAfter/60))} minutes before resending`,retryAfter },429,{ 'Retry-After':String(retryAfter) }); }
    const invited = await r.invite(address,typeof b?.name==='string' ? b.name.trim() || address : address);
    const response = await sendLogin(req,env,invited);
    if (response.ok) await r.audit(user.id,'invite',null,null,address);
    return response;
  }
  const person = /^\/api\/people\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (person && method==='DELETE') {
    const target = await r.account(person[1]!);
    if (!target) return error('Account not found',404);
    if (!(await r.withdraw(target.id))) return error('Only an invitation that was never accepted can be withdrawn',409);
    await r.audit(user.id,'invite_withdrawn',null,null,target.email); return json({ ok:true });
  }
  if (person && method==='PATCH') {
    const b = await smallBody(req); const target = await r.account(person[1]!);
    if (!target) return error('Account not found',404);
    if (target.role==='owner') return error('Cannot change the instance owner',403);
    if (b?.status!=='active' && b?.status!=='disabled') return error('Invalid status');
    if (b.status === 'active' && await needsReauth()) return reauth();
    await r.status(target.id,b.status); await r.audit(user.id,`account_${b.status}`,null,null,target.name && target.name!==target.email ? `${target.name} (${target.email})` : target.email); return json({ ok:true });
  }
  if (path==='/api/admin/activity' && method==='GET') {
    const kind = url.searchParams.get('kind') ?? '';
    if (kind && !ACTIVITY_KINDS[kind]) return error('Unknown activity kind');
    const page = await r.activity(limitOf(url),kind,(url.searchParams.get('cursor') ?? '').slice(0,200),(url.searchParams.get('q') ?? '').slice(0,300));
    return json({ events:page.events.map(e => ({ ...e,createdAt:isoOrNull(e.createdAt) })),nextCursor:page.nextCursor });
  }
  if (path==='/api/credentials') {
    if (method==='GET') return json({ credentials:(await r.credentials(user.id)).map(c => ({ ...c,createdAt:isoOrNull(c.createdAt) })) });
    if (method==='POST') {
      const b = await smallBody(req);
      if (typeof b?.name!=='string' || !b.name.trim() || b.name.length>100) return error('Credential name required (1–100 characters)');
      if (await needsReauth()) return reauth();
      const id = genId(),token = genToken(),name = b.name.trim();
      if (!(await r.credential(user.id,id,name,await sha256hex(token)))) return error('Credential limit reached',409);
      await r.audit(user.id,'credential_create'); return json({ id,name,token },201);
    }
  }
  const credential = /^\/api\/credentials\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (credential && method==='DELETE') { await r.revoke(user.id,credential[1]!); await r.audit(user.id,'credential_revoke'); return json({ ok:true }); }
  // Test-only read of the Repo's durability state, so a test can see a pending
  // intent and its armed alarm while a projection is still outstanding. The
  // hook variable is blank in every deployed configuration.
  const state = /^\/api\/artifacts\/([A-Za-z0-9_-]{1,64})\/expiration-state$/.exec(path);
  if (state && method==='GET') {
    if (!(env as unknown as Record<string,string|undefined>).TEST_EXPIRATION_STATE) return error('Not found',404);
    const id = await r.resolve(state[1]!); if (!id) return error('Not found',404);
    const entry = await r.get(id); const permission = await r.permission(id,user);
    if (!permission || !entry || !(admin || entry.ownerId===user.id)) return error('Not found',404);
    return json(await env.REPO.getByName(id).expirationState());
  }
  const artifact = /^\/api\/artifacts\/([A-Za-z0-9_-]{1,64})\/(sharing|manage|star)$/.exec(path);
  if (artifact) {
    const id = await r.resolve(artifact[1]!); if (!id) return error('Not found',404);
    const entry = await r.get(id); const permission = await r.permission(id,user);
    if (!permission || !entry) return error('Not found',404);
    const canManage = admin || entry.ownerId===user.id;
    if (artifact[2]==='star' && method==='PUT') {
      const b = await smallBody(req); if (typeof b?.starred!=='boolean') return error('starred must be boolean');
      await r.star(id,user.id,b.starred); return json({ ok:true });
    }
    if (!canManage) return error('Artifact owner required',403);
    if (artifact[2]==='sharing') {
      if (method==='GET') return json({ ownerId:entry.ownerId,grants:await r.sharing(id),users:(await r.people()).filter(u => (u.status==='active' || u.status==='invited') && u.role!=='owner' && u.id!==entry.ownerId).map(u => ({ id:u.id,email:u.email,name:u.name,status:u.status })) });
      if (method==='PUT') {
        const b = await smallBody(req);
        if (typeof b?.userId!=='string' || !['read','write',null].includes(b.permission as string | null)) return error('Valid user and permission required');
        const target = await r.account(b.userId);
        if (!target || target.role==='owner' || target.id===entry.ownerId
          || (b.permission !== null && target.status !== 'active' && target.status !== 'invited')) return error('Target must be an invited or active non-owner account');
        if (b.permission !== null && await needsReauth()) return reauth();
        await r.grant(id,target.id,b.permission as string | null); await r.audit(user.id,'sharing_change',id,entry.title); return json({ ok:true });
      }
    }
    if (artifact[2]==='manage' && method==='PATCH') {
      const b = await smallBody(req); if (!b || !Object.keys(b).length || Object.keys(b).some(k => !['archived','ownerId','title','expiresAt'].includes(k))) return error('Invalid management request');
      if (b.archived!==undefined && typeof b.archived!=='boolean') return error('archived must be boolean');
      if (b.title!==undefined && (typeof b.title!=='string' || !b.title.trim() || b.title.length>300)) return error('Title must have 1–300 characters');
      if (b.ownerId!==undefined) {
        if (!admin) return error('Only instance owner may transfer artifacts',403);
        if (await needsReauth()) return reauth();
        const target = typeof b.ownerId==='string' ? await r.account(b.ownerId) : null;
        if (!target || target.status!=='active') return error('New owner must be active');
      }
      // Omitted leaves the current expiration. Repo owns the deadline;
      // Registry projects it for the library and access checks.
      const requested = b.expiresAt===undefined ? undefined : parseExpiration(b.expiresAt, Number.parseInt(env.MAX_TTL_SECONDS,10), Math.floor(Date.now()/1000));
      if (requested && 'error' in requested) return error(requested.error);
      const changes = b as { archived?: boolean; ownerId?: string; title?: string };
      const renamed = changes.title ? changes.title.trim() : null;
      // Expiration is owned by the Repo: it persists the deadline and the
      // revision naming this intent, then projects it to the library row
      // itself. A failed projection stays pending there and its alarm retries,
      // so convergence is scheduled rather than assumed.
      //
      // It runs before the other changes so its answer is not a partial
      // success: a Repo that is already gone must answer not found without a
      // rename or archive having landed first. The audit title is the one the
      // artifact will have once this request finishes.
      let expiration = null as null | { projected: boolean; found: boolean };
      if (requested) expiration = await env.REPO.getByName(id).setExpiration(requested.expiresAt,user.id,renamed ?? entry.title);
      if (expiration && !expiration.found) return error('Not found',404);
      if (renamed) await env.REPO.getByName(id).rename(renamed);
      await r.manage(id,{ ...changes,...(renamed ? { title:renamed } : {}) });
      // Each change a request makes is audited under its own kind; a combined
      // request must not lose the expiration to a rename or archive. The
      // expiration entry comes from the Repo's accepted projection instead, so
      // a retry cannot write it twice.
      const audited: [string, string | null][] = [];
      if (renamed) audited.push(['rename', renamed]);
      if (changes.archived !== undefined) audited.push([changes.archived ? 'archive' : 'restore', entry.title]);
      if (changes.ownerId) audited.push(['transfer', entry.title]);
      for (const [action, title] of audited) await r.audit(user.id, action, id, title);
      // Report the projection honestly: the deadline is durable either way, but
      // a caller should not be told the library agrees when it does not yet.
      if (expiration && !expiration.projected) return json({ ok:true, expirationPending:true },202);
      return json({ ok:true });
    }
  }
  return error('Method not allowed',405);
}
