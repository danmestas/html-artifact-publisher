// Real Wrangler integration tests. All emails stay in explicitly enabled loopback transport.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const port = 21000 + Math.floor(Math.random() * 1500);
const base = `http://127.0.0.1:${port}`;
const work = mkdtempSync(join(tmpdir(),'artifact-accounts-'));
const legacy = 'accounts-legacy-owner';
let server;
let startupLog='';
let ownerAccount, memberA, memberB;
async function api(path, { method='GET', cookie, bearer, token, body, origin=base } = {}) {
  const headers = origin === null ? {} : { Origin:origin };
  // Synchronous browser commands block Node from retiring idle pooled sockets.
  if (process.env.ACCOUNTS_BROWSER_QA === '1') headers.Connection='close';
  if (cookie) headers.Cookie=cookie;
  if (bearer) headers.Authorization=`Bearer ${bearer}`;
  if (token) headers.Authorization=`Token ${token}`;
  const res = await fetch(base+path,{method,headers,body:body===undefined ? undefined : JSON.stringify(body)});
  const text = await res.text(); let json;
  try { json=JSON.parse(text); } catch { /* no body */ }
  return {status:res.status,json,text,headers:res.headers};
}
function linkToken(r) { assert.ok(r.json.loginUrl,r.text); return new URL(r.json.loginUrl).hash.slice(7); }
async function verify(token) {
  const res=await api('/api/auth/verify',{method:'POST',body:{token}});
  assert.equal(res.status,200,res.text);
  assert.match(res.headers.get('Set-Cookie'),/HttpOnly/);
  assert.match(res.headers.get('Set-Cookie'),/SameSite=Lax/);
  return {cookie:res.headers.get('Set-Cookie').split(';')[0],user:res.json.user};
}
async function login(email) { return verify(linkToken(await api('/api/auth/request',{method:'POST',body:{email}}))); }
async function invite(owner,email) {
  const r=await api('/api/invitations',{method:'POST',cookie:owner.cookie,body:{email,name:email.split('@')[0]}});
  assert.equal(r.status,200,r.text); return verify(linkToken(r));
}
async function create(auth,extra={}) {
  const r=await api('/api/artifacts',{method:'POST',...auth,body:{title:'Accounts test',ttlSeconds:null,files:{'index.html':Buffer.from('<h1>Private</h1>').toString('base64')},...extra}});
  assert.equal(r.status,201,r.text); return r.json;
}
before(async () => {
  server=spawn(join(root,'node_modules/.bin/wrangler'),['dev','--port',String(port),'--ip','127.0.0.1','--persist-to',join(work,'state'),'--var',`BEARER_TOKEN:${legacy}`,'--var','OWNER_EMAIL:owner@example.com','--var',`APP_ORIGIN:${base}`,'--var','TEST_MAIL_TRANSPORT:loopback','--show-interactive-dev-session=false'],{cwd:root,stdio:['ignore','pipe','pipe'],detached:true});
  server.stdout.on('data',d=>{startupLog+=d;});server.stderr.on('data',d=>{startupLog+=d;});
  for (let i=0;i<120;i++) { try { if ((await fetch(base+'/healthz')).ok) return; } catch {} await new Promise(r=>setTimeout(r,1000)); }
  throw new Error(`Wrangler failed to start: ${startupLog}`);
});
after(() => { if (server) try { process.kill(-server.pid,'SIGTERM'); } catch {} rmSync(work,{recursive:true,force:true}); });

