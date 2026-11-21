import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startWorker,freePort} from './helpers/worker.mjs';
import {Artifact} from '../public/client.js';
const exec=promisify(execFile);
const root=new URL('..',import.meta.url);
async function fixture(t,handler){
  const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});return `http://127.0.0.1:${server.address().port}`;
}
function input(t,{binary=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'account-update-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(join(dir,'index.html'),'<!doctype html><html><body><h1>Current document</h1></body></html>');
  if(binary)writeFileSync(join(dir,'image.png'),Buffer.from([137,80,78,71]));return dir;
}
async function update(origin,url,dir,credential='fixture-account-credential'){
  try{return{code:0,...await exec(process.execPath,['scripts/publish-html.mjs','update','--json','--no-clipboard',url,dir],{cwd:root,timeout:15000,env:{...process.env,HTML_PUBLISHER_URL:origin,HTML_PUBLISHER_TOKEN:credential}})}}
  catch(error){return{code:error.code,stdout:error.stdout||'',stderr:error.stderr||''};}
}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}
function normal(req,res){
  if(req.method==='GET')return json(res,200,{role:'write',tip:'a'.repeat(40)});
  if(req.method==='PUT')return json(res,200,{tip:'b'.repeat(40)});
  return json(res,404,{error:'not found'});
}

test('plain-link updates reject a configured URL that is not a bare HTTP origin',async t=>{
  const requests=[];const origin=await fixture(t,(req,res)=>{requests.push(req.url);normal(req,res);});
  const dir=input(t);
  for(const configured of [origin+'/other-app',origin+'?other=1',origin+'#fragment',origin.replace('://','://user:password@')]){
    const result=await update(configured,origin+'/v/item',dir);
    assert.notEqual(result.code,0,'a malformed publisher origin is rejected');
    assert.match(result.stderr,/origin/);
  }
  assert.equal(requests.length,0,'no configured credential leaves the process for an invalid origin configuration');
});

test('plain-link updates reject embedded credentials in the supplied artifact URL',async t=>{
  let requests=0;const origin=await fixture(t,(req,res)=>{requests++;normal(req,res);});
  const result=await update(origin,origin.replace('://','://other:password@')+'/v/item',input(t));
  assert.notEqual(result.code,0);assert.equal(requests,0);
});

test('a normalized explicit read fragment never falls back to the environment account',async t=>{
  let accountRequests=0;
  const origin=await fixture(t,(req,res)=>{
    if(req.headers.authorization?.startsWith('Bearer ')){accountRequests++;normal(req,res);}
    else json(res,200,{role:'read',tip:'a'.repeat(40)});
  });
  const result=await update(origin,origin+'/v/item#\n'+'a'.repeat(64),input(t));
  assert.equal(accountRequests,0,'URL normalization must not silently select stronger account authority');
  assert.notEqual(result.code,0);assert.match(result.stderr,/updating needs the edit link/);
});

test('account-authorized artifact requests do not follow redirects',async t=>{
  let redirected=0;
  const origin=await fixture(t,(req,res)=>{
    if(req.url==='/api/artifacts/item'&&req.method==='GET'){res.writeHead(302,{Location:'/unexpected'});res.end();return;}
    if(req.url==='/unexpected')redirected++;
    normal(req,res);
  });
  const result=await update(origin,origin+'/v/item',input(t));
  assert.equal(redirected,0,'the account credential must not be replayed on a redirected path');
  assert.notEqual(result.code,0);
});

test('account-authorized blob existence checks do not follow redirects',async t=>{
  let redirected=0;
  const origin=await fixture(t,(req,res)=>{
    if(req.method==='HEAD'&&req.url.startsWith('/api/artifacts/item/blobs/')){res.writeHead(302,{Location:'/unexpected'});res.end();return;}
    if(req.url==='/unexpected'){redirected++;res.writeHead(404);res.end();return;}
    normal(req,res);
  });
  const result=await update(origin,origin+'/v/item',input(t,{binary:true}));
  assert.equal(redirected,0,'blob probing must not relay account authorization');
  assert.notEqual(result.code,0);
});

test('account-authorized blob uploads do not replay private bytes to a redirected origin',async t=>{
  let received=0;
  const other=await fixture(t,(req,res)=>{received++;req.resume();json(res,200,{});});
  const origin=await fixture(t,(req,res)=>{
    if(req.method==='PUT'&&req.url.startsWith('/api/artifacts/item/blobs/')){res.writeHead(307,{Location:other+'/collect'});res.end();return;}
    normal(req,res);
  });
  const result=await update(origin,origin+'/v/item',input(t,{binary:true}));
  assert.equal(received,0,'no file content is sent to a second origin');
  assert.notEqual(result.code,0);
});

test('account write denial after metadata lookup retains the edit-link recovery hint',async t=>{
  const origin=await fixture(t,(req,res)=>req.method==='PUT'?json(res,403,{error:'write required'}):normal(req,res));
  const result=await update(origin,origin+'/v/item',input(t));assert.notEqual(result.code,0);
  assert.match(result.stderr,/this account cannot edit this artifact; use its edit link/);
});

