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
const args=process.argv.slice(2),path=args[args.indexOf('--secrets-file')+1];
const secrets=JSON.parse(fs.readFileSync(path,'utf8'));
fs.writeFileSync(process.env.DEPLOY_TEST_MARKER,JSON.stringify({args,path,mode:fs.statSync(path).mode&511,keys:Object.keys(secrets),owner:secrets.OWNER_EMAIL}));
`);
    chmodSync(fake,0o700);
    const env={...process.env,PATH:dir+':'+process.env.PATH,CLOUDFLARE_API_TOKEN:'test-placeholder',CLOUDFLARE_ACCOUNT_ID:'test-account',BEARER_TOKEN:'test-placeholder',OWNER_EMAIL:'approved@example.com',EMAIL_FROM:'artifacts@example.com',APP_ORIGIN:'https://example.com',TEST_MAIL_TRANSPORT:'',DEPLOY_TEST_MARKER:marker};
    for(const changes of [{OWNER_EMAIL:''},{OWNER_EMAIL:'not-an-email'},{EMAIL_FROM:''},{EMAIL_FROM:'invalid'},{APP_ORIGIN:''},{APP_ORIGIN:'http://example.com'},{APP_ORIGIN:'https://example.com/'},{APP_ORIGIN:'https://localhost'},{APP_ORIGIN:'https://user:pass@example.com'},{TEST_MAIL_TRANSPORT:'loopback'},{TEST_MAIL_TRANSPORT:'anything'},{APP_ORIGIN:'http://127.0.0.1:8787',TEST_MAIL_TRANSPORT:'loopback'}]) {
      const r=spawnSync('sh',['scripts/deploy.sh'],{cwd:root,env:{...env,...changes},encoding:'utf8'});
      assert.notEqual(r.status,0,JSON.stringify(changes));
      assert.equal(existsSync(marker),false,'unsafe config must never reach deployment');
    }
    execFileSync('sh',['scripts/deploy.sh'],{cwd:root,env,stdio:'pipe'});
    const call=JSON.parse(readFileSync(marker,'utf8'));
    assert.equal(call.owner,'approved@example.com');
    assert.ok(call.keys.includes('OWNER_EMAIL'));assert.ok(call.keys.includes('BEARER_TOKEN'));
    assert.equal(call.mode,0o600);
    assert.ok(call.args.includes('APP_ORIGIN:https://example.com'));
    assert.ok(call.args.includes('EMAIL_FROM:artifacts@example.com'));
    assert.ok(call.args.includes('TEST_MAIL_TRANSPORT:'));
    assert.equal(existsSync(call.path),false,'secret scratch file must be removed');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