test('invite-only login, generic unknown response, CSRF, one-time replay, logout',async()=>{
  assert.deepEqual((await api('/api/session')).json,{user:null});
  const unknown=await api('/api/auth/request',{method:'POST',body:{email:'unknown@example.com'}});
  assert.deepEqual(unknown.json,{ok:true});
  assert.equal((await api('/api/auth/request',{method:'POST',origin:'https://evil.example',body:{email:'owner@example.com'}})).status,403);
  const request=await api('/api/auth/request',{method:'POST',body:{email:'OWNER@example.com'}});
  const token=linkToken(request); const owner=await verify(token);
  assert.equal(owner.user.id,'instance-owner');
  assert.equal((await api('/api/auth/verify',{method:'POST',body:{token}})).status,401);
  const results=await Promise.all([api('/api/auth/verify',{method:'POST',body:{token:'f'.repeat(64)}}),api('/api/auth/verify',{method:'POST',body:{token:'bad'}})]);
  assert.ok(results.every(r=>r.status===401));
  assert.equal((await api('/api/session',{cookie:owner.cookie})).json.user.id,owner.user.id);
  assert.equal((await api('/api/auth/logout',{method:'POST',cookie:owner.cookie})).status,200);
  assert.deepEqual((await api('/api/session',{cookie:owner.cookie})).json,{user:null});
});

