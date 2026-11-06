// Opt-in real Chromium QA, invoked by ACCOUNTS_BROWSER_QA=1 node --test
// test/accounts.test.mjs. Requires the agent-browser executable, not production
// dependencies. The account suite owns the isolated Wrangler lifecycle.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const execFileAsync=promisify(execFile);

// The expiration flow on its own, so it can run without the navigation matrix.
// `artifact` names the artifact and the session that may manage it.
export async function expirationQA({base,api,run,evaluate,wait,click,output,artifact}) {
  mkdirSync(output,{recursive:true});
  await run('cookies','set','artifact_session',artifact.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
  await run('set','viewport','390','844');
  await run('open',base+'/?view=mine');await wait('.artifact-title');
  const item=async ()=>await evaluate(`[...document.querySelectorAll('.artifact-title')].find(e=>new URL(e.href).pathname===${JSON.stringify('/v/'+artifact.id)}).closest('article').querySelector('.artifact-menu').click()`);
  const expiresAt=async()=>(await api(`/api/artifacts/${artifact.id}`,{cookie:artifact.cookie})).json.expiresAt;
  await item();await run('find','role','button','click','--name','Expiration');await wait('#expiration-mode');
  assert.equal(await evaluate('document.getElementById("expiration-mode").value'),'never','an artifact that does not expire starts at Never expires');
  assert.equal(await evaluate('document.getElementById("expiration-date-field").hidden'),true,'the whole date field is hidden until a date is chosen');
  assert.equal(await evaluate('[...document.querySelectorAll("#dialog-body label")].some(l=>l.textContent==="Date and time"&&l.getClientRects().length>0)'),false,'Never leaves no orphaned "Date and time" label');
  // A whole-second instant: the dialog must prefills and resave it unchanged.
  const future=new Date(Math.floor((Date.now()+3600_000)/1000)*1000+17);
  const pad=n=>String(n).padStart(2,'0');
  const localValue=`${future.getFullYear()}-${pad(future.getMonth()+1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}:${pad(future.getSeconds())}`;
  assert.ok(await evaluate('document.getElementById("expiration-zone").textContent.includes(Intl.DateTimeFormat().resolvedOptions().timeZone)'),'the dialog names the timezone it uses');
  // agent-browser's fill cannot write a datetime-local control, so set it the
  // way a picker does: through the native setter, then fire input and change.
  const setDate=async value=>await evaluate(`(()=>{const e=document.getElementById('expiration-date');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return e.value})()`);
  await run('select','#expiration-mode','date');await wait('#expiration-date-field:not([hidden])');
  assert.equal(await setDate(localValue),localValue,'the date field takes the chosen local time');
  const capture=async name=>{
    for(const width of [390,320]) for(const theme of ['light','dark']) {
      await run('set','viewport',String(width),'1000');
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await run('screenshot',join(output,`expiration-${name}-${theme}-${width}.png`));
    }
    await run('set','viewport','390','844');
  };
  await capture('date');
  await run('select','#expiration-mode','never');await run('wait','--fn','document.getElementById("expiration-date-field").hidden');
  assert.equal(await evaluate('[...document.querySelectorAll("#dialog-body label")].some(l=>l.textContent==="Date and time"&&l.getClientRects().length>0)'),false,'Never leaves no orphaned "Date and time" label');
  await capture('never');
  await run('select','#expiration-mode','date');await wait('#expiration-date-field:not([hidden])');
  await setDate(localValue);
  await click('#dialog-body button[type=submit]');await run('wait','--fn','!document.getElementById("dialog").open');await run('wait','[aria-busy="false"]');
  assert.equal(Date.parse(await expiresAt()),new Date(localValue).getTime(),'the saved expiration is the chosen local instant, in UTC');
  await item();await run('find','role','button','click','--name','Expiration');await wait('#expiration-mode');
  assert.equal(await evaluate('document.getElementById("expiration-date").value'),localValue,'the dialog prefills the stored expiration');
  assert.equal(await evaluate('document.getElementById("expiration-mode").value'),'date');
  assert.equal(await evaluate('document.getElementById("expiration-date").step'),'1','the field accepts whole seconds');
  await capture('prefilled');
  const stored=await expiresAt();
  await click('#dialog-body button[type=submit]');await run('wait','--fn','!document.getElementById("dialog").open');await run('wait','[aria-busy="false"]');
  assert.equal(await expiresAt(),stored,'saving a prefilled value unchanged keeps the exact instant');
  await item();await run('find','role','button','click','--name','Expiration');await wait('#expiration-mode');
  await run('select','#expiration-mode','never');await click('#dialog-body button[type=submit]');await run('wait','--fn','!document.getElementById("dialog").open');await run('wait','[aria-busy="false"]');
  assert.equal(await expiresAt(),null,'Never expires clears the expiration');
  await item();await run('find','role','button','click','--name','Expiration');await wait('#expiration-mode');
  await run('select','#expiration-mode','date');await wait('#expiration-date-field:not([hidden])');
  await setDate('2000-01-01T00:00');await click('#dialog-body button[type=submit]');await wait('#dialog-error:not([hidden])');
  assert.ok(await evaluate('document.getElementById("dialog-error").textContent.includes("future")'),'a past date says what is wrong');
  assert.equal(await evaluate('document.getElementById("dialog").open'),true,'a rejected date keeps the dialog open for correction');
  await run('press','Escape');
  // A 202 from this PATCH means the deadline is durable but the library has not
  // caught up. Intercepted locally: the real request never leaves the browser.
  await item();await run('find','role','button','click','--name','Expiration');await wait('#expiration-mode');
  const pendingText=await evaluate(`(()=>{
    const real=window.fetch;
    window.__realFetch=real;
    window.fetch=(url,opts)=>String(url).endsWith('/manage')&&opts?.method==='PATCH'
      ? Promise.resolve(new Response(JSON.stringify({ok:true,expirationPending:true}),{status:202,headers:{'Content-Type':'application/json'}}))
      : real(url,opts);
    return true;
  })()`);
  assert.equal(pendingText,true,'the pending-response interceptor installed');
  await run('select','#expiration-mode','date');await wait('#expiration-date-field:not([hidden])');
  await setDate(localValue);await click('#dialog-body button[type=submit]');
  await run('wait','--fn','!document.getElementById("dialog").open');
  const toast=async ()=>await evaluate('document.getElementById("toast").textContent');
  assert.match(await toast(),/still updating/,'a pending update is not reported as saved');
  assert.ok(!/Expiration (saved|cleared)/.test(await toast()),'no confirmed message appears while the projection is pending');
  assert.equal(await expiresAt(),null,'the intercepted request changed nothing in the library');
  await evaluate('window.fetch=window.__realFetch||window.fetch');
  await run('open',base+'/?view=mine');await wait('.artifact-title');
}


// The agent-browser primitives, usable without the full matrix so a single flow
// (expiration) can run on its own.
export function browserDriver(session='accounts-library-qa', {asyncCommands=false}={}) {
  // Awaited commands leave the fixture event loop free to drain Wrangler/proxy
  // pipes while Chromium waits on HTTP or queued browser events.
  const runAsync=async(...args)=>(await execFileAsync('agent-browser',['--session',session,...args],{encoding:'utf8',timeout:45000,env:{...process.env,AGENT_BROWSER_IDLE_TIMEOUT_MS:'60000'}})).stdout;
  const run=asyncCommands ? runAsync : (...args)=>execFileSync('agent-browser',['--session',session,...args],{encoding:'utf8',timeout:45000,env:{...process.env,AGENT_BROWSER_IDLE_TIMEOUT_MS:'60000'}});
  const result=raw=> {
    const response=JSON.parse(raw);
    assert.equal(response.success,true,JSON.stringify(response));
    return response.data.result;
  };
  const evaluate=asyncCommands
    ? async source=>result(await run('--json','eval',source))
    : source=>result(run('--json','eval',source));
  return {run,runAsync,evaluate,wait:selector=>run('wait',selector),click:selector=>run('click',selector)};
}

export async function browserQA({base,loginUrl,output,api,owner,browserOwner,member}) {
  mkdirSync(output,{recursive:true});
  const {run,runAsync,evaluate,wait,click}=browserDriver('accounts-library-qa',{asyncCommands:true});
  const evidence=[],fixtures=[];
  let failure;
  const selectQA=async ()=>{
    const selects=await evaluate(`Array.from(document.querySelectorAll('select'),e=>{
      const s=getComputedStyle(e),c=document.createElement('canvas').getContext('2d');c.font=s.font;
      return {name:e.id||e.getAttribute('aria-label'),padding:parseFloat(s.paddingInlineEnd),checkLabel:e.getClientRects().length>0&&e.matches('.toolbar select,.grant select'),label:c.measureText(e.selectedOptions[0]?.textContent||'').width,available:e.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)};
    })`);
    assert.ok(selects.length,'exercise real application selects');
    for(const select of selects) {
      assert.ok(select.padding>=32,`${select.name}: reserve space between selected text and the inset caret (${select.padding}px)`);
      if(select.checkLabel) assert.ok(select.label<=select.available+1,`${select.name}: selected label fits without clipping (${select.label}px in ${select.available}px)`);
    }
  };
  const dialogSelectQA=async name=>{
    for(const width of [1440,390]) for(const theme of ['light','dark']) {
      await run('set','viewport',String(width),'1000');
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await selectQA();
      await run('screenshot',join(output,`selects-${name}-${theme}-${width}.png`));
    }
  };
  try {
    for(let i=0;i<28;i++) {
      const r=await api('/api/artifacts',{method:'POST',cookie:owner.cookie,body:{icon:i===0?'chart':'document',title:i===0?'A very long artifact title '.repeat(10):`Browser pagination fixture ${i}`,ttlSeconds:null,files:{'index.html':Buffer.from('<h1>Local-only QA fixture</h1>').toString('base64')}}});
      assert.equal(r.status,201,r.text);fixtures.push(r.json.id);
    }
    await api(`/api/artifacts/${fixtures[0]}/star`,{method:'PUT',cookie:owner.cookie,body:{starred:true}});
    await run('open',loginUrl);
    await wait('#verify-button');
    assert.equal(await evaluate('location.hash'),'','magic link is removed before confirmation');
    assert.equal((await api('/api/session')).json.user,null);
    await click('#verify-button'); await wait('#app:not([hidden])'); await wait('.artifact-title');
    assert.equal(await evaluate('document.getElementById("page-error").hidden'),true);
    for(const width of [1440,390,320]) for(const theme of ['light','dark']) {
      await run('set','viewport',String(width),'1000');
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await click('#content article:first-child .artifact-menu');
      await run('find','role','button','click','--name','Delete artifact…');await wait('#delete-confirm');
      assert.equal(await evaluate('document.activeElement.textContent'),'Cancel','deletion starts with the safe Cancel action focused');
      const unfocused=await evaluate('getComputedStyle(document.getElementById("delete-confirm")).borderColor');
      await run('press','Shift+Tab');
      assert.equal(await evaluate('document.activeElement.id'),'delete-confirm','confirmation input is keyboard reachable');
      await run('fill','#delete-confirm','DELETE');
      const layout=await evaluate(`(()=>{const input=document.getElementById('delete-confirm'),actions=document.querySelector('#dialog-body .actions'),dialog=document.getElementById('dialog'),s=getComputedStyle(input);return {outline:s.outlineStyle,border:s.borderColor,gap:actions.getBoundingClientRect().top-input.getBoundingClientRect().bottom,overflow:dialog.scrollWidth>dialog.clientWidth||document.documentElement.scrollWidth>innerWidth}})()`);
      assert.equal(layout.outline,'none','input uses its border rather than an oversized outside focus ring');
      assert.notEqual(layout.border,unfocused,'focused input still has a visible focus indicator');
      assert.ok(layout.gap>=16,`actions are separated from the confirmation input (${layout.gap}px)`);
      assert.equal(layout.overflow,false,'delete dialog fits desktop and phone widths');
      await run('screenshot',join(output,`delete-dialog-${theme}-${width}.png`));
      await run('find','role','button','click','--name','Cancel');
      await run('wait','--fn','!document.getElementById("dialog").open');
      assert.equal(await evaluate('document.activeElement.matches(".artifact-menu")'),true,'Cancel returns focus to the triggering artifact');
    }
    const { parityQA } = await import('./parity-browser.mjs');
    // parityQA awaits every browser command so Node keeps draining the
    // Wrangler pipes while the browser waits on the page.
    await parityQA({base,api,owner,browserOwner,member,runAsync,evaluate,output,selectQA});
    await run('set','viewport','390','844');
    await run('open',base+'/?view=starred');await wait('.artifact-title');
    for (const width of [1440,390]) for (const theme of ['light','dark']) for (const layout of ['grid','list']) {
      // Layout controls are intentionally hidden on phones; choose the preference on desktop first.
      await run('set','viewport','1440','1000');
      await click(`[data-layout="${layout}"]`);
      await run('set','viewport',String(width),width===390?'844':'1000');
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await run('wait','[aria-busy="false"]');
      await wait('.artifact-title .artifact-icon svg');
      const icon=await evaluate(`(()=>{const e=document.querySelector('.artifact-title .artifact-icon');const s=e.querySelector('svg');return {hidden:e.getAttribute('aria-hidden'),path:s.querySelector('path').getAttribute('d'),wrapperWidth:e.getBoundingClientRect().width,width:s.getBoundingClientRect().width,color:getComputedStyle(s).stroke,layout:document.querySelector('.artifact-grid')?'grid':'list'}})()`);
      assert.equal(icon.hidden,'true');assert.match(icon.path,/M4 3v17/);assert.ok(icon.width>=14,JSON.stringify(icon));assert.ok(icon.wrapperWidth>=14,JSON.stringify(icon));assert.notEqual(icon.color,'none');assert.equal(icon.layout,layout);
      await run('screenshot',join(output,`artifact-icon-${width}-${theme}-${layout}.png`));
    }
    await run('set','viewport','1440','1000');
    await click('[data-layout="grid"]');
    await run('set','viewport','390','844');
    await evaluate('document.documentElement.dataset.theme="light"');
    const longTitle=await evaluate(`(()=>{const e=document.querySelector('.artifact-title');return {height:e.getBoundingClientRect().height,wrap:getComputedStyle(e).whiteSpace,clipped:e.scrollWidth>e.clientWidth}})()`);
    assert.notEqual(longTitle.wrap,'nowrap','phone titles must wrap');
    assert.equal(longTitle.clipped,false,'long title must not be clipped');
    assert.ok(longTitle.height>=44,'opening target must be at least 44px');
    await run('screenshot',join(output,'long-title-phone.png'));
    await run('open',base+'/v/'+fixtures[0]);await wait('#bar:not([hidden])');
    const favicon=await evaluate(`(()=>{const e=document.querySelector('link[rel="icon"]');return {type:e.type,svg:decodeURIComponent(e.href.split(',')[1])}})()`);
    assert.equal(favicon.type,'image/svg+xml');assert.match(favicon.svg,/M4 3v17/);assert.match(favicon.svg,/prefers-color-scheme:dark/);
    await run('screenshot',join(output,'artifact-icon-viewer.png'));
    assert.equal(await evaluate('document.getElementById("shareBtn").getAttribute("aria-label")'),'Share artifact');
    assert.equal(await evaluate('document.getElementById("backLibrary")?.hidden'),false,'account viewer offers library navigation');
    await click('#backLibrary');await wait('#app:not([hidden])');
    // All navigation views, in both themes and three viewports. Read actual
    // computed layout rather than trusting source CSS.
    for (const width of [1440,768,390]) for (const theme of ['light','dark']) {
      await run('set','viewport',String(width),width===390?'844':'1000');
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      for (const view of ['all','mine','shared','starred','admin','people','activity','credentials']) {
        await run('open',base+'/?view='+view);
        await wait('#app:not([hidden])');
        await run('wait','[aria-busy="false"]');
        await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
        const result=await evaluate(`(()=>{
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
        if(width===390) {assert.equal(result.nav,'none');assert.ok(result.headerHeight<=90,JSON.stringify(result));assert.ok(result.rows.every(h=>h>=44),JSON.stringify(result));}
        evidence.push(result);
        await selectQA();
        await run('screenshot',join(output,`${view}-${theme}-${width}.png`));
      }
    }
    await run('set','viewport','1440','1000');
    // Sidebar hierarchy: primary destinations first, administration named apart.
    await run('open',base+'/?view=mine');await wait('.artifact-title');
    const nav=await evaluate(`(()=>{const primary=[...document.querySelectorAll('.nav-primary .nav-button')].map(b=>({text:b.textContent.trim(),current:b.getAttribute('aria-current')}));const admin=[...document.querySelectorAll('.nav-admin .nav-button')].map(b=>b.textContent.trim());const scopes=[...document.querySelectorAll('#scopes [data-view]')].map(b=>b.textContent.trim());return {primary,admin,scopes,scopesVisible:!document.getElementById('scopes').hidden,archivedVisible:!document.getElementById('archived-link').hidden}})()`);
    assert.deepEqual(nav.primary.map(p=>p.text),['Library','Starred','Published links'],'the sidebar leads with three primary destinations');
    assert.equal(nav.primary[0].current,'page','the current library destination is marked');
    assert.deepEqual(nav.admin,['Inventory','People','Activity'],'owner-only administration is a named group');
    assert.deepEqual(nav.scopes,['All','Mine','Shared'],'scope lives with the list, not as six equal sidebar peers');
    assert.equal(nav.scopesVisible,true);assert.equal(nav.archivedVisible,true,'Archived stays easily reachable');
    // A scope switch is a filter on the current list: keep the search query.
    await run('fill','#search',`Browser pagination`);await run('press','Enter');await run('wait','[aria-busy="false"]');
    await click('#scopes [data-view="shared"]');await run('wait','[aria-busy="false"]');
    assert.equal(await evaluate('new URL(location.href).searchParams.get("view")'),'shared');
    assert.equal(await evaluate('document.getElementById("search").value'),'Browser pagination','scope changes keep the current search');
    await click('#archived-link');await run('wait','[aria-busy="false"]');
    assert.equal(await evaluate('new URL(location.href).searchParams.get("view")'),'archived','Archived is one click from the library');
    assert.equal(await evaluate('document.getElementById("archived-link").getAttribute("aria-pressed")'),'true');
    // A viewer Find link focuses the real search field and drops the fragment.
    await run('open',base+'/?view=all#search');await wait('#app:not([hidden])');await wait('[aria-busy="false"]');
    assert.equal(await evaluate('location.hash'),'','the search fragment is not left behind');
    assert.equal(await evaluate('document.activeElement.id'),'search','#search focuses the real search input');
    // Cmd/Ctrl+K is the same search, never a fake command surface.
    await evaluate('document.getElementById("search").blur()');
    await run('press','Meta+k');
    assert.equal(await evaluate('document.activeElement.id'),'search','Cmd/Ctrl+K focuses search');
    // It must not disturb an open dialog that may hold a one-time credential.
    await click('#content article:first-child .artifact-menu');await wait('#dialog[open]');
    await evaluate('document.getElementById("search").blur()');
    await run('press','Meta+k');
    assert.equal(await evaluate('document.getElementById("dialog").open'),true,'Cmd/Ctrl+K leaves modal editing alone');
    await run('press','Escape');await run('wait','--fn','!document.getElementById("dialog").open');
    // Recent links are real authorized artifacts, not samples.
    await run('open',base+'/?view=all');await wait('.artifact-title');await run('wait','[aria-busy="false"]');
    await run('wait','--fn','!document.getElementById("recent-group").hidden');
    const recent=await evaluate(`[...document.querySelectorAll('#recent-list a')].map(a=>({href:new URL(a.href).pathname,text:a.textContent.trim()}))`);
    assert.ok(recent.length>0&&recent.length<=3,'Recent shows at most three real artifacts');
    assert.ok(recent.every(r=>r.href.startsWith('/v/')),'Recent links point at real artifacts');
    await run('open',base+'/?sort=name');await wait('.artifact-title');
    assert.equal(await evaluate('document.getElementById("sort").value'),'name');
    const sortedTitles=await evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>e.textContent.replace(/^★/,"").toLowerCase())');
    assert.deepEqual(sortedTitles,[...sortedTitles].sort());
    assert.equal(await evaluate('document.querySelectorAll(".artifact-title").length'),12,'the first batch is 12');
    assert.match(await evaluate('document.getElementById("shown").textContent'),/^12 of \d+ shown$/);
    const firstBatch=await evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>new URL(e.href).pathname)');
    // Chromium pointer activation must use the post-scroll target coordinates.
    await evaluate('document.getElementById("more").scrollIntoView({block:"center",behavior:"instant"})');
    await click('#more');await run('wait','--fn','document.querySelectorAll(".artifact-title").length===24');
    const shown=await evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>new URL(e.href).pathname)');
    assert.deepEqual(shown.slice(0,12),firstBatch,'show more appends after the first batch');
    assert.equal(new Set(shown).size,24,'show more adds no duplicates');
    const shownUrl=await evaluate('location.pathname+location.search');
    assert.match(shownUrl,/[?&]n=24(&|$)/,'the URL records how many are shown');
    await click('#content article:first-child .artifact-title');await wait('#bar:not([hidden])');await click('#backLibrary');await wait('.artifact-title');await run('wait','[aria-busy="false"]');
    assert.equal(await evaluate('location.pathname+location.search'),shownUrl,'Library returns with the same batches shown');
    await run('wait','--fn','document.querySelectorAll(".artifact-title").length===24');
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>new URL(e.href).pathname)'),shown);
    await run('fill','#search','very long artifact');await run('press','Enter');await run('wait','[aria-busy="false"]');
    await run('wait','--fn','document.querySelectorAll(".artifact-title").length===1');
    const filteredUrl=await evaluate('location.pathname+location.search');
    await click('.artifact-title');await wait('#bar:not([hidden])');
    const filteredViewer=await evaluate('location.pathname+location.search');
    await click('#shareBtn');
    assert.equal(await evaluate('document.getElementById("libraryLink").value'),base+filteredViewer.split('?')[0],'shared link excludes private browsing context');
    await run('press','Escape');
    await click('#backLibrary');await wait('.artifact-title');await run('wait','[aria-busy="false"]');
    assert.equal(await evaluate('location.pathname+location.search'),filteredUrl,'Library preserves the filtered view');
    assert.equal(await evaluate('document.getElementById("search").value'),'very long artifact');
    assert.equal(await evaluate('document.querySelectorAll(".artifact-title").length'),1);
    await click('.artifact-title');await wait('#bar:not([hidden])');await run('back');await wait('.artifact-title');
    assert.equal(await evaluate('location.pathname+location.search'),filteredUrl,'browser Back preserves the filtered view');
    for(const unsafe of ['https://example.com/','//example.com/','javascript:alert(1)','/api/auth/logout']) {
      await run('open',base+filteredViewer.split('?')[0]+'?returnTo='+encodeURIComponent(unsafe));await wait('#bar:not([hidden])');
      assert.equal(await evaluate('document.getElementById("backLibrary").getAttribute("href")'),'/','return location stays on the library route');
    }
    // Publish using actual file chooser/form, including literal hostile title.
    await run('set','viewport','390','844'); await run('open',base+'/'); await wait('.artifact-title');
    await click('#page-action'); await wait('#upload-files');
    const invalid=join(output,'not-html.txt');writeFileSync(invalid,'Not an HTML upload');
    await run('upload','#upload-files',invalid);await run('fill','#upload-title','Invalid upload');
    await click('#dialog-body button[type=submit]');await wait('#dialog-error:not([hidden])');
    assert.ok(await evaluate('document.getElementById("dialog-error").textContent.includes("Choose an HTML page")'));
    assert.equal(await evaluate('document.querySelector("#dialog-body button[type=submit]").disabled'),false);
    await run('screenshot',join(output,'upload-error-phone.png'));
    const html=join(output,'upload.html');
    writeFileSync(html,'<!doctype html><h1>Browser upload verified</h1><script>window.fixtureLoaded=true</script>');
    await run('upload','#upload-files',html);
    await run('fill','#upload-title','<img src=x onerror=alert(1)> Browser upload');
    await click('#dialog-body button[type=submit]'); await run('wait','--fn','!document.getElementById("dialog").open'); await run('wait','[aria-busy="false"]');
    assert.equal(await evaluate('!!document.querySelector(".artifact-title img")'),false);
    const href=await evaluate('[...document.querySelectorAll(".artifact-title")].find(e=>e.textContent.includes("Browser upload")).getAttribute("href")');
    const id=new URL(href,base).pathname.split('/').at(-1);
    const item=async ()=>await evaluate(`[...document.querySelectorAll('.artifact-title')].find(e=>new URL(e.href).pathname===${JSON.stringify('/v/'+id)}).closest('article').querySelector('.artifact-menu').click()`);
    await item(); await wait('#dialog[open]');
    await run('find','role','button','click','--name','Rename'); await wait('#rename-title');
    await run('fill','#rename-title','Browser renamed'); await click('#dialog-body button[type=submit]'); await run('wait','--fn','!document.getElementById("dialog").open'); await run('wait','[aria-busy="false"]');
    await item(); await run('find','role','button','click','--name','Manage access'); await wait('#share-person');
    await dialogSelectQA('add-access');
    const eligible=await evaluate('document.getElementById("share-person").value'); assert.ok(eligible,'sharing selects an eligible account');
    await run('select','#share-person',member.user.id);await run('select','#share-permission','write');
    await click('#dialog-body button[type=submit]');await run('wait','--fn','!document.getElementById("dialog").open');await run('wait','[aria-busy="false"]');
    assert.equal((await api(`/api/artifacts/${id}/sharing`,{cookie:owner.cookie})).json.grants.length,1);
    await item();await run('find','role','button','click','--name','Manage access');await wait('.grant select');
    await dialogSelectQA('existing-access');await click('#dialog-close');
    await item();await run('find','role','button','click','--name','Star artifact');await run('wait','--fn','!document.getElementById("dialog").open');await run('wait','[aria-busy="false"]');
    assert.ok((await api('/api/library?view=starred',{cookie:owner.cookie})).json.artifacts.some(a=>a.id===id));
    // Named write grantees get editing, never management or capability links.
    await run('cookies','set','artifact_session',member.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    await run('open',base+'/?view=shared');await wait('.artifact-title');
    assert.equal(await evaluate('[...document.querySelectorAll("[data-owner-only]")].every(e=>e.hidden)'),true);
    await item();assert.equal(await evaluate('[...document.querySelectorAll("#dialog-body button")].some(e=>e.textContent==="Manage access")'),false);
    assert.equal(await evaluate('[...document.querySelectorAll("#dialog-body button")].some(e=>e.textContent==="Expiration")'),false,'a named editor cannot change expiration');
    await click('#dialog-close');await run('open',base+href);await wait('#bar:not([hidden])');
    assert.equal(await evaluate('document.getElementById("deleteBtn").hidden'),true);
    assert.equal(await evaluate('document.getElementById("role").textContent'),'Can edit');
    await click('#shareBtn');assert.equal(await evaluate('document.querySelectorAll("#readLink,#editLink,#cloneCmd").length'),0);
    await run('screenshot',join(output,'named-editor-phone.png'));
    await run('cookies','set','artifact_session',browserOwner.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    // Session viewer, sandbox execution, old history selection and restore.
    const before=await api(`/api/artifacts/${id}`,{cookie:owner.cookie});
    const changed=await api(`/api/artifacts/${id}`,{method:'PUT',cookie:owner.cookie,body:{parent:before.json.tip,message:'Browser history fixture',files:{'index.html':Buffer.from('<h1>Changed version</h1>').toString('base64')}}});
    assert.equal(changed.status,200,changed.text);
    await run('open',base+href); await wait('#bar:not([hidden])');
    await click('#titleBtn');await wait('#role');
    assert.equal(await evaluate('document.getElementById("title").textContent'),'Browser renamed');
    assert.equal(await evaluate('document.getElementById("deleteBtn").hidden'),false);
    assert.ok(await evaluate('document.getElementById("frame").getAttribute("sandbox").includes("allow-scripts")'));
    await click('#shareBtn');assert.ok(await evaluate('document.getElementById("shareRows").textContent.includes("Only the owner")'));
    assert.ok(await evaluate('document.getElementById("shareRows").textContent.includes("Comment link")'),'a signed-in editor can copy a comment link');
    assert.match(await evaluate('document.getElementById("commentLink").value'),/\/v\/[^#]+#[0-9a-f]{64}$/);
    await run('screenshot',join(output,'session-viewer-phone.png'));
    await click('#versionBtn');await run('click','#versionList .version:last-child');await wait('#restoreBtn');
    assert.ok(await evaluate('location.hash.startsWith("#@")'));
    await click('#restoreBtn');await run('wait','--fn','document.getElementById("oldStrip").hidden');
    const restored=await api(`/api/artifacts/${id}/files/index.html`,{cookie:owner.cookie});
    assert.ok(restored.text.includes('Browser upload verified'));
    // Credential one-time reveal and revoke through UI.
    await run('open',base+'/?view=credentials');await wait('#app:not([hidden])');await run('wait','[aria-busy="false"]');
    await click('#page-action');await wait('#credential-name');await run('fill','#credential-name','Browser credential');await click('#dialog-body button[type=submit]');await wait('.secret');
    assert.match(await evaluate('document.querySelector(".secret").textContent'),/^[a-f0-9]{64}$/);
    assert.ok(await evaluate('document.querySelector("#dialog-body .cli-guide code").textContent.includes("<your-personal-credential>")'));
    assert.equal(await evaluate('document.querySelector("#dialog-body .cli-guide code").textContent.includes(document.querySelector(".secret").textContent)'),false,'setup example never embeds the credential');
    assert.equal(await evaluate(`(()=>{document.getElementById('dialog-close').click();return document.querySelector('.secret')===null})()`),true,'closing immediately removes the one-time credential');
    await run('wait','[aria-busy="false"]');
    await evaluate('[...document.querySelectorAll(".record")].find(e=>e.textContent.includes("Browser credential")).querySelector("button").click()');
    await wait('#dialog[open]');await click('#dialog-body button[type=submit]');await run('wait','--fn','!document.getElementById("dialog").open');await run('wait','[aria-busy="false"]');
    assert.ok(!(await api('/api/credentials',{cookie:owner.cookie})).json.credentials.some(c=>c.name==='Browser credential'));
    // Archive, find in instance inventory, restore, and explicit deletion.
    await run('open',base+'/?view=mine');await wait('.artifact-title');await item();await run('find','role','button','click','--name','Archive artifact');
    assert.ok(await evaluate('document.getElementById("dialog-body").textContent.includes("You can restore it from Archived")'));
    await click('#dialog-body button[type=submit]');await run('wait','--fn','!document.getElementById("dialog").open');await run('wait','[aria-busy="false"]');
    await run('open',base+'/?view=admin&status=archived');await wait('.artifact-title');await item();await run('find','role','button','click','--name','Restore to library');
    await click('#dialog-body button[type=submit]');await run('wait','--fn','!document.getElementById("dialog").open');await run('wait','[aria-busy="false"]');
    await run('open',base+'/?view=mine');await wait('.artifact-title');await item();await run('find','role','button','click','--name','Transfer ownership');await wait('#transfer-owner');
    await dialogSelectQA('transfer');
    await run('select','#transfer-owner',member.user.id);await run('check','#transfer-confirm');await click('#dialog-body button[type=submit]');await run('wait','--fn','!document.getElementById("dialog").open');await run('wait','[aria-busy="false"]');
    const sharing=await api(`/api/artifacts/${id}/sharing`,{cookie:owner.cookie});assert.equal(sharing.json.ownerId,member.user.id);assert.equal(sharing.json.grants.length,0);
    await run('cookies','set','artifact_session',member.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    await run('open',base+'/?view=mine');await wait('.artifact-title');await item();await run('find','role','button','click','--name','Archive artifact');
    assert.ok(await evaluate('document.getElementById("dialog-body").textContent.includes("You can restore it from Archived")'));
    await click('#dialog-body button[type=submit]');await run('wait','--fn','!document.getElementById("dialog").open');await run('wait','[aria-busy="false"]');
    await run('open',base+'/?view=archived');await wait('.artifact-title');await item();await run('find','role','button','click','--name','Restore to library');
    await click('#dialog-body button[type=submit]');await run('wait','--fn','!document.getElementById("dialog").open');await run('wait','[aria-busy="false"]');
    assert.ok((await api('/api/library?view=mine',{cookie:member.cookie})).json.artifacts.some(a=>a.id===id),'member restores without instance administration');
    await expirationQA({base,api,run,evaluate,wait,click,output,artifact:{id,cookie:member.cookie}});
    await run('cookies','set','artifact_session',browserOwner.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    await run('open',base+'/?view=admin');await wait('.artifact-title');await item();await run('find','role','button','click','--name','Manage access');await wait('#share-person');
    assert.equal(await evaluate('[...document.querySelectorAll("#share-person option")].some(e=>e.value==="instance-owner")'),false,'instance owner has fixed administrative access');
    await run('screenshot',join(output,'member-artifact-access-phone.png'));
    // Chromium defers native dialog-close events in hidden tabs. Exercise the
    // visible user's dialog rather than waiting forever on a background tab.
    const tabs=JSON.parse(await run('--json','tab','list'));
    assert.equal(tabs.success,true,JSON.stringify(tabs));
    const activeTab=tabs.data.tabs.find(tab=>tab.active);
    assert.ok(activeTab,'the matrix has an active test tab');
    await run('tab',activeTab.tabId);
    await run('wait','--fn','document.visibilityState==="visible"');
    // Closing and immediately reopening must not let the old queued close event
    // erase the new dialog. Wait for that event, not an arbitrary frame delay.
    assert.equal(await evaluate(`(async()=>{
      const dialog=document.getElementById('dialog');
      const closed=new Promise(resolve=>dialog.addEventListener('close',resolve,{once:true}));
      dialog.close();
      [...document.querySelectorAll('.artifact-title')].find(e=>new URL(e.href).pathname===${JSON.stringify('/v/'+id)}).closest('article').querySelector('.artifact-menu').click();
      await closed;
      return dialog.open&&[...dialog.querySelectorAll('button')].some(e=>e.textContent==='Delete artifact…');
    })()`),true,'a queued close event preserves a newly reopened management dialog');
    await run('find','role','button','click','--name','Delete artifact…');await wait('#delete-confirm');
    await run('fill','#delete-confirm','DELETE');await click('#dialog-body button[type=submit]');await run('wait','--fn','!document.getElementById("dialog").open');await run('wait','[aria-busy="false"]');
    assert.equal((await api(`/api/artifacts/${id}`,{cookie:owner.cookie})).status,404);
    await run('open',base+'/?view=people');await wait('#page-action');await click('#page-action');await wait('#invite-email');
    await run('fill','#invite-email','browser-invitation@example.com');await run('fill','#invite-name','Browser invitation');await click('#dialog-body button[type=submit]');await run('wait','--fn','!document.getElementById("dialog").open');await run('wait','[aria-busy="false"]');
    await evaluate('[...document.querySelectorAll(".record")].find(e=>e.textContent.includes("browser-invitation@example.com")).querySelector(".record-actions button:last-child").click()');
    await wait('#dialog[open]');await run('find','role','button','click','--name','Suspend account');await wait('#dialog-body button[type=submit]');await click('#dialog-body button[type=submit]');await run('wait','--fn','!document.getElementById("dialog").open');await run('wait','[aria-busy="false"]');
    assert.ok((await api('/api/people',{cookie:owner.cookie})).json.users.some(u=>u.email==='browser-invitation@example.com'&&u.status==='disabled'));
    // A failed library fetch offers recovery without dropping the signed-in user.
    await evaluate(`(()=>{const original=window.fetch;window.fetch=(...args)=>{if(String(args[0]).startsWith('/api/library')){window.fetch=original;return Promise.reject(new Error('Local test connection failure'))}return original(...args)}})()`);
    await click('#nav-toggle');await wait('#navigation');await click('.sidebar [data-view="all"]');await wait('#page-error:not([hidden])');
    assert.ok(await evaluate('document.getElementById("page-error").textContent.includes("Local test connection failure")'));
    await run('find','role','button','click','--name','Try again');await wait('.artifact-title');
    assert.equal(await evaluate('document.getElementById("page-error").hidden'),true);
    const savedThemeBeforeLogout=await evaluate('JSON.parse(localStorage.getItem("artifact-library-preferences")).theme');
    await click('#nav-toggle');await wait('#navigation');await click('#account-menu-button');await wait('#account-menu:not([hidden])');await click('#logout');await wait('#login:not([hidden])');
    assert.equal(await evaluate('document.querySelectorAll(".artifact-title").length'),0);
    assert.equal(await evaluate('document.documentElement.dataset.theme||null'),null,'logout restores system appearance');
    assert.equal(await evaluate('JSON.parse(localStorage.getItem("artifact-library-preferences")).theme'),savedThemeBeforeLogout,'logout retains the in-app preference');
    await run('open',base+'/login#token='+'0'.repeat(64));await wait('#verify-button');
    assert.equal(await evaluate('document.activeElement.id'),'verify-button','the verify step focuses Continue');
    await click('#verify-button');await wait('#login-form:not([hidden])');
    assert.equal(await evaluate('document.getElementById("login-title").textContent'),'This link has expired','an expired link offers a new one instead of a dead end');
    assert.equal(await evaluate('document.getElementById("login-submit").textContent'),'Email me a new link');
    assert.equal(await evaluate('document.activeElement.id'),'login-email','the email field takes focus');
    await run('screenshot',join(output,'invalid-login-phone.png'));
    // An expired link shows the request form itself, so there is no separate escape to click.
    assert.equal(await evaluate('document.getElementById("login-form").hidden'),false,'the expired link offers the form directly');
    assert.equal(await evaluate('document.activeElement.id'),'login-email','the form is ready to type in');
    await run('fill','#login-email','unknown-browser@example.com');await click('#login-form button[type=submit]');await wait('#sent-panel:not([hidden])');
    assert.ok(await evaluate('document.getElementById("sent-text").textContent.includes("invited account")'));
    assert.equal(await evaluate('document.getElementById("login-form").hidden'),true,'the sent state replaces the form');
    assert.ok(await evaluate('document.getElementById("resend-link").disabled'),'resend waits before it can be used again');
    writeFileSync(join(output,'layout-evidence.json'),JSON.stringify(evidence,null,2));
    return {permutations:evidence.length,output};
  } catch (error) {
    failure=error;
    throw error;
  } finally {
    try {await run('close');} catch (error) {
      if(failure) throw new AggregateError([failure,error],'Browser verification and cleanup failed');
      throw error;
    } finally {
      for(const id of fixtures) await api(`/api/artifacts/${id}`,{method:'DELETE',cookie:owner.cookie});
    }
  }
}
