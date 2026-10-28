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
  let failure;
  const selectQA=()=>{
    const selects=evaluate(`Array.from(document.querySelectorAll('select'),e=>{
      const s=getComputedStyle(e),c=document.createElement('canvas').getContext('2d');c.font=s.font;
      return {name:e.id||e.getAttribute('aria-label'),padding:parseFloat(s.paddingInlineEnd),checkLabel:e.getClientRects().length>0&&e.matches('.toolbar select,.grant select'),label:c.measureText(e.selectedOptions[0]?.textContent||'').width,available:e.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)};
    })`);
    assert.ok(selects.length,'exercise real application selects');
    for(const select of selects) {
      assert.ok(select.padding>=32,`${select.name}: reserve space between selected text and the inset caret (${select.padding}px)`);
      if(select.checkLabel) assert.ok(select.label<=select.available+1,`${select.name}: selected label fits without clipping (${select.label}px in ${select.available}px)`);
    }
  };
  const dialogSelectQA=name=>{
    for(const width of [1440,390]) for(const theme of ['light','dark']) {
      run('set','viewport',String(width),'1000');
      evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      selectQA();
      run('screenshot',join(output,`selects-${name}-${theme}-${width}.png`));
    }
  };
  try {
    for(let i=0;i<28;i++) {
      const r=await api('/api/artifacts',{method:'POST',cookie:owner.cookie,body:{icon:i===0?'chart':'document',title:i===0?'A very long artifact title '.repeat(10):`Browser pagination fixture ${i}`,ttlSeconds:null,files:{'index.html':Buffer.from('<h1>Local-only QA fixture</h1>').toString('base64')}}});
      assert.equal(r.status,201,r.text);fixtures.push(r.json.id);
    }
    await api(`/api/artifacts/${fixtures[0]}/star`,{method:'PUT',cookie:owner.cookie,body:{starred:true}});
    run('open',loginUrl);
    wait('#verify-button');
    assert.equal(evaluate('location.hash'),'','magic link is removed before confirmation');
    assert.equal((await api('/api/session')).json.user,null);
    click('#verify-button'); wait('#app:not([hidden])'); wait('.artifact-title');
    assert.equal(evaluate('document.getElementById("page-error").hidden'),true);
    for(const width of [1440,390,320]) for(const theme of ['light','dark']) {
      run('set','viewport',String(width),'1000');
      evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      click('#content article:first-child .artifact-menu');
      run('find','role','button','click','--name','Delete artifact…');wait('#delete-confirm');
      assert.equal(evaluate('document.activeElement.textContent'),'Cancel','deletion starts with the safe Cancel action focused');
      const unfocused=evaluate('getComputedStyle(document.getElementById("delete-confirm")).borderColor');
      run('press','Shift+Tab');
      assert.equal(evaluate('document.activeElement.id'),'delete-confirm','confirmation input is keyboard reachable');
      run('fill','#delete-confirm','DELETE');
      const layout=evaluate(`(()=>{const input=document.getElementById('delete-confirm'),actions=document.querySelector('#dialog-body .actions'),dialog=document.getElementById('dialog'),s=getComputedStyle(input);return {outline:s.outlineStyle,border:s.borderColor,gap:actions.getBoundingClientRect().top-input.getBoundingClientRect().bottom,overflow:dialog.scrollWidth>dialog.clientWidth||document.documentElement.scrollWidth>innerWidth}})()`);
      assert.equal(layout.outline,'none','input uses its border rather than an oversized outside focus ring');
      assert.notEqual(layout.border,unfocused,'focused input still has a visible focus indicator');
      assert.ok(layout.gap>=16,`actions are separated from the confirmation input (${layout.gap}px)`);
      assert.equal(layout.overflow,false,'delete dialog fits desktop and phone widths');
      run('screenshot',join(output,`delete-dialog-${theme}-${width}.png`));
      run('find','role','button','click','--name','Cancel');
      run('wait','--fn','!document.getElementById("dialog").open');
      assert.equal(evaluate('document.activeElement.matches(".artifact-menu")'),true,'Cancel returns focus to the triggering artifact');
    }
    const { parityQA } = await import('./parity-browser.mjs');
    await parityQA({base,api,owner,browserOwner,member,run,evaluate,wait,click,output,selectQA});
    run('set','viewport','390','844');
    run('open',base+'/?view=starred');wait('.artifact-title');
    for (const width of [1440,390]) for (const theme of ['light','dark']) for (const layout of ['grid','list']) {
      // Layout controls are intentionally hidden on phones; choose the preference on desktop first.
      run('set','viewport','1440','1000');
      click(`[data-layout="${layout}"]`);
      run('set','viewport',String(width),width===390?'844':'1000');
      evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      wait('.artifact-title .artifact-icon svg');
      const icon=evaluate(`(()=>{const e=document.querySelector('.artifact-title .artifact-icon');const s=e.querySelector('svg');return {hidden:e.getAttribute('aria-hidden'),path:s.querySelector('path').getAttribute('d'),wrapperWidth:e.getBoundingClientRect().width,width:s.getBoundingClientRect().width,color:getComputedStyle(s).stroke,layout:document.querySelector('.artifact-grid')?'grid':'list'}})()`);
      assert.equal(icon.hidden,'true');assert.match(icon.path,/M4 3v17/);assert.ok(icon.width>=14,JSON.stringify(icon));assert.ok(icon.wrapperWidth>=14,JSON.stringify(icon));assert.notEqual(icon.color,'none');assert.equal(icon.layout,layout);
      run('screenshot',join(output,`artifact-icon-${width}-${theme}-${layout}.png`));
    }
    run('set','viewport','1440','1000');
    click('[data-layout="grid"]');
    run('set','viewport','390','844');
    evaluate('document.documentElement.dataset.theme="light"');
    const longTitle=evaluate(`(()=>{const e=document.querySelector('.artifact-title');return {height:e.getBoundingClientRect().height,wrap:getComputedStyle(e).whiteSpace,clipped:e.scrollWidth>e.clientWidth}})()`);
    assert.notEqual(longTitle.wrap,'nowrap','phone titles must wrap');
    assert.equal(longTitle.clipped,false,'long title must not be clipped');
    assert.ok(longTitle.height>=44,'opening target must be at least 44px');
    run('screenshot',join(output,'long-title-phone.png'));
    run('open',base+'/v/'+fixtures[0]);wait('#bar:not([hidden])');
    const favicon=evaluate(`(()=>{const e=document.querySelector('link[rel="icon"]');return {type:e.type,svg:decodeURIComponent(e.href.split(',')[1])}})()`);
    assert.equal(favicon.type,'image/svg+xml');assert.match(favicon.svg,/M4 3v17/);assert.match(favicon.svg,/prefers-color-scheme:dark/);
    run('screenshot',join(output,'artifact-icon-viewer.png'));
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
        selectQA();
        run('screenshot',join(output,`${view}-${theme}-${width}.png`));
      }
    }
    run('open',base+'/?sort=name');wait('.artifact-title');
    assert.equal(evaluate('document.getElementById("sort").value'),'name');
    const sortedTitles=evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>e.textContent.replace(/^★/,"").toLowerCase())');
    assert.deepEqual(sortedTitles,[...sortedTitles].sort());
    assert.equal(evaluate('document.querySelectorAll(".artifact-title").length'),25);
    const firstPage=evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>new URL(e.href).pathname)');
    // Chromium pointer activation must use the post-scroll target coordinates.
    evaluate('document.getElementById("next").scrollIntoView({block:"center",behavior:"instant"})');
    click('#next');run('wait','--fn','document.getElementById("page-number").textContent==="Page 2"');run('wait','[aria-busy="false"]');
    const secondPage=evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>new URL(e.href).pathname)');
    assert.ok(secondPage.length>0 && secondPage.every(href=>!firstPage.includes(href)),'next page advances without duplicates');
    const secondPageUrl=evaluate('location.pathname+location.search');
    click('#content article:first-child .artifact-title');wait('#bar:not([hidden])');click('#backLibrary');wait('.artifact-title');run('wait','[aria-busy="false"]');
    assert.equal(evaluate('location.pathname+location.search'),secondPageUrl,'Library returns to the same pagination cursor');
    assert.equal(evaluate('document.getElementById("page-number").textContent'),'Page 2');
    assert.deepEqual(evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>new URL(e.href).pathname)'),secondPage);
    evaluate('document.getElementById("previous").scrollIntoView({block:"center",behavior:"instant"})');
    click('#previous');run('wait','--fn','document.getElementById("page-number").textContent==="Page 1"');run('wait','[aria-busy="false"]');
    assert.deepEqual(evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>new URL(e.href).pathname)'),firstPage);
    run('fill','#search','very long artifact');run('press','Enter');run('wait','[aria-busy="false"]');
    run('wait','--fn','document.querySelectorAll(".artifact-title").length===1');
    const filteredUrl=evaluate('location.pathname+location.search');
    click('.artifact-title');wait('#bar:not([hidden])');
    const filteredViewer=evaluate('location.pathname+location.search');
    click('#shareBtn');
    assert.equal(evaluate('document.getElementById("libraryLink").value'),base+filteredViewer.split('?')[0],'shared link excludes private browsing context');
    run('press','Escape');
    click('#backLibrary');wait('.artifact-title');run('wait','[aria-busy="false"]');
    assert.equal(evaluate('location.pathname+location.search'),filteredUrl,'Library preserves the filtered view');
    assert.equal(evaluate('document.getElementById("search").value'),'very long artifact');
    assert.equal(evaluate('document.querySelectorAll(".artifact-title").length'),1);
    click('.artifact-title');wait('#bar:not([hidden])');run('back');wait('.artifact-title');
    assert.equal(evaluate('location.pathname+location.search'),filteredUrl,'browser Back preserves the filtered view');
    for(const unsafe of ['https://example.com/','//example.com/','javascript:alert(1)','/api/auth/logout']) {
      run('open',base+filteredViewer.split('?')[0]+'?returnTo='+encodeURIComponent(unsafe));wait('#bar:not([hidden])');
      assert.equal(evaluate('document.getElementById("backLibrary").getAttribute("href")'),'/','return location stays on the library route');
    }
    // Publish using actual file chooser/form, including literal hostile title.
    run('set','viewport','390','844'); run('open',base+'/'); wait('.artifact-title');
    click('#page-action'); wait('#upload-files');
    const invalid=join(output,'not-html.txt');writeFileSync(invalid,'Not an HTML upload');
    run('upload','#upload-files',invalid);run('fill','#upload-title','Invalid upload');
    click('#dialog-body button[type=submit]');wait('#dialog-error:not([hidden])');
    assert.ok(evaluate('document.getElementById("dialog-error").textContent.includes("Choose an HTML page")'));
    assert.equal(evaluate('document.querySelector("#dialog-body button[type=submit]").disabled'),false);
    run('screenshot',join(output,'upload-error-phone.png'));
    const html=join(output,'upload.html');
    writeFileSync(html,'<!doctype html><h1>Browser upload verified</h1><script>window.fixtureLoaded=true</script>');
    run('upload','#upload-files',html);
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
    dialogSelectQA('add-access');
    const eligible=evaluate('document.getElementById("share-person").value'); assert.ok(eligible,'sharing selects an eligible account');
    run('select','#share-person',member.user.id);run('select','#share-permission','write');
    click('#dialog-body button[type=submit]');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    assert.equal((await api(`/api/artifacts/${id}/sharing`,{cookie:owner.cookie})).json.grants.length,1);
    item();run('find','role','button','click','--name','Manage access');wait('.grant select');
    dialogSelectQA('existing-access');click('#dialog-close');
    item();run('find','role','button','click','--name','Star artifact');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    assert.ok((await api('/api/library?view=starred',{cookie:owner.cookie})).json.artifacts.some(a=>a.id===id));
    // Named write grantees get editing, never management or capability links.
    run('cookies','set','artifact_session',member.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    run('open',base+'/?view=shared');wait('.artifact-title');
    assert.equal(evaluate('[...document.querySelectorAll("[data-owner-only]")].every(e=>e.hidden)'),true);
    item();assert.equal(evaluate('[...document.querySelectorAll("#dialog-body button")].some(e=>e.textContent==="Manage access")'),false);
    click('#dialog-close');run('open',base+href);wait('#bar:not([hidden])');
    assert.equal(evaluate('document.getElementById("deleteBtn").hidden'),true);
    assert.equal(evaluate('document.getElementById("role").textContent'),'Can edit');
    click('#shareBtn');assert.equal(evaluate('document.querySelectorAll("#readLink,#editLink,#cloneCmd").length'),0);
    run('screenshot',join(output,'named-editor-phone.png'));
    run('cookies','set','artifact_session',browserOwner.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    // Session viewer, sandbox execution, old history selection and restore.
    const before=await api(`/api/artifacts/${id}`,{cookie:owner.cookie});
    const changed=await api(`/api/artifacts/${id}`,{method:'PUT',cookie:owner.cookie,body:{parent:before.json.tip,message:'Browser history fixture',files:{'index.html':Buffer.from('<h1>Changed version</h1>').toString('base64')}}});
    assert.equal(changed.status,200,changed.text);
    run('open',base+href); wait('#bar:not([hidden])');
    click('#titleBtn');wait('#role');
    assert.equal(evaluate('document.getElementById("title").textContent'),'Browser renamed');
    assert.equal(evaluate('document.getElementById("deleteBtn").hidden'),false);
    assert.ok(evaluate('document.getElementById("frame").getAttribute("sandbox").includes("allow-scripts")'));
    click('#shareBtn');assert.ok(evaluate('document.getElementById("shareRows").textContent.includes("Only the owner")'));
    assert.ok(evaluate('document.getElementById("shareRows").textContent.includes("Comment link")'),'a signed-in editor can copy a comment link');
    assert.match(evaluate('document.getElementById("commentLink").value'),/\/v\/[^#]+#[0-9a-f]{64}$/);
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
    assert.ok(evaluate('document.getElementById("dialog-body").textContent.includes("You can restore it from Archived")'));
    click('#dialog-body button[type=submit]');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    run('open',base+'/?view=admin&status=archived');wait('.artifact-title');item();run('find','role','button','click','--name','Restore to library');
    click('#dialog-body button[type=submit]');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    run('open',base+'/?view=mine');wait('.artifact-title');item();run('find','role','button','click','--name','Transfer ownership');wait('#transfer-owner');
    dialogSelectQA('transfer');
    run('select','#transfer-owner',member.user.id);run('check','#transfer-confirm');click('#dialog-body button[type=submit]');run('wait','--fn','!document.getElementById("dialog").open');run('wait','[aria-busy="false"]');
    const sharing=await api(`/api/artifacts/${id}/sharing`,{cookie:owner.cookie});assert.equal(sharing.json.ownerId,member.user.id);assert.equal(sharing.json.grants.length,0);
    run('cookies','set','artifact_session',member.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    run('open',base+'/?view=mine');wait('.artifact-title');item();run('find','role','button','click','--name','Archive artifact');
    assert.ok(evaluate('document.getElementById("dialog-body").textContent.includes("You can restore it from Archived")'));
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
    const savedThemeBeforeLogout=evaluate('JSON.parse(localStorage.getItem("artifact-library-preferences")).theme');
    click('#nav-toggle');wait('#navigation');click('#logout');wait('#login:not([hidden])');
    assert.equal(evaluate('document.querySelectorAll(".artifact-title").length'),0);
    assert.equal(evaluate('document.documentElement.dataset.theme||null'),null,'logout restores system appearance');
    assert.equal(evaluate('JSON.parse(localStorage.getItem("artifact-library-preferences")).theme'),savedThemeBeforeLogout,'logout retains the in-app preference');
    run('open',base+'/login#token='+'0'.repeat(64));wait('#verify-button');click('#verify-button');wait('#login-feedback:not([hidden])');
    assert.ok(evaluate('document.getElementById("login-feedback").textContent.includes("request a fresh sign-in link")'));
    run('screenshot',join(output,'invalid-login-phone.png'));
    click('#different-email');wait('#login-email');run('fill','#login-email','unknown-browser@example.com');click('#login-form button[type=submit]');wait('#login-feedback:not([hidden])');
    assert.ok(evaluate('document.getElementById("login-feedback").textContent.includes("invited account")'));
    writeFileSync(join(output,'layout-evidence.json'),JSON.stringify(evidence,null,2));
    return {permutations:evidence.length,output};
  } catch (error) {
    failure=error;
    throw error;
  } finally {
    try {run('close');} catch (error) {
      if(failure) throw new AggregateError([failure,error],'Browser verification and cleanup failed');
      throw error;
    } finally {
      for(const id of fixtures) await api(`/api/artifacts/${id}`,{method:'DELETE',cookie:owner.cookie});
    }
  }
}