test('permission isolation, named grants, account metadata, archive, transfer and legacy links',async()=>{
  const owner=await login('owner@example.com');
  const a=await invite(owner,'member-a@example.com'); const b=await invite(owner,'member-b@example.com');
  const c=await invite(owner,'member-c@example.com');
  ownerAccount=owner; memberA=a; memberB=b;
  assert.equal((await api('/api/invitations',{method:'POST',cookie:a.cookie,body:{email:'intruder@example.com'}})).status,403);
  assert.equal((await api('/api/invitations',{method:'POST',cookie:owner.cookie,body:{email:'member-a@example.com'}})).status,409);
  assert.equal((await api('/api/people',{cookie:a.cookie})).status,403);
  assert.equal((await api('/api/admin/artifacts',{cookie:a.cookie})).status,403);
  const key=await api('/api/credentials',{method:'POST',cookie:a.cookie,body:{name:'Legacy link fixture'}});
  const artifact=await create({bearer:key.json.token});
  assert.equal(artifact.expiresAt,null);
  const id=artifact.id; const path=`/api/artifacts/${id}`;
  assert.equal((await api(path,{cookie:b.cookie})).status,404);
  assert.equal((await api(path+'/bundle',{cookie:b.cookie})).status,404);
  assert.equal((await api(path+'/data/x',{method:'PUT',cookie:b.cookie,body:1})).status,404);
  const candidates=await api(path+'/sharing',{cookie:a.cookie});
  assert.ok(!candidates.json.users.some(u=>u.id==='instance-owner'),'administrative access is not a grant candidate');
  assert.equal((await api(path+'/sharing',{method:'PUT',cookie:a.cookie,body:{userId:'instance-owner',permission:'read'}})).status,400);
  const grant=permission=>api(path+'/sharing',{method:'PUT',cookie:a.cookie,body:{userId:b.user.id,permission}});
  assert.equal((await grant('read')).status,200);
  let info=await api(path,{cookie:b.cookie}); assert.equal(info.status,200,info.text); assert.equal(info.json.role,'read'); assert.equal(info.json.readToken,undefined);
  assert.equal((await api(path,{cookie:a.cookie})).json.readToken,undefined);
  assert.equal((await api(path,{cookie:owner.cookie})).json.readToken,undefined);
  const update={parent:artifact.tip,files:{'index.html':Buffer.from('<h1>Updated</h1>').toString('base64')}};
  assert.equal((await api(path,{method:'PUT',cookie:b.cookie,body:update})).status,403);
  assert.equal((await api(path+'/manage',{method:'PATCH',cookie:b.cookie,body:{title:'No'}})).status,403);
  assert.equal((await api(path+'/sharing',{cookie:b.cookie})).status,403);
  assert.equal((await grant('write')).status,200);
  info=await api(path,{cookie:b.cookie}); assert.equal(info.json.role,'write'); assert.equal(info.json.readToken,undefined); assert.equal(info.json.canManage,false);
  assert.equal((await api(path,{cookie:a.cookie})).json.canManage,true);
  assert.equal((await api(path,{cookie:owner.cookie})).json.canManage,true);
  assert.equal((await api(path,{method:'PUT',cookie:b.cookie,body:{...update,title:'Forbidden rename'}})).status,403);
  assert.equal((await api(path,{method:'DELETE',cookie:b.cookie})).status,403);
  assert.equal((await api(path,{method:'PUT',cookie:b.cookie,body:update})).status,200);
  assert.equal((await api(path+'/data/x',{method:'PUT',cookie:b.cookie,body:{n:1}})).status,200);
  const shared=await api('/api/library?view=shared',{cookie:b.cookie}); assert.ok(shared.json.artifacts.some(e=>e.id===id && e.permission==='write' && !e.canManage));
  assert.equal((await api(path+'/star',{method:'PUT',cookie:b.cookie,body:{starred:true}})).status,200);
  assert.ok((await api('/api/library?view=starred',{cookie:b.cookie})).json.artifacts.some(e=>e.id===id));
  assert.ok(!(await api('/api/library?view=starred',{cookie:a.cookie})).json.artifacts.some(e=>e.id===id));
  assert.equal((await api(path+'/manage',{method:'PATCH',cookie:a.cookie,body:{ownerId:c.user.id}})).status,403);
  assert.equal((await api(path+'/manage',{method:'PATCH',cookie:a.cookie,body:{archived:true}})).status,200);
  assert.ok(!(await api('/api/library',{cookie:a.cookie})).json.artifacts.some(e=>e.id===id));
  assert.ok((await api('/api/library?view=archived',{cookie:a.cookie})).json.artifacts.some(e=>e.id===id && e.canManage));
  assert.ok((await api('/api/library?view=archived',{cookie:b.cookie})).json.artifacts.some(e=>e.id===id && !e.canManage));
  assert.ok(!(await api('/api/library?view=archived',{cookie:c.cookie})).json.artifacts.some(e=>e.id===id));
  assert.equal((await api(path+'/manage',{method:'PATCH',cookie:b.cookie,body:{archived:false}})).status,403);
  assert.equal((await api(path+'/manage',{method:'PATCH',cookie:a.cookie,body:{archived:false}})).status,200,'member creator can restore their own artifact');
  assert.ok((await api('/api/library?view=mine',{cookie:a.cookie})).json.artifacts.some(e=>e.id===id));
  assert.ok(!(await api('/api/library?view=archived',{cookie:a.cookie})).json.artifacts.some(e=>e.id===id));
  assert.equal((await api(path+'/manage',{method:'PATCH',cookie:a.cookie,body:{archived:true}})).status,200);
  assert.ok((await api('/api/admin/artifacts?status=archived',{cookie:owner.cookie})).json.artifacts.some(e=>e.id===id));
  assert.equal((await api(path,{cookie:b.cookie})).status,200,'archive does not revoke access');
  assert.equal((await api(path+'/manage',{method:'PATCH',cookie:owner.cookie,body:{archived:false,ownerId:c.user.id,title:'Transferred'}})).status,200);
  assert.equal((await api(path,{cookie:b.cookie})).status,404,'transfer clears named grants');
  assert.equal((await api(path,{cookie:a.cookie})).status,404,'former owner loses named access');
  assert.equal((await api(path,{cookie:c.cookie})).status,200);
  const read=artifact.viewerUrl.split('#')[1]; const write=artifact.editUrl.split('#')[1];
  assert.equal((await api(path,{token:read})).status,200,'transfer retains capability links');
  assert.equal((await api(path,{token:write})).json.readToken,read,'explicit legacy edit token retains read-link retrieval');
  assert.equal((await api(path+'/sharing',{cookie:c.cookie})).json.grants.length,0);
  assert.ok((await api('/api/admin/activity',{cookie:owner.cookie})).json.events.some(e=>e.action==='transfer'));
  const legacyArtifact=await create({bearer:legacy});
  assert.ok((await api('/api/library?view=mine',{cookie:owner.cookie})).json.artifacts.some(e=>e.id===legacyArtifact.id && e.ownerId==='instance-owner'));
  assert.equal((await api(path,{method:'DELETE',cookie:c.cookie})).status,204);
});

