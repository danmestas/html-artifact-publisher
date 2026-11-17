// Opt-in real Chromium QA for fonts in the viewer's opaque-origin page frame:
// the house faces the CSS names and a font bundled in the published directory
// must load, while an external webfont file (Google Fonts) must be refused.
// Run by FONTS_BROWSER_QA=1 node --test test/e2e.test.mjs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { frameEval } from './helpers/frame-eval.mjs';

const execFileAsync = promisify(execFile);
const b64 = s => Buffer.from(s).toString('base64');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fonts fixture</title>
<script>
window.__csp = [];
document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
</script>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto">
<script src="https://blocked-resource.invalid/script.js"></script>
<style>
@font-face { font-family: "Display Face"; src: url(fonts/display.woff2) format("woff2"); font-display: swap; }
@font-face { font-family: "Remote Face"; src: url(https://fonts.gstatic.com/s/roboto/v51/remote.woff2) format("woff2"); }
body { font-family: "Instrument Sans", system-ui, -apple-system, sans-serif; }
h1 { font-family: "Display Face", sans-serif; }
code { font-family: "IBM Plex Mono", ui-monospace, monospace; }
.remote { font-family: "Remote Face", sans-serif; }
</style></head><body><h1>Bundled face</h1><p>House body <code>mono</code></p>
<p class="remote">An external webfont that must not load</p></body></html>`;

export async function fontsQA({ base, api, owner, output }) {
  mkdirSync(output, { recursive: true });
  const display = readFileSync(new URL('../public/fonts/instrument-sans.woff2', import.meta.url));
  const created = await api('/api/artifacts', {
    method: 'POST', bearer: owner,
    body: { title: 'Fonts fixture', ttlSeconds: null, files: {
      'index.html': b64(PAGE),
      'fonts/display.woff2': display.toString('base64'),
    } },
  });
  assert.equal(created.status, 201, created.text);
  const artifact = { ...created.json, read: (created.json.viewerUrl || '').split('#')[1] };

  const session = `fonts-qa-${process.pid}`;
  // Awaiting agent-browser keeps Node's event loop free to drain the Worker's
  // pipes; a synchronous wait starves them and the page looks stalled.
  const run = async (...args) => {
    try {
      const { stdout } = await execFileAsync('agent-browser', ['--session', session, ...args], {
        encoding: 'utf8', timeout: 45000,
        env: { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '600000' },
      });
      return stdout;
    } catch (e) {
      // Command output can contain a private artifact link; never echo it.
      throw new Error(`agent-browser ${args[0]} failed (exit ${e.code ?? 'unknown'})`);
    }
  };

  let failure;
  try {
    await run('set', 'viewport', '900', '900');
    await run('open', `${base}/v/${artifact.id}#${artifact.read}`);
    await run('wait', '#bar:not([hidden])');
    await run('wait', '#frame');
    await run('wait', '--fn', `document.getElementById('frame').style.display === 'block'`);

    const page = await frameEval((await run('get', 'cdp-url')).trim());
    try {
      await page.eval('document.fonts.ready.then(() => true)');
      const fonts = await page.eval(`(() => {
        const faces = [...document.fonts].map(f => ({ family: f.family.replace(/["']/g, ''), status: f.status }));
        return {
          body: getComputedStyle(document.body).fontFamily,
          code: getComputedStyle(document.querySelector('code')).fontFamily,
          title: getComputedStyle(document.querySelector('h1')).fontFamily,
          remote: getComputedStyle(document.querySelector('.remote')).fontFamily,
          resources: performance.getEntriesByType('resource').map(e => ({ name: e.name, size: e.transferSize, duration: e.duration })),
          violations: window.__csp,
          faces,
          houseSans: document.fonts.check('16px "Instrument Sans"'),
          houseMono: document.fonts.check('16px "IBM Plex Mono"'),
          bundled: document.fonts.check('16px "Display Face"'),
          remoteFace: document.fonts.check('16px "Remote Face"'),
        };
      })()`);
      assert.match(fonts.body, /"Instrument Sans"/, 'the house family reaches the page style');
      assert.match(fonts.title, /"Display Face"/, 'the bundled family reaches the page style');
      for (const family of ['Instrument Sans', 'IBM Plex Mono', 'Display Face']) {
        assert.ok(fonts.faces.some(face => face.family === family && face.status === 'loaded'), `${family} has a genuinely loaded FontFace`);
      }
      assert.equal(fonts.houseSans, true, 'the house Instrument Sans face is loaded');
      assert.equal(fonts.houseMono, true, 'the house IBM Plex Mono face is loaded');
      assert.equal(fonts.bundled, true, 'the bundled relative @font-face is loaded');
      assert.equal(fonts.remoteFace, false, 'the external webfont face is not available');
      assert.ok(fonts.violations.some(v => /^style-src\b/.test(v) && /fonts\.googleapis\.com/.test(v)),
        'the external Google stylesheet is refused by CSP');
      assert.ok(fonts.violations.some(v => /^script-src\b/.test(v) && /blocked-resource\.invalid/.test(v)),
        'the unresolved external script is refused by CSP');
      // The @font-face rule is present, so the refusal must come from the page
      // CSP, not from the page never asking.
      const remote = fonts.resources.filter(r => /fonts\.gstatic\.com/.test(r.name));
      assert.ok(remote.every(r => r.size === 0), `no external webfont bytes arrived: ${JSON.stringify(remote)}`);
      assert.ok(fonts.violations.some(v => /^font-src\b/.test(v) && /fonts\.gstatic\.com/.test(v)),
        `the external webfont was refused by font-src: ${JSON.stringify(fonts.violations)}`);
      // Faces the page never displays (here, Plex Mono bold and italic) stay
      // unloaded by design; an error is the failure this checks for.
      for (const face of fonts.faces.filter(f => !/remote face/i.test(f.family))) {
        assert.notEqual(face.status, 'error', `${face.family} did not fail to load`);
      }
    } finally {
      page.close();
    }
    await run('screenshot', join(output, 'fonts.png'));
  } catch (error) {
    failure = error;
    try { await run('screenshot', join(output, 'failure.png')); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    try { await run('close'); } catch (error) { if (!failure) throw error; }
    await api(`/api/artifacts/${artifact.id}`, { method: 'DELETE', bearer: owner });
  }
}
