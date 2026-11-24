// Public UI contract, with an isolated account and real FTS results; never a live instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freePort, startWorker } from './helpers/worker.mjs';

const exec = promisify(execFile);
test('library search compares dates and named shares in compact accessible rows', {timeout: 150000}, async t => {
  if (process.env.LIBRARY_TABLE_BROWSER_QA !== '1') return t.skip('enable LIBRARY_TABLE_BROWSER_QA for Chrome');
  const state = mkdtempSync(join(tmpdir(), 'compact-library-browser-'));
  const session = `compact-library-${process.pid}`;
  const run = async (...args) => {
    try { return (await exec('agent-browser', ['--session',session,...args], {timeout:20000, env:{...process.env,AGENT_BROWSER_IDLE_TIMEOUT_MS:'60000'}})).stdout; }
    catch { throw Error(`Browser command failed: ${args[0]}`); }
  };
  const evaluate = async code => JSON.parse(await run('--json','eval',code)).data.result;
  const waitFor = code => run('wait','--fn',code);
  const click = async selector => {
    await run('wait',selector);
    // Verify pointer hit testing at the live, scrolled position, then exercise
    // native keyboard activation and focus restoration without saved coordinates.
    const reachable = await evaluate(`(() => {
      const target = document.querySelector(${JSON.stringify(selector)});
      target.scrollIntoView({block:'center',behavior:'instant'});
      target.focus({preventScroll:true});
      const r=target.getBoundingClientRect();
      return document.activeElement===target && target.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
    })()`);
    assert.ok(reachable,`control has a visible, focusable hit target: ${selector}`);
    await run('press','Enter');
  };
  const go = async (base, query) => { await run('open',base+'/?'+query); await run('wait','.artifact-title'); };
  const port = await freePort();
  let app;
  try {
    app = await startWorker(state, { OWNER_EMAIL:'owner@example.com', APP_ORIGIN:`http://127.0.0.1:${port}`, TEST_MAIL_TRANSPORT:'loopback' }, {port});
    const api = async (path, body, cookie, method = 'POST') => {
      const r = await fetch(app.base+path, { method, headers:{Origin:app.base,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})}, body:JSON.stringify(body), signal:AbortSignal.timeout(10000) });
      assert.ok(r.ok,`${path} returned ${r.status}`);
      return {data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
    };
    const verify = async reply => api('/api/auth/verify', {token:new URL(reply.data.loginUrl).hash.slice(7)});
    const owner = await verify(await api('/api/auth/request',{email:'owner@example.com'}));
    const member = await verify(await api('/api/invitations',{email:'lane@example.com',name:'Lane Rivera'},owner.cookie));
    const moreReaders = [];
    for (const [name, email] of [['Avery Finch','avery'], ['Jo North','jo'], ['Sol Pike','sol']]) {
      const r = await verify(await api('/api/invitations',{email:`${email}@example.com`,name},owner.cookie));
      moreReaders.push(r.data.user.id);
    }
    await api('/api/invitations',{email:'waiting@example.com',name:'Pending User'},owner.cookie);
    const people = await api('/api/people',undefined,owner.cookie,'GET');
    const pending = people.data.users.find(p=>p.status==='invited');assert.ok(pending);
    const files = {'index.html':Buffer.from('<!doctype html><h1>Service desk</h1><p>Attach the return label to the parcel.</p>').toString('base64')};
    let firstArtifactPath;
    for (let i=0;i<13;i++) {
      const bodyFiles = i===12 ? {'index.html':Buffer.from('<!doctype html><h1>Returns desk</h1><p>Attach the return label.</p><script>void 0</script>').toString('base64')} : files;
      const a = await api('/api/artifacts',{title:`Counter handbook ${String(i+1).padStart(2,'0')}`,files:bodyFiles,ttlSeconds:i===0?7200:null},owner.cookie);
      if (!i) firstArtifactPath = new URL(a.data.viewerUrl).pathname;
      const grants = i===0 ? [member.data.user.id,...moreReaders,pending.id] : i===1 ? moreReaders.slice(0,1) : [];
      for (const userId of grants) await api(`/api/artifacts/${a.data.id}/sharing`,{userId,permission:'read'},owner.cookie,'PUT');
    }
    const useCookie = cookie => run('cookies','set','artifact_session',cookie.slice(cookie.indexOf('=')+1),'--url',app.base,'--httpOnly','--sameSite','Lax');
    await useCookie(owner.cookie);
    await run('set','viewport','1280','800');
    await go(app.base,'q=return&sort=name');
    assert.equal(await evaluate(`!!document.querySelector('#content table thead')`),true,'List presents a native comparison table');
    assert.match(await evaluate(`document.querySelector('#content thead').textContent`),/Artifact[\s\S]*Updated[\s\S]*Expires[\s\S]*Shared (to|with)/i);
    assert.equal(await evaluate(`document.querySelectorAll('#content tbody .artifact-title').length`),12);
    const geometry = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#content tbody tr')];
      const boxes = rows.slice(0, 8).map(row => row.getBoundingClientRect());
      return { height: boxes.at(-1).bottom - boxes[0].top,
        full: boxes.filter(b => b.bottom <= innerHeight && b.top >= 0).length,
        marks: rows.filter(row => row.querySelector('mark')).length };
    })()`);
    assert.ok(geometry.height<=493,`eight desktop search rows fit in 493px (got ${geometry.height}px)`);
    assert.equal(geometry.marks,12,'all body-only matches retain highlighted evidence');
    console.log(`Desktop: eight search rows occupy ${geometry.height}px; ${geometry.full}/8 fully visible at 1280×800.`);
    if (process.env.LIBRARY_QA_SHOTS) await run('screenshot',join(process.env.LIBRARY_QA_SHOTS,'table-desktop.png'));
    assert.equal(await evaluate(`performance.getEntriesByType('resource').filter(e=>/\\/sharing(?:\\?|$)|\\/p\\//.test(new URL(e.name).pathname)).length`),0,'listing requests neither individual rosters nor previews');
    await click('#content tbody tr:first-child .artifact-details-button');
    await run('wait','#dialog[open] .search-path');
    assert.equal(await evaluate(`document.querySelector('#dialog .search-path').textContent`),'index.html');
    assert.match(await evaluate(`document.querySelector('#dialog').innerText`),/return label/);
    assert.match(await evaluate(`document.querySelector('#dialog').innerText`),/UTC|GMT|Local|America\/|Europe\/|\d{2}:\d{2}/i);
    await run('press','Escape');await waitFor(`document.activeElement.matches('.artifact-details-button')`);
    await click('#content tbody tr:first-child .sharing-summary');await run('wait','#dialog[open] .grant');
    assert.match(await evaluate(`document.querySelector('#dialog').textContent`),/Lane Rivera/,'roster opens on explicit request');
    await run('press','Escape');await waitFor(`document.activeElement.matches('.sharing-summary')`);
    const expHeader = `document.querySelectorAll('#content th')`;
    await evaluate(`[...${expHeader}].find(th=>/expires/i.test(th.textContent)).querySelector('button').click(); true`);
    await waitFor(`document.querySelector('#content th[aria-sort="ascending"]')?.textContent.toLowerCase().includes('expir') && document.getElementById('sort').value==='expiry' && document.getElementById('content').getAttribute('aria-busy')==='false'`);
    assert.equal(await evaluate(`new URL(document.querySelector('#content tbody .artifact-title').href).pathname`),firstArtifactPath,'only finite deadline sorts first');
    const preview=await evaluate(`(()=>{const b=document.querySelector('#content tbody tr .sharing-summary');return {text:b.innerText,label:b.getAttribute('aria-label')};})()`);
    assert.match(preview.text,/LR/);assert.match(preview.text,/\+1/);assert.match(preview.text,/1 pending/i);
    assert.match(preview.label,/Lane Rivera/,'names available to assistive technology');
    assert.doesNotMatch(preview.text+' '+preview.label,/Pending User|@example\.com/);
    await evaluate(`document.getElementById('more').scrollIntoView({block:'center'}); true`);await click('#more');
    await waitFor(`document.querySelectorAll('#content tbody .artifact-title').length===13`);
    assert.equal(await evaluate(`new Set([...document.querySelectorAll('#content tbody .artifact-title')].map(x=>x.href)).size`),13);
    assert.ok(await evaluate(`document.activeElement.closest('tr')?.contains([...document.querySelectorAll('#content tbody .artifact-title')].at(-1))`),'focus moves to first newly appended row');
    for (const width of [390,320]) {
      await run('set','viewport',String(width),'844');
      for (const theme of ['light','dark']) {
        const layout = await evaluate(`(() => {
          document.documentElement.dataset.theme = '${theme}';
          const row = document.querySelector('#content tbody tr');
          const targets = [...document.querySelectorAll('#content tbody :is(button,a,summary)')]
            .map(e => e.getBoundingClientRect()).filter(r => r.width && r.height);
          return { overflow: document.documentElement.scrollWidth > innerWidth,
            targets: targets.map(r => [r.width, r.height]),
            dateCount: [...row.querySelectorAll('time')].filter(e => e.getBoundingClientRect().width).length };
        })()`);
        assert.equal(layout.overflow,false,`no page overflow at ${width}px (${theme})`);
        assert.ok(layout.targets.every(([w,h])=>w>=44 && h>=44),`phone tap targets: ${JSON.stringify(layout.targets)}`);
        assert.ok(layout.dateCount>=2,'updated time and finite expiry stay visible on phones');
        if (width===390 && process.env.LIBRARY_QA_SHOTS) {
          await evaluate(`document.querySelector('#content').scrollIntoView({block:'start'}); true`);
          await run('screenshot',join(process.env.LIBRARY_QA_SHOTS,`table-phone-${theme}.png`));
        }
      }
    }
    await run('set','viewport','1280','800');
    const returnTo=await evaluate('location.pathname+location.search');
    await click('#content tbody tr:first-child .artifact-title');await run('wait','#backLibrary:not([hidden])');await click('#backLibrary');
    await waitFor(`document.querySelectorAll('#content tbody .artifact-title').length===13`);
    assert.equal(await evaluate('location.pathname+location.search'),returnTo,'viewer return preserves query, chosen expiry order and page size');
    await click('[data-layout="grid"]');
    await run('wait','.artifact-grid .artifact-title');
    assert.equal(await evaluate(`!!document.querySelector('#content table')`),false,'Grid preference is preserved independently');
    await click('[data-layout="list"]'); await run('wait','#content table');
    await go(app.base,'q=return+missingword&sort=name&n=24');
    await waitFor(`document.querySelectorAll('#content tbody .artifact-title').length===13`);
    const caveats=await evaluate(`document.querySelector('#content tbody tr:last-child').innerText`);
    assert.match(caveats,/Matched 1 of 2 words/);assert.match(caveats,/may not be searchable/i);
    // Other tabs share this cookie. A tab that already rendered the owner's roster
    // must recheck its own cookie, not trust a broadcast identity or require reload.
    await click('#content tbody tr:first-child .sharing-summary');await run('wait','#dialog[open] .grant');
    await evaluate(`(() => {
      window.__originalLibraryDocument = true;
      // A management notice (for example an invitation cooldown) can name a person.
      const toast = document.getElementById('toast');
      toast.textContent = 'Previous owner invitation notice'; toast.hidden = false;
      const original = window.fetch;
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (new URL(args[0],location.href).pathname !== '/api/session') return response;
        window.fetch = original;
        return new Promise(resolve => { window.__releaseIdentityCheck = () => resolve(response); });
      }; return true;
    })()`);
    await useCookie(member.cookie);
    await evaluate(`(()=>{const channel=new BroadcastChannel('artifact-signin');channel.postMessage({type:'signed-in'});channel.close();return true})()`);
    await waitFor(`typeof window.__releaseIdentityCheck==='function'`);
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('dialog')).visibility`),'hidden','old roster cannot be seen while identity is unconfirmed');
    await evaluate('window.__releaseIdentityCheck(); true');
    await waitFor(`document.getElementById('account-email').textContent==='lane@example.com' && !document.querySelector('#dialog[open]') && document.querySelectorAll('#content tbody .artifact-title').length===1`);
    assert.equal(await evaluate(`window.__originalLibraryDocument && !document.querySelector('#dialog-body .grant') && !document.querySelector('#content .sharing-summary')`),true,'account switch clears old roster, summary and dialog without navigation');
    assert.ok(await evaluate(`document.getElementById('toast').hidden && !document.getElementById('toast').textContent`),'private notices cannot reappear for the new account');
    const shared=await evaluate(`(()=>{const rows=document.querySelectorAll('#content tbody tr');return {n:rows.length,text:rows[0].innerText,labels:[...rows[0].querySelectorAll('[aria-label],[title]')].flatMap(x=>[x.getAttribute('aria-label'),x.title]).join(' ')}})()`);
    assert.equal(shared.n,1);assert.match(shared.text,/Can view/i);assert.doesNotMatch(shared.text+' '+shared.labels,/Lane Rivera|Avery Finch|\bLR\b|\+\d+|No named grants|\d+ pending/i,'readers get their role, no roster or derived counts');
    // The account can remain unchanged while management of a particular row is lost.
    const own = await api('/api/artifacts',{title:'Transfer fixture',files,ttlSeconds:null},member.cookie);
    await api(`/api/artifacts/${own.data.id}/sharing`,{userId:moreReaders[0],permission:'read'},member.cookie,'PUT');
    await go(app.base,'view=mine');await run('wait','.sharing-summary');
    await api(`/api/artifacts/${own.data.id}/manage`,{ownerId:moreReaders[1]},owner.cookie,'PATCH');
    await click('.sharing-summary');await run('wait','#dialog-error:not([hidden])');
    assert.equal(await evaluate(`document.querySelectorAll('#dialog-body .grant').length`),0,'full roster denied after transfer');
    await waitFor(`!document.querySelector('#content .sharing-summary') && !document.querySelector('#content .artifact-title')`);
    await run('press','Escape');
    await run('cookies','clear');
    await evaluate(`window.dispatchEvent(new Event('focus')); true`);
    await run('wait','#login:not([hidden])');
    assert.equal(await evaluate(`document.querySelectorAll('#content .artifact-title,#dialog-body .grant').length`),0,'focus revalidates sign-out even without broadcast');
  } finally {
    try { await run('close'); } catch { /* preserve original failure */ }
    app?.stop(); rmSync(state,{recursive:true,force:true});
  }
});