test('name sorting, deterministic ties, filtered totals and compatible cursors',async()=>{
  const auth={cookie:memberA.cookie};
  const titles=['Parity zebra','Parity alpha','Parity Alpha','Parity middle'];
  const created=[];
  for (const title of titles) created.push(await create(auth,{title}));
  // Isolated fixture timestamps make the default order unambiguously different.
  for (let i=0;i<created.length;i++) registrySQL('UPDATE artifacts SET updated_at=? WHERE id=?',100+i,created[i].id);
  const query='/api/library?q=Parity&limit=2';
  const recent=await api(query,auth);
  assert.deepEqual(recent.json.artifacts.map(a=>a.id),[created[3].id,created[2].id]);
  assert.equal(recent.json.total,4);
  const first=await api(query+'&sort=name',auth);
  const second=await api(query+'&sort=name&cursor='+encodeURIComponent(first.json.nextCursor),auth);
  const expected=created.map((a,i)=>({...a,title:titles[i]})).sort((a,b)=>a.title.toLowerCase()<b.title.toLowerCase()?-1:a.title.toLowerCase()>b.title.toLowerCase()?1:a.id<b.id?-1:1);
  assert.deepEqual([...first.json.artifacts,...second.json.artifacts].map(a=>a.id),expected.map(a=>a.id));
  assert.equal(second.json.total,4); assert.equal(second.json.nextCursor,null);
  assert.ok(first.json.artifacts.every(a=>a.accessLabel==='Private'));
  assert.equal((await api(query+'&cursor='+encodeURIComponent(first.json.nextCursor),auth)).status,400);
  assert.equal((await api(query+'&sort=name&cursor='+encodeURIComponent(recent.json.nextCursor),auth)).status,400);
  for (const cursor of ['null','[]','["name",1,"id"]','["name","ok","bad id"]','[-1,"id"]']) {
    assert.equal((await api(query+'&sort=name&cursor='+encodeURIComponent(cursor),auth)).status,400);
  }
  assert.equal((await api(query+'&sort=invalid',auth)).status,400);
  assert.equal((await api('/api/library?q=Parity',{cookie:memberB.cookie})).json.total,0);
  await api(`/api/artifacts/${created[0].id}/manage`,{...auth,method:'PATCH',body:{archived:true}});
  const archived=await api('/api/library?view=archived&q=Parity&sort=name',auth);
  assert.deepEqual(archived.json.artifacts.map(a=>a.id),[created[0].id]);
  const inventory=await api('/api/admin/artifacts?sort=name&q=Parity&status=active&ownerId='+memberA.user.id,{cookie:ownerAccount.cookie});
  assert.equal(inventory.json.total,3);
  assert.deepEqual(inventory.json.artifacts.map(a=>a.id),expected.filter(a=>a.id!==created[0].id).map(a=>a.id));
  assert.ok(inventory.json.artifacts.every(a=>a.accessLabel==='Can edit'));
  for (const a of created) await api('/api/artifacts/'+a.id,{...auth,method:'DELETE'});
});

