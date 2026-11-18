import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startWorker,freePort} from './helpers/worker.mjs';
const nativeFetch=globalThis.fetch;
globalThis.fetch=(input,options={})=>nativeFetch(input,{...options,signal:options.signal??AbortSignal.timeout(5000)});
const work=mkdtempSync(join(tmpdir(),'search-repair-test-'));
after(()=>rmSync(work,{recursive:true,force:true}));
async function withWorker(body){
  const port=await freePort();
  const app=await startWorker(mkdtempSync(join(work,'state-')),{OWNER_EMAIL:'owner@example.com',APP_ORIGIN:`http://127.0.0.1:${port}`,TEST_MAIL_TRANSPORT:'loopback'},{port});
  const call=async(path,{method='GET',body,authorization=`Bearer ${app.owner}`,cookie,origin=app.base}={})=>{
    const response=await fetch(app.base+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(authorization?{Authorization:authorization}:{}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{}
    assert.ok(response.status<500,`${response.status}`);
    return {status:response.status,data,headers:response.headers};
  };
  try{await body({app,call});}finally{app.stop();}
}

test('body indexing handles self-closing SVG elements without losing readable HTML',async()=>{
  await withWorker(async({call})=>{
    const created=await call('/api/artifacts',{method:'POST',body:{title:'Storage notes',ttlSeconds:null,files:{'index.html':Buffer.from('<h1>Five big data stores</h1><svg viewBox="0 0 10 10"><path d="M0 0h1"/><rect width="1" height="1"/></svg><p>Readable subject after the diagram.</p>').toString('base64')}}});
    assert.equal(created.status,201);
    const indexed=await call('/api/search?q=five%20big');
    assert.equal(indexed.status,200);
    assert.equal(indexed.data.total,1);
    assert.notEqual(indexed.data.artifacts[0].searchIndex.status,'error');
    assert.match(indexed.data.artifacts[0].search.snippet.text,/Five big data stores/);
  });
});

test('foreign self-closing hidden nodes neither leak text nor suppress later readable content',async()=>{
  await withWorker(async({call})=>{
    const html='<svg aria-hidden="true"><g><text>hiddensvgsecret</text></g><path d="M0 0"/></svg><svg><path aria-hidden="true" d="M0 0"/><title/><g hidden><text>nestedsecret</text></g><foreignObject><p>Readable foreign object.</p><script>scriptsecret</script></foreignObject></svg><math><mspace hidden/></math><p>aftervisible content</p>';
    assert.equal((await call('/api/artifacts',{method:'POST',body:{title:'Foreign elements',ttlSeconds:null,files:{'index.html':Buffer.from(html).toString('base64')}}})).status,201);
    assert.notEqual((await call('/api/search')).data.artifacts[0].searchIndex.status,'error');
    for(const q of ['aftervisible','readable'])assert.equal((await call('/api/search?q='+q)).data.total,1,q);
    for(const q of ['hiddensvgsecret','nestedsecret','scriptsecret'])assert.equal((await call('/api/search?q='+q)).data.total,0,q);
  });
});

test('existing instance automation can inspect and resume backfill without becoming an account',async()=>{
  await withWorker(async({call})=>{
    const created=await call('/api/artifacts',{method:'POST',body:{title:'Backfill example',ttlSeconds:null,files:{'index.html':Buffer.from('<p>backfill source</p>').toString('base64')}}});
    assert.equal(created.status,201);
    const before=(await call('/api/search')).data.artifacts[0];
    assert.equal((await call('/api/admin/search-index')).status,200);
    assert.equal((await call('/api/session')).data.user,null,'instance authority is not a fabricated account');
    assert.equal((await call('/api/admin/artifacts')).status,401,'account administration remains separate');
    assert.equal((await call('/api/credentials',{method:'POST',body:{name:'forbidden'}})).status,401);
    assert.equal((await call('/api/admin/search-index',{method:'POST',body:{},origin:'https://unrelated.invalid'})).status,403);
    assert.equal((await call('/api/admin/search-index',{method:'POST',body:{limit:1000}})).status,400);
    assert.equal((await call('/api/admin/search-index',{method:'POST',body:{}})).status,202);
    const deadline=Date.now()+8000;let progress;
    do{progress=(await call('/api/admin/search-index')).data;if(progress.status==='complete')break;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<deadline);
    assert.deepEqual(progress,{status:'complete',processed:1,remaining:0,failed:0});
    assert.equal((await call('/api/admin/search-index',{method:'POST',body:{}})).data.processed,1);
    const after=(await call('/api/search')).data.artifacts[0];
    assert.equal(after.tip,before.tip);assert.equal(after.updatedAt,before.updatedAt);
    assert.equal((await call(`/api/artifacts/${created.data.id}`)).data.timeline.length,1);
    const cap='Token '+new URL(created.data.viewerUrl).hash.slice(1);
    for(const authorization of ['', 'Bearer invalid-instance-credential',cap])for(const method of ['GET','POST']){
      const denied=await call('/api/admin/search-index',{method,authorization,...(method==='POST'?{body:{}}:{})});
      assert.equal(denied.status,401);
      assert.ok(!Object.hasOwn(denied.data,'processed'));
    }
    const requested=await call('/api/auth/request',{method:'POST',authorization:'',body:{email:'owner@example.com'}});
    const verified=await call('/api/auth/verify',{method:'POST',authorization:'',body:{token:new URL(requested.data.loginUrl).hash.slice(7)}});
    const owner=verified.headers.get('Set-Cookie').split(';')[0];
    assert.equal((await call('/api/admin/search-index',{authorization:'',cookie:owner})).status,200);
    const invited=await call('/api/invitations',{method:'POST',authorization:'',cookie:owner,body:{email:'member@example.com'}});
    const member=await call('/api/auth/verify',{method:'POST',authorization:'',body:{token:new URL(invited.data.loginUrl).hash.slice(7)}});
    const cookie=member.headers.get('Set-Cookie').split(';')[0];
    const credential=await call('/api/credentials',{method:'POST',authorization:'',cookie,body:{name:'member search'}});
    for(const identity of [{authorization:'',cookie},{authorization:'Bearer '+credential.data.token}])for(const method of ['GET','POST'])assert.equal((await call('/api/admin/search-index',{...identity,method,...(method==='POST'?{body:{}}:{})})).status,403);
  });
});