test('account-authorized CLI updates obey named grants',async t=>{
  const state=mkdtempSync(join(tmpdir(),'account-update-worker-'));
  const port=await freePort();const app=await startWorker(state,{OWNER_EMAIL:'owner@example.com',APP_ORIGIN:`http://127.0.0.1:${port}`,TEST_MAIL_TRANSPORT:'loopback'},{port});
  t.after(()=>{app.stop();rmSync(state,{recursive:true,force:true});});
  const call=async(path,{body,cookie,method=body===undefined?'GET':'POST'}={})=>{
    const response=await fetch(app.base+path,{method,headers:{Origin:app.base,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    const data=await response.json();return{status:response.status,data,headers:response.headers};
  };
  const login=async url=>{const result=await call('/api/auth/verify',{body:{token:new URL(url).hash.slice(7)}});assert.equal(result.status,200);return{cookie:result.headers.get('set-cookie').split(';')[0],user:result.data.user};};
  const requested=await call('/api/auth/request',{body:{email:'owner@example.com'}});assert.equal(requested.status,200);
  const owner=await login(requested.data.loginUrl);
  const created=await call('/api/artifacts',{cookie:owner.cookie,body:{title:'Account CLI fixture',ttlSeconds:null,files:{'index.html':Buffer.from('<!doctype html><h1>Original</h1>').toString('base64')}}});assert.equal(created.status,201);
  const artifact=created.data,plain=app.base+'/v/'+artifact.id;
  const invited=await call('/api/invitations',{cookie:owner.cookie,body:{email:'editor@example.com'}});assert.equal(invited.status,200);
  const editor=await login(invited.data.loginUrl);
  const issued=await call('/api/credentials',{cookie:editor.cookie,body:{name:'CLI editor'}});assert.equal(issued.status,201);
  assert.equal((await call('/api/artifacts/'+artifact.id+'/sharing',{method:'PUT',cookie:owner.cookie,body:{userId:editor.user.id,permission:'write'}})).status,200);
  const dir=input(t,{binary:true});
  await t.test('a personal named editor updates text and binary bytes without receiving a read grant',async()=>{
    const result=await update(app.base,plain+'?returnTo=%2F',dir,issued.data.token);assert.equal(result.code,0);
    const output=JSON.parse(result.stdout);assert.equal(output.viewerUrl===plain,true);assert.equal(output.linkVerified,false);
    const readToken=(await call('/api/artifacts/'+artifact.id,{cookie:owner.cookie})).data.readToken;
    assert.equal(/^[a-f0-9]{64}$/.test(readToken),true,'owner info supplies the actual reusable read capability');
    assert.equal(result.stdout.includes(readToken),false);
    const client=new Artifact(app.base,artifact.id,readToken),bundle=await client.bundle();
    assert.ok(bundle.blobs['image.png']);assert.deepEqual([...await client.blob(bundle.blobs['image.png'])],[137,80,78,71]);
    assert.equal(new TextDecoder().decode(bundle.files['index.html']).includes('Current document'),true);
  });
  await t.test('a named reader is denied with an edit-link recovery hint and no content change',async()=>{
    assert.equal((await call('/api/artifacts/'+artifact.id+'/sharing',{method:'PUT',cookie:owner.cookie,body:{userId:editor.user.id,permission:'read'}})).status,200);
    const before=(await call('/api/artifacts/'+artifact.id,{cookie:owner.cookie})).data.tip;
    writeFileSync(join(dir,'index.html'),'<!doctype html><h1>Must not land</h1>');
    const result=await update(app.base,plain,dir,issued.data.token);assert.notEqual(result.code,0);assert.match(result.stderr,/this account cannot edit this artifact; use its edit link/);
    assert.equal((await call('/api/artifacts/'+artifact.id,{cookie:owner.cookie})).data.tip,before);
  });
  await t.test('a revoked named grant gives the account edit-denial hint without revealing content',async()=>{
    assert.equal((await call('/api/artifacts/'+artifact.id+'/sharing',{method:'PUT',cookie:owner.cookie,body:{userId:editor.user.id,permission:null}})).status,200);
    const before=(await call('/api/artifacts/'+artifact.id,{cookie:owner.cookie})).data.tip;
    const result=await update(app.base,plain,dir,issued.data.token);assert.notEqual(result.code,0);
    assert.match(result.stderr,/this account cannot edit this artifact; use its edit link/);
    assert.equal((await call('/api/artifacts/'+artifact.id,{cookie:owner.cookie})).data.tip,before);
  });
  await t.test('a creator personal credential updates its own artifact and receives a verified read link',async()=>{
    const own=await call('/api/artifacts',{cookie:editor.cookie,body:{title:'Creator CLI fixture',ttlSeconds:null,files:{'index.html':Buffer.from('<!doctype html><h1>Creator original</h1>').toString('base64')}}});assert.equal(own.status,201);
    const path=app.base+'/v/'+own.data.id;
    const info=(await call('/api/artifacts/'+own.data.id,{cookie:editor.cookie})).data;
    assert.equal(/^[a-f0-9]{64}$/.test(info.readToken),true);
    writeFileSync(join(dir,'index.html'),'<!doctype html><h1>Creator update</h1>');
    const result=await update(app.base,path,dir,issued.data.token);assert.equal(result.code,0);
    const output=JSON.parse(result.stdout);assert.equal(output.viewerUrl===path+'#'+info.readToken,true,'only the reusable read link is returned');assert.equal(output.linkVerified,true);
    const next=(await call('/api/artifacts/'+own.data.id,{cookie:editor.cookie})).data;
    assert.equal(next.tip,output.checkin);assert.equal(next.timeline.length,2,'one update adds exactly one check-in');
  });
});