test('static previews enforce access, strip active markup and bound entry payloads',async()=>{
  const creator={cookie:memberA.cookie}, owner={cookie:ownerAccount.cookie}, reader={cookie:memberB.cookie};
  const hostile='<html><head><base href="https://outside.invalid/"><meta http-equiv="refresh" content="0;url=https://outside.invalid/"><script>parent.pwned=true</script><style>h1{color:red;background:url(https://outside.invalid/css)}</style></head><body onload="alert(1)"><h1>Distinct static content</h1><a href="https://outside.invalid/" target="_top" ping="https://outside.invalid/ping">Link</a><iframe src="https://outside.invalid/frame"></iframe><object data="https://outside.invalid/obj"></object><form action="https://outside.invalid/form"><input autofocus></form><img src="https://outside.invalid/image" onerror="alert(1)"><svg onload="alert(1)"><a href="javascript:alert(1)">SVG</a></svg></body></html>';
  const a=await create(creator,{files:{'index.html':Buffer.from(hostile).toString('base64'),'other.html':Buffer.from('<h1>Wrong entry</h1>').toString('base64')}});
  const path='/p/'+a.id;
  const hostCSP=(await api('/')).headers.get('content-security-policy');
  assert.match(hostCSP,/script-src 'self'; style-src 'self'/);
  assert.doesNotMatch(hostCSP,/unsafe-inline/,'preview support does not relax the host shell');
  assert.equal((await api(path)).status,404);
  assert.equal((await api(path,reader)).status,404);
  for(const auth of [creator,owner]) {
    const r=await api(path,auth); assert.equal(r.status,200,r.text);
    assert.match(r.text,/Distinct static content/); assert.doesNotMatch(r.text,/Wrong entry/);
    assert.doesNotMatch(r.text,/<(?:script|base|meta|iframe|object|form|svg)\b|\bonload=|\bonerror=|\bhref=|\btarget=|\bping=/i);
    assert.match(r.headers.get('content-security-policy'),/^sandbox;/);
    assert.match(r.headers.get('content-security-policy'),/default-src 'none'/);
    assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'self'/);
    assert.equal(r.headers.get('cache-control'),'private, no-store');
  }
  for (const permission of ['read','write']) {
    await api(`/api/artifacts/${a.id}/sharing`,{...creator,method:'PUT',body:{userId:memberB.user.id,permission}});
    assert.equal((await api(path,reader)).status,200);
    const shared=await api('/api/library?view=shared',reader);
    assert.equal(shared.json.artifacts.find(e=>e.id===a.id).accessLabel,permission==='read'?'Can view':'Can edit');
    assert.equal((await api('/api/library',creator)).json.artifacts.find(e=>e.id===a.id).accessLabel,'Shared by you');
  }
  await api(`/api/artifacts/${a.id}/sharing`,{...creator,method:'PUT',body:{userId:memberB.user.id,permission:null}});
  assert.equal((await api(path,reader)).status,404,'revocation affects new preview requests');
  for (const [files,expected] of [
    [{'report.htm':Buffer.from('<h1>Alternate entry</h1>').toString('base64')},'Alternate entry'],
    [{'notes.txt':Buffer.from('Not HTML').toString('base64')},'Static preview unavailable'],
    [{'index.html':Buffer.from('<!doctype html><html><head><title>Script app</title><style>body{color:red}</style></head><body><div id="app"></div><script>document.body.textContent="Dynamic"</script></body></html>').toString('base64')},'Static preview unavailable'],
    [{'index.html':Buffer.from('x'.repeat(256*1024+1)).toString('base64')},'Static preview unavailable'],
  ]) {
    const fixture=await create(creator,{files});
    assert.ok((await api('/p/'+fixture.id,creator)).text.includes(expected));
    await api('/api/artifacts/'+fixture.id,{...creator,method:'DELETE'});
  }
  await api('/api/artifacts/'+a.id,{...creator,method:'DELETE'});
});

// Expiry fixtures edit only the suite's throwaway Registry database. This
// avoids a test-only authentication endpoint or waiting 15 minutes in CI.
function registrySQL(sql, ...args) {
  const state=join(work,'state');
  for (const file of readdirSync(state,{recursive:true})) {
    if (!String(file).endsWith('.sqlite')) continue;
    const db=new DatabaseSync(join(state,String(file)));
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='accounts'").get()) return db.prepare(sql).all(...args);
    } finally { db.close(); }
  }
  throw new Error('Test Registry database not found');
}
const hash = value => createHash('sha256').update(value).digest('hex');

