import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startWorker,createArtifact} from './helpers/worker.mjs';

const exec=promisify(execFile);
test('location and discussion icons remain centered in phone and desktop toolbar buttons',{timeout:120000},async t=>{
  if(process.env.RENDERED_COPY_BROWSER_QA!=='1')return t.skip('RENDERED_COPY_BROWSER_QA=1 enables viewer browser QA');
  const state=mkdtempSync(join(tmpdir(),'viewer-toolbar-'));
  const session='viewer-toolbar-'+process.pid;
  const chrome=process.env.AGENT_BROWSER_EXECUTABLE_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'/usr/bin/google-chrome');
  const headed=process.env.AGENT_BROWSER_HEADED==='1';
  const run=async(...args)=>{
    try{return(await exec('agent-browser',['--session',session,'--executable-path',chrome,...(headed?['--headed']:[]),...args],{timeout:30000,env:{...process.env,AGENT_BROWSER_IDLE_TIMEOUT_MS:'120000'}})).stdout;}
    catch{throw Error('Browser command failed: '+args[0]);}
  };
  const evaluate=async code=>{const response=JSON.parse(await run('--json','eval',code));assert.equal(response.success,true);return response.data.result;};
  let app;
  try{
    app=await startWorker(state);
    const artifact=await createArtifact(app.base,app.owner,'<!doctype html><html><body><h1>Toolbar fixture</h1></body></html>');
    await run('open',artifact.commentUrl);await run('wait','#commentsBtn:not([hidden])');
    for(const width of [320,375,390,640,641,1024]){
      await run('set','viewport',String(width),'844');
      for(const theme of ['light','dark'])for(const pressed of [false,true]){
        const geometry=await evaluate(`(()=>{
          document.documentElement.dataset.theme=${JSON.stringify(theme)};
          const button=document.getElementById('commentsBtn');button.setAttribute('aria-pressed',${JSON.stringify(String(pressed))});
          const measure=(el,children)=>{const b=el.getBoundingClientRect(),boxes=children.map(c=>c.getBoundingClientRect());const left=Math.min(...boxes.map(r=>r.left)),right=Math.max(...boxes.map(r=>r.right)),top=Math.min(...boxes.map(r=>r.top)),bottom=Math.max(...boxes.map(r=>r.bottom));return{dx:(left+right-b.left-b.right)/2,dy:(top+bottom-b.top-b.bottom)/2,width:b.width,height:b.height};};
          const discussion=document.getElementById('discussionsBtn'),count=document.getElementById('commentCount');
          count.textContent='';const empty=measure(discussion,[discussion.querySelector('svg')]);
          count.textContent='12';const counted=measure(discussion,[discussion.querySelector('svg'),count]);
          return{location:measure(button,[button.querySelector('svg')]),empty,counted};
        })()`);
        for(const name of ['location','empty','counted']){
          const box=geometry[name];
          assert.ok(Math.abs(box.dx)<=0.5,`${name} horizontally centered at ${width}px (${theme}, pressed=${pressed}): offset ${box.dx}px`);
          assert.ok(Math.abs(box.dy)<=0.5,`${name} vertically centered at ${width}px`);
          if(width<=640){assert.ok(box.width>=44,`${name} preserves 44px tap width`);assert.ok(box.height>=44,`${name} preserves 44px tap height`);}
        }
      }
    }
  }finally{
    try{await run('close');}catch{/* preserve original failure */}
    app?.stop();rmSync(state,{recursive:true,force:true});
  }
});
