import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { browserDriver } from './library-browser.mjs';

export async function adminWorkspaceQA({base,output,owner,api}) {
  mkdirSync(output,{recursive:true});
  const {run,runAsync,evaluate,wait,click}=browserDriver('accounts-admin-workspace-qa');
  const fixtures=[];
  let failure;
  const ready=()=>wait('#content[aria-busy="false"]');
  const rowIds=()=>evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>new URL(e.href).pathname.split("/").at(-1))');
  const more=()=>{
    // Scroll the actual main pane before taking click coordinates; an implicit
    // CDP scroll-and-click can otherwise activate the row previously here.
    evaluate('document.getElementById("more").scrollIntoView({block:"center",behavior:"instant"})');
    run('wait','--fn','(()=>{const r=document.getElementById("more").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()');
    click('#more');
  };
  try {
    run('cookies','set','artifact_session',owner.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    for(const view of ['people','activity','credentials']) {
      run('open',`${base}/?view=${view}`);ready();
      assert.equal(evaluate('document.getElementById("privacy-note").hidden'),true,`${view} does not show unrelated artifact privacy copy`);
      if(view!=='credentials') assert.ok(evaluate('document.getElementById("search-label").getBoundingClientRect().height>=12'),`${view} retains a visible search signifier when filled`);
    }
    const prefix='Admin workflow fixture';
    for(let i=0;i<16;i++) {
      const ttlSeconds=i<14?(i+1)*3600:i===14?21*86400:null;
      const response=await api('/api/artifacts',{method:'POST',cookie:owner.cookie,body:{title:`${prefix} ${String(i).padStart(2,'0')}`,ttlSeconds,files:{'index.html':Buffer.from('<!doctype html><h1>Local admin workflow fixture</h1>').toString('base64')}}});
      assert.equal(response.status,201,'create local admin workflow fixture');
      fixtures.push(response.json.id);
    }
    run('open',`${base}/?view=admin&q=${encodeURIComponent(prefix)}`);ready();
    // Inventory filters are progressive disclosure behind one labeled control.
    assert.equal(evaluate('document.getElementById("filter-toggle").hidden'),false,'inventory offers a labeled Filters control');
    click('#filter-toggle');wait('#filter-popover:not([hidden])');
    assert.equal(evaluate('!!document.querySelector("#expiry-filter:not([hidden])")'),true,'inventory exposes its expiration filter');
    assert.equal(evaluate('[...document.querySelectorAll("#sort option")].some(e=>e.value==="expiry"&&e.textContent==="Expires soonest")'),true,'expiration ordering is discoverable');
    assert.ok(evaluate('document.querySelector(".inventory-head").textContent.includes("Expires")'),'expiry is visible without opening Manage');
    run('select','#sort','expiry');ready();
    assert.equal(evaluate('new URL(location.href).searchParams.get("sort")'),'expiry','expiration ordering survives a shareable inventory URL');
    assert.equal(evaluate('document.getElementById("page-error").hidden'),true,'expiry sort uses the real API successfully');
    assert.match(evaluate('document.getElementById("filter-chips").textContent'),/Expires soonest/,'the active sort is a removable chip');
    assert.match(evaluate('document.getElementById("filter-chips").textContent'),/Search: Admin workflow fixture/,'the active search is a removable chip');
    assert.equal(evaluate('document.getElementById("filter-count").textContent'),'2','the Filters control counts every active filter');
    assert.deepEqual(rowIds(),fixtures.slice(0,12),'finite deadlines are earliest first');
    run('press','Escape');run('wait','--fn','document.getElementById("filter-popover").hidden');
    more();await runAsync('wait','--fn','document.querySelectorAll(".artifact-title").length===16');
    assert.deepEqual(rowIds(),fixtures,'pagination keeps finite deadlines ordered and never last');
    run('reload');ready();
    assert.equal(evaluate('document.getElementById("sort").value'),'expiry','refresh restores expiration ordering');
    assert.deepEqual(rowIds(),fixtures,'refresh preserves the expanded expiry list');
    click('.artifact-title');wait('#bar:not([hidden])');click('#backLibrary');ready();
    assert.deepEqual(rowIds(),fixtures,'viewer return preserves expiry ordering and expanded count');
    click('#filter-toggle');wait('#filter-popover:not([hidden])');
    run('select','#expiry-filter','soon');ready();
    assert.equal(evaluate('new URL(location.href).searchParams.get("expiry")'),'soon');
    assert.equal(evaluate('document.querySelectorAll(".artifact-title").length'),12,'changing expiry filter resets pagination');
    run('press','Escape');run('wait','--fn','document.getElementById("filter-popover").hidden');
    more();await runAsync('wait','--fn','document.querySelectorAll(".artifact-title").length===14');
    assert.deepEqual(rowIds(),fixtures.slice(0,14),'seven-day filter excludes distant and never deadlines');
    for(const width of [320,390,768,1280])for(const theme of ['light','dark']) {
      run('set','viewport',String(width),'1000');
      evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};window.scrollTo({top:0,behavior:'instant'})`);
      const geometry=evaluate(`(()=>{const e=document.querySelector(innerWidth<=760?'.inventory-expiration':'.expiry-cell');return {overflow:document.documentElement.scrollWidth>innerWidth,expiryVisible:!!e&&e.getBoundingClientRect().height>0,titleTargets:[...document.querySelectorAll('.artifact-title')].every(e=>e.getBoundingClientRect().height>=44)}})()`);
      assert.equal(geometry.overflow,false,`${width}/${theme}: inventory fits`);
      assert.equal(geometry.expiryVisible,true,`${width}/${theme}: expiry remains visible`);
      assert.equal(geometry.titleTargets,true,`${width}/${theme}: opening targets stay 44px`);
      run('screenshot',join(output,`inventory-expiry-${theme}-${width}.png`));
    }
    run('set','viewport','1280','1000');
    run('fill','#search','No matching admin fixture');run('press','Enter');ready();
    assert.equal(evaluate('document.querySelectorAll(".artifact-title").length'),0);
    assert.ok(evaluate('document.getElementById("content").textContent.includes("No matching artifacts")'));
    assert.equal(evaluate('document.getElementById("clear-filters").hidden'),false,'empty search has an explicit recovery control');
    click('#clear-filters');ready();
    assert.equal(evaluate('document.getElementById("search").value'),'');
    assert.equal(evaluate('document.getElementById("expiry-filter").value'),'all');
    assert.ok(rowIds().length,'clear filters recovers the inventory');
    for(const control of ['clear-filters','popover-clear']) {
      run('open',`${base}/?view=admin&sort=expiry`);ready();
      assert.equal(evaluate('document.getElementById("filter-count").textContent'),'1','expiry ordering alone is an active filter');
      if(control==='popover-clear'){
        run('set','viewport','320','600');click('#filter-toggle');wait('#filter-popover:not([hidden])');
        assert.equal(evaluate('(()=>{const p=document.getElementById("filter-popover").getBoundingClientRect();return p.top>=15&&p.bottom<=innerHeight-15&&p.left>=15&&p.right<=innerWidth-15})()'),true,'filters stay inside a small viewport');
        assert.equal(evaluate('(()=>{const r=document.getElementById("popover-done").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()'),true,'Done is reachable without scrolling the page');
      }
      click('#'+control);ready();
      assert.equal(evaluate('document.getElementById("sort").value'),'recent','clear removes the sort-only expiry filter');
      assert.equal(evaluate('new URL(location.href).searchParams.has("sort")'),false);
      assert.equal(evaluate('document.getElementById("filter-chips").children.length'),0);
      assert.equal(evaluate('document.getElementById("filter-count").hidden'),true);
    }

    run('set','viewport','1280','1000');
    const invited=await api('/api/invitations',{method:'POST',cookie:owner.cookie,body:{email:'admin-leaving-member@example.com',name:'Admin leaving member'}});
    assert.equal(invited.status,200,'invite a local offboarding fixture');
    const verified=await api('/api/auth/verify',{method:'POST',body:{token:new URL(invited.json.loginUrl).hash.slice(7)}});
    assert.equal(verified.status,200,'accept the local fixture invitation');
    const member={id:verified.json.user.id,cookie:verified.headers.get('Set-Cookie').split(';')[0]};
    for(let i=0;i<2;i++) {
      const created=await api('/api/artifacts',{method:'POST',cookie:member.cookie,body:{title:`Admin member fixture ${i}`,ttlSeconds:null,files:{'index.html':Buffer.from('<h1>Local member fixture</h1>').toString('base64')}}});
      assert.equal(created.status,201);fixtures.push(created.json.id);
      if(i===1)assert.equal((await api(`/api/artifacts/${created.json.id}/manage`,{method:'PATCH',cookie:owner.cookie,body:{archived:true}})).status,200);
    }
    run('cookies','set','artifact_session',member.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    run('open',`${base}/?view=admin&sort=expiry&expiry=soon`);ready();
    assert.equal(evaluate('document.getElementById("page-error").hidden'),true,'member following an admin expiry URL reaches a usable personal library');
    assert.equal(evaluate('new URL(location.href).searchParams.has("expiry")'),false,'admin-only filters are removed on role fallback');
    assert.equal(evaluate('document.getElementById("sort").value'),'recent');
    assert.deepEqual(rowIds(),fixtures.slice(-2,-1),'role fallback never lists other owners or archived work');
    run('cookies','set','artifact_session',owner.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    run('open',`${base}/?view=people&q=admin-leaving-member`);ready();
    const person=evaluate(`(()=>{const row=document.querySelector('[data-person-id="${member.id}"]');const link=row?.querySelector('.person-artifacts');return {count:document.querySelectorAll('.person').length,link:link?.textContent||null,signin:row?.textContent.includes('Last sign-in')||false}})()`);
    assert.equal(person.link,'View 2 artifacts','person has a direct current-artifact count and destination');
    assert.equal(person.count,1,'people search narrows by email');
    assert.equal(person.signin,true,'recorded sign-in is visible before offboarding');
    click('.person-artifacts');ready();
    assert.equal(evaluate('new URL(location.href).searchParams.get("ownerId")'),member.id,'person link maps directly to owner-filtered inventory');
    assert.deepEqual(rowIds().sort(),fixtures.slice(-2).sort(),'owner-filtered inventory includes archived work');
    run('open',`${base}/?view=people&q=admin-leaving-member`);ready();
    click('.person .record-actions button:last-child');wait('#dialog[open]');
    assert.ok(evaluate('document.getElementById("dialog-body").textContent.includes("View 2 artifacts")'),'person management includes a route to their remaining work');
    run('find','role','button','click','--name','Suspend account');wait('#dialog-body button[type="submit"]');
    assert.ok(evaluate('document.getElementById("dialog-body").textContent.includes("Their artifacts will remain")'),'suspension explains retained artifacts');
    assert.ok(evaluate('document.getElementById("dialog-body").textContent.includes("capability links still work")'),'suspension does not imply complete revocation of previously issued artifact links');
    click('#dialog-body button[type="submit"]');run('wait','--fn','!document.getElementById("dialog").open');ready();
    assert.equal(evaluate('document.querySelector(".person-artifacts").textContent'),'View 2 artifacts','suspension keeps the artifact-management path');
    assert.ok(evaluate('document.querySelector(".person .state").textContent.includes("Suspended")'));
    for(const width of [320,1280])for(const theme of ['light','dark']) {
      run('set','viewport',String(width),'1000');evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};window.scrollTo({top:0,behavior:'instant'})`);
      assert.equal(evaluate('document.documentElement.scrollWidth>innerWidth'),false,'people details fit phone and desktop');
      assert.ok(evaluate('document.querySelector(".person-artifacts").getBoundingClientRect().height>=44'),'person-to-artifact destination has a touch-size target');
      run('screenshot',join(output,`people-${theme}-${width}.png`));
    }

    const deadline=new Date(Math.floor(Date.now()/1000)*1000+3*86400000).toISOString();
    for(const expiresAt of [deadline,null]) assert.equal((await api(`/api/artifacts/${fixtures[0]}/manage`,{method:'PATCH',cookie:owner.cookie,body:{expiresAt}})).status,200);
    assert.equal((await api(`/api/artifacts/${fixtures[0]}/comment-link`,{method:'POST',cookie:owner.cookie})).status,200);
    assert.equal((await api(`/api/artifacts/${fixtures[1]}`,{method:'DELETE',cookie:owner.cookie})).status,204);
    for(let i=0;i<26;i++) assert.equal((await api(`/api/artifacts/${fixtures[0]}/manage`,{method:'PATCH',cookie:owner.cookie,body:{title:`${prefix} revision ${i}`}})).status,200);
    const expiring=await api('/api/artifacts',{method:'POST',cookie:owner.cookie,body:{title:`${prefix} automatic expiry`,ttlSeconds:6,files:{'index.html':Buffer.from('<h1>Local expiry fixture</h1>').toString('base64')}}});
    assert.equal(expiring.status,201);fixtures.push(expiring.json.id);
    let expired=false;
    for(const until=Date.now()+30000;Date.now()<until;) {
      const response=await api('/api/admin/activity?kind=artifacts&limit=100&q='+encodeURIComponent(prefix),{cookie:owner.cookie});
      assert.equal(response.status,200);
      if(response.json.events.some(e=>e.action==='expired'&&e.artifactId===expiring.json.id)){expired=true;break;}
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.equal(expired,true,'automatic deletion is visible through the real Activity API');
    run('open',`${base}/?view=activity&q=${encodeURIComponent(prefix)}&kind=artifacts`);ready();
    assert.equal(evaluate('document.getElementById("filters").hidden'),false,'Activity search is discoverable');
    assert.equal(evaluate('document.getElementById("search").value'),prefix);
    assert.equal(evaluate('document.querySelector(".event-filter [aria-pressed=true]").textContent'),'Artifacts','a linked Activity URL restores its kind');
    const firstEvents=evaluate('document.querySelectorAll(".event").length');
    assert.equal(firstEvents,25,'Activity starts with a bounded batch');
    more();await runAsync('wait','--fn',`document.querySelectorAll('.event').length>${firstEvents}`);
    const expandedEvents=evaluate('document.querySelectorAll(".event").length');
    const text=evaluate('document.getElementById("content").textContent');
    assert.match(text,/published /,'publish entries name their action and artifact');
    assert.match(text,/deleted /,'delete entries are readable');
    assert.match(text,/rotated the comment link for /);
    assert.match(text,/set the expiration of /);
    assert.match(text,/removed the expiration of /);
    assert.match(text,/System.*expired /);
    assert.equal(evaluate('[...document.querySelectorAll(".event[data-action=delete],.event[data-action=expired]")].every(e=>!e.querySelector("a[href^=\\\"/v/\\\"]"))'),true,'permanently gone artifacts are not broken viewer links');
    assert.equal(evaluate('!!document.querySelector(".event[data-action=delete]")&&!!document.querySelector(".event[data-action=expired]")'),true,'both deletion paths are exercised');
    run('reload');ready();
    assert.equal(evaluate('document.querySelectorAll(".event").length'),expandedEvents,'refresh keeps the expanded search and kind');
    run('find','role','button','click','--name','People','--exact');ready();
    assert.equal(evaluate('document.getElementById("search").value'),prefix,'kind changes keep the existing search');
    assert.equal(evaluate('new URL(location.href).searchParams.get("kind")'),'people');
    assert.equal(evaluate('document.querySelectorAll(".event").length'),0,'kind and search compose instead of displaying unrelated people events');
    run('find','role','button','click','--name','Artifacts','--exact');ready();
    assert.equal(evaluate('document.querySelectorAll(".event").length'),25,'changing kind resets expanded pagination');
    // A historical response has no details field. Inject that public response
    // shape once; all sorting/search/deletion checks above use the real Worker.
    evaluate(`(()=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).startsWith('/api/admin/activity?')){window.fetch=original;const data=await response.json();data.events[0]={id:'legacy-ui-fixture',actorName:'Historical audit',action:'expiration',artifactId:${JSON.stringify(fixtures[0])},artifactTitle:${JSON.stringify(prefix)},createdAt:new Date().toISOString(),target:null};return new Response(JSON.stringify(data),{status:response.status,headers:{'Content-Type':'application/json'}})}return response}})()`);
    run('fill','#search',prefix);run('press','Enter');ready();
    const historical=evaluate('document.querySelector(".event[data-action=expiration]").textContent');
    assert.match(historical,/deadline not recorded/,'missing historical metadata is not presented as never expires');
    assert.doesNotMatch(historical,/removed the expiration/);
    run('reload');ready();
    evaluate(`(()=>{const original=window.fetch;window.fetch=(...args)=>{if(String(args[0]).startsWith('/api/admin/activity?')){window.fetch=original;return Promise.reject(new Error('Local Activity recovery fixture'))}return original(...args)}})()`);
    run('fill','#search',prefix);run('press','Enter');wait('#page-error:not([hidden])');
    assert.equal(evaluate('document.getElementById("search").value'),prefix);
    run('find','role','button','click','--name','Try again');ready();
    assert.equal(evaluate('document.getElementById("page-error").hidden'),true,'Activity fetch failure has a working retry path');
    assert.equal(evaluate('new URL(location.href).searchParams.get("kind")'),'artifacts','recovery preserves the selected kind');
    for(const width of [320,390,1280])for(const theme of ['light','dark']) {
      run('set','viewport',String(width),'1000');evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};window.scrollTo({top:0,behavior:'instant'})`);
      assert.equal(evaluate('document.documentElement.scrollWidth>innerWidth'),false,'Activity fits phone and desktop');
      if(width<=760) assert.ok(evaluate('[...document.querySelectorAll(".event-filter button")].every(e=>e.getBoundingClientRect().height>=44)'), 'phone Activity filters have 44px touch targets');
      run('screenshot',join(output,`activity-${theme}-${width}.png`));
    }
    run('fill','#search','No matching admin event');run('press','Enter');ready();
    assert.equal(evaluate('document.querySelectorAll(".event").length'),0);
    assert.ok(evaluate('document.getElementById("content").textContent.includes("No matching activity")'));
    click('#clear-filters');ready();
    assert.equal(evaluate('document.getElementById("search").value'),'');
    assert.equal(evaluate('document.querySelector(".event-filter [aria-pressed=true]").textContent'),'Everything');
  } catch(error) {
    failure=error;
    try {
      console.error('Admin browser state:',JSON.stringify(evaluate('({path:location.pathname+location.search,rows:document.querySelectorAll(".artifact-title").length,status:document.getElementById("result-status")?.textContent,error:document.getElementById("page-error")?.textContent,busy:document.getElementById("content")?.getAttribute("aria-busy"),moreDisabled:document.getElementById("more")?.disabled})')));
      run('screenshot',join(output,'admin-workflow-failure.png'));
    } catch { /* Keep the original assertion or command error. */ }
    throw error;
  }
  finally {
    let cleanupError;
    try { run('close'); } catch(error) { cleanupError=error; }
    for(const id of fixtures) {
      try { const response=await api(`/api/artifacts/${id}`,{method:'DELETE',cookie:owner.cookie});assert.ok([200,204,404].includes(response.status),'remove local admin fixture'); }
      catch(error) { cleanupError??=error; }
    }
    if(!failure&&cleanupError)throw cleanupError;
  }
}