if (process.env.ACCOUNTS_BROWSER_QA === '1') test('real browser: navigation matrix, phone controls and management workflows',async()=>{
  // This browser case has its own lifecycle/fixtures and runs before the later
  // expiry/rate checks. Reset only the ephemeral test rate-limit table.
  registrySQL('DELETE FROM rate_limits RETURNING key');
  const request=await api('/api/auth/request',{method:'POST',body:{email:'owner@example.com'}});
  const browserOwner=await login('owner@example.com');
  const { browserQA }=await import('./library-browser.mjs');
  const result=await browserQA({base,loginUrl:request.json.loginUrl,output:join(root,'.wrangler/accounts-browser-qa'),api,owner:ownerAccount,browserOwner,member:memberB});
  assert.equal(result.permutations,48);
});

test('personal credentials, revoke and suspend, stable pagination, sole owner protection',async()=>{
  const owner=ownerAccount, member=memberA, other=memberB;
  const credential=await api('/api/credentials',{method:'POST',cookie:member.cookie,body:{name:'CLI test'}});
  assert.equal(credential.status,201,credential.text); const {id,token}=credential.json;
  assert.ok(token); assert.ok(!(await api('/api/credentials',{cookie:member.cookie})).json.credentials.some(c=>'token' in c));
  assert.equal((await api('/api/credentials',{cookie:other.cookie})).json.credentials.length,0);
  await api(`/api/credentials/${id}`,{method:'DELETE',cookie:other.cookie});
  const created=[]; for (let i=0;i<5;i++) created.push(await create({bearer:token},{title:`Pagination ${i}`}));
  assert.ok((await api('/api/library?view=mine',{cookie:member.cookie})).json.artifacts.some(e=>e.id===created[0].id && e.ownerId===member.user.id));
  const ids=[]; let cursor=''; do {
    const r=await api('/api/library?limit=2&q=Pagination'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{cookie:member.cookie});
    assert.equal(r.status,200,r.text); assert.ok(r.json.artifacts.length<=2); ids.push(...r.json.artifacts.map(e=>e.id)); cursor=r.json.nextCursor;
  } while(cursor);
  assert.equal(ids.length,5); assert.equal(new Set(ids).size,5);
  assert.equal((await api('/api/library?cursor=invalid',{cookie:member.cookie})).status,400);
  const path=`/api/artifacts/${created[0].id}`;
  assert.equal((await api(path,{cookie:other.cookie})).status,404);
  assert.equal((await api(path,{method:'DELETE',cookie:member.cookie,origin:'https://evil.example'})).status,403);
  await api(`/api/credentials/${id}`,{method:'DELETE',cookie:member.cookie});
  assert.equal((await api('/api/artifacts',{method:'POST',bearer:token,body:{files:{'index.html':'eA=='}}})).status,401);
  const second=await api('/api/credentials',{method:'POST',cookie:member.cookie,body:{name:'Before suspend'}});
  assert.equal((await api(`/api/people/${member.user.id}`,{method:'PATCH',cookie:owner.cookie,body:{status:'disabled'}})).status,200);
  assert.deepEqual((await api('/api/session',{cookie:member.cookie})).json,{user:null});
  assert.equal((await api('/p/'+created[0].id,{cookie:member.cookie})).status,404,'suspension denies new previews');
  assert.equal((await api('/p/'+created[0].id,{bearer:second.json.token})).status,404);
  assert.equal((await api('/api/artifacts',{method:'POST',bearer:second.json.token,body:{files:{'index.html':'eA=='}}})).status,401);
  assert.deepEqual((await api('/api/auth/request',{method:'POST',body:{email:member.user.email}})).json,{ok:true});
  assert.equal((await api('/api/people/instance-owner',{method:'PATCH',cookie:owner.cookie,body:{status:'disabled'}})).status,403);
});

