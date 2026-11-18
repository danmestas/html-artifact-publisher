import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, freePort, haveStockFossil, stockFossil } from './helpers/worker.mjs';

const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options = {}) => nativeFetch(input, { ...options, signal: options.signal ?? AbortSignal.timeout(5000) });
const work = mkdtempSync(join(tmpdir(), 'body-search-'));
after(() => rmSync(work, { recursive: true, force: true }));
async function withWorker(body, vars = {}) {
  const port = await freePort();
  const stateRoot = mkdtempSync(join(work,'state-'));
  let app = await startWorker(stateRoot, { OWNER_EMAIL: 'owner@example.com', APP_ORIGIN: `http://127.0.0.1:${port}`, TEST_MAIL_TRANSPORT: 'loopback', ...vars }, { port });
  const restart = async () => {
    const old = app; old.stop();
    const deadline = Date.now()+5000;
    while (true) {
      try { await fetch(old.base+'/healthz',{signal:AbortSignal.timeout(200)}); }
      catch { break; }
      assert.ok(Date.now()<deadline,'old Worker must stop before reopening persisted state');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const nextPort = await freePort();
    app = await startWorker(stateRoot,{OWNER_EMAIL:'owner@example.com',APP_ORIGIN:`http://127.0.0.1:${nextPort}`,TEST_MAIL_TRANSPORT:'loopback',...vars},{port:nextPort});
  };
  const call = async (path, body, cookie = '', method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(app.base + path, { method, headers: { Origin: app.base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { /* empty response */ }
    assert.ok(res.status < 500, `${res.status}: ${text}`);
    return { status: res.status, data, headers: res.headers };
  };
  const signIn = async email => {
    const requested = await call('/api/auth/request', { email });
    const verified = await call('/api/auth/verify', { token: new URL(requested.data.loginUrl).hash.slice(7) });
    assert.equal(verified.status, 200);
    return verified.headers.get('Set-Cookie').split(';')[0];
  };
  const create = async (cookie, title, html, extra = {}) => {
    const r = await call('/api/artifacts', { title, ttlSeconds: null, files: { 'index.html': Buffer.from(html).toString('base64') }, ...extra }, cookie);
    assert.equal(r.status, 201); return r.data;
  };
  const search = async (query = '', authorization = '', cookie = '') => {
    const response = await fetch(app.base+'/api/search'+(query ? '?'+query : ''),{headers:{...(authorization ? {Authorization:authorization} : {}),...(cookie ? {Cookie:cookie} : {})}});
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { /* useful status for missing routes */ }
    return {status:response.status,data};
  };
  try { await body({ call, signIn, create, search, app, restart }); } finally { app.stop(); }
}

test('authenticated library finds a subject mentioned only in the persisted HTML body', async () => {
  await withWorker(async ({ call, signIn, create }) => {
    const cookie = await signIn('owner@example.com');
    const artifact = await create(cookie, 'Quarterly notes', '<h1>Research</h1><p>Capybara conservation report.</p>');
    const result = await call('/api/library?q=capybara', undefined, cookie);
    assert.equal(result.status, 200);
    assert.equal(result.data.total, 1);
    assert.equal(result.data.artifacts[0].id, artifact.id);
    assert.equal(result.data.artifacts[0].searchIndex.status, 'complete');
    assert.deepEqual(result.data.artifacts[0].search.matchedTerms, ['capybara']);
    assert.match(result.data.artifacts[0].search.snippet.text, /Capybara/);
  });
});

test('content commits remove old body hits and expose the current revision, while rename searches current titles', async () => {
  await withWorker(async ({ call, signIn, create }) => {
    const cookie = await signIn('owner@example.com');
    const a = await create(cookie, 'Original title', '<p>oldbodyword</p>');
    const updated = await call(`/api/artifacts/${a.id}`, { parent:a.tip, files:{ 'index.html':Buffer.from('<p>newbodyword</p>').toString('base64') } }, cookie, 'PUT');
    assert.equal(updated.status, 200);
    assert.equal((await call('/api/library?q=oldbodyword', undefined, cookie)).data.total, 0);
    const found = await call('/api/library?q=newbodyword', undefined, cookie);
    assert.equal(found.data.total, 1);
    assert.equal(found.data.artifacts[0].searchIndex.version, 2);
    assert.equal(found.data.artifacts[0].searchIndex.status, 'complete');
    assert.equal((await call(`/api/artifacts/${a.id}/manage`, { title:'Renamed subject' }, cookie, 'PATCH')).status, 200);
    assert.equal((await call('/api/library?q=renamed', undefined, cookie)).data.total, 1);
    assert.equal((await call('/api/library?q=original', undefined, cookie)).data.total, 0);
  });
});

test('literal multi-term searches rank complete hits above partial hits and paginate without changing the query', async () => {
  await withWorker(async ({ call, signIn, create }) => {
    const cookie = await signIn('owner@example.com');
    const partial = await create(cookie, 'Short notes', '<p>five small observations</p>');
    const complete = await create(cookie, 'Complete notes', '<p>five big observations</p>');
    const titled = await create(cookie, 'Five big title', '<p>different content</p>');
    const result = await call('/api/library?q=five%20big&limit=1', undefined, cookie);
    assert.equal(result.data.total, 3);
    assert.equal(result.data.artifacts[0].id, titled.id);
    assert.deepEqual(result.data.artifacts[0].search, { matchedTerms:['five','big'],totalTerms:2,partial:false,snippet:null });
    const page2 = await call(`/api/library?q=five%20big&limit=1&cursor=${encodeURIComponent(result.data.nextCursor)}`, undefined, cookie);
    assert.equal(page2.status, 200);
    assert.equal(page2.data.artifacts[0].id, complete.id);
    const page3 = await call(`/api/library?q=five%20big&limit=1&cursor=${encodeURIComponent(page2.data.nextCursor)}`, undefined, cookie);
    assert.equal(page3.data.artifacts[0].id, partial.id);
    assert.equal(page3.data.artifacts[0].search.partial, true);
    assert.deepEqual(page3.data.artifacts[0].search.matchedTerms,['five']);
    assert.equal(page3.data.nextCursor,null);
    assert.equal((await call(`/api/library?q=other&limit=1&cursor=${encodeURIComponent(result.data.nextCursor)}`, undefined, cookie)).status,400);
    const phrase = await call('/api/library?q=%22five%20big%22', undefined, cookie);
    assert.equal(phrase.data.total,2);
    assert.equal((await call('/api/library?q=NOT%20OR%20%22%20*', undefined, cookie)).status,200);
    assert.equal((await call('/api/library?q=fiv', undefined, cookie)).data.total,3);
  });
});

test('matching every query term beats any title-weighted partial match at the query bound', async () => {
  await withWorker(async ({ call, signIn, create }) => {
    const cookie = await signIn('owner@example.com');
    const terms = Array.from({length:12},(_,i)=>`word${i}x`);
    const complete = await create(cookie,'Complete coverage',`<p>${terms.join(' ')}</p>`);
    await create(cookie,terms.slice(0,11).join(' '),'<p>partial document</p>');
    const found = await call(`/api/library?q=${encodeURIComponent(terms.join(' '))}`,undefined,cookie);
    assert.equal(found.data.artifacts[0].id,complete.id);
    assert.equal((await call(`/api/library?q=${encodeURIComponent([...terms,'extra'].join(' '))}`,undefined,cookie)).status,400,'too many terms must not silently drop terms');
  });
});

test('search hits, counts and excerpts obey current grants, archived views and instance-owner authentication', async () => {
  await withWorker(async ({ call, signIn, create, app }) => {
    const cookie = await signIn('owner@example.com');
    const invite = await call('/api/invitations', { email:'member@example.com' }, cookie);
    const verified = await call('/api/auth/verify', { token:new URL(invite.data.loginUrl).hash.slice(7) });
    const memberCookie = verified.headers.get('Set-Cookie').split(';')[0];
    const memberId = verified.data.user.id;
    const privateArtifact = await create(cookie, 'Private record', '<p>aclword confidential excerpt</p>');
    const shared = await create(cookie, 'Shared record', '<p>aclword shared excerpt</p>');
    assert.equal((await call(`/api/artifacts/${shared.id}/sharing`, { userId:memberId,permission:'read' }, cookie,'PUT')).status,200);
    const result = await call('/api/library?q=aclword&limit=1', undefined, memberCookie);
    assert.equal(result.data.total,1);
    assert.equal(result.data.artifacts[0].id,shared.id);
    assert.ok(!JSON.stringify(result.data).includes('confidential'));
    assert.equal((await call('/api/admin/artifacts?q=aclword', undefined, memberCookie)).status,403);
    assert.equal((await call('/api/library?q=aclword')).status,401);
    const legacy = await fetch(app.base + '/api/admin/artifacts?q=aclword', { headers:{ Authorization:`Bearer ${app.owner}` } });
    assert.equal(legacy.status,401);
    assert.equal((await call(`/api/artifacts/${privateArtifact.id}/manage`, { archived:true }, cookie,'PATCH')).status,200);
    const inventory = (await call('/api/admin/artifacts?q=aclword&status=active', undefined,cookie)).data;
    assert.deepEqual(inventory.counts,{all:2,active:1,archived:1});
    assert.equal(inventory.total,1);
    assert.equal((await call('/api/library?q=aclword&view=archived', undefined,cookie)).data.total,1);
    assert.equal((await call(`/api/artifacts/${shared.id}/sharing`, { userId:memberId,permission:null }, cookie,'PUT')).status,200);
    assert.equal((await call('/api/library?q=aclword', undefined,memberCookie)).data.total,0);
  });
});

test('a failed index projection does not retry a successful commit and the durable alarm replaces stale body text', async () => {
  await withWorker(async ({ call, signIn, create }) => {
    const cookie = await signIn('owner@example.com');
    const a = await create(cookie,'Retry subject','<p>beforeword</p>');
    const updated = await call(`/api/artifacts/${a.id}`, { parent:a.tip,files:{'index.html':Buffer.from('<p>afterword</p>').toString('base64')} },cookie,'PUT');
    assert.equal(updated.status,200);
    assert.equal((await call('/api/library?q=beforeword',undefined,cookie)).data.total,0);
    const pending = (await call('/api/library?q=retry',undefined,cookie)).data.artifacts[0];
    assert.equal(pending.searchIndex.status,'error');
    assert.equal(pending.search.snippet,null);
    assert.equal((await call('/api/library?q=afterword',undefined,cookie)).data.total,0);
    const deadline = Date.now()+8000;
    let found;
    do {
      found = await call('/api/library?q=afterword',undefined,cookie);
      if (found.data.total) break;
      await new Promise(resolve => setTimeout(resolve,100));
    } while (Date.now()<deadline);
    assert.equal(found.data.total,1,'durable retry must converge');
    assert.equal(found.data.artifacts[0].searchIndex.status,'complete');
    assert.equal((await call(`/api/artifacts/${a.id}`,undefined,cookie)).data.timeline.length,2,'index retry adds no check-in');
  },{ TEST_SEARCH_FAULT:'fail-version-2-once',TEST_EXPIRATION_RETRY_MS:'1000' });
});

test('pending index retries and backfill cannot resurrect deleted or expired artifacts', async () => {
  await withWorker(async ({ call, signIn, create }) => {
    const cookie = await signIn('owner@example.com');
    const removed = await create(cookie,'Removed subject','<p>removedword</p>');
    assert.equal((await call(`/api/artifacts/${removed.id}`,{parent:removed.tip,files:{'index.html':Buffer.from('<p>replacementword</p>').toString('base64')}},cookie,'PUT')).status,200);
    assert.equal((await call(`/api/artifacts/${removed.id}`,undefined,cookie,'DELETE')).status,204);
    const expiring = await create(cookie,'Expiring subject','<p>expiryword</p>',{ttlSeconds:2});
    assert.equal((await call(`/api/artifacts/${expiring.id}`,{parent:expiring.tip,files:{'index.html':Buffer.from('<p>expirychanged</p>').toString('base64')}},cookie,'PUT')).status,200);
    await call('/api/admin/search-index',{},cookie);
    await new Promise(resolve => setTimeout(resolve,Math.max(0,Date.parse(expiring.expiresAt)-Date.now()+100)));
    assert.equal((await call('/api/admin/artifacts?q=subject',undefined,cookie)).data.total,0);
    assert.equal((await call('/api/library?q=replacementword',undefined,cookie)).data.total,0);
    assert.equal((await call('/api/library?q=expirychanged',undefined,cookie)).data.total,0);
    assert.equal((await call(`/api/artifacts/${removed.id}`,undefined,cookie)).status,404);
    assert.equal((await call(`/api/artifacts/${expiring.id}`,undefined,cookie)).status,404);
    const status = (await call('/api/admin/search-index',{},cookie)).data;
    assert.equal(status.remaining,0); assert.equal(status.failed,0);
  },{TEST_SEARCH_FAULT:'fail-version-2-once',TEST_EXPIRATION_RETRY_MS:'1000'});
});

test('remote search accepts legacy instance Bearer without a browser session and preserves cookie library scope', async () => {
  await withWorker(async ({ call, signIn, create, search, app }) => {
    const cookie = await signIn('owner@example.com');
    const active = await create(cookie,'Remote active','<p>remoteword current subject</p>');
    const archived = await create(cookie,'Remote archived','<p>remoteword archived subject</p>');
    await call(`/api/artifacts/${archived.id}/manage`,{archived:true},cookie,'PATCH');
    const root = await search('q=remoteword',`Bearer ${app.owner}`);
    assert.equal(root.status,200);
    assert.equal(root.data.total,2);
    assert.deepEqual(root.data.counts,{all:2,active:1,archived:1});
    assert.equal(root.data.searchCoverage.total,2);
    for (const artifact of root.data.artifacts) {
      assert.equal(new URL(artifact.viewerUrl).hash,'');
      assert.ok(!Object.hasOwn(artifact,'editUrl'));
      assert.ok(!Object.hasOwn(artifact,'cloneUrl'));
      assert.ok(!JSON.stringify(artifact).includes(app.owner));
    }
    assert.equal((await search('q=remoteword')).status,401);
    assert.equal((await search('q=remoteword','Bearer invalid-credential')).status,401);
    const account = await search('q=remoteword','',cookie);
    assert.equal(account.status,200); assert.equal(account.data.total,1);
    assert.equal(account.data.artifacts[0].id,active.id);
    assert.deepEqual(account.data.searchCoverage,{total:1,complete:1,partial:0,pending:0,error:0,unsupported:0});
    assert.equal((await search('q=remoteword&scope=inventory','',cookie)).data.total,2);
  });
});

test('remote personal credentials use current account grants, support artifact narrowing, and fail after revocation', async () => {
  await withWorker(async ({ call, signIn, create, search }) => {
    const owner = await signIn('owner@example.com');
    const privateArtifact = await create(owner,'Private subject','<p>personalword confidential</p>');
    const invite = await call('/api/invitations',{email:'remote@example.com'},owner);
    const verified = await call('/api/auth/verify',{token:new URL(invite.data.loginUrl).hash.slice(7)});
    const cookie = verified.headers.get('Set-Cookie').split(';')[0];
    const first = await create(cookie,'First subject','<p>personalword first</p>');
    await create(cookie,'Second subject','<p>personalword second</p>');
    const credential = await call('/api/credentials',{name:'Remote search test'},cookie);
    assert.equal(credential.status,201);
    const auth = `Bearer ${credential.data.token}`;
    const found = await search('q=personalword',auth);
    assert.equal(found.status,200); assert.equal(found.data.total,2);
    assert.equal(found.data.searchCoverage.total,2);
    assert.ok(!JSON.stringify(found.data).includes('confidential'));
    const narrowed = await search(`q=personalword&artifactId=${first.id}`,auth);
    assert.equal(narrowed.status,200); assert.equal(narrowed.data.total,1);
    assert.equal(narrowed.data.searchCoverage.total,1);
    assert.equal((await search(`q=personalword&artifactId=${privateArtifact.id}`,auth)).status,404);
    assert.equal((await search('q=personalword&scope=inventory',auth)).status,403);
    assert.equal((await search('q=personalword&ownerId=instance-owner',auth)).status,403);
    await call(`/api/credentials/${credential.data.id}`,undefined,cookie,'DELETE');
    assert.equal((await search('q=personalword',auth)).status,401);
  });
});

test('artifact Token remote search is scoped to one current artifact, never a library or account profile', async () => {
  await withWorker(async ({ call, signIn, create, search, app }) => {
    const cookie = await signIn('owner@example.com');
    const other = await create(cookie,'Unrelated private artifact','<p>tokenword private other</p>');
    const response = await fetch(app.base+'/api/artifacts',{method:'POST',headers:{Authorization:`Bearer ${app.owner}`},body:JSON.stringify({title:'Scoped artifact',ttlSeconds:null,files:{'index.html':Buffer.from('<p>tokenword scoped content</p>').toString('base64')}})});
    assert.equal(response.status,201);
    const a = await response.json();
    const read = new URL(a.viewerUrl).hash.slice(1), comment = new URL(a.commentUrl).hash.slice(1), write = new URL(a.editUrl).hash.slice(1);
    const query = `q=tokenword&artifactId=${a.id}`;
    assert.equal((await search('q=tokenword',`Token ${read}`)).status,400);
    assert.equal((await search(`q=tokenword&artifactId=${other.id}`,`Token ${read}`)).status,404);
    assert.equal((await search(query,'Token invalid-credential')).status,404);
    assert.equal((await search(query,`Bearer ${read}`)).status,401);
    for (const [token,permission] of [[read,'read'],[comment,'comment'],[write,'write']]) {
      const scoped = await search(query,`Token ${token}`);
      assert.equal(scoped.status,200); assert.equal(scoped.data.total,1);
      assert.equal(scoped.data.searchCoverage.total,1);
      const hit = scoped.data.artifacts[0];
      assert.equal(hit.id,a.id); assert.equal(hit.permission,permission);
      assert.equal(hit.canManage,false);
      for (const field of ['ownerId','ownerName','editUrl','cloneUrl','readToken','commentToken','starred','visibility']) assert.ok(!Object.hasOwn(hit,field),field);
      assert.equal(new URL(hit.viewerUrl).hash,'');
      assert.ok(!JSON.stringify(scoped.data).includes(token));
      assert.ok(!JSON.stringify(scoped.data).includes(other.id));
    }
    assert.equal((await search(query+'&scope=inventory',`Token ${read}`)).status,403);
    assert.equal((await search(query+'&ownerId=instance-owner',`Token ${read}`)).status,403);
    assert.equal((await search(query+'&view=mine',`Token ${read}`)).status,403);
    await call(`/api/artifacts/${a.id}/manage`,{archived:true},cookie,'PATCH');
    assert.equal((await search(query,`Token ${read}`)).data.total,1,'valid capabilities search exactly their artifact, including an archive');
    await call(`/api/artifacts/${a.id}/comment-link`,{},cookie);
    assert.equal((await search(query,`Token ${comment}`)).status,404);
  });
});

test('search coverage counts the authorized filtered scope before the query, not just matching indexed rows', async () => {
  await withWorker(async ({ call, signIn, create }) => {
    const cookie = await signIn('owner@example.com');
    await create(cookie,'Complete document','<p>known content</p>');
    const failed = await create(cookie,'Error document','<p>old source</p>');
    await call(`/api/artifacts/${failed.id}`,{parent:failed.tip,files:{'index.html':Buffer.from('<p>new source</p>').toString('base64')}},cookie,'PUT');
    const unsupported = await create(cookie,'Unsupported document','ignored',{files:{'readme.txt':Buffer.from('unsupported').toString('base64')}});
    await create(cookie,'Partial document',`<p>${'a'.repeat(550000)}</p>`);
    const absent = (await call('/api/library?q=nomatchingword',undefined,cookie)).data;
    assert.equal(absent.total,0);
    assert.deepEqual(absent.searchCoverage,{total:4,complete:1,partial:1,pending:0,error:1,unsupported:1});
    const invite = await call('/api/invitations',{email:'coverage@example.com'},cookie);
    const verified = await call('/api/auth/verify',{token:new URL(invite.data.loginUrl).hash.slice(7)});
    const memberCookie = verified.headers.get('Set-Cookie').split(';')[0];
    await create(memberCookie,'Member document','<p>member only</p>');
    await call(`/api/artifacts/${failed.id}/sharing`,{userId:verified.data.user.id,permission:'read'},cookie,'PUT');
    assert.deepEqual((await call('/api/library?q=nomatchingword',undefined,memberCookie)).data.searchCoverage,{total:2,complete:1,partial:0,pending:0,error:1,unsupported:0});
    await call(`/api/artifacts/${unsupported.id}/manage`,{archived:true},cookie,'PATCH');
    assert.deepEqual((await call('/api/library?q=nomatchingword&view=archived',undefined,cookie)).data.searchCoverage,{total:1,complete:0,partial:0,pending:0,error:0,unsupported:1});
    assert.equal((await call('/api/admin/artifacts?q=nomatchingword&status=active',undefined,cookie)).data.searchCoverage.total,4);
  },{TEST_SEARCH_FAULT:'fail-version-2-once',TEST_EXPIRATION_RETRY_MS:'5000'});
});

test('instance-owner backfill is bounded, resumable, read-only to history and includes archived live artifacts', async () => {
  await withWorker(async ({ call, signIn, create, app }) => {
    const cookie = await signIn('owner@example.com');
    const a = await create(cookie,'Backfill active','<p>backfillword active</p>');
    const b = await create(cookie,'Backfill archive','<p>backfillword archive</p>');
    await call(`/api/artifacts/${b.id}/manage`,{archived:true},cookie,'PATCH');
    const before = (await call('/api/admin/artifacts',undefined,cookie)).data.artifacts;
    const automation = await fetch(app.base+'/api/admin/search-index',{method:'POST',headers:{Authorization:`Bearer ${app.owner}`,'Content-Type':'application/json'},body:'{}'});
    assert.equal(automation.status,202);
    assert.equal((await call('/api/admin/search-index')).status,401);
    const started = await call('/api/admin/search-index',{},cookie);
    assert.equal(started.status,202);
    assert.deepEqual(Object.keys(started.data).sort(),['failed','processed','remaining','status']);
    const repeated = await call('/api/admin/search-index',{},cookie);
    assert.equal(repeated.status,202);
    const deadline = Date.now()+8000;
    let state;
    do {
      state = (await call('/api/admin/search-index',undefined,cookie)).data;
      if (state.status==='complete') break;
      await new Promise(resolve => setTimeout(resolve,100));
    } while (Date.now()<deadline);
    assert.deepEqual(state,{status:'complete',processed:2,remaining:0,failed:0});
    const after = (await call('/api/admin/artifacts',undefined,cookie)).data.artifacts;
    for (const old of before) {
      const current = after.find(e => e.id===old.id);
      assert.equal(current.tip,old.tip); assert.equal(current.updatedAt,old.updatedAt);
      assert.equal((await call(`/api/artifacts/${old.id}`,undefined,cookie)).data.timeline.length,1);
    }
    assert.equal((await call('/api/library?q=backfillword',undefined,cookie)).data.artifacts[0].id,a.id);
    assert.equal((await call('/api/library?q=backfillword&view=archived',undefined,cookie)).data.artifacts[0].id,b.id);
    assert.equal((await call('/api/admin/search-index',{},cookie)).data.processed,2);
  });
});

test('malformed unauthenticated native sync leaves index revision and coverage unchanged', async () => {
  await withWorker(async ({ signIn, create, search, app }) => {
    const cookie = await signIn('owner@example.com');
    const a = await create(cookie,'Native stable','<p>stablesourceword</p>');
    const before = (await search('q=stablesourceword','',cookie)).data;
    await fetch(app.base+`/r/${a.id}`,{method:'POST',headers:{'Content-Type':'application/x-fossil'},body:Buffer.from('not a valid sync frame')});
    const after = (await search('q=stablesourceword','',cookie)).data;
    assert.equal(after.artifacts[0].searchIndex.version,before.artifacts[0].searchIndex.version);
    assert.deepEqual(after.searchCoverage,before.searchCoverage);
  });
});

test('native content and pending index outbox survive scheduling failure and Worker restart without a duplicate commit', {skip:!haveStockFossil}, async () => {
  await withWorker(async ({ call, signIn, app, restart }) => {
    const cookie = await signIn('owner@example.com');
    const response = await fetch(app.base+'/api/artifacts',{method:'POST',headers:{Authorization:`Bearer ${app.owner}`},body:JSON.stringify({title:'Native restart subject',ttlSeconds:null,files:{'index.html':Buffer.from('<p>restartbefore</p>').toString('base64')}})});
    assert.equal(response.status,201);
    const a = await response.json();
    const dir = mkdtempSync(join(work,'restart-')), home = join(dir,'home'), tree = join(dir,'tree'), repository = join(dir,'repo.fossil');
    mkdirSync(home); mkdirSync(tree);
    const fossil = (args,cwd=dir) => {
      try { return execFileSync(stockFossil,args,{cwd,env:{...process.env,HOME:home,FOSSIL_HOME:home,USERPROFILE:home},timeout:20000,stdio:['ignore','pipe','pipe']}).toString(); }
      catch { assert.fail(`native restart fixture ${args[0]} failed (credentials redacted)`); }
    };
    fossil(['clone',a.cloneUrl,repository]);
    fossil(['settings','autosync','off','-R',repository]);
    fossil(['open',repository],tree);
    writeFileSync(join(tree,'index.html'),'<p>restartafter</p>');
    fossil(['commit','--no-warnings','--user','editor','-m','Persist once'],tree);
    fossil(['push',a.cloneUrl],tree);
    const pending = (await call('/api/library?q=restart',undefined,cookie)).data.artifacts[0];
    assert.equal(pending.searchIndex.status,'pending');
    assert.equal(pending.search.snippet,null);
    assert.equal((await call('/api/library?q=restartbefore',undefined,cookie)).data.total,0);
    assert.equal((await call('/api/library?q=restartafter',undefined,cookie)).data.total,0);
    assert.equal((await call(`/api/artifacts/${a.id}`,undefined,cookie)).data.timeline.length,2);
    fossil(['push',a.cloneUrl],tree);
    assert.equal((await call('/api/library?q=restart',undefined,cookie)).data.artifacts[0].searchIndex.version,pending.searchIndex.version,'no-op retry cannot increment the index revision');
    await restart();
    const deadline = Date.now()+8000;
    let found;
    do {
      found = (await call('/api/library?q=restartafter',undefined,cookie)).data;
      if (found.total) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    } while (Date.now()<deadline);
    assert.equal(found.total,1,'persisted alarm repairs the outbox after restart');
    assert.equal(found.artifacts[0].searchIndex.status,'complete');
    assert.equal((await call(`/api/artifacts/${a.id}`,undefined,cookie)).data.timeline.length,2,'retry adds no native commit');
  },{TEST_NATIVE_SEARCH_FAULT:'defer-projection-and-fail-alarm-once',TEST_EXPIRATION_RETRY_MS:'5000'});
});

test('native Fossil push refreshes current HTML body search without an API commit', {skip:!haveStockFossil}, async () => {
  await withWorker(async ({ call, signIn, app }) => {
    const cookie = await signIn('owner@example.com');
    const created = await fetch(app.base+'/api/artifacts', {method:'POST',headers:{Authorization:`Bearer ${app.owner}`},body:JSON.stringify({title:'Native snapshot',ttlSeconds:null,files:{'index.html':Buffer.from('<p>nativebefore</p>').toString('base64')}})});
    assert.equal(created.status,201);
    const a = await created.json();
    const dir = mkdtempSync(join(work,'checkout-')), home = join(dir,'home'), tree = join(dir,'tree');
    mkdirSync(home); mkdirSync(tree);
    const fossil = (args,cwd=dir) => {
      try { return execFileSync(stockFossil,args,{cwd,env:{...process.env,HOME:home,FOSSIL_HOME:home,USERPROFILE:home},timeout:20000,stdio:['ignore','pipe','pipe']}).toString(); }
      catch (error) {
        let diagnostic = String(error.stderr ?? '').replace(/https?:\/\/\S+/g,'[URL redacted]');
        for (const link of [a.cloneUrl,a.editUrl,a.viewerUrl,a.commentUrl]) {
          diagnostic = diagnostic.replaceAll(link,'[redacted]');
          const token = link?.split('#')[1]; if (token) diagnostic = diagnostic.replaceAll(token,'[redacted]');
        }
        assert.fail(`native Fossil ${args[0]} failed: ${diagnostic}`);
      }
    };
    const originalIndex = (await call('/api/library?q=nativebefore',undefined,cookie)).data.artifacts[0].searchIndex;
    fossil(['clone',a.cloneUrl,join(dir,'repo.fossil')]);
    fossil(['settings','autosync','off','-R',join(dir,'repo.fossil')]);
    fossil(['open',join(dir,'repo.fossil')],tree);
    fossil(['pull',a.cloneUrl],tree);
    fossil(['push',a.cloneUrl],tree);
    assert.deepEqual((await call('/api/library?q=nativebefore',undefined,cookie)).data.artifacts[0].searchIndex,originalIndex,'authorized clone, pull and no-op push must not read/rebuild the source index');
    writeFileSync(join(tree,'index.html'),'<p>nativeafter</p>');
    fossil(['commit','--no-warnings','--user','editor','-m','Updated native document'],tree);
    fossil(['push',a.cloneUrl],tree);
    assert.equal((await call('/api/library?q=nativebefore',undefined,cookie)).data.total,0);
    const found = (await call('/api/library?q=nativeafter',undefined,cookie)).data;
    assert.equal(found.total,1);
    assert.equal(found.artifacts[0].searchIndex.status,'complete');
    const { createHash } = await import('node:crypto');
    const privateBytes = Buffer.from('<p>crossartifactsecret</p>');
    const sha = createHash('sha256').update(privateBytes).digest('hex');
    assert.equal((await fetch(app.base+`/api/blobs/${sha}`,{method:'PUT',headers:{Origin:app.base,Cookie:cookie},body:privateBytes})).status,201);
    const pointer = `artifact-blob 1\nsha256 ${sha}\nsize ${privateBytes.length}\ntype text/html\n`;
    const privateSource = await call('/api/artifacts',{title:'Private source',ttlSeconds:null,files:{'index.html':Buffer.from(pointer).toString('base64')}},cookie);
    assert.equal(privateSource.status,201);
    writeFileSync(join(tree,'index.html'),pointer);
    fossil(['commit','--no-warnings','--user','editor','-m','Untrusted cross-artifact pointer'],tree);
    fossil(['push',a.cloneUrl],tree);
    const secret = (await call('/api/library?q=crossartifactsecret',undefined,cookie)).data;
    assert.equal(secret.total,1,'a native push cannot read a blob held by a different artifact');
    assert.equal(secret.artifacts[0].id,privateSource.data.id);
  });
});

test('bounded R2-backed HTML is indexed from persisted bytes and unsupported documents never claim complete coverage', async () => {
  await withWorker(async ({ call, signIn, create, app }) => {
    const cookie = await signIn('owner@example.com');
    const bytes = Buffer.from(`<p>r2subject ${'visible '.repeat(40000)}</p>`);
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const uploaded = await fetch(app.base+`/api/blobs/${sha}`,{method:'PUT',headers:{Origin:app.base,Cookie:cookie,'Content-Type':'text/html'},body:bytes});
    assert.equal(uploaded.status,201);
    const pointer = `artifact-blob 1\nsha256 ${sha}\nsize ${bytes.length}\ntype text/html\n`;
    const a = await create(cookie,'R2 document','ignored',{files:{'index.html':Buffer.from(pointer).toString('base64')}});
    const hit = (await call('/api/library?q=r2subject',undefined,cookie)).data;
    assert.equal(hit.total,1);
    assert.equal(hit.artifacts[0].id,a.id);
    assert.equal(hit.artifacts[0].searchIndex.status,'partial','extracted text budget is reported');
    const unsupported = await create(cookie,'Only binary','ignored',{files:{'readme.txt':Buffer.from('not indexed').toString('base64')}});
    const jsOnly = await create(cookie,'Script generated','<title>Dynamic</title><script>document.write("runtimeonly")</script>');
    const imageOnly = await create(cookie,'Image generated','<img alt="not OCR" src="page.png">');
    const library = (await call('/api/library',undefined,cookie)).data.artifacts;
    assert.equal(library.find(e => e.id===unsupported.id).searchIndex.status,'unsupported');
    assert.equal(library.find(e => e.id===imageOnly.id).searchIndex.status,'unsupported');
    assert.notEqual(library.find(e => e.id===jsOnly.id).searchIndex.status,'complete');
    assert.equal((await call('/api/library?q=runtimeonly',undefined,cookie)).data.total,0);
  });
});

test('indexing refuses an oversized current manifest before expanding it just to read a small HTML file', async () => {
  await withWorker(async ({ call, signIn, create }) => {
    const cookie = await signIn('owner@example.com');
    const files = {'index.html':Buffer.from('<p>manifestbodyword</p>').toString('base64')};
    for (let i=0;i<2400;i++) files[`files/${String(i).padStart(4,'0')}-${'x'.repeat(210)}.txt`] = Buffer.from('x').toString('base64');
    const a = await create(cookie,'Bounded manifest subject','ignored',{files});
    const title = (await call('/api/library?q=manifest',undefined,cookie)).data.artifacts.find(e=>e.id===a.id);
    assert.equal(title.searchIndex.status,'partial');
    assert.equal(title.search.snippet,null);
    assert.equal((await call('/api/library?q=manifestbodyword',undefined,cookie)).data.total,0);
  });
});

test('indexing bounds a small HTML delta whose basis belongs to a different oversized file', {skip:!haveStockFossil}, async () => {
  await withWorker(async ({ call, signIn, app }) => {
    const cookie = await signIn('owner@example.com');
    const basis = 'oversized basis text '.repeat(110000);
    const created = await fetch(app.base+'/api/artifacts',{method:'POST',headers:{Authorization:`Bearer ${app.owner}`},body:JSON.stringify({title:'Delta budget subject',ttlSeconds:null,files:{'index.html':Buffer.from('<p>old text</p>').toString('base64'),'basis.txt':Buffer.from(basis).toString('base64')}})});
    assert.equal(created.status,201);
    const a = await created.json();
    const dir = mkdtempSync(join(work,'delta-')), home = join(dir,'home'), tree = join(dir,'tree'), repository = join(dir,'repo.fossil');
    mkdirSync(home); mkdirSync(tree);
    const fossil = (args,cwd=dir) => {
      try { return execFileSync(stockFossil,args,{cwd,env:{...process.env,HOME:home,FOSSIL_HOME:home,USERPROFILE:home},timeout:20000,stdio:['ignore','pipe','pipe']}).toString(); }
      catch (error) { assert.fail(`native delta fixture ${args[0]} failed: ${String(error.stderr ?? '').replace(/https?:\/\/\S+/g,'[URL redacted]')}`); }
    };
    fossil(['clone',a.cloneUrl,repository]);
    fossil(['settings','autosync','off','-R',repository]);
    fossil(['open',repository],tree);
    const target = `<p>ancestorbudgetword ${'oversized basis text '.repeat(100)}</p>`;
    writeFileSync(join(tree,'index.html'),target);
    fossil(['commit','--no-warnings','--user','editor','-m','Small HTML target'],tree);
    const targetRecord = fossil(['test-content-put','index.html'],tree).match(/record\s+(\d+)/)?.[1];
    const basisRecord = fossil(['test-content-put','basis.txt'],tree).match(/record\s+(\d+)/)?.[1];
    assert.ok(targetRecord,'native target record'); assert.ok(basisRecord,'native basis record');
    fossil(['test-content-deltify',targetRecord,basisRecord,'-force'],tree);
    const rawFile = join(dir,'stored-delta');
    fossil(['test-content-rawget',`rid:${targetRecord}`,rawFile],tree);
    const delta = readFileSync(rawFile,'utf8');
    assert.match(delta,/^[0-9A-Z_a-z~]+\n/,'fixture is stored as a delta, not full HTML');
    // Send that exact delta through authenticated native protocol before the
    // stock client publishes its manifest (stock push may choose full text).
    const manifest = fossil(['artifact','current'],tree);
    const targetHash = /^F index\.html ([0-9a-f]+)/m.exec(manifest)?.[1];
    const basisHash = /^F basis\.txt ([0-9a-f]+)/m.exec(manifest)?.[1];
    const project = /^project-code:\s+([0-9a-f]+)/m.exec(fossil(['info'],tree))?.[1];
    assert.ok(targetHash && basisHash && project,'native manifest and project identifiers');
    const {createHash,randomBytes} = await import('node:crypto');
    const {deflateSync,inflateSync} = await import('node:zlib');
    const sha1 = data=>createHash('sha1').update(data).digest('hex');
    const payload = Buffer.from(`push ${'0'.repeat(40)} ${project}\nfile ${targetHash} ${basisHash} ${Buffer.byteLength(delta)}\n${delta}\n# ${randomBytes(20).toString('hex').toUpperCase()}\n`);
    const nonce = sha1(payload), secret = sha1(`${project}/editor/${new URL(a.editUrl).hash.slice(1)}`);
    const message = Buffer.concat([Buffer.from(`login editor ${nonce} ${sha1(nonce+secret)}\n`),payload]);
    const length = Buffer.alloc(4); length.writeUInt32BE(message.length);
    const transferred = await fetch(app.base+`/r/${a.id}`,{method:'POST',headers:{'Content-Type':'application/x-fossil'},body:Buffer.concat([length,deflateSync(message)])});
    assert.equal(transferred.status,200);
    const reply = Buffer.from(await transferred.arrayBuffer());
    assert.ok(!inflateSync(reply.subarray(4)).toString().includes('error '),'authenticated native delta transfer accepted');
    fossil(['push',a.cloneUrl],tree);
    const raw = await fetch(app.base+`/api/artifacts/${a.id}/files/index.html`,{headers:{Cookie:cookie}});
    assert.equal(raw.status,200); assert.equal(await raw.text(),target,'native push stored the actual small current HTML');
    const title = (await call('/api/library?q=delta',undefined,cookie)).data.artifacts[0];
    assert.equal(title.searchIndex.status,'partial');
    assert.equal((await call('/api/library?q=ancestorbudgetword',undefined,cookie)).data.total,0);
  });
});

test('current library titles use Unicode case and accent normalization through rename, pending indexing and backfill', async () => {
  await withWorker(async ({ call, signIn, create }) => {
    const cookie = await signIn('owner@example.com');
    const a = await create(cookie,'ÉTUDES Café','<p>unrelated body text</p>');
    for (const q of ['ÉTUDES','études','etudes','cafe']) assert.equal((await call(`/api/library?q=${encodeURIComponent(q)}`,undefined,cookie)).data.total,1,q);
    await call(`/api/artifacts/${a.id}/manage`,{title:'ÅNGSTRÖM Zürich'},cookie,'PATCH');
    assert.equal((await call('/api/library?q=cafe',undefined,cookie)).data.total,0);
    await call(`/api/artifacts/${a.id}`,{parent:a.tip,files:{'index.html':Buffer.from('<p>changed unrelated body</p>').toString('base64')}},cookie,'PUT');
    for (const q of ['angstrom','ÅNGSTRÖM','ZURICH']) {
      const result = (await call(`/api/library?q=${encodeURIComponent(q)}`,undefined,cookie)).data;
      assert.equal(result.total,1,q); assert.equal(result.artifacts[0].searchIndex.status,'error');
      assert.equal(result.artifacts[0].search.snippet,null);
    }
    await call('/api/admin/search-index',{},cookie);
    const deadline = Date.now()+8000;
    while ((await call('/api/admin/search-index',undefined,cookie)).data.status!=='complete' && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,100));
    const after = (await call('/api/library?q=angstrom',undefined,cookie)).data;
    assert.equal(after.total,1); assert.equal(after.artifacts[0].searchIndex.status,'complete');
  },{TEST_SEARCH_FAULT:'fail-version-2-once',TEST_EXPIRATION_RETRY_MS:'5000'});
});

test('snippets preserve Unicode text with UTF-16 match offsets and readable inline markup', async () => {
  await withWorker(async ({ call, signIn, create }) => {
    const cookie = await signIn('owner@example.com');
    await create(cookie,'Unicode notes','<p>🦋 Café con<b>ser</b>vation &amp; wildlife</p>');
    const hit = (await call('/api/library?q=cafe',undefined,cookie)).data.artifacts[0];
    assert.ok(hit.search.snippet,'a body-only accent-insensitive hit has a snippet');
    assert.deepEqual(hit.search.snippet.matches.map(m => hit.search.snippet.text.slice(m.start,m.end)),['Café']);
    assert.equal((await call('/api/library?q=conservation',undefined,cookie)).data.total,1);
  });
});

test('static HTML indexing excludes hidden metadata and private content, and bounds supported content honestly', async () => {
  await withWorker(async ({ call, signIn, create }) => {
    const cookie = await signIn('owner@example.com');
    await create(cookie, 'Safety notes', `<head><title>Titleword</title><meta name="description" content="metasecret"><script>scriptsecret</script><style>.x { color:red } stylesecret</style></head><body><!-- commentsecret --><p data-secret="attributesecret">Visibleword &amp; text</p><div hidden>hiddensecret <b>nestedsecret</b></div><div aria-hidden="true">ariasecret</div><p style="display:none">csssecret</p><p style="display&#58;none">encodedsecret</p><form><label>formsecret</label><input value="inputsecret"></form><pre>codeword &lt;tag&gt;</pre></body>`);
    for (const q of ['scriptsecret','metasecret','stylesecret','commentsecret','attributesecret','hiddensecret','nestedsecret','ariasecret','csssecret','encodedsecret','formsecret','inputsecret']) {
      const found = await call(`/api/library?q=${q}`, undefined, cookie);
      assert.equal(found.data.total, 0, q);
    }
    for (const q of ['titleword','visibleword','codeword']) assert.equal((await call(`/api/library?q=${q}`, undefined, cookie)).data.total, 1, q);
    const code = (await call('/api/library?q=codeword', undefined, cookie)).data.artifacts[0].search.snippet;
    assert.ok(code.text.includes('<tag>'), code.text);
    assert.ok(code.text.includes('& text'), code.text);
    const secondary = await create(cookie, 'Several pages', 'unused', { files: { 'index.html': Buffer.from('<p>First page</p>').toString('base64'), 'notes/subject.html': Buffer.from('<p>Secondword subject</p>').toString('base64') } });
    const found = await call('/api/library?q=secondword', undefined, cookie);
    assert.equal(found.data.artifacts[0].id, secondary.id);
    assert.equal(found.data.artifacts[0].search.snippet.path, 'notes/subject.html');
    const giant = await create(cookie, 'Oversized page', `<p>oversizedsecret${'a'.repeat(550000)}</p>`);
    const status = (await call('/api/library', undefined, cookie)).data.artifacts.find(a => a.id === giant.id).searchIndex.status;
    assert.equal(status, 'partial');
    assert.equal((await call('/api/library?q=oversizedsecret', undefined, cookie)).data.total, 0);
  });
});
