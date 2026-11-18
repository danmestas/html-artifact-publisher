import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { pointerText } from '../public/blobs.js';
import { startWorker, freePort } from './helpers/worker.mjs';
import { frameEval } from './helpers/frame-eval.mjs';

const exec = promisify(execFile);
const chrome = process.env.AGENT_BROWSER_EXECUTABLE_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const headed = process.env.AGENT_BROWSER_HEADED === '1' || (process.platform === 'darwin' && process.env.AGENT_BROWSER_HEADED !== '0');
test('Save HTML creates an inert portable rendered document that prints fully offline', { timeout: 120000 }, async t => {
  if (process.env.RENDERED_COPY_BROWSER_QA !== '1') return t.skip('RENDERED_COPY_BROWSER_QA=1 enables rendered-copy browser QA');
  const state = mkdtempSync(join(tmpdir(), 'rendered-copy-state-'));
  const output = join(process.cwd(), '.wrangler', 'rendered-copy-evidence'); mkdirSync(output, { recursive: true });
  const session = 'rendered-copy-' + process.pid;
  const run = async (...args) => {
    try { return (await exec('agent-browser', ['--session', session, '--executable-path', chrome, ...(headed ? ['--headed'] : []), '--download-path', output, ...args], { timeout: 30000, env: { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '120000' } })).stdout; }
    catch { throw new Error('Browser command failed: ' + args[0]); }
  };
  const evaluate = async expression => {
    const response = JSON.parse(await run('--json', 'eval', expression));
    assert.equal(response.success, true, 'browser evaluation succeeds'); return response.data.result;
  };
  const nativeClick = async selector => {
    const box = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const controller = await frameEval((await run('get', 'cdp-url')).trim());
    try { await controller.click(box.x, box.y); } finally { controller.close(); }
  };
  let app;
  try {
    const port = await freePort(); app = await startWorker(state, {}, { port });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const sha256 = createHash('sha256').update(png).digest('hex');
    const uploaded = await fetch(app.base + '/api/blobs/' + sha256, { method: 'PUT', headers: { Authorization: 'Bearer ' + app.owner, 'Content-Type': 'image/png' }, body: png, signal: AbortSignal.timeout(20000) });
    assert.ok(uploaded.ok, 'local image uploaded');
    const paragraphs = Array.from({ length: 80 }, (_, i) => `<p>Paragraph ${i}: ${'A long paragraph must wrap to the paper without losing later content. '.repeat(4)}</p>`).join('');
    const escapedStyle = String.raw`<style>.escape{background:url('data:image/svg+xml,<\/style><meta http-equiv=refresh content=0;url=${app.base}/copy-escape>')}</style>`;
    const html = '<!doctype html><html><head><title>Rendered copy fixture</title><style>:root{color-scheme:dark}body{margin:0;padding:24px;background:#12171a;color:#e4e9eb;font:16px/1.5 sans-serif}p{margin:16px 0}</style>' + escapedStyle + '</head><body><h1>COPYFIRSTMARKER</h1>' + paragraphs + '<img id="signed-image" src="pixel.png"><a id="signed-link">Resource</a><canvas id="chart" width="80" height="40"></canvas><script>document.getElementById("signed-link").href=document.getElementById("signed-image").src;document.getElementById("signed-link").textContent=document.getElementById("signed-image").src;const c=document.getElementById("chart").getContext("2d");c.fillStyle="red";c.fillRect(0,0,80,40);const b=document.createElement("button");b.textContent="Unrelated control";b.style.cssText="position:fixed;top:4px;left:4px;z-index:999999";b.addEventListener("click",()=>parent.postMessage({__artifactCopyShortcut:1,render:1,action:"save"},"*"));document.body.append(b);const update=document.createElement("button");update.textContent="Update view";update.style.cssText="position:fixed;top:40px;left:4px;z-index:999999";update.addEventListener("click",()=>{const p=document.createElement("p");p.textContent="SECOND-RENDERED-STATE";document.body.append(p)});document.body.append(update);</script><input type="hidden" value="hidden-secret-must-not-export"><input type="password" value="password-must-not-export"><p>COPYLASTMARKER</p></body></html>';
    const response = await fetch(app.base + '/api/artifacts', { method: 'POST', headers: { Authorization: 'Bearer ' + app.owner }, body: JSON.stringify({ title: 'Rendered copy fixture', ttlSeconds: null, files: { 'index.html': Buffer.from(html).toString('base64'), 'pixel.png': Buffer.from(pointerText({ sha256, size: png.length, type: 'image/png' })).toString('base64') } }), signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 201); const artifact = await response.json();
    const bundled = await fetch(app.base + '/api/artifacts/' + artifact.id + '/bundle', { headers: { Authorization: 'Bearer ' + app.owner }, signal: AbortSignal.timeout(20000) });
    assert.equal(bundled.status, 200);
    const signedPath = new URL((await bundled.json()).blobs['pixel.png'].url, app.base).pathname;
    await run('open', artifact.viewerUrl); await run('wait', '#frame[src^="blob:"]');
    await run('pdf', join(output, 'viewer-native.pdf'));
    const gray = (await exec('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', '-x', '48', '-y', '134', '-W', '500', '-H', '40', '-gray', join(output, 'viewer-native.pdf')], { timeout: 15000, encoding: 'buffer' })).stdout;
    let pos = 0;
    const whitespace = value => [9, 10, 13, 32].includes(value);
    const token = () => {
      while (pos < gray.length && (gray[pos] === 35 || whitespace(gray[pos]))) {
        if (gray[pos] === 35) while (pos < gray.length && gray[pos] !== 10) pos++;
        else pos++;
      }
      const start = pos; while (pos < gray.length && !whitespace(gray[pos])) pos++;
      assert.ok(pos < gray.length && pos > start, 'complete PGM header');
      return gray.subarray(start, pos).toString('ascii');
    };
    assert.equal(token(), 'P5'); const width = Number(token()), height = Number(token()); assert.equal(token(), '255'); pos++;
    const pixels = gray.subarray(pos, pos + width * height);
    assert.ok(pixels.some(value => value < 80) && pixels.some(value => value > 180), 'native print keeps readable foreground/background contrast, not dark text on the cached dark backdrop');
    await run('click', '#shareBtn'); await run('click', '#exportTab');
    assert.equal(await evaluate('!!document.getElementById("saveHtmlBtn")'), true, 'readers have a rendered HTML save action');
    const beforeForged = new Set(readdirSync(output));
    const controller = await frameEval((await run('get', 'cdp-url')).trim());
    const box = await evaluate('(()=>{const r=document.getElementById("frame").getBoundingClientRect();return{x:r.x,y:r.y}})()');
    try { await controller.click(box.x + 20, box.y + 20); } finally { controller.close(); }
    await run('wait', '#renderedCopyDialog[open]');
    await run('click', '#renderedCopyCancel');
    assert.equal(readdirSync(output).some(name => !beforeForged.has(name) && name.endsWith('.html')), false,
      'an artifact cannot turn an unrelated click into a parent download without parent confirmation');
    if (await evaluate('document.getElementById("shareMenu").hidden')) await run('click', '#shareBtn');
    await run('click', '#exportTab');
    const before = new Set(readdirSync(output));
    await run('click', '#saveHtmlBtn');
    await run('wait', '#renderedCopyDownload'); await nativeClick('#renderedCopyDownload');
    let file;
    for (let attempt = 0; attempt < 100 && !file; attempt++) {
      file = readdirSync(output).find(name => !before.has(name) && name.endsWith('.html'));
      if (!file) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(file, 'the browser actually downloaded an HTML file');
    const saved = readFileSync(join(output, file), 'utf8');
    assert.equal(saved.includes('COPYFIRSTMARKER') && saved.includes('COPYLASTMARKER'), true);
    assert.equal(saved.includes('SECOND-RENDERED-STATE'), false, 'the first copy predates the later UI change');
    assert.equal(saved.includes(signedPath), false, 'signed asset grants cannot survive in exported links or text');
    assert.equal(saved.includes('hidden-secret-must-not-export') || saved.includes('password-must-not-export'), false);
    assert.equal(saved.includes('window.artifact') || saved.includes('<script'), false, 'the copy has no live bridge or scripts');
    for (const key of ['viewerUrl', 'editUrl', 'commentUrl', 'cloneUrl']) if (artifact[key]) {
      const value = new URL(artifact[key]).hash.slice(1); if (value) assert.equal(saved.includes(value), false, 'no capability enters the saved file');
    }
    assert.match(saved, /data:image\/png;base64,/, 'the rendered canvas is retained');
    await run('open', pathToFileURL(join(output, file)).href);
    await run('wait', '--load', 'networkidle');
    assert.equal(await evaluate('location.protocol'), 'file:', 'sanitized CSS cannot turn into an active navigation after HTML reparsing');
    assert.equal(await evaluate('document.querySelectorAll(\'meta[http-equiv="refresh"]\').length'), 0);
    assert.equal(await evaluate('document.body.innerText.includes("COPYLASTMARKER")'), true);
    assert.equal(await evaluate('typeof window.artifact'), 'undefined');
    await run('pdf', join(output, 'saved-copy.pdf'));
    const printed = (await exec('pdftotext', [join(output, 'saved-copy.pdf'), '-'], { timeout: 15000 })).stdout;
    assert.equal(printed.includes('COPYFIRSTMARKER') && printed.includes('COPYLASTMARKER'), true, 'native PDF prints the whole portable copy');
    await run('open', artifact.viewerUrl); await run('wait', '#frame[src^="blob:"]');
    const priorKeyboard = new Set(readdirSync(output));
    const updateBox = await evaluate('(()=>{const r=document.getElementById("frame").getBoundingClientRect();return{x:r.x,y:r.y}})()');
    const updater = await frameEval((await run('get', 'cdp-url')).trim());
    try { await updater.click(updateBox.x + 20, updateBox.y + 55); } finally { updater.close(); }
    await run('click', '#frame');
    await run('press', 'Meta+s');
    await run('wait', '#renderedCopyDialog[open]');
    await run('click', '#renderedCopyConfirm');
    await run('wait', '#renderedCopyDownload'); await nativeClick('#renderedCopyDownload');
    let keyboardFile;
    for (let attempt = 0; attempt < 100 && !keyboardFile; attempt++) {
      keyboardFile = readdirSync(output).find(name => {
        if (!name.startsWith(file.replace(/\.html$/, '')) || !name.endsWith('.html')) return false;
        try { return readFileSync(join(output, name), 'utf8').includes('SECOND-RENDERED-STATE'); } catch { return false; }
      });
      if (!keyboardFile) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (keyboardFile) console.log('Keyboard save retained updated rendered state; existing filename replaced:', priorKeyboard.has(keyboardFile));
    assert.ok(keyboardFile, 'Cmd+S while focused inside the opaque artifact saves its rendered HTML: ' + await evaluate('document.getElementById("toastText").textContent'));
    // Stub only the external OS print dialog/window API. The real app prepares
    // the copy; Chrome then prints that exact HTML through its native PDF engine.
    await evaluate(`(()=>{
      window.__originalOpen=window.open;window.__printResult={url:'about:blank',printed:false,closed:false};
      window.open=()=>({opener:window,location:{replace:url=>{window.__printResult.url=url},get protocol(){return new URL(window.__printResult.url).protocol}},document:{readyState:'complete'},get closed(){return window.__printResult.closed},close(){window.__printResult.closed=true},focus(){},print(){window.__printResult.printed=true}});
      return true;
    })()`);
    if (await evaluate('document.getElementById("shareMenu").hidden')) await run('click', '#shareBtn');
    await run('click', '#exportTab'); await run('click', '#printCopyBtn');
    await run('wait', '--fn', 'window.__printResult.printed || window.__printResult.closed');
    assert.equal(await evaluate('window.__printResult.printed'), true, 'Print invokes the browser only after preparing its standalone document');
    const printUrl = await evaluate('window.__printResult.url');
    assert.ok(printUrl.startsWith('blob:'));
    await evaluate('window.open=window.__originalOpen; true');
    await run('tab', 'new', printUrl);
    assert.equal(await evaluate('document.querySelectorAll("iframe,script").length'), 0);
    assert.equal(await evaluate('typeof window.artifact'), 'undefined');
    await run('pdf', join(output, 'print-action.pdf'));
    const printAction = (await exec('pdftotext', [join(output, 'print-action.pdf'), '-'], { timeout: 15000 })).stdout;
    assert.equal(printAction.includes('COPYFIRSTMARKER') && printAction.includes('COPYLASTMARKER'), true, 'the Print action includes first and last content, including paper-width wrapping');
  } catch (error) {
    let state = 'unavailable';
    try { state = JSON.stringify(await evaluate('({toast:document.getElementById("toastText")?.textContent,prompt:!!document.querySelector("#renderedCopyDialog[open]"),ready:!!document.querySelector("#renderedCopyReady[open]")})')); } catch { /* original failure remains */ }
    error.message += '; application state: ' + state; throw error;
  } finally {
    try { await run('close'); } catch { /* cleanup only */ }
    app?.stop(); rmSync(state, { recursive: true, force: true });
  }
});