test('expired magic links and sessions fail, concurrent confirmation consumes once, secrets stored hashed',async()=>{
  const inviteResponse=await api('/api/invitations',{method:'POST',cookie:ownerAccount.cookie,body:{email:'expiry@example.com'}});
  const expired=linkToken(inviteResponse);
  const stored=registrySQL('SELECT hash,expires FROM logins WHERE hash=?',hash(expired));
  assert.equal(stored.length,1); assert.notEqual(stored[0].hash,expired);
  registrySQL('UPDATE logins SET expires=0 WHERE hash=? RETURNING hash',hash(expired));
  assert.equal((await api('/api/auth/verify',{method:'POST',body:{token:expired}})).status,401);
  const fresh=linkToken(await api('/api/auth/request',{method:'POST',body:{email:'expiry@example.com'}}));
  const attempts=await Promise.all([api('/api/auth/verify',{method:'POST',body:{token:fresh}}),api('/api/auth/verify',{method:'POST',body:{token:fresh}})]);
  assert.deepEqual(attempts.map(r=>r.status).sort(),[200,401]);
  const cookie=attempts.find(r=>r.status===200).headers.get('Set-Cookie').split(';')[0];
  const session=cookie.split('=')[1];
  assert.equal(registrySQL('SELECT hash FROM sessions WHERE hash=?',hash(session)).length,1);
  const key=await api('/api/credentials',{method:'POST',cookie,body:{name:'Hash-only'}});
  assert.equal(registrySQL('SELECT hash FROM credentials WHERE id=?',key.json.id)[0].hash,hash(key.json.token));
  registrySQL('UPDATE sessions SET expires=0 WHERE hash=? RETURNING hash',hash(session));
  assert.deepEqual((await api('/api/session',{cookie})).json,{user:null});
  assert.equal((await api('/api/library',{cookie})).status,401);
});

test('suspension consumes pending invitations and reactivation does not restore revoked secrets',async()=>{
  const invited=await api('/api/invitations',{method:'POST',cookie:ownerAccount.cookie,body:{email:'suspended@example.com'}});
  const token=linkToken(invited);
  const target=(await api('/api/people',{cookie:ownerAccount.cookie})).json.users.find(u=>u.email==='suspended@example.com');
  const change=status=>api(`/api/people/${target.id}`,{method:'PATCH',cookie:ownerAccount.cookie,body:{status}});
  assert.equal((await change('disabled')).status,200);
  assert.equal((await api('/api/auth/verify',{method:'POST',body:{token}})).status,401);
  assert.deepEqual((await api('/api/auth/request',{method:'POST',body:{email:target.email}})).json,{ok:true});
  assert.equal((await change('active')).status,200);
  assert.equal((await api('/api/auth/verify',{method:'POST',body:{token}})).status,401);
  assert.equal((await api('/api/invitations',{method:'POST',cookie:ownerAccount.cookie,body:{email:target.email}})).status,409);
});

test('all browser mutation routes reject missing and cross-site origins, credential clients remain explicit',async()=>{
  const owned=await create({cookie:ownerAccount.cookie});
  assert.equal(new URL(owned.viewerUrl).hash,''); assert.equal(owned.editUrl,undefined); assert.equal(owned.cloneUrl,undefined);
  const path=`/api/artifacts/${owned.id}`;
  const cases=[['/api/auth/request','POST',{email:'owner@example.com'}],['/api/auth/verify','POST',{token:'0'.repeat(64)}],['/api/auth/logout','POST'],['/api/invitations','POST',{email:'csrf@example.com'}],['/api/credentials','POST',{name:'csrf'}],['/api/credentials/unknown','DELETE'],['/api/people/unknown','PATCH',{status:'disabled'}],[path+'/star','PUT',{starred:true}],[path+'/sharing','PUT',{userId:'instance-owner',permission:'write'}],[path+'/manage','PATCH',{archived:true}],[path,'DELETE'],[path,'PUT',{parent:owned.tip,files:{'index.html':'eA=='}}]];
  for (const [route,method,body] of cases) for (const origin of [null,'https://evil.example']) {
    assert.equal((await api(route,{method,body,origin,cookie:ownerAccount.cookie})).status,403,`${method} ${route}`);
  }
  assert.equal((await api(path,{method:'DELETE',bearer:legacy,origin:'https://evil.example'})).status,403);
  assert.equal((await api(path,{bearer:legacy,origin:null})).status,200);
  assert.equal((await api('/api/admin/artifacts',{cookie:memberB.cookie})).status,403);
  assert.equal((await api(path,{cookie:memberB.cookie,bearer:'invalid'})).status,404,'explicit bad credential must not fall back to cookie');
});

