import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startWorker,freePort} from './helpers/worker.mjs';
const exec=promisify(execFile);
async function beforeDocument(url,startUrl,source,navigate){
  const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=()=>reject(new Error('Browser control unavailable'));});
  let n=0;const pending=new Map();
  ws.onmessage=event=>{const d=JSON.parse(event.data);if(pending.has(d.id)){pending.get(d.id)(d);pending.delete(d.id);}};
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++n;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Browser control timeout'));},5000);
    pending.set(id,d=>{clearTimeout(timer);d.error?reject(new Error('Browser control failed: '+method)):resolve(d.result);});
    ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });
  const {targetInfos}=await call('Target.getTargets');const target=targetInfos.find(t=>t.type==='page'&&t.url===startUrl);assert.ok(target);
  const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  await call('Page.enable',{},sessionId);
  const {identifier}=await call('Page.addScriptToEvaluateOnNewDocument',{source},sessionId);
  await call('Page.navigate',{url:navigate},sessionId);
  return async()=>{await call('Page.removeScriptToEvaluateOnNewDocument',{identifier},sessionId).catch(()=>{});await call('Target.detachFromTarget',{sessionId}).catch(()=>{});ws.close();};
}

test('first account discovery cannot cancel an independently authorized reader copy',{timeout:120000},async t=>{
  if(process.env.RENDERED_COPY_BROWSER_QA!=='1')return t.skip('RENDERED_COPY_BROWSER_QA=1 enables reader scope QA');
  const state=mkdtempSync(join(tmpdir(),'copy-scope-state-')),output=mkdtempSync(join(tmpdir(),'copy-scope-output-'));
  const session='copy-scope-'+process.pid;
  const chrome=process.env.AGENT_BROWSER_EXECUTABLE_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/google-chrome');
  const headed=process.env.AGENT_BROWSER_HEADED==='1'||(process.platform==='darwin'&&process.env.AGENT_BROWSER_HEADED!=='0');
  const run=async(...args)=>{try{return(await exec('agent-browser',['--session',session,'--executable-path',chrome,...(headed?['--headed']:[]),'--download-path',output,...args],{timeout:30000,env:{...process.env,AGENT_BROWSER_IDLE_TIMEOUT_MS:'120000'}})).stdout;}catch{throw new Error('Browser action failed: '+args[0]);}};
  const evaluate=async expression=>{const result=JSON.parse(await run('--json','eval',expression));assert.equal(result.success,true);return result.data.result;};
  let app,remove;
  try{
    const port=await freePort();app=await startWorker(state,{}, {port});
    const response=await fetch(app.base+'/api/artifacts',{method:'POST',headers:{Authorization:'Bearer '+app.owner},body:JSON.stringify({title:'Reader scope fixture',ttlSeconds:null,files:{'index.html':Buffer.from('<!doctype html><html><head><title>Reader scope fixture</title></head><body><h1>READER-SCOPE-MARKER</h1></body></html>').toString('base64')}}),signal:AbortSignal.timeout(20000)});
    assert.equal(response.status,201);const artifact=await response.json();
    // Pin the already-loaded fixture tab. Page.navigate acknowledges navigation
    // before the browser's tab list necessarily reports the new document URL.
    const startUrl=app.base+'/healthz';
    await run('open',startUrl);
    const tabs=JSON.parse(await run('--json','tab','list')).data.tabs;
    const tab=tabs.find(item=>item.url===startUrl);assert.ok(tab,'local fixture tab is open');
    await run('--pin-tab','tab',tab.tabId);
    remove=await beforeDocument((await run('get','cdp-url')).trim(),startUrl,`(()=>{
      const real=window.fetch.bind(window);const sessions=[];window.__initialAccountHandled=false;
      window.__releaseSessions=()=>sessions.splice(0).forEach(release=>release());
      window.fetch=(input,options)=>{
        const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
        if(path==='/api/session'){
          const network=real(input,options);
          return new Promise((resolve,reject)=>sessions.push(()=>network.then(response=>{
            const json=response.json.bind(response);response.json=async()=>{const value=await json();setTimeout(()=>window.__initialAccountHandled=true,0);return value;};resolve(response);
          },reject)));
        }
        if(window.__holdCopyInfo&&path===${JSON.stringify('/api/artifacts/'+artifact.id)}&&(!options?.method||options.method==='GET')){
          window.__holdCopyInfo=false;const network=real(input,options);
          return new Promise((resolve,reject)=>{window.__releaseCopyInfo=()=>network.then(resolve,reject);});
        }
        return real(input,options);
      };
    })()`,artifact.viewerUrl);
    await run('wait','#frame[src^="blob:"]');
    assert.equal(await evaluate('location.pathname'),'/v/'+artifact.id,'the same tab loaded the intended viewer');
    assert.equal(await evaluate('window.__initialAccountHandled'),false,'the capability document loads before account discovery');
    await evaluate('window.__holdCopyInfo=true;true');
    await run('click','#shareBtn');await run('click','#exportTab');await run('click','#saveHtmlBtn');
    await run('wait','--fn','typeof window.__releaseCopyInfo==="function"');
    await evaluate('window.__releaseSessions();true');await run('wait','--fn','window.__initialAccountHandled');
    await evaluate('window.__releaseCopyInfo();true');
    await run('wait','#renderedCopyDownload');await run('click','#renderedCopyDownload');
    let file;for(let i=0;i<100&&!file;i++){file=readdirSync(output).find(name=>name.endsWith('.html'));if(!file)await new Promise(resolve=>setTimeout(resolve,100));}
    assert.ok(file,'a real reader copy is downloaded after initial account discovery');
    assert.equal(readFileSync(join(output,file),'utf8').includes('READER-SCOPE-MARKER'),true);
  }finally{
    await remove?.();try{await run('close');}catch{}app?.stop();rmSync(state,{recursive:true,force:true});rmSync(output,{recursive:true,force:true});
  }
});
