import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root=new URL('..',import.meta.url).pathname;

async function withWorker(vars,check) {
  const work=mkdtempSync(join(tmpdir(),'artifact-mail-isolation-'));
  const port=24000+Math.floor(Math.random()*1000),base=`http://127.0.0.1:${port}`;
  const settings={BEARER_TOKEN:'local-mail-test',OWNER_EMAIL:'owner@example.com',EMAIL_FROM:'artifacts@example.com',APP_ORIGIN:base,TEST_MAIL_TRANSPORT:'',...vars};
  const args=['dev','--port',String(port),'--ip','127.0.0.1','--persist-to',join(work,'state'),'--show-interactive-dev-session=false'];
  for(const [key,value]of Object.entries(settings))args.push('--var',`${key}:${value}`);
  const child=spawn(join(root,'node_modules/.bin/wrangler'),args,{cwd:root,stdio:['ignore','pipe','pipe'],detached:true});
  // Drain logs, including Miniflare's local email sink. Never print mail bodies.
  child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
  try {
    let ready=false;
    for(let i=0;i<120;i++) {
      try {if((await fetch(base+'/healthz')).ok){ready=true;break;}} catch {}
      await new Promise(r=>setTimeout(r,1000));
    }
    assert.ok(ready,'isolated mail Worker starts');
    const request=async(email='owner@example.com')=>{
      const r=await fetch(base+'/api/auth/request',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email})});
      return {status:r.status,json:await r.json()};
    };
    await check(request);
  } finally {try{process.kill(-child.pid,'SIGTERM');}catch{}rmSync(work,{recursive:true,force:true});}
}

test('normal mail responses never return magic links even on a loopback request',async()=>{
  await withWorker({},async request=>assert.deepEqual(await request(),{status:200,json:{ok:true}}));
});
test('test transport cannot expose links for a production or mismatched origin',async()=>{
  await withWorker({APP_ORIGIN:'https://production.example',TEST_MAIL_TRANSPORT:'loopback'},async request=>assert.deepEqual(await request(),{status:200,json:{ok:true}}));
});
test('missing sender or invalid origin returns actionable 503 for delivery, unknown emails remain generic',async()=>{
  for(const vars of [{EMAIL_FROM:''},{APP_ORIGIN:'https://production.example/untrusted-path'}]) {
    await withWorker(vars,async request=>{
      const known=await request();assert.equal(known.status,503);assert.equal(typeof known.json.error,'string');assert.equal(known.json.loginUrl,undefined);
      assert.deepEqual(await request('unknown@example.com'),{status:200,json:{ok:true}});
    });
  }
});
test('no owner email means no default privileged login',async()=>{
  await withWorker({OWNER_EMAIL:'',TEST_MAIL_TRANSPORT:'loopback'},async request=>assert.deepEqual(await request(),{status:200,json:{ok:true}}));
});