test('configured owner email rotation revokes prior owner secrets without changing ownership',async()=>{
  registrySQL('DELETE FROM rate_limits RETURNING key');
  const pending=linkToken(await api('/api/auth/request',{method:'POST',body:{email:'owner@example.com'}}));
  const credential=await api('/api/credentials',{method:'POST',cookie:ownerAccount.cookie,body:{name:'Before owner rotation'}});
  assert.equal(credential.status,201);
  // Persisted owner predates the currently configured OWNER_EMAIL, as on redeploy.
  registrySQL("UPDATE accounts SET email='previous-owner@example.com' WHERE id='instance-owner' RETURNING id");
  assert.deepEqual((await api('/api/session',{cookie:ownerAccount.cookie})).json,{user:null});
  assert.equal((await api('/api/auth/verify',{method:'POST',body:{token:pending}})).status,401);
  assert.equal((await api('/api/credentials',{bearer:credential.json.token})).status,401);
  assert.deepEqual((await api('/api/auth/request',{method:'POST',body:{email:'previous-owner@example.com'}})).json,{ok:true});
  ownerAccount=await login('owner@example.com');
  assert.equal(ownerAccount.user.id,'instance-owner');
  assert.equal(ownerAccount.user.email,'owner@example.com');
  assert.equal((await api('/api/credentials',{cookie:ownerAccount.cookie})).json.credentials.length,0);
});

test('legacy owner migration, account-filtered old listing, pagination and revocation isolate grants',async()=>{
  const artifact=await create({bearer:legacy},{title:'Legacy null owner'});
  registrySQL('UPDATE artifacts SET owner_id=NULL WHERE id=? RETURNING id',artifact.id);
  assert.ok((await api('/api/library?view=mine',{cookie:ownerAccount.cookie})).json.artifacts.some(a=>a.id===artifact.id && a.canManage));
  assert.ok(!(await api('/api/artifacts',{cookie:memberB.cookie})).json.artifacts.some(a=>a.id===artifact.id));
  assert.ok(!(await api('/api/artifacts',{cookie:memberB.cookie})).json.artifacts.some(a=>a.title.startsWith('Pagination')));
  const path=`/api/artifacts/${artifact.id}`;
  assert.equal((await api(path+'/sharing',{method:'PUT',cookie:ownerAccount.cookie,body:{userId:memberB.user.id,permission:'read'}})).status,200);
  assert.equal((await api(path,{cookie:memberB.cookie})).status,200);
  assert.equal((await api(path+'/sharing',{method:'PUT',cookie:ownerAccount.cookie,body:{userId:memberB.user.id,permission:null}})).status,200);
  assert.equal((await api(path,{cookie:memberB.cookie})).status,404);
  const ids=[]; let cursor='';
  do {
    const r=await api('/api/admin/artifacts?limit=2'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{cookie:ownerAccount.cookie});
    assert.equal(r.status,200); assert.ok(r.json.artifacts.length<=2); ids.push(...r.json.artifacts.map(a=>a.id)); cursor=r.json.nextCursor;
  } while(cursor);
  assert.equal(new Set(ids).size,ids.length); assert.ok(ids.length>=7);
  for (const filter of ['view=unknown','cursor='+encodeURIComponent('[0,{}]')]) assert.equal((await api('/api/library?'+filter,{cookie:ownerAccount.cookie})).status,400);
});
