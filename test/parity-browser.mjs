import assert from 'node:assert/strict';
import { join } from 'node:path';

// Uses the existing suite's single browser tab and throwaway accounts/server.
export async function parityQA({base,api,owner,browserOwner,member,run,evaluate,wait,click,output,selectQA}) {
  const ids=[];
  const cdpURL=run('get','cdp-url').trim();
  const endpoints=await (await fetch(`http://${new URL(cdpURL).host}/json/list`)).json();
  const target=endpoints.find(e=>e.type==='page' && e.url.startsWith(base));
  assert.ok(target,'find the test tab without opening another');
  const socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let next=0;
  const pending=new Map(),requests=new Map();
  socket.addEventListener('message',event=>{
    const m=JSON.parse(event.data);
    if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}
    if(m.method==='Network.requestWillBeSent') requests.set(m.params.requestId,{url:m.params.request.url});
    if(m.method==='Network.loadingFailed') Object.assign(requests.get(m.params.requestId)||{}, {blocked:m.params.blockedReason,failed:true});
    if(m.method==='Network.responseReceived') Object.assign(requests.get(m.params.requestId)||{}, {response:true});
  });
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++next; const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},10000);
    pending.set(id,{resolve,reject,timer}); socket.send(JSON.stringify({id,method,params,sessionId}));
  });
  try {
    await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
    for(const [name,color] of [['Alpha','#fbe5cb'],['Beta','#c5e8f8']]) {
      const html=`<!doctype html><html><head><style>body{background:${color};font:36px system-ui;padding:40px}h1{background-image:url(https://outside.invalid/preview-leak-css)}</style><meta http-equiv="refresh" content="0;url=https://outside.invalid/preview-leak-nav"></head><body onload="document.body.dataset.executed='handler'"><h1>Actual ${name} document</h1><p>Unique ${color} content</p><script>document.body.dataset.executed='script';parent.postMessage({previewExecuted:true},'*')</script><img src="https://outside.invalid/preview-leak-img"><iframe src="https://outside.invalid/preview-leak-frame"></iframe><a href="https://outside.invalid/preview-leak-link" target="_top">Untrusted link</a></body></html>`;
      const r=await api('/api/artifacts',{method:'POST',cookie:owner.cookie,body:{title:`Parity browser ${name}`,ttlSeconds:null,files:{'index.html':Buffer.from(html).toString('base64')}}});
      assert.equal(r.status,201);ids.push(r.json.id);
    }
    await api(`/api/artifacts/${ids[0]}/sharing`,{method:'PUT',cookie:owner.cookie,body:{userId:member.user.id,permission:'read'}});
    run('set','viewport','1440','1000');run('open',base+'/?q=Parity+browser&sort=name');wait('.artifact-title');wait('.artifact-preview iframe');run('wait','--load','networkidle');
    assert.deepEqual(evaluate('[...document.querySelectorAll(".artifact-title")].map(e=>e.textContent)'),['Parity browser Alpha','Parity browser Beta']);
    assert.deepEqual(evaluate('[...document.querySelectorAll(".access-badge")].map(e=>e.textContent)'),['Shared by you','Private']);
    assert.match(evaluate('document.getElementById("result-status").textContent'),/2 of 2/);
    assert.equal(evaluate('[...document.querySelectorAll(".artifact-preview iframe")].every(e=>e.getAttribute("sandbox")===""&&getComputedStyle(e).pointerEvents==="none")'),true);
    const {targetInfos}=await send('Target.getTargets');
    const frames=targetInfos.filter(t=>t.type==='iframe' && t.url.startsWith(base+'/p/'));
    assert.equal(frames.length,2,'two opaque-origin static documents, not sample thumbnails');
    const texts=[];
    for(const frame of frames){
      const {sessionId}=await send('Target.attachToTarget',{targetId:frame.targetId,flatten:true});
      const r=await send('Runtime.evaluate',{expression:'JSON.stringify({text:document.body.innerText,executed:document.body.dataset.executed||null,scripts:document.scripts.length,frames:document.querySelectorAll("iframe").length,links:document.querySelectorAll("[href],[onclick],[onload]").length})',returnByValue:true},sessionId);
      const value=JSON.parse(r.result.value);texts.push(value.text);
      assert.equal(value.executed,null);assert.equal(value.scripts,0);assert.equal(value.frames,0);assert.equal(value.links,0);
    }
    assert.ok(texts.some(t=>t.includes('Actual Alpha document')));assert.ok(texts.some(t=>t.includes('Actual Beta document')));
    // Opening the response directly must retain its sandbox and network policy.
    // Observe on the top-level target so OOPIF network isolation cannot hide events.
    run('open',base+'/p/'+ids[0]);run('wait','--load','networkidle');
    await send('Runtime.evaluate',{expression:'document.readyState'});
    assert.match(evaluate('document.body.innerText'),/Actual Alpha document/);
    assert.equal(evaluate('document.body.dataset.executed||null'),null);
    const outbound=[...requests.values()].filter(r=>r.url.includes('preview-leak'));
    assert.ok(outbound.length>0,'hostile inline CSS attempts a resource load');
    assert.ok(outbound.every(r=>r.blocked==='csp' && !r.response),JSON.stringify(outbound));
    run('open',base+'/?q=Parity+browser&sort=name');wait('.artifact-preview iframe');run('wait','--load','networkidle');
    assert.ok(evaluate('document.querySelector(".artifact-preview iframe").contentDocument===null'),'opaque origin prevents trusted-parent DOM access');
    run('screenshot',join(output,'parity-previews-desktop.png'));
    run('cookies','set','artifact_session',member.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    run('open',base+'/?q=Parity+browser&sort=name');wait('.artifact-title');
    assert.deepEqual(evaluate('[...document.querySelectorAll(".access-badge")].map(e=>e.textContent)'),['Can view']);
    await api(`/api/artifacts/${ids[0]}/sharing`,{method:'PUT',cookie:owner.cookie,body:{userId:member.user.id,permission:'write'}});
    run('open',base+'/?q=Parity+browser&sort=name');wait('.artifact-title');
    assert.deepEqual(evaluate('[...document.querySelectorAll(".access-badge")].map(e=>e.textContent)'),['Can edit']);
    run('cookies','set','artifact_session',browserOwner.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    run('open',base+'/?q=Parity+browser&sort=name');wait('.artifact-preview iframe');
    click('.artifact-preview');wait('#bar:not([hidden])');
    assert.ok(evaluate('location.pathname').startsWith('/v/'),'preview activation opens normal viewer');
    run('back');wait('.artifact-preview iframe');
    click('.artifact-preview');wait('#bar:not([hidden])');
    click('#backLibrary');wait('.artifact-title');
    assert.equal(evaluate('document.getElementById("sort").value'),'name');
    assert.equal(evaluate('document.getElementById("search").value'),'Parity browser');
    run('select','#sort','recent');run('wait','[aria-busy="false"]');
    assert.equal(evaluate('new URLSearchParams(location.search).has("cursor")'),false);
    run('back');wait('.artifact-title');assert.equal(evaluate('document.getElementById("sort").value'),'name');
    run('open',base+'/?view=admin&q=Parity+browser&sort=name');wait('.artifact-row');
    assert.match(evaluate('document.querySelector(".inventory-head").textContent'),/OwnerVisibility \/ statusUpdated/);
    assert.deepEqual(evaluate('[...document.querySelectorAll(".artifact-row:first-child .cell .sr-only")].map(e=>e.textContent)'),['Owner: ','Visibility and status: ','Updated: ']);
    run('set','viewport','390','1000');selectQA();
    const fallback=await api('/api/artifacts',{method:'POST',cookie:owner.cookie,body:{title:'Unavailable preview fixture',ttlSeconds:null,files:{'index.html':Buffer.from('<script>window.interactiveOnly=true</script>').toString('base64')}}});
    assert.equal(fallback.status,201);ids.push(fallback.json.id);
    run('set','media','dark');run('open',base+'/p/'+fallback.json.id);run('wait','--load','networkidle');
    assert.match(evaluate('document.body.innerText'),/Static preview unavailable/);
    assert.equal(evaluate('getComputedStyle(document.body).backgroundColor'),'rgb(29, 38, 51)');
    run('set','media','light');
    assert.equal(evaluate('getComputedStyle(document.body).backgroundColor'),'rgb(255, 255, 255)');
    // Preferences must survive actual navigation, not just an injected data attribute.
    for(const width of [1440,390]) for(const theme of ['light','dark','system']) {
      run('set','viewport',String(width),'1000');run('set','media','dark');
      run('open',base+'/?q=Parity+browser&sort=name');wait('.artifact-title');
      if(width===390) click('#nav-toggle');
      assert.ok(evaluate('(()=>{const a=document.querySelector(".account").getBoundingClientRect(),s=document.querySelector(".sidebar").getBoundingClientRect();return Math.abs(a.left-s.left)<=1 && Math.abs(a.right-s.right)<=1})()'),'account divider spans the sidebar');
      run('select','#theme',theme);
      const expected=theme==='light'?'light':'dark';
      assert.equal(evaluate('getComputedStyle(document.documentElement).colorScheme'),expected);
      selectQA();run('screenshot',join(output,`selects-library-${theme}-${width}.png`));
      click('.artifact-title');wait('#frame');
      // The frame is static shell markup; toolbar actions need loaded artifact metadata.
      wait('#bar:not([hidden])');
      assert.equal(evaluate('getComputedStyle(document.documentElement).colorScheme'),expected);
      assert.equal(evaluate('document.getElementById("viewer-theme").value'),theme);
      click('#moreBtn');selectQA();
      run('screenshot',join(output,`selects-viewer-${theme}-${width}.png`));run('press','Escape');
      if(width===390) {
        assert.notEqual(evaluate('getComputedStyle(document.querySelector("#shareBtn .label")).display'),'none');
        assert.ok(evaluate('document.getElementById("bar").getBoundingClientRect().height<=112'),'phone viewer controls fit two rows');
      }
      click('#backLibrary');wait('.artifact-title');
      assert.equal(evaluate('getComputedStyle(document.documentElement).colorScheme'),expected);
    }
    requests.clear();run('open',base+'/?q=Parity+browser&sort=name');wait('.artifact-title');run('wait','--load','networkidle');
    assert.equal(evaluate('document.querySelectorAll(".artifact-preview iframe").length'),0,'phone does not create hidden frames');
    assert.equal([...requests.values()].filter(r=>r.url.startsWith(base+'/p/')).length,0,'phone makes no preview requests');
    const heights=evaluate('[...document.querySelectorAll(".artifact-summary")].map(e=>e.getBoundingClientRect().height)');
    assert.ok(heights.every(h=>h>=72&&h<=88),JSON.stringify(heights));
    run('screenshot',join(output,'parity-phone.png'));
    run('set','viewport','1440','1000');run('wait','.artifact-preview iframe');
    run('set','viewport','390','1000');
    assert.equal(evaluate('document.querySelectorAll(".artifact-preview iframe").length'),0,'resizing removes frames');
    run('set','viewport','1440','1000');run('wait','.artifact-preview iframe');
    click('[data-layout="list"]');wait('.artifact-row');
    assert.equal(evaluate('document.querySelectorAll(".artifact-preview iframe").length'),0,'list removes frames');
    click('[data-layout="grid"]');wait('.artifact-card');
    // Signed-out screens follow the system without discarding the in-app choice.
    run('cookies','clear');
    for(const width of [1440,390]) for(const system of ['light','dark']) {
      const saved=system==='light'?'dark':'light';
      run('set','viewport',String(width),width===390?'844':'1000');run('set','media',system);
      evaluate(`localStorage.setItem('artifact-library-preferences',JSON.stringify({...JSON.parse(localStorage.getItem('artifact-library-preferences')||'{}'),theme:${JSON.stringify(saved)}}))`);
      run('open',base+'/login');wait('#login:not([hidden])');
      assert.equal(evaluate('document.getElementById("login-theme")'),null);
      assert.equal(evaluate('getComputedStyle(document.documentElement).colorScheme'),system);
      assert.equal(evaluate('JSON.parse(localStorage.getItem("artifact-library-preferences")).theme'),saved);
      evaluate('window.dispatchEvent(new StorageEvent("storage",{key:"artifact-library-preferences"}))');
      assert.equal(evaluate('getComputedStyle(document.documentElement).colorScheme'),system,'storage changes cannot override login appearance');
      run('open',base+'/');wait('#login:not([hidden])');
      assert.equal(evaluate('getComputedStyle(document.documentElement).colorScheme'),system,'signed-out homepage follows system too');
      run('screenshot',join(output,`login-system-${system}-${width}.png`));
    }
    run('cookies','set','artifact_session',browserOwner.cookie.split('=')[1],'--url',base,'--httpOnly','--sameSite','Lax');
    run('open',base+'/');wait('.artifact-title');
    assert.equal(evaluate('getComputedStyle(document.documentElement).colorScheme'),'light','sign-in restores the saved choice despite a dark system');
    assert.equal(evaluate('document.getElementById("theme").value'),'light');
  } finally {
    socket.close();
    for(const id of ids) await api('/api/artifacts/'+id,{method:'DELETE',cookie:owner.cookie});
  }
}
