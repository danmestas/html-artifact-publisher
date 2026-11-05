// Opt-in real Chromium QA for the viewer's backdrop: the colour behind and
// beyond the artifact page. Run by BACKDROP_BROWSER_QA=1 node --test test/e2e.test.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { frameEval } from './helpers/frame-eval.mjs';

const b64 = s => Buffer.from(s).toString('base64');

const DARK = 'rgb(16, 20, 24)';
// The viewer's ground tokens (public/viewer.css).
const VIEWER_GROUND = { dark: 'rgb(21, 21, 20)', light: 'rgb(243, 242, 239)' };

const page = ({ html = '', body = '', colorScheme = '', extra = '' }) => `<!doctype html><html><head><style>
:root { ${colorScheme ? `color-scheme: ${colorScheme};` : ''} ${html} }
body { margin: 0; ${body} }
section { min-height: 1400px; padding: 24px; }
${extra}
</style></head><body><section><h1>Backdrop fixture</h1><p>content near the top</p></section><section><h2>bottom</h2></section></body></html>`;

// Each fixture is the pattern a page may ship; the browser run checks what the
// viewer paints behind it.
const FIXTURES = {
  opaqueDark: page({ html: 'background: #101418; color: #e6edf3; color-scheme: dark;' }),
  bodyDark: page({ body: 'background: #101418; color: #e6edf3;', extra: ':root { color-scheme: dark; }' }),
  transparent: page({}),
  runtimeTheme: page({
    html: 'background: #101418; color: #e6edf3;',
    extra: ':root.light { background: #faf9f7; color: #1d1c1a; }',
  }),
  followsScheme: page({
    html: 'background: #fbfaf8; color: #1d1c1a; color-scheme: light;',
    extra: '@media (prefers-color-scheme: dark) { :root { background: #141517; color: #e8e6e2; color-scheme: dark; } }',
  }),
  // A translucent canvas is not a canvas: it lets the viewer ground through, so
  // mirroring it behind the page would composite the same layer twice.
  partialHtml: page({ html: 'background: rgba(255, 0, 0, 0.5); color-scheme: dark;' }),
  partialBody: page({ body: 'background: rgba(255, 0, 0, 0.5);', extra: ':root { color-scheme: dark; }' }),
  // A document that styles nothing keeps the browser's own canvas, which carries
  // the default text colour with it. The viewer fallback must not paint over it.
  unstyled: '<!doctype html><html><body><h1>Unstyled report</h1><p>Ordinary body text.</p></body></html>',
};

