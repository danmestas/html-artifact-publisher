import assert from 'node:assert/strict';
import { browserDriver } from './library-browser.mjs';

// Exercise a real same-document account transition: sign out leaves /login,
// and the next mail link changes only its hash. Only response timing (and the
// delayed-401 failure shape) is injected; identities/data come from the Worker.
export async function libraryIdentityQA({base,api,owner,member}) {
  const titleA='Identity A private recent fixture',titleB='Identity B private recent fixture',titleBExtra='Identity B secondary recent fixture';
  const fixtures=[];
  const make=async(cookie,title)=>{
    const response=await api('/api/artifacts',{method:'POST',cookie,body:{title,ttlSeconds:null,files:{'index.html':Buffer.from('<h1>Local identity fixture</h1>').toString('base64')}}});
    assert.equal(response.status,201,'create local identity fixture');fixtures.push(response.json.id);return response.json.id;
  };
  try {
    const a=await make(owner.cookie,titleA);await make(member.cookie,titleB);await make(member.cookie,titleBExtra);
    assert.equal((await api(`/api/artifacts/${a}`,{cookie:member.cookie})).status,404,'B has no access to A private fixture');
    for(const mode of ['data','unauthorized']) {
      const request=async email=>{
        const response=await api('/api/auth/request',{method:'POST',body:{email}});assert.equal(response.status,200);assert.ok(response.json.loginUrl,'local mail transport');return response.json.loginUrl;
      };
      const loginA=await request(owner.user.email),loginB=await request(member.user.email);
      const driver=browserDriver(`library-identity-${process.pid}-${mode}`);
      const run=(...args)=>{
        try{return driver.run(...args)}catch(error){throw new Error(`Browser ${args[0]} failed: ${String(error.stderr||error.message).replace(/[a-f0-9]{64}/g,'[redacted]')}`)}
      };
      const evaluate=source=>{const result=JSON.parse(run('--json','eval',source));assert.equal(result.success,true,'identity browser evaluation');return result.data.result};
      try {
        run('open',loginA);run('wait','#verify-button');
        evaluate(`(()=>{
          const original=window.fetch;let held=false;window.__identityDocument=true;
          window.fetch=async(...args)=>{
            const url=new URL(String(args[0]),location.href);
            const recent=url.pathname==='/api/library'&&url.searchParams.get('limit')==='3';
            if(!recent)return original(...args);
            if(held){const response=await original(...args);const json=response.json.bind(response);response.json=async()=>{try{return await json()}finally{setTimeout(()=>{window.__identityBRecentSettled=true},0)}};return response;}
            held=true;url.searchParams.set('q',${JSON.stringify(titleA)});
            const response=await original(url.pathname+url.search,args[1]);
            const data=await response.json();window.__heldIdentityTitles=(data.artifacts||[]).map(x=>x.title);
            const late=new Response(JSON.stringify(${mode==='unauthorized'?"{error:'Delayed old-account response'}":'data'}),{status:${mode==='unauthorized'?401:200},headers:{'Content-Type':'application/json'}});
            const json=late.json.bind(late);late.json=async()=>{try{return await json()}finally{setTimeout(()=>{window.__identityLateSettled=true},0)}};
            return new Promise(resolve=>{window.__releaseIdentityRecent=()=>resolve(late);window.__identityHeld=true});
          };return true;
        })()`);
        run('click','#verify-button');run('wait','#content[aria-busy="false"]');run('wait','--fn','window.__identityHeld===true');
        assert.equal(evaluate('!!document.querySelector(".artifact-list")'),true,'a fresh workspace defaults to quiet rows');
        assert.deepEqual(evaluate('window.__heldIdentityTitles'),[titleA],'held response really contains A private data');
        run('click','#account-menu-button');run('click','#logout');run('wait','#login:not([hidden])');
        assert.equal(evaluate('location.pathname'),'/login');
        evaluate(`location.hash=${JSON.stringify(new URL(loginB).hash)}`);run('wait','#verify-button');run('click','#verify-button');
        run('wait','--fn',`!document.getElementById('app').hidden&&document.getElementById('account-email').textContent===${JSON.stringify(member.user.email)}`);
        run('wait','--fn',`window.__identityBRecentSettled===true&&document.getElementById('recent-list').textContent.includes(${JSON.stringify(titleB)})`);
        assert.equal(evaluate('window.__identityDocument'),true,'mail-link switch keeps the same document and pending response');
        evaluate('window.__releaseIdentityRecent();true');run('wait','--fn','window.__identityLateSettled===true');
        assert.equal(evaluate('document.getElementById("app").hidden'),false,'an old 401 cannot sign out the newly adopted account');
        assert.equal(evaluate('document.getElementById("account-email").textContent'),member.user.email);
        const recent=evaluate('document.getElementById("recent-list").textContent');
        assert.ok(recent.includes(titleB),'B keeps its own recent artifacts');
        assert.ok(!recent.includes(titleA),'A private titles do not reappear after the account transition');
        assert.ok(!evaluate('document.getElementById("content").textContent').includes(titleA),'A rows stay cleared');
        run('fill','#search',titleB);run('press','Enter');
        run('wait','--fn',`new URL(location.href).searchParams.get('q')===${JSON.stringify(titleB)}`);run('wait','#content[aria-busy="false"]');
        assert.ok(evaluate('document.getElementById("recent-list").textContent').includes(titleBExtra),'Recent stays independent of the current search results');
        const returnTo=evaluate('location.pathname+location.search');
        assert.equal(evaluate('new URL(document.querySelector("#recent-list a").href).searchParams.get("returnTo")'),returnTo,'Recent links retain the current filtered return location');
        run('click','#recent-list a');run('wait','#bar:not([hidden])');run('click','#backLibrary');run('wait','#content[aria-busy="false"]');
        assert.equal(evaluate('location.pathname+location.search'),returnTo,'Recent viewer return restores the filter');
      } finally { try{run('close')}catch{} }
    }
  } finally {
    for(const id of fixtures)await api(`/api/artifacts/${id}`,{method:'DELETE',cookie:owner.cookie});
  }
}
