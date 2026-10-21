// Opt-in real Chromium QA, invoked by ACCOUNTS_BROWSER_QA=1 node --test
// test/accounts.test.mjs. Requires the agent-browser executable, not production
// dependencies. The account suite owns the isolated Wrangler lifecycle.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function browserQA({base,loginUrl,output,api,owner,browserOwner,member}) {
  mkdirSync(output,{recursive:true});
  const session='accounts-library-qa';
  const run=(...args)=>execFileSync('agent-browser',['--session',session,...args],{encoding:'utf8',timeout:45000,env:{...process.env,AGENT_BROWSER_IDLE_TIMEOUT_MS:'60000'}});
  const evaluate=source=> {
    const result=JSON.parse(run('--json','eval',source));
    assert.equal(result.success,true,JSON.stringify(result));
    return result.data.result;
  };
  const wait=selector=>run('wait',selector);
  const click=selector=>run('click',selector);
  const evidence=[],fixtures=[];
  try {
    for(let i=0;i<28;i++) {
      const r=await api('/api/artifacts',{method:'POST',cookie:owner.cookie,body:{title:i===0?'A very long artifact title '.repeat(10):`Browser pagination fixture ${i}`,ttlSeconds:null,files:{'index.html':Buffer.from('<h1>Local-only QA fixture</h1>').toString('base64')}}});
      assert.equal(r.status,201,r.text);fixtures.push(r.json.id);
    }
    await api(`/api/artifacts/${fixtures[0]}/star`,{method:'PUT',cookie:owner.cookie,body:{starred:true}});
    run('open',loginUrl);
    wait('#verify-button');
    assert.equal(evaluate('location.hash'),'','magic link is removed before confirmation');
    assert.equal((await api('/api/session')).json.user,null);
    click('#verify-button'); wait('#app:not([hidden])'); wait('.artifact-title');
    assert.equal(evaluate('document.getElementById("page-error").hidden'),true);
    run('set','viewport','390','844');
    run('open',base+'/?view=starred');wait('.artifact-title');
    const longTitle=evaluate(`(()=>{const e=document.querySelector('.artifact-title');return {height:e.getBoundingClientRect().height,wrap:getComputedStyle(e).whiteSpace,clipped:e.scrollWidth>e.clientWidth}})()`);
    assert.notEqual(longTitle.wrap,'nowrap','phone titles must wrap');
    assert.equal(longTitle.clipped,false,'long title must not be clipped');
    assert.ok(longTitle.height>=44,'opening target must be at least 44px');
    run('screenshot',join(output,'long-title-phone.png'));
    run('open',base+'/v/'+fixtures[0]);wait('#bar:not([hidden])');
    assert.equal(evaluate('document.getElementById("shareBtn").getAttribute("aria-label")'),'Share artifact');
    assert.equal(evaluate('document.getElementById("backLibrary")?.hidden'),false,'account viewer offers library navigation');
    click('#backLibrary');wait('#app:not([hidden])');
    // All navigation views, in both themes and three viewports. Read actual
    // computed layout rather than trusting source CSS.
    for (const width of [1440,768,390]) for (const theme of ['light','dark']) {
      run('set','viewport',String(width),width===390?'844':'1000');
      evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      for (const view of ['all','mine','shared','starred','admin','people','activity','credentials']) {
        run('open',base+'/?view='+view);
        wait('#app:not([hidden])');
        run('wait','[aria-busy="false"]');
        evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        const result=evaluate(`(()=>{
          const root=document.documentElement;
          const nav=document.getElementById('navigation');
          const allRows=[...document.querySelectorAll('.artifact-row,.artifact-summary')];
          const rows=allRows.filter(e=>!e.textContent.includes('A very long artifact title')).slice(0,4).map(e=>e.getBoundingClientRect().height);
          const targets=[...document.querySelectorAll('.artifact-title')].map(e=>e.getBoundingClientRect().height);
          const sample=document.querySelector('.artifact-meta,.muted');
          const cs=getComputedStyle(sample);
          function rgb(s){return s.match(/[\\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4})}
          function lum(s){const c=rgb(s);return c[0]*.2126+c[1]*.7152+c[2]*.0722}
          let bg=sample;while(bg.parentElement && getComputedStyle(bg).backgroundColor==='rgba(0, 0, 0, 0)')bg=bg.parentElement;
          const a=lum(cs.color),b=lum(getComputedStyle(bg).backgroundColor);
          return {view:${JSON.stringify(view)},width:${width},theme:${JSON.stringify(theme)},overflow:root.scrollWidth>innerWidth,nav:getComputedStyle(nav).display,headerHeight:document.querySelector('.sidebar').getBoundingClientRect().height,rows,targets,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),error:document.getElementById('page-error').hidden?null:document.getElementById('page-error').textContent};
        })()`);
        assert.equal(result.overflow,false,JSON.stringify(result));
        assert.equal(result.error,null,JSON.stringify(result));
        assert.ok(result.targets.every(h=>h>=44),JSON.stringify(result));
        assert.ok(result.contrast>=4.5,JSON.stringify(result));
        if(width===390) {assert.equal(result.nav,'none');assert.ok(result.headerHeight<=90,JSON.stringify(result));assert.ok(result.rows.every(h=>h>=72&&h<=88),JSON.stringify(result));}
        evidence.push(result);
        run('screenshot',join(output,`${view}-${theme}-${width}.png`));
      }
    }
    run('open',base+'/');wait('.artifact-title');
    assert.equal(evaluate('document.querySelectorAll(".artifact-title").length'),25);
    const firstPage=evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>new URL(e.href).pathname)');
    // Chromium pointer activation must use the post-scroll target coordinates.
    evaluate('document.getElementById("next").scrollIntoView({block:"center",behavior:"instant"})');
    click('#next');run('wait','--fn','document.getElementById("page-number").textContent==="Page 2"');run('wait','[aria-busy="false"]');
    const secondPage=evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>new URL(e.href).pathname)');
    assert.ok(secondPage.length>0 && secondPage.every(href=>!firstPage.includes(href)),'next page advances without duplicates');
    const secondPageUrl=evaluate('location.pathname+location.search');
    click('#content article:first-child .artifact-title');wait('#frame');click('#backLibrary');wait('.artifact-title');run('wait','[aria-busy="false"]');
    assert.equal(evaluate('location.pathname+location.search'),secondPageUrl,'Library returns to the same pagination cursor');
    assert.equal(evaluate('document.getElementById("page-number").textContent'),'Page 2');
    assert.deepEqual(evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>new URL(e.href).pathname)'),secondPage);
    evaluate('document.getElementById("previous").scrollIntoView({block:"center",behavior:"instant"})');
    click('#previous');run('wait','--fn','document.getElementById("page-number").textContent==="Page 1"');run('wait','[aria-busy="false"]');
    assert.deepEqual(evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>new URL(e.href).pathname)'),firstPage);
    run('fill','#search','very long artifact');run('press','Enter');run('wait','[aria-busy="false"]');
    run('wait','--fn','document.querySelectorAll(".artifact-title").length===1');
    const filteredUrl=evaluate('location.pathname+location.search');
    click('.artifact-title');wait('#frame');
    const filteredViewer=evaluate('location.pathname+location.search');
    click('#shareBtn');
    assert.equal(evaluate('document.getElementById("libraryLink").value'),base+filteredViewer.split('?')[0],'shared link excludes private browsing context');
    run('press','Escape');
    click('#backLibrary');wait('.artifact-title');run('wait','[aria-busy="false"]');
    assert.equal(evaluate('location.pathname+location.search'),filteredUrl,'Library preserves the filtered view');
    assert.equal(evaluate('document.getElementById("search").value'),'very long artifact');
    assert.equal(evaluate('document.querySelectorAll(".artifact-title").length'),1);
    click('.artifact-title');wait('#frame');run('back');wait('.artifact-title');
    assert.equal(evaluate('location.pathname+location.search'),filteredUrl,'browser Back preserves the filtered view');
    for(const unsafe of ['https://example.com/','//example.com/','javascript:alert(1)','/api/auth/logout']) {
      run('open',base+filteredViewer.split('?')[0]+'?returnTo='+encodeURIComponent(unsafe));wait('#frame');
      assert.equal(evaluate('document.getElementById("backLibrary").getAttribute("href")'),'/','return location stays on the library route');
    }
    // Publish using actual file chooser/form, including literal hostile title.
    run('set','viewport','390','844'); run('open',base+'/'); wait('.artifact-title');
    click('#page-action'); wait('#upload-file');
    const invalid=join(output,'not-html.txt');writeFileSync(invalid,'Not an HTML upload');
    run('upload','#upload-file',invalid);run('fill','#upload-title','Invalid upload');
    click('#dialog-body button[type=submit]');wait('#dialog-error:not([hidden])');
    assert.ok(evaluate('document.getElementById("dialog-error").textContent.includes("Choose an HTML file")'));
    assert.equal(evaluate('document.querySelector("#dialog-body button[type=submit]").disabled'),false);
    run('screenshot',join(output,'upload-error-phone.png'));
    const html=join(output,'upload.html');
    writeFileSync(html,'<!doctype html><h1>Browser upload verified</h1><script>window.fixtureLoaded=true</script>');
    run('upload','#upload-file',html);
    run('fill','#upload-title','<img src=x onerror=alert(1)> Browser upload');
    click('#dialog-body button[type=submit]'); run('wait','--fn','!document.getElementById("dialog").open'); run('wait','[aria-busy="false"]');
    assert.equal(evaluate('!!document.querySelector(".artifact-title img")'),false);
    const href=evaluate('[...document.querySelectorAll(".artifact-title")].find(e=>e.textContent.includes("Browser upload")).getAttribute("href")');
    const id=new URL(href,base).pathname.split('/').at(-1);
    const item=()=>evaluate(`[...document.querySelectorAll('.artifact-title')].find(e=>new URL(e.href).pathname===${JSON.stringify('/v/'+id)}).closest('article').querySelector('.artifact-menu').click()`);
    item(); wait('#dialog[open]');
    run('find','role','button','click','--name','Rename'); wait('#rename-title');
    run('fill','#rename-title','Browser renamed'); click('#dialog-body button[type=submit]'); run('wait','--fn','!document.getElementById("dialog").open'); run('wait','[aria-busy="false"]');
    item(); run('find','role','button','click','--name','Manage access'); wait('#share-person');
    const eligible=evaluate('document.getElementById("share-person").value'); assert.ok(eligible,'sharing selects an eligible account');
    run('select','#share-person',member.user.id);run('select','#share-permission','write');
    click('#dialog-body button[type=submit]');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    assert.equal((await api(`/api/artifacts/${id}/sharing`,{cookie:owner.cookie})).json.grants.length,1);
    item();run('find','role','button','click','--name','Star artifact');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    assert.ok((await api('/api/library?view=starred',{cookie:owner.cookie})).json.artifacts.some(a=>a.id===id));
    // Named write grantees get editing, never management or capability links.
    run('cookies','set','artifact_session',member.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    run('open',base+'/?view=shared');wait('.artifact-title');
    assert.equal(evaluate('[...document.querySelectorAll("[data-owner-only]")].every(e=>e.hidden)'),true);
    item();assert.equal(evaluate('[...document.querySelectorAll("#dialog-body button")].some(e=>e.textContent==="Manage access")'),false);
    click('#dialog-close');run('open',base+href);wait('#frame');
    assert.equal(evaluate('document.getElementById("deleteBtn").hidden'),true);
    assert.equal(evaluate('document.getElementById("role").textContent'),'Can edit');
    click('#shareBtn');assert.equal(evaluate('document.querySelectorAll("#readLink,#editLink,#cloneCmd").length'),0);
    run('screenshot',join(output,'named-editor-phone.png'));
    run('cookies','set','artifact_session',browserOwner.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    // Session viewer, sandbox execution, old history selection and restore.
    const before=await api(`/api/artifacts/${id}`,{cookie:owner.cookie});
    const changed=await api(`/api/artifacts/${id}`,{method:'PUT',cookie:owner.cookie,body:{parent:before.json.tip,message:'Browser history fixture',files:{'index.html':Buffer.from('<h1>Changed version</h1>').toString('base64')}}});
    assert.equal(changed.status,200,changed.text);
    run('open',base+href); wait('#frame');
    run('wait','#role');
    assert.equal(evaluate('document.getElementById("title").textContent'),'Browser renamed');
    assert.equal(evaluate('document.getElementById("deleteBtn").hidden'),false);
    assert.ok(evaluate('document.getElementById("frame").getAttribute("sandbox").includes("allow-scripts")'));
    click('#shareBtn');assert.ok(evaluate('document.getElementById("shareRows").textContent.includes("Only the owner")'));
    run('screenshot',join(output,'session-viewer-phone.png'));
    click('#versionBtn');run('click','#versionList .version:last-child');wait('#restoreBtn');
    assert.ok(evaluate('location.hash.startsWith("#@")'));
    click('#restoreBtn');run('wait','--fn','document.getElementById("oldStrip").hidden');
    const restored=await api(`/api/artifacts/${id}/files/index.html`,{cookie:owner.cookie});
    assert.ok(restored.text.includes('Browser upload verified'));
    // Credential one-time reveal and revoke through UI.
    run('open',base+'/?view=credentials');wait('#app:not([hidden])');run('wait','[aria-busy="false"]');
    click('#page-action');wait('#credential-name');run('fill','#credential-name','Browser credential');click('#dialog-body button[type=submit]');wait('.secret');
    assert.match(evaluate('document.querySelector(".secret").textContent'),/^[a-f0-9]{64}$/);
    assert.ok(evaluate('document.querySelector("#dialog-body .cli-guide code").textContent.includes("<your-personal-credential>")'));
    assert.equal(evaluate('document.querySelector("#dialog-body .cli-guide code").textContent.includes(document.querySelector(".secret").textContent)'),false,'setup example never embeds the credential');
    click('#dialog-close');assert.equal(evaluate('document.querySelector(".secret")'),null);
    run('wait','[aria-busy="false"]');
    evaluate('[...document.querySelectorAll(".record")].find(e=>e.textContent.includes("Browser credential")).querySelector("button").click()');
    wait('#dialog[open]');click('#dialog-body button[type=submit]');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    assert.ok(!(await api('/api/credentials',{cookie:owner.cookie})).json.credentials.some(c=>c.name==='Browser credential'));
    // Archive, find in instance inventory, restore, and explicit deletion.
    run('open',base+'/?view=mine');wait('.artifact-title');item();run('find','role','button','click','--name','Archive artifact');
    click('#dialog-body button[type=submit]');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    run('open',base+'/?view=admin&status=archived');wait('.artifact-title');item();run('find','role','button','click','--name','Restore to library');
    click('#dialog-body button[type=submit]');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    run('open',base+'/?view=mine');wait('.artifact-title');item();run('find','role','button','click','--name','Transfer ownership');wait('#transfer-owner');
    run('select','#transfer-owner',member.user.id);run('check','#transfer-confirm');click('#dialog-body button[type=submit]');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    const sharing=await api(`/api/artifacts/${id}/sharing`,{cookie:owner.cookie});assert.equal(sharing.json.ownerId,member.user.id);assert.equal(sharing.json.grants.length,0);
    run('cookies','set','artifact_session',member.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    run('open',base+'/?view=mine');wait('.artifact-title');item();run('find','role','button','click','--name','Archive artifact');
    click('#dialog-body button[type=submit]');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    run('open',base+'/?view=archived');wait('.artifact-title');item();run('find','role','button','click','--name','Restore to library');
    click('#dialog-body button[type=submit]');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    assert.ok((await api('/api/library?view=mine',{cookie:member.cookie})).json.artifacts.some(a=>a.id===id),'member restores without instance administration');
    run('cookies','set','artifact_session',browserOwner.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    run('open',base+'/?view=admin');wait('.artifact-title');item();run('find','role','button','click','--name','Manage access');wait('#share-person');
    assert.equal(evaluate('[...document.querySelectorAll("#share-person option")].some(e=>e.value==="instance-owner")'),false,'instance owner has fixed administrative access');
    run('screenshot',join(output,'member-artifact-access-phone.png'));click('#dialog-close');
    item();run('find','role','button','click','--name','Delete artifact…');wait('#delete-confirm');
    run('fill','#delete-confirm','DELETE');click('#dialog-body button[type=submit]');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    assert.equal((await api(`/api/artifacts/${id}`,{cookie:owner.cookie})).status,404);
    run('open',base+'/?view=people');wait('#page-action');click('#page-action');wait('#invite-email');
    run('fill','#invite-email','browser-invitation@example.com');run('fill','#invite-name','Browser invitation');click('#dialog-body button[type=submit]');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    evaluate('[...document.querySelectorAll(".record")].find(e=>e.textContent.includes("browser-invitation@example.com")).querySelector(".record-actions button:last-child").click()');
    wait('#dialog[open]');click('#dialog-body button[type=submit]');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    assert.ok((await api('/api/people',{cookie:owner.cookie})).json.users.some(u=>u.email==='browser-invitation@example.com'&&u.status==='disabled'));
    // A failed library fetch offers recovery without dropping the signed-in user.
    evaluate(`(()=>{const original=window.fetch;window.fetch=(...args)=>{if(String(args[0]).startsWith('/api/library')){window.fetch=original;return Promise.reject(new Error('Local test connection failure'))}return original(...args)}})()`);
    click('#nav-toggle');wait('#navigation');click('[data-view="all"]');wait('#page-error:not([hidden])');
    assert.ok(evaluate('document.getElementById("page-error").textContent.includes("Local test connection failure")'));
    run('find','role','button','click','--name','Try again');wait('.artifact-title');
    assert.equal(evaluate('document.getElementById("page-error").hidden'),true);
    click('#nav-toggle');wait('#navigation');click('#logout');wait('#login:not([hidden])');
    assert.equal(evaluate('document.querySelectorAll(".artifact-title").length'),0);
    run('open',base+'/login#token='+'0'.repeat(64));wait('#verify-button');click('#verify-button');wait('#login-feedback:not([hidden])');
    assert.ok(evaluate('document.getElementById("login-feedback").textContent.includes("request a fresh sign-in link")'));
    run('screenshot',join(output,'invalid-login-phone.png'));
    click('#different-email');wait('#login-email');run('fill','#login-email','unknown-browser@example.com');click('#login-form button[type=submit]');wait('#login-feedback:not([hidden])');
    assert.ok(evaluate('document.getElementById("login-feedback").textContent.includes("invited account")'));
    writeFileSync(join(output,'layout-evidence.json'),JSON.stringify(evidence,null,2));
    return {permutations:evidence.length,output};
  } finally {
    try {run('close');} finally {
      for(const id of fixtures) await api(`/api/artifacts/${id}`,{method:'DELETE',cookie:owner.cookie});
    }
  }
}
