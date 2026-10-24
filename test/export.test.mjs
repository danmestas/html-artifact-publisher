import test from 'node:test';
import assert from 'node:assert/strict';
import { usesArtifactRuntime, preparePublication, validateResource, validateCSS, validateScriptResources } from '../public/export.js';
import { embedFonts } from '../public/fonts.js';

for (const source of [
  'window.artifact.data.get("x")',
  'artifact.read("file")',
  'artifact.data.set("x", 1)',
  'window["artifact"].canWrite()',
  "self['artifact']",
  'globalThis.artifact',
  'artifact?.data?.get("x")',
  '`Value: ${artifact.read("x")}`',
  '`Value: ${globalThis.artifact.data.get("x")}`',
]) {
  test(`static export detects runtime dependency: ${source}`, () => {
    assert.equal(usesArtifactRuntime(source), true);
  });
}

for (const source of [
  '// window.artifact.data.get("x")\nconsole.log("hello")',
  '/* artifact.read("x") */ document.title = "Static"',
  'const example = "window.artifact.data.get()";',
  'const label = `artifact.read()`;',
  'document.querySelector("button").onclick = () => alert("hello");',
]) {
  test(`static export permits ordinary JavaScript: ${source}`, () => {
    assert.equal(usesArtifactRuntime(source), false);
  });
}

test('static export refuses a bundle with missing files', async () => {
  await assert.rejects(preparePublication({}, { files: {}, missing: ['image.png'] }), /missing files/);
});

test('static export inspects external R2 scripts using art.blob', async () => {
  const entry = { type: 'text/javascript' };
  let fetched = false;
  const art = { blob: async actual => {
    assert.equal(actual, entry);
    fetched = true;
    return new TextEncoder().encode('artifact.data.get("private")');
  } };
  await assert.rejects(preparePublication(art, {
    files: { 'app.js': new Uint8Array() }, blobs: { 'app.js': entry },
  }), /Unsupported static export: app.js/);
  assert.equal(fetched, true);
});

test('public resource validation accepts local assets and CSP-permitted data images/fonts', () => {
  for (const ref of ['images/photo.png', '../styles/page.css', '/assets/app.js', '#symbol']) validateResource(ref, 'image', 'index.html');
  validateResource('data:image/png;base64,AAAA', 'image', 'index.html');
  validateCSS('@font-face{src:url(data:font/woff2;base64,AAAA)} .hero{background:url(data:image/png;base64,AAAA)}', 'page.css');
});

test('public resource validation rejects remote and transient blob resources', () => {
  for (const ref of ['https://cdn.example/app.js', '//cdn.example/app.js', 'blob:https://private.example/id', 'data:text/javascript,alert(1)']) {
    assert.throws(() => validateResource(ref, 'script', 'index.html'), /Include local supporting files/);
  }
});

for (const css of [
  '@import "https://fonts.example/css";',
  '@import url(//fonts.example/css);',
  'body{background:url("https://images.example/hero.png")}',
  '@font-face{src:url(https://fonts.example/font.woff2)}',
]) test(`public CSS rejects external dependency: ${css}`, () => {
  assert.throws(() => validateCSS(css, 'page.css'), /Include local supporting files/);
});

for (const script of [
  'import x from "https://cdn.example/x.js";',
  'export { x } from "//cdn.example/x.js";',
  'import("https://cdn.example/x.js")',
  'import x from "cdn-package";',
  'fetch("https://api.example/data")',
  'new Worker("https://cdn.example/worker.js")',
]) test(`public scripts reject non-local load: ${script}`, () => {
  assert.throws(() => validateScriptResources(script, 'app.js'), /Include local supporting files/);
});

for (const script of [
  'import "/app.js";',
  'import x from "/app.js";',
  'export { x } from "/app.js";',
  'import("/app.js")',
  'fetch("/data.json")',
  'new Worker("/worker.js")',
]) test(`public scripts reject root-relative load: ${script}`, () => {
  assert.throws(() => validateScriptResources(script, 'app.js'), /Use document\/module-relative paths/);
});

test('public scripts permit local imports and ordinary links represented as strings', () => {
  validateScriptResources('import x from "./x.js"; export {x} from "./x.js"; import("../y.js"); fetch("./data.json"); fetch("data.json"); new Worker("./worker.js"); const link = "https://example.com";', 'app.js');
});

test('static export requires an HTML document', async () => {
  await assert.rejects(preparePublication({}, { files: {} }), /no HTML document/);
});

test('font embedding retains viewer fallback but strict export rejects failed downloads', async t => {
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
  const styles = [];
  const doc = {
    querySelectorAll: selector => selector === 'style' ? [{ textContent: 'body{font-family:"Instrument Sans"}' }] : [],
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { prepend: style => styles.push(style) },
  };
  assert.deepEqual(await embedFonts(doc, ''), ['Instrument Sans']);
  assert.equal(styles.length, 1);
  assert.equal(styles[0].textContent, '');
  assert.equal(warnings.length, 1);
  await assert.rejects(embedFonts(doc, '', { strict: true }), /Cannot embed font Instrument Sans:.*HTTP 503/);
  assert.equal(styles.length, 1, 'strict failure must not inject incomplete font CSS');
});
