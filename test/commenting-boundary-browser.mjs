// Opt-in: node test/commenting-boundary-browser.mjs.
// Real UI + isolated loopback Worker; no production mail or comments.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, freePort, createArtifact } from './helpers/worker.mjs';
const exec=promisify(execFile),session='comment-boundary-'+process.pid;
const work=mkdtempSync(join(tmpdir(),'hap-comment-boundary-'));
let worker;const results=[];
const stop=()=>worker?.stop();process.once('exit',stop);process.once('SIGTERM',()=>{stop();process.exit(1)});
const deadline=setTimeout(()=>{stop();process.exit(1)},240000);
async function browser(...args){try{return(await exec('agent-browser',['--session',session,...args],{encoding:'utf8',timeout:45000,env:{...process.env,AGENT_BROWSER_IDLE_TIMEOUT_MS:'180000'}})).stdout}catch(error){const detail=String(error.stderr||error.stdout||error.message).replace(/https?:\/\/\S+/g,'[fixture URL]').replace(/[a-f0-9]{64}/gi,'[private value]').replace(/--session\s+\S+/g,'--session [browser]');throw new Error('Browser command failed: '+args[0]+'; '+detail.slice(0,1800))}}
async function evaluate(source){await browser('frame','main');const r=JSON.parse(await browser('--json','eval',source));assert.equal(r.success,true,'browser evaluation succeeded');return r.data.result}
async function wait(source){try{await browser('wait','--fn',source)}catch{throw new Error('Wait condition failed: '+source.replace(/[a-f0-9]{64}/gi,'[private value]').slice(0,220))}}
async function step(name,fn){if(process.env.COMMENT_BOUNDARY_CASE&&!name.includes(process.env.COMMENT_BOUNDARY_CASE))return;try{await fn();results.push({name,passed:true});console.log('PASS: '+name)}catch(error){results.push({name,passed:false,error:String(error.message).replace(/[a-f0-9]{64}/gi,'[private value]')});console.log('FAIL: '+name+': '+results.at(-1).error)}}
try{
 const port=await freePort();
 worker=await startWorker(work,{OWNER_EMAIL:'owner@example.com',APP_ORIGIN:`http://127.0.0.1:${port}`,TEST_MAIL_TRANSPORT:'loopback',WAKE_SINK_KIND:'none'},{port});
 const api=async(path,{method='GET',cookie,bearer,body}={})=>{const r=await fetch(worker.base+path,{method,headers:{Origin:worker.base,...(cookie?{Cookie:cookie}:{}),...(bearer?{Authorization:'Bearer '+bearer}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const text=await r.text();return{status:r.status,data:text?JSON.parse(text):null,cookie:r.headers.get('set-cookie')?.split(';')[0]}};
 const verify=async login=>{const r=await api('/api/auth/verify',{method:'POST',body:{token:new URL(login.data.loginUrl).hash.slice(7)}});assert.equal(r.status,200);return r};
 const owner=await verify(await api('/api/auth/request',{method:'POST',body:{email:'owner@example.com'}}));
 const reviewer=await verify(await api('/api/invitations',{method:'POST',cookie:owner.cookie,body:{email:'reviewer-b@example.com',name:'Reviewer B'}}));
 const a=await createArtifact(worker.base,worker.owner,'<!doctype html><h1 id="scope">Boundary fixture</h1><p>Local review only.</p>');
 const path='/api/artifacts/'+a.id;
 assert.equal((await api(path+'/sharing',{method:'PUT',cookie:owner.cookie,body:{userId:reviewer.data.user.id,permission:'read'}})).status,200);
 const seed=await api(path+'/tickets',{method:'POST',cookie:owner.cookie,body:{text:'Boundary seed thread',identity:'account'}});assert.equal(seed.status,201);
 const plain=worker.base+'/v/'+a.id;let serial=0;
 const setCookie=async cookie=>browser('cookies','set','artifact_session',cookie.split('=')[1],'--url',worker.base,'--httpOnly','--sameSite','Lax');
 const openAs=async(cookie,extra='',preserveDrafts=false)=>{
  if(!preserveDrafts)await evaluate('try{for(const k of Object.keys(sessionStorage))if(k.startsWith("hap-comment-draft:"))sessionStorage.removeItem(k)}catch{};true').catch(()=>{});
  await setCookie(cookie);const url=plain+'?boundaryCase='+(++serial)+extra;
  await browser('open',url);const tabs=JSON.parse(await browser('--json','tab','list')).data.tabs;const tab=tabs.find(t=>t.url===url);assert.ok(tab);await browser('--pin-tab','tab',tab.tabId);
  await browser('wait','#bar:not([hidden])');await wait('document.getElementById("frame").style.display==="block"');
  if(extra.includes('&thread='))await wait('document.getElementById("threadPanel").dataset.mode==="thread"&&!!document.querySelector("#threadPanel .thread.focus")');
 };
 const comments=async()=>{if(await evaluate('document.getElementById("threadPanel").hidden'))await browser('click','#discussionsBtn');await browser('wait','#threadPanel:not([hidden])')};
 const accountIdentity=async()=>{await comments();if(await evaluate('!document.getElementById("useAccountIdentity").hidden'))await evaluate('document.getElementById("useAccountIdentity").click();true');await wait('document.getElementById("identityText").textContent.includes("verified account")')};
 const persisted=async text=>wait(`Object.keys(sessionStorage).some(k=>k.startsWith('hap-comment-draft:')&&sessionStorage.getItem(k).includes(${JSON.stringify(text)}))`);
 const compose=async text=>{await comments();await evaluate('document.getElementById("generalComment").click();true');await browser('wait','#commentForm:not([hidden])');await browser('fill','#commentText',text)};
 const observe=async()=>evaluate(`(()=>{const original=window.fetch.bind(window);window.__sessionSeen=null;window.__sessionChecks=0;window.__held=false;window.__release=null;window.__failTickets=false;window.__holdExact=false;window.__holdRefresh=false;window.__postFinished=false;window.fetch=async(input,init={})=>{const u=new URL(typeof input==='string'?input:input.url,location.origin);const method=init.method||'GET';if(window.__failTickets&&method==='GET'&&u.pathname.endsWith('/tickets'))return new Response(JSON.stringify({error:'Controlled refresh unavailable'}),{status:503,headers:{'Content-Type':'application/json'}});const r=await original(input,init);if(u.pathname==='/api/session'){window.__sessionChecks++;window.__sessionSeen=(await r.clone().json()).user?.id||''}if(method==='POST'&&u.pathname.endsWith('/tickets'))window.__postFinished=true;if(!window.__held&&method==='GET'&&u.pathname.endsWith('/tickets')&&((window.__holdExact&&u.searchParams.has('thread'))||(window.__holdRefresh&&window.__postFinished&&!u.searchParams.has('thread')))){window.__held=true;await new Promise(resolve=>window.__release=resolve)}return r};return true})()`);
 const switchToB=async()=>{await setCookie(reviewer.cookie);await evaluate('window.dispatchEvent(new Event("focus"));true');await wait(`window.__sessionSeen===${JSON.stringify(reviewer.data.user.id)}`);await wait('document.getElementById("role").textContent==="Can comment"&&!document.getElementById("bar").hidden&&document.getElementById("frame").style.display==="block"')};
 await browser('set','viewport','1280','1000');
 await step('account switch refreshes role metadata instead of discarding its own response',async()=>{
  await openAs(owner.cookie);await comments();await wait('document.getElementById("role").textContent==="Can edit"');await observe();await switchToB();await wait('document.getElementById("role").textContent==="Can comment"');
  assert.equal(await evaluate('document.getElementById("uploadFilesBtn").hidden'),true);
 });
 await step('failed new-identity refresh cannot rediscover a previous account recovery draft',async()=>{
  await openAs(owner.cookie);await comments();await evaluate('for(const k of Object.keys(sessionStorage))if(k.startsWith("hap-comment-draft:"))sessionStorage.removeItem(k);true');
  await accountIdentity();await compose('PRIVATE-A recovery text');await persisted('PRIVATE-A recovery text');await observe();await evaluate('window.__failTickets=true;true');await switchToB();
  await comments();await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  assert.equal(await evaluate('Object.keys(sessionStorage).some(k=>k.startsWith("hap-comment-draft:")&&sessionStorage.getItem(k).includes("PRIVATE-A recovery text"))'),false,'the actual previous principal key is cleared');
  assert.equal(await evaluate('document.getElementById("threadRecovery").hidden'),true,'failed refresh does not offer the old account draft');
 });
 await step('cookie-owner copying revalidates the session before exporting a read capability',async()=>{
  await openAs(owner.cookie);await comments();await evaluate('document.querySelector("#threadList .thread summary").click();true');
  await observe();await evaluate('window.__copied=null;Object.defineProperty(navigator.clipboard,"writeText",{configurable:true,value:async value=>window.__copied=value});document.querySelector("#threadList .thread-link").click();true');await wait('window.__copied!==null');
  assert.equal(await evaluate(`new URL(window.__copied).hash.slice(1).split('@')[0]===${JSON.stringify(a.read)}`),true,'a currently authorized owner can share the read capability');
  // Keep automatic focus/poll checks paused while changing the cookie, then
  // make the page visible and click in the same task. Copy must do its own check.
  await evaluate('Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});true');
  await setCookie(reviewer.cookie);
  await evaluate('Object.defineProperty(document,"visibilityState",{configurable:true,value:"visible"});window.__copied=null;window.__sessionChecks=0;document.querySelector("#threadList .thread-link").click();true');
  await evaluate('new Promise(r=>setTimeout(r,500))');
  assert.ok(await evaluate('window.__sessionChecks>0'),'owner copy makes a fresh session check');
  assert.equal(await evaluate(`window.__copied!==null&&new URL(window.__copied).hash.slice(1).split('@')[0]===${JSON.stringify(a.read)}`),false,'a lost owner cannot export its cached read capability');
 });
 await step('cookie-only content is removed when the new account has no artifact access',async()=>{
  const unshared=await verify(await api('/api/invitations',{method:'POST',cookie:owner.cookie,body:{email:'unshared@example.com',name:'Unshared reviewer'}}));
  assert.equal((await api(path,{cookie:unshared.cookie})).status,404,'the new account has no grant');
  await openAs(owner.cookie);await comments();await observe();await setCookie(unshared.cookie);await evaluate('window.dispatchEvent(new Event("focus"));true');
  await wait(`window.__sessionSeen===${JSON.stringify(unshared.data.user.id)}`);
  await wait('document.getElementById("frame").src==="about:blank"');
  assert.equal(await evaluate('document.getElementById("frame").style.display'),'none','cached private document is not left visible');
 });
 await step('explicit account and guest choices clear the previous principal immediately',async()=>{
  await openAs(owner.cookie);await accountIdentity();await compose('Account-only unsent words');await persisted('Account-only unsent words');
  assert.equal(await evaluate('document.getElementById("useGuestIdentity").click();document.getElementById("commentText").value'),'','guest choice cannot retain the account draft');
  await wait('document.getElementById("identityText").textContent.includes("unverified guest")');
  await compose('Guest-only unsent words');await persisted('Guest-only unsent words');
  assert.equal(await evaluate('document.getElementById("useAccountIdentity").click();document.getElementById("commentText").value'),'','account choice cannot consume a stale sign-in exemption');
 });
 await step('a silently changed account cookie cannot publish the displayed account draft',async()=>{
  await openAs(owner.cookie);await accountIdentity();await compose('PRIVATE-A silently queued words');await observe();
  await evaluate('Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});true');await setCookie(reviewer.cookie);
  await evaluate('Object.defineProperty(document,"visibilityState",{configurable:true,value:"visible"});document.querySelector("#commentForm [type=submit]").click();true');
  await wait(`window.__sessionSeen===${JSON.stringify(reviewer.data.user.id)}`);
  const result=await api(path+'/tickets?q='+encodeURIComponent('PRIVATE-A silently queued words'),{cookie:owner.cookie});
  assert.equal(result.status,200);assert.equal(result.data.tickets.length,0,'stale draft is rejected, not published as B');
  assert.equal(await evaluate('document.getElementById("commentText").value'),'');
 });
 // Bury the seed so restoring its reply requires an exact, asynchronous lookup.
 for(let i=0;i<38;i++){const r=await api(path+'/tickets',{method:'POST',bearer:worker.owner,body:{text:'Later boundary thread '+i}});assert.equal(r.status,201)}
 await step('delayed reply restoration cannot reinsert old identity text after switching accounts',async()=>{
  await openAs(owner.cookie,'&thread='+seed.data.ticketUuid);await accountIdentity();await wait('!!document.querySelector("#threadPanel .thread.focus .reply textarea")');
  await browser('fill','#threadPanel .thread.focus .reply textarea','PRIVATE-A delayed restore');await persisted('PRIVATE-A delayed restore');
  await openAs(owner.cookie,'',true);await accountIdentity();await wait('!document.getElementById("threadRecovery").hidden');
  assert.equal(await evaluate('document.getElementById("threadRecovery").textContent.includes("a reply")'),true,'the recovery target is a reply, not another draft');await observe();await evaluate('window.__holdExact=true;document.getElementById("restoreDraft").click();true');await wait('window.__held===true');
  await switchToB();await compose('B current safe draft');await evaluate('window.__holdExact=false;window.__release();true');await evaluate('new Promise(r=>setTimeout(r,500))');
  assert.equal(await evaluate('[...document.querySelectorAll("textarea")].some(t=>t.value.includes("PRIVATE-A delayed restore"))'),false);
  assert.equal(await evaluate('document.getElementById("commentText").value'),'B current safe draft');
 });
 await step('a stale post-refresh callback cannot close the new identity composer',async()=>{
  await openAs(owner.cookie);await accountIdentity();await compose('A intentionally submitted note');await observe();await evaluate('window.__holdRefresh=true;document.querySelector("#commentForm [type=submit]").click();true');await wait('window.__held===true');
  await switchToB();await compose('B draft after the switch');await evaluate('window.__holdRefresh=false;window.__release();true');await evaluate('new Promise(r=>setTimeout(r,500))');
  assert.equal(await evaluate('document.getElementById("commentText").value'),'B draft after the switch');
  assert.equal(await evaluate('document.getElementById("commentForm").hidden'),false,'old refresh does not change the new reader mode');
 });
 await step('a recovered correction reopens its own editor and never becomes a new comment',async()=>{
  await openAs(owner.cookie,'&thread='+seed.data.ticketUuid);await accountIdentity();await wait('!!document.querySelector("#threadPanel .thread.focus .edit-message")');
  await evaluate('document.querySelector("#threadPanel .thread.focus .edit-message").click();true');
  await browser('fill','#threadPanel .thread.focus .message-editor textarea','Recovered correction text');await persisted('Recovered correction text');
  await openAs(owner.cookie,'',true);await accountIdentity();await wait('!document.getElementById("threadRecovery").hidden');
  assert.equal(await evaluate('document.getElementById("threadRecovery").textContent.includes("your correction")'),true);
  await evaluate('document.getElementById("restoreDraft").click();true');await wait('!!document.querySelector("#threadPanel .thread.focus .message-editor textarea")');
  assert.equal(await evaluate('document.querySelector("#threadPanel .thread.focus .message-editor textarea").value'),'Recovered correction text');
  let exact=await api(path+'/tickets?thread='+seed.data.ticketUuid,{cookie:owner.cookie});
  assert.equal(exact.data.tickets[0].changes[0].text,'Boundary seed thread','restoring is not a server write');
  await evaluate('document.querySelector("#threadPanel .thread.focus .message-editor [type=submit]").click();true');
  await wait('!document.querySelector("#threadPanel .thread.focus .message-editor")');
  exact=await api(path+'/tickets?thread='+seed.data.ticketUuid,{cookie:owner.cookie});
  assert.equal(exact.data.tickets[0].changes[0].text,'Recovered correction text');
  assert.deepEqual(exact.data.tickets[0].changes[0].history.map(h=>h.text),['Boundary seed thread','Recovered correction text']);
 });
 writeFileSync('/tmp/hap-commenting-boundary-results.json',JSON.stringify(results,null,2),{mode:0o600});
 if(results.some(r=>!r.passed))process.exitCode=1;
}finally{try{await browser('close')}catch{}clearTimeout(deadline);stop();rmSync(work,{recursive:true,force:true})}
