// Opt-in: node test/commenting-draft-browser.mjs. Isolated local review only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, createArtifact } from './helpers/worker.mjs';
import { frameEval } from './helpers/frame-eval.mjs';
const exec=promisify(execFile),session='comment-draft-'+process.pid;
const work=mkdtempSync(join(tmpdir(),'hap-comment-draft-'));
let worker,page,stage='starting local Worker';
const mark=value=>{stage=value;console.log('CHECK: '+value)};
const stop=()=>{page?.close();worker?.stop()};
process.once('exit',stop);process.once('SIGTERM',()=>{stop();process.exit(1)});
const deadline=setTimeout(()=>{console.error('Verification deadline during '+stage);stop();process.exit(1)},240000);
async function browser(...args){try{return(await exec('agent-browser',['--session',session,...args],{encoding:'utf8',timeout:45000,env:{...process.env,AGENT_BROWSER_IDLE_TIMEOUT_MS:'180000'}})).stdout}catch(error){const detail=String(error.stderr||error.stdout||error.message).replace(/https?:\/\/\S+/g,'[fixture URL]').replace(/[a-f0-9]{64}/gi,'[private value]').replace(/--session\s+\S+/g,'--session [browser]');throw new Error('Browser command failed: '+args[0]+'; '+detail.slice(0,1800))}}
async function evaluate(source){await browser('frame','main');const r=JSON.parse(await browser('--json','eval',source));assert.equal(r.success,true);return r.data.result}
async function wait(source){try{await browser('wait','--fn',source)}catch{
 let detail='';try{detail=JSON.stringify(await evaluate('({debug:window.__restoreDebug,visibility:document.visibilityState,placing:document.getElementById("commentsBtn").getAttribute("aria-pressed"),inspectorHidden:document.getElementById("inspector").hidden,bubbleHidden:document.getElementById("commentBubble").hidden,pinMessages:window.__pinMessages,parentClicks:window.__parentClicks,mode:document.getElementById("threadPanel").dataset.mode,identity:document.getElementById("identityText").textContent,recovery:document.getElementById("threadRecovery").textContent,notice:document.getElementById("threadNotice")?.textContent,rows:[...document.querySelectorAll("#threadPanel .thread")].map(t=>({open:t.open,classes:t.className,text:t.querySelector("textarea")?.value})),drafts:Object.keys(sessionStorage).filter(k=>k.startsWith("hap-comment-draft:")).map(k=>JSON.parse(sessionStorage.getItem(k)))})'))}catch{}
 try{detail+='; browser errors '+await browser('errors')}catch{}
 throw new Error('Wait failed: '+source.replace(/[a-f0-9]{64}/gi,'[private value]').slice(0,200)+'; state '+detail)
}}
try{
 worker=await startWorker(work,{WAKE_SINK_KIND:'none'});
 mark('creating local artifact');
 const a=await createArtifact(worker.base,worker.owner,'<!doctype html><meta charset="utf-8"><title>Draft fixture</title><h1 id="scope">Review scope</h1><p>Local-only independent draft recovery.</p>');
 mark('seeding one discussion');
 const endpoint=worker.base+'/api/artifacts/'+a.id+'/tickets';
 const seeded=await fetch(endpoint,{method:'POST',headers:{Authorization:'Token '+a.write},body:JSON.stringify({text:'A seed discussion'})});assert.equal(seeded.status,201);await seeded.arrayBuffer();
 mark('opening anonymous read viewer');
 await browser('set','viewport','1280','1000');
 await browser('open',a.viewerUrl);
 const tabs=JSON.parse(await browser('--json','tab','list')).data.tabs;const tab=tabs.find(t=>t.url.includes('/v/'+a.id));assert.ok(tab);await browser('--pin-tab','tab',tab.tabId);
 const ready=async()=>{await browser('wait','#bar:not([hidden])');await wait('document.getElementById("frame").style.display==="block"')};
 const comments=async()=>{if(await evaluate('document.getElementById("threadPanel").hidden'))await browser('click','#discussionsBtn');await browser('wait','#threadPanel:not([hidden])')};
 const read=async()=>{const r=await fetch(endpoint,{headers:{Authorization:'Token '+a.read},signal:AbortSignal.timeout(20000)});assert.equal(r.status,200);return r.json()};
 await ready();await comments();
 mark('anonymous reply and follow');
 await evaluate('const t=document.querySelector("#threadList .thread");if(!t.open)t.querySelector("summary").click();true');
 await browser('fill','#threadList .thread .reply textarea','Anonymous reply before profile creation');
 await evaluate('document.querySelector("#threadList .thread-follow").click();true');
 await wait('document.querySelector("#threadList .thread-follow").textContent==="Following"');
 mark('reply recovery after reload');
 await browser('reload');await ready();await comments();await wait('!document.getElementById("threadRecovery").hidden');
 assert.equal(await evaluate('document.getElementById("threadRecovery").textContent.includes("a reply")'),true,'anonymous reply migrated to the named browser identity');
 await evaluate('document.querySelector("#threadFilters [data-filter=unread]").click();true');
 await evaluate('document.getElementById("restoreDraft").click();true');
 await wait('document.querySelector("#threadPanel .thread.focus .reply textarea")?.value==="Anonymous reply before profile creation"');
 assert.equal((await read()).tickets[0].changes.length,1,'restoration never posts');
 assert.equal(await evaluate('document.getElementById("threadRecovery").hidden'),true,'an active restored reply is not offered twice');
 await wait('fetch("/api/artifacts/"+location.pathname.split("/")[2]+"/tickets?identity=guest",{headers:{Authorization:"Token "+location.hash.slice(1)}}).then(r=>r.json()).then(r=>r.tickets.length===1&&!r.tickets[0].unread)');
 assert.equal(await evaluate('document.querySelector("#threadPanel .thread.focus .reply textarea")?.value'),'Anonymous reply before profile creation','read acknowledgement does not remove the active Unread card');
 await evaluate('document.getElementById("allComments").click();true');
 await wait('document.querySelectorAll("#threadList .thread").length===0');
 await evaluate('document.querySelector("#threadFilters [data-filter=all]").click();true');await wait('!!document.querySelector("#threadList .thread")');
 await evaluate('const t=document.querySelector("#threadList .thread");if(!t.open)t.querySelector("summary").click();true');
 await browser('fill','#threadPanel .thread.focus .reply textarea','');
 await evaluate('document.getElementById("generalComment").click();true');await browser('wait','#commentForm:not([hidden])');
 await browser('fill','#commentText','Independent general draft');
 await browser('click','#threadClose');
 await evaluate('window.__parentClicks=[];document.addEventListener("click",e=>window.__parentClicks.push({id:e.target.id,tag:e.target.tagName,x:e.clientX,y:e.clientY}),true);true');
 if(await evaluate('document.getElementById("commentsBtn").getAttribute("aria-pressed")!=="true"'))await browser('click','#commentsBtn');
 assert.equal(await evaluate('document.getElementById("commentsBtn").getAttribute("aria-pressed")'),'true','placement is armed before the frame click');
 mark('placing independent point draft');
 console.log('CHECK: browser dialog '+await browser('dialog','status'));
 page=await frameEval((await browser('get','cdp-url')).trim());
 const pos=await page.eval('(()=>{const r=document.getElementById("scope").getBoundingClientRect();return{x:r.left+35,y:r.top+10}})()');
 const frame=await evaluate('(()=>{const r=document.getElementById("frame").getBoundingClientRect();return{x:r.left,y:r.top}})()');
 console.log('CHECK: pointer geometry '+JSON.stringify({pos,frame,hit:await evaluate(`(()=>{const e=document.elementFromPoint(${Math.round(frame.x+pos.x)},${Math.round(frame.y+pos.y)});return{tag:e?.tagName,id:e?.id,placing:document.getElementById('commentsBtn').getAttribute('aria-pressed')}})()`)}));
 await evaluate('window.__pinMessages=[];addEventListener("message",e=>{if(e.data?.__artifactPins)window.__pinMessages.push(e.data.type)});true');
 await page.click(Math.round(frame.x+pos.x),Math.round(frame.y+pos.y));await wait('!document.getElementById("commentBubble").hidden');
 await browser('fill','#bubbleText','Independent point draft');
 // Reload while the point bubble is still open: no Close/Save action first.
 await browser('reload');page.close();page=null;await ready();await comments();await wait('!document.getElementById("threadRecovery").hidden');
 assert.equal(await evaluate('Object.keys(sessionStorage).filter(k=>k.startsWith("hap-comment-draft:")).some(k=>sessionStorage.getItem(k).includes("Independent point draft"))'),true,'live point typing is recoverable without closing first');
 const recovered=new Set();
 for(let i=0;i<2;i++){
  await comments();await wait('!document.getElementById("threadRecovery").hidden');await evaluate('document.getElementById("restoreDraft").click();true');
  const restored=await evaluate('!document.getElementById("commentBubble").hidden&&document.getElementById("bubbleText").value==="Independent point draft"?"point":!document.getElementById("commentForm").hidden&&document.getElementById("commentText").value==="Independent general draft"?"general":""');
  assert.ok(restored,'Restore opens the matching composer');recovered.add(restored);
 }
 assert.equal(recovered.size,2,'both independent composers are restored, regardless of storage enumeration order');
 if(await evaluate('document.getElementById("commentBubble").hidden'))await evaluate('document.getElementById("placeComment").click();true');
 await browser('wait','#commentBubble:not([hidden])');
 assert.equal(await evaluate('document.getElementById("bubbleText").value'),'Independent point draft');
 assert.equal(await evaluate('document.getElementById("commentText").value'),'Independent general draft','point restoration does not overwrite the other composer');
 await evaluate('document.getElementById("bubbleIdentityChange").click();true');await browser('wait','#guestProfile:not([hidden])');
 assert.equal(await evaluate('document.getElementById("inspector").hidden'),false,'bubble identity change opens visible settings');
 await browser('fill','#guestEmail','not-an-email');await evaluate('document.getElementById("identityDone").click();true');
 assert.equal(await evaluate('document.getElementById("guestProfile").hidden'),false,'invalid optional email is not hidden by Done');
 await browser('fill','#guestEmail','');await evaluate('document.getElementById("identityDone").click();document.getElementById("placeComment").click();true');await browser('wait','#commentBubble:not([hidden])');
 assert.equal(await evaluate('document.getElementById("bubbleText").value'),'Independent point draft','settings preserve the independent point draft');
 assert.equal(await evaluate('document.getElementById("commentText").value'),'Independent general draft');
 await browser('click','#commentBubble [type=submit]');await wait('document.getElementById("commentBubble").hidden');
 assert.equal(await evaluate('Object.keys(sessionStorage).filter(k=>k.startsWith("hap-comment-draft:")).some(k=>sessionStorage.getItem(k).includes("Independent point draft"))'),false,'a saved point has no stale recovery');
 assert.equal(await evaluate('Object.keys(sessionStorage).filter(k=>k.startsWith("hap-comment-draft:")).some(k=>sessionStorage.getItem(k).includes("Independent general draft"))'),true,'posting one composer preserves the other');
 await comments();await evaluate('document.getElementById("generalComment").click();true');await browser('wait','#commentForm:not([hidden])');await evaluate('document.querySelector("#commentForm [type=submit]").click();true');
 await wait('document.getElementById("commentForm").hidden');
 assert.equal(await evaluate('document.getElementById("threadRecovery").hidden'),true,'a successful post cannot re-offer itself as unsent');
 const all=await read();
 assert.equal(all.tickets.length,3);
 assert.ok(all.tickets.some(t=>t.fields.comment==='Independent point draft'));
 assert.ok(all.tickets.some(t=>t.fields.comment==='Independent general draft'));
 console.log('PASS: anonymous reply adoption, live point reload recovery, independent general/point drafts, explicit restoration, and successful-post cleanup.');
}finally{try{await browser('close')}catch{}clearTimeout(deadline);stop();rmSync(work,{recursive:true,force:true})}
