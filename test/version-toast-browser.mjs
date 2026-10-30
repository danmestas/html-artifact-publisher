// Opt-in phone/desktop QA for the real new-version poll and its update action.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export async function versionToastQA({ base, a, api, output }) {
  mkdirSync(output, { recursive: true });
  const session = `version-toast-qa-${process.pid}`;
  const run = (...args) => {
    try {
      return execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      throw new Error(`agent-browser ${args[0]} failed`);
    }
  };
  const evaluate = source => {
    const result = JSON.parse(run('--json', 'eval', source));
    assert.equal(result.success, true);
    return result.data.result;
  };
  let failure;
  try {
    run('set', 'viewport', '390', '844');
    run('open', `${base}/v/${a.id}#${a.read}`);
    run('wait', '#bar:not([hidden])');
    const oldHash = evaluate('document.getElementById("versionHash").textContent');
    const update = await api(`/api/artifacts/${a.id}`, { method: 'PUT', token: a.write, body: { parent: a.tip, user: 'Mobile QA', files: { 'index.html': Buffer.from('<h1>Updated page</h1>').toString('base64') } } });
    assert.equal(update.status, 200);
    // The production watcher polls every minute; keep that behavior unchanged.
    const deadline = Date.now() + 75000;
    while (evaluate('document.getElementById("toast").hidden') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(evaluate('document.getElementById("toast").hidden'), false, 'a real published version triggers the toast');
    const notification = evaluate('document.getElementById("toastText").textContent');
    assert.match(notification, /published a new version/);
    for (const width of [390, 320, 360, 844, 1440]) for (const theme of ['light', 'dark']) {
      run('set', 'viewport', String(width), '844');
      evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      for (const [name, text, action] of [['version', notification, true], ['long-publisher', 'PublisherWithoutWordBreaks'.repeat(8) + ' published a new version', true], ['notice', 'Page saved', false]]) {
        evaluate(`(document.getElementById('toastText').textContent=${JSON.stringify(text)}, document.getElementById('toastShow').hidden=${!action})`);
        const layout = evaluate(`(() => {
          const toast=document.getElementById('toast'), text=document.getElementById('toastText'), button=document.getElementById('toastShow'), r=toast.getBoundingClientRect(), b=button.getBoundingClientRect(), range=document.createRange(); range.selectNodeContents(button);
          return { left:r.left, right:r.right, width:r.width, overflow:document.documentElement.scrollWidth>innerWidth || text.scrollWidth>text.clientWidth, lines:range.getClientRects().length, actionInside:b.left>=r.left && b.right<=r.right, hit:document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===button };
        })()`);
        run('screenshot', join(output, `toast-${name}-${theme}-${width}.png`));
        assert.ok(layout.left >= 11 && layout.right <= width - 11, 'toast stays within phone gutters');
        if (width <= 640) assert.ok(layout.width >= width - 26, 'phone toast uses available width instead of a narrow floating column');
        assert.equal(layout.overflow, false, `${name}: long text wraps without overflow`);
        if (action) {
          assert.equal(layout.lines, 1, 'Show it stays on one line');
          assert.ok(layout.actionInside && layout.hit, 'update action is inside the toast and clickable');
        }
      }
    }
    evaluate(`(document.getElementById('toastText').textContent=${JSON.stringify(notification)}, document.getElementById('toastShow').hidden=false)`);
    run('set', 'viewport', '390', '844');
    run('click', '#toastShow');
    run('wait', '--fn', `document.getElementById('toast').hidden && document.getElementById('versionHash').textContent!==${JSON.stringify(oldHash)}`);
    assert.ok(update.json.tip.startsWith(evaluate('document.getElementById("versionHash").textContent')), 'Show it loads the newly published version');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { run('close'); } catch (error) { if (!failure) throw error; }
  }
}
