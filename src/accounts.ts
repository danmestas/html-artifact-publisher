import type { Account } from './registry';
import type { Caller } from './repo';
import { ACTIVITY_KINDS, LOGIN_TTL, parseExpiration } from './registry';
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
async function sendLogin(req: Request, env: Env, user: Account): Promise<Response> {
  const origin = appOrigin(env);
  if (!origin || (!testMail(req,env) && (!env.EMAIL_FROM || !env.EMAIL))) return error('Email sign-in is not configured',503);
  const token = genToken(); const hash = await sha256hex(token);
  await registry(env).login(hash,user.id);
  const loginUrl = `${origin.origin}/login#token=${token}`;
  if (testMail(req,env)) return json({ ok:true,loginUrl });
  try {
    await env.EMAIL.send({ from:env.EMAIL_FROM,to:user.email,subject:'Sign in to your artifact library',text:`Use this one-time link within ${LOGIN_TTL/60} minutes:\n${loginUrl}\n\nIf you did not request this, ignore this message.` });
  } catch {
    // Invalidate a failed delivery; do not reveal provider errors or tokens.
    await registry(env).discardLogin(hash);
    return error('Email delivery is unavailable',503);
  }
  return json({ ok:true });
}
function sessionCookie(req: Request, token: string, clear = false): string {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : 604800}${new URL(req.url).protocol==='https:' ? '; Secure' : ''}`;
}
const limitOf = (url: URL) => Math.min(100,Math.max(1,Number.parseInt(url.searchParams.get('limit') ?? '25',10)||25));

/** Account routes; null leaves the existing artifact/sync API in charge. */
export async function accountRoutes(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url), path = url.pathname, method = req.method;
  if (!/^\/api\/(session$|auth\/|library$|admin\/|people(?:\/|$)|invitations$|credentials(?:\/|$)|artifacts\/[^/]+\/(sharing|manage|star|expiration-state)$)/.test(path)) return null;
  const r = registry(env); const actor = await identity(req,env);
  if (path==='/api/session' && method==='GET') return json({ user:actor.user ? publicUser(actor.user) : null });
  if (path==='/api/auth/request' && method==='POST') {
    const b = await smallBody(req); const address = email(b?.email);
    if (!address) return json({ ok:true });
    const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
    // 5 links per address keep one inbox from being flooded; 60 per client address lets an office behind one NAT sign in.
    if (!(await r.rate([`email:${await sha256hex(address)}`,[`ip:${await sha256hex(ip)}`,60]]))) return json({ ok:true });
    const user = await r.byEmail(address);
    return user && user.status!=='disabled' ? sendLogin(req,env,user) : json({ ok:true });
  }
  if (path==='/api/auth/verify' && method==='POST') {
    const b = await smallBody(req);
    if (typeof b?.token!=='string' || !/^[a-f0-9]{64}$/.test(b.token)) return error('Invalid or expired sign-in link',401);
    const token = genToken(); const user = await r.verify(await sha256hex(b.token),await sha256hex(token));
    if (!user) return error('Invalid or expired sign-in link',401);
    await r.audit(user.id,'sign_in');
    return json({ user:publicUser(user) },200,{ 'Set-Cookie':sessionCookie(req,token) });
  }
  if (path==='/api/auth/logout' && method==='POST') {
    await r.logout(await sha256hex(sessionToken(req)));
    return json({ ok:true },200,{ 'Set-Cookie':sessionCookie(req,'',true) });
  }
  const user = actor.user;
  if (!user) return error('Sign in required',401);
  const admin = user.role==='owner';
  if (path.startsWith('/api/admin/') || path.startsWith('/api/people') || path==='/api/invitations') {
    if (!admin) return error('Instance owner required',403);
  }
  if ((path==='/api/library' || path==='/api/admin/artifacts') && method==='GET') {
    const admin = path==='/api/admin/artifacts';
    const view = url.searchParams.get('view') ?? 'all', status = url.searchParams.get('status') ?? 'all';
    if (!['all','mine','shared','starred','archived'].includes(view) || !['all','active','archived'].includes(status)) return error('Invalid filter');
    const cursor = url.searchParams.get('cursor') ?? '';
    const sort = url.searchParams.get('sort') ?? 'recent';
    // Expiry ordering and the upcoming-deadline filter are the admin
    // workspace's; a member's library keeps its recent and name contracts.
    if (sort !== 'recent' && sort !== 'name' && !(admin && sort === 'expiry')) return error('Invalid sort');
    const expiry = url.searchParams.get('expiry') ?? 'all';
    if (expiry !== 'all' && expiry !== 'soon') return error('Invalid expiry');
    if (!admin && expiry !== 'all') return error('Invalid expiry');
    if (cursor) {
      try {
        const v: unknown = JSON.parse(cursor);
        if (!Array.isArray(v) || (sort === 'name'
          ? v.length !== 3 || v[0] !== 'name' || typeof v[1] !== 'string' || v[1].length > 300
          : sort === 'expiry'
            ? v.length !== 3 || v[0] !== 'expiry' || !(v[1] === null || (Number.isSafeInteger(v[1]) && (v[1] as number) >= 0))
            : v.length !== 2 || !Number.isSafeInteger(v[0]) || v[0] < 0)
          || typeof v.at(-1) !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v.at(-1))) return error('Invalid cursor');
      } catch { return error('Invalid cursor'); }
    }
    const result = await r.library(user,{ admin,view,status,cursor,sort,expiry, q:(url.searchParams.get('q') ?? '').slice(0,300),ownerId:(url.searchParams.get('ownerId') ?? '').slice(0,64),limit:limitOf(url) });
    return json({ ...result,artifacts:result.artifacts.map(e => ({ ...e,createdAt:isoOrNull(e.createdAt),updatedAt:isoOrNull(e.updatedAt),expiresAt:isoOrNull(e.expiresAt),viewerUrl:`${url.origin}/v/${e.slug ?? e.id}` })) });
  }
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
      if (method==='GET') return json({ ownerId:entry.ownerId,grants:await r.sharing(id),users:(await r.people()).filter(u => u.status==='active' && u.role!=='owner' && u.id!==entry.ownerId).map(u => ({ id:u.id,email:u.email,name:u.name })) });
      if (method==='PUT') {
        const b = await smallBody(req);
        if (typeof b?.userId!=='string' || !['read','write',null].includes(b.permission as string | null)) return error('Valid user and permission required');
        const target = await r.account(b.userId);
        if (!target || target.status!=='active' || target.role==='owner' || target.id===entry.ownerId) return error('Target must be an active non-owner account');
        await r.grant(id,target.id,b.permission as string | null); await r.audit(user.id,'sharing_change',id,entry.title); return json({ ok:true });
      }
    }
    if (artifact[2]==='manage' && method==='PATCH') {
      const b = await smallBody(req); if (!b || !Object.keys(b).length || Object.keys(b).some(k => !['archived','ownerId','title','expiresAt'].includes(k))) return error('Invalid management request');
      if (b.archived!==undefined && typeof b.archived!=='boolean') return error('archived must be boolean');
      if (b.title!==undefined && (typeof b.title!=='string' || !b.title.trim() || b.title.length>300)) return error('Title must have 1–300 characters');
      if (b.ownerId!==undefined) {
        if (!admin) return error('Only instance owner may transfer artifacts',403);
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
