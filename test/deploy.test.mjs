import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root=new URL('..',import.meta.url).pathname;
test('production deployment gates reject missing owner, unsafe origins, invalid sender and test transport before running deploy',()=>{
  const dir=mkdtempSync(join(tmpdir(),'artifact-deploy-gates-'));
  try {
    const marker=join(dir,'called.json');
    const fake=join(dir,'npx');
    writeFileSync(fake,`#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2);
if(args[1]==='r2'){fs.appendFileSync(process.env.DEPLOY_TEST_MARKER+'.r2',args.join(' ')+'\\n');process.exit(0);}
if(args.includes('wrangler.public.jsonc')){fs.writeFileSync(process.env.DEPLOY_TEST_MARKER+'.public',JSON.stringify(args));console.log('https://artifact-pages.test.workers.dev');process.exit(0);}
const path=args[args.indexOf('--secrets-file')+1];
const secrets=JSON.parse(fs.readFileSync(path,'utf8'));
fs.writeFileSync(process.env.DEPLOY_TEST_MARKER,JSON.stringify({args,path,mode:fs.statSync(path).mode&511,keys:Object.keys(secrets),owner:secrets.OWNER_EMAIL}));
`);
    chmodSync(fake,0o700);
    const env={...process.env,PATH:dir+':'+process.env.PATH,CLOUDFLARE_API_TOKEN:'test-placeholder',CLOUDFLARE_ACCOUNT_ID:'test-account',BEARER_TOKEN:'test-placeholder',OWNER_EMAIL:'approved@example.com',EMAIL_FROM:'artifacts@example.com',APP_ORIGIN:'https://example.com',PUBLIC_ORIGIN:'',TEST_MAIL_TRANSPORT:'',WAKE_SINK_KIND:'',WAKE_SINK_URL:'',WAKE_SINK_SECRET:'',DEPLOY_TEST_MARKER:marker};
    for(const changes of [{PUBLIC_ORIGIN:'https://example.com'},{PUBLIC_ORIGIN:'http://public.example.com'},{PUBLIC_ORIGIN:'https://public.example.com/'},{PUBLIC_ORIGIN:'https://localhost'},{OWNER_EMAIL:''},{OWNER_EMAIL:'not-an-email'},{EMAIL_FROM:''},{EMAIL_FROM:'invalid'},{APP_ORIGIN:''},{APP_ORIGIN:'http://example.com'},{APP_ORIGIN:'https://example.com/'},{APP_ORIGIN:'https://localhost'},{APP_ORIGIN:'https://user:pass@example.com'},{TEST_MAIL_TRANSPORT:'loopback'},{TEST_MAIL_TRANSPORT:'anything'},{APP_ORIGIN:'http://127.0.0.1:8787',TEST_MAIL_TRANSPORT:'loopback'}]) {
      const r=spawnSync('sh',['scripts/deploy.sh'],{cwd:root,env:{...env,...changes},encoding:'utf8'});
      assert.notEqual(r.status,0,JSON.stringify(changes));
      assert.equal(existsSync(marker),false,'unsafe config must never reach deployment');
    }
    const output=execFileSync('sh',['scripts/deploy.sh'],{cwd:root,env,encoding:'utf8'});
    assert.match(output,/APP_URL=https:\/\/example\.com/);
    assert.match(output,/PUBLIC_URL=https:\/\/artifact-pages\.test\.workers\.dev/);
    const publicArgs=JSON.parse(readFileSync(marker+'.public','utf8'));
    assert.equal(publicArgs.includes('--secrets-file'),false,'static Worker must receive no app secrets');
    const call=JSON.parse(readFileSync(marker,'utf8'));
    assert.equal(call.owner,'approved@example.com');
    assert.ok(call.keys.includes('OWNER_EMAIL'));assert.ok(call.keys.includes('BEARER_TOKEN'));
    assert.equal(call.mode,0o600);
    assert.ok(call.args.includes('APP_ORIGIN:https://example.com'));
    assert.ok(call.args.includes('EMAIL_FROM:artifacts@example.com'));
    assert.ok(call.args.includes('PUBLIC_ORIGIN:https://artifact-pages.test.workers.dev'));
    assert.ok(call.args.includes('TEST_MAIL_TRANSPORT:'));
    for (const hook of ['TEST_CLEANUP_PAUSE_MS:', 'TEST_CLEANUP_FAULT:', 'TEST_TOMBSTONE_STALE_MS:', 'TEST_UPLOAD_HOLD_MS:']) assert.ok(call.args.includes(hook), `deploy blanks ${hook}`);
    assert.equal(existsSync(call.path),false,'secret scratch file must be removed');
    assert.match(readFileSync(marker+'.r2','utf8'),/r2 bucket info html-artifact-publisher-blobs/,'the blob bucket is checked before deploying');
    // No wake sink set: none rides the deploy, so wrangler.jsonc's empty values (NOTIFY_* fallback) stand.
    assert.ok(!call.args.some(a=>a.startsWith('WAKE_SINK_')));assert.ok(!call.keys.includes('WAKE_SINK_SECRET'));
    execFileSync('sh',['scripts/deploy.sh'],{cwd:root,env:{...env,WAKE_SINK_KIND:'webhook',WAKE_SINK_URL:'https://hooks.example/wake',WAKE_SINK_SECRET:'test-placeholder'},encoding:'utf8'});
    const woken=JSON.parse(readFileSync(marker,'utf8'));
    assert.ok(woken.args.includes('WAKE_SINK_KIND:webhook'));
    assert.ok(woken.args.includes('WAKE_SINK_URL:https://hooks.example/wake'));
    assert.ok(woken.keys.includes('WAKE_SINK_SECRET'),'the wake secret rides the secrets file, never --var');
    assert.ok(!woken.args.some(a=>a.includes('WAKE_SINK_SECRET')));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