export async function backdropQA({ base, owner, api, output }) {
  mkdirSync(output, { recursive: true });
  const artifacts = {};
  for (const [name, html] of Object.entries(FIXTURES)) {
    const r = await api('/api/artifacts', { method: 'POST', bearer: owner, body: { title: `Backdrop ${name}`, ttlSeconds: null, files: { 'index.html': b64(html) } } });
    assert.equal(r.status, 201, r.text);
    artifacts[name] = { ...r.json, read: (r.json.viewerUrl || '').split('#')[1] };
  }
  const session = `backdrop-qa-${process.pid}`;
  const run = (...args) => {
    try {
      return execFileSync('agent-browser', ['--session', session, ...args], {
        encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '600000' },
      });
    } catch (e) {
      throw new Error(`agent-browser ${args[0]} failed: ${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 1500));
    }
  };
  const evaluate = source => {
    const result = JSON.parse(run('--json', 'eval', `(${source})`));
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data.result;
  };
  const frame = () => evaluate(`(() => {
    const s = getComputedStyle(document.getElementById('frame'));
    return { bg: s.backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme };
  })()`);
  const open = async (a, theme, media) => {
    run('set', 'viewport', '390', '844');
    run('set', 'media', media);
    run('open', `${base}/v/${a.id}#${a.read}`);
    run('wait', '#bar:not([hidden])');
    run('wait', '#frame');
    run('select', '#viewer-theme', theme);
    run('wait', '900');
  };
  let failure;
  try {
    // A dark page owns its canvas: the frame is backed by that colour, not white.
    await open(artifacts.opaqueDark, 'dark', 'dark');
    assert.equal((await frame()).bg, DARK, 'the frame is backed by an opaque dark page canvas');
    run('screenshot', join(output, 'opaque-dark-explicit-dark.png'));

    // The authoring pattern sets the colour on body only; propagation still holds.
    await open(artifacts.bodyDark, 'dark', 'dark');
    assert.equal((await frame()).bg, DARK, 'a body-only dark canvas backs the frame');

    // An explicit viewer choice opposite the OS does not overwrite the page.
    await open(artifacts.opaqueDark, 'light', 'dark');
    assert.equal((await frame()).bg, DARK, 'the page canvas, not the viewer theme, backs a dark page under Light');

    // A transparent page shows the viewer's own ground, never a fixed white.
    await open(artifacts.transparent, 'dark', 'dark');
    assert.equal((await frame()).bg, VIEWER_GROUND.dark, 'a transparent page is backed by the dark viewer ground');
    run('screenshot', join(output, 'transparent-explicit-dark.png'));
    await open(artifacts.transparent, 'light', 'light');
    assert.equal((await frame()).bg, VIEWER_GROUND.light, 'a transparent page is backed by the light viewer ground');

    // A translucent canvas lets the viewer ground show through the page. If the
    // frame mirrored it, the same layer would composite twice and the visible
    // red would be darker than the page's own.
    for (const [name, label] of [['partialHtml', 'an html canvas at 50% alpha'], ['partialBody', 'a body canvas at 50% alpha']]) {
      await open(artifacts[name], 'dark', 'dark');
      assert.equal((await frame()).bg, VIEWER_GROUND.dark, `${label} keeps the viewer ground behind the page`);
      run('screenshot', join(output, `partial-${name}.png`));
    }

    // An unstyled document keeps the browser's own canvas and its matching
    // default text colour. The viewer must not paint a canvas into the page, so
    // the text stays black on the browser's white and remains readable.
    await open(artifacts.unstyled, 'dark', 'dark');
    assert.equal((await frame()).bg, VIEWER_GROUND.dark, 'an unstyled document leaves the frame on the viewer ground');
    const unstyled = await frameEval(run('get', 'cdp-url').trim());
    try {
      const doc = await unstyled.eval(`({ bg: getComputedStyle(document.documentElement).backgroundColor, text: getComputedStyle(document.body).color })`);
      assert.equal(doc.bg, 'rgba(0, 0, 0, 0)', 'the viewer paints no canvas into an unstyled document');
      assert.equal(doc.text, 'rgb(0, 0, 0)', 'the unstyled document keeps default black text');
    } finally {
      await unstyled.close();
    }
    run('screenshot', join(output, 'unstyled-explicit-dark.png'));

    // A page that switches theme at runtime moves its backdrop with it.
    await open(artifacts.runtimeTheme, 'system', 'dark');
    assert.equal((await frame()).bg, DARK, 'the runtime-theme page starts dark');
    // The page switches its own theme from inside the sandboxed frame.
    const page = await frameEval(run('get', 'cdp-url').trim());
    try {
      await page.eval(`(document.documentElement.classList.add('light'), true)`);
    } finally {
      await page.close();
    }
    run('wait', '--fn', `getComputedStyle(document.getElementById('frame')).backgroundColor === 'rgb(250, 249, 247)'`);
    assert.equal((await frame()).bg, 'rgb(250, 249, 247)', 'a runtime theme change repaints the backdrop');
    run('screenshot', join(output, 'runtime-theme-light.png'));

    // The reader's appearance change reaches a theme-following page.
    await open(artifacts.followsScheme, 'system', 'dark');
    assert.equal((await frame()).bg, 'rgb(20, 21, 23)', 'a scheme-following page starts dark');
    run('select', '#viewer-theme', 'light');
    run('wait', '--fn', `getComputedStyle(document.getElementById('frame')).backgroundColor === 'rgb(251, 250, 248)'`);
    assert.equal((await frame()).bg, 'rgb(251, 250, 248)', 'Light repaints a scheme-following page');
    run('select', '#viewer-theme', 'dark');
    run('wait', '--fn', `getComputedStyle(document.getElementById('frame')).backgroundColor === 'rgb(20, 21, 23)'`);
    assert.equal((await frame()).bg, 'rgb(20, 21, 23)', 'Dark paints it back');
    run('screenshot', join(output, 'follows-scheme-dark.png'));
  } catch (error) {
    failure = error;
    try { run('screenshot', join(output, 'failure.png')); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    try { run('close'); } catch (error) { if (!failure) throw error; }
  }
}
