// Opt-in phone/desktop QA for the real new-version poll and its update action.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function versionToastQA({ base, a, api, output }) {
  mkdirSync(output, { recursive: true });
  const session = `version-toast-qa-${process.pid}`;
  // Awaiting agent-browser keeps Node's event loop free to drain the Worker's
  // pipes; a synchronous wait starves them and the page looks stalled.
  const run = async (...args) => {
    try {
      const { stdout } = await execFileAsync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', timeout: 45000 });
      return stdout;
    } catch {
      throw new Error(`agent-browser ${args[0]} failed`);
    }
  };
  const evaluate = async source => {
    const result = JSON.parse(await run('--json', 'eval', source));
    assert.equal(result.success, true);
    return result.data.result;
  };
  let failure;
  try {
    await run('set', 'viewport', '390', '844');
    await run('open', `${base}/v/${a.id}#${a.read}`);
    await run('wait', '#bar:not([hidden])');
    const oldHash = await evaluate('document.getElementById("versionHash").textContent');
    const update = await api(`/api/artifacts/${a.id}`, { method: 'PUT', token: a.write, body: { parent: a.tip, user: 'Mobile QA', files: { 'index.html': Buffer.from('<h1>Updated page</h1>').toString('base64') } } });
    assert.equal(update.status, 200);
    // The production watcher polls every minute; keep that behavior unchanged.
    const deadline = Date.now() + 75000;
    while ((await evaluate('document.getElementById("toast").hidden')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(await evaluate('document.getElementById("toast").hidden'), false, 'a real published version triggers the toast');
    const notification = await evaluate('document.getElementById("toastText").textContent');
    assert.match(notification, /published a new version/);
    for (const width of [390, 320, 360, 844, 1440]) for (const theme of ['light', 'dark']) {
      await run('set', 'viewport', String(width), '844');
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      for (const [name, text, action] of [['version', notification, true], ['long-publisher', 'PublisherWithoutWordBreaks'.repeat(8) + ' published a new version', true], ['notice', 'Page saved', false]]) {
        await evaluate(`(document.getElementById('toastText').textContent=${JSON.stringify(text)}, document.getElementById('toastShow').hidden=${!action})`);
        const layout = await evaluate(`(() => {
          const toast=document.getElementById('toast'), text=document.getElementById('toastText'), button=document.getElementById('toastShow'), r=toast.getBoundingClientRect(), b=button.getBoundingClientRect(), range=document.createRange(); range.selectNodeContents(button);
          return { left:r.left, right:r.right, width:r.width, overflow:document.documentElement.scrollWidth>innerWidth || text.scrollWidth>text.clientWidth, lines:range.getClientRects().length, actionInside:b.left>=r.left && b.right<=r.right, hit:document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)===button };
        })()`);
        await run('screenshot', join(output, `toast-${name}-${theme}-${width}.png`));
        assert.ok(layout.left >= 11 && layout.right <= width - 11, 'toast stays within phone gutters');
        if (width <= 640) assert.ok(layout.width >= width - 26, 'phone toast uses available width instead of a narrow floating column');
        assert.equal(layout.overflow, false, `${name}: long text wraps without overflow`);
        if (action) {
          assert.equal(layout.lines, 1, 'Show it stays on one line');
          assert.ok(layout.actionInside && layout.hit, 'update action is inside the toast and clickable');
        }
      }
    }
    await evaluate(`(document.getElementById('toastText').textContent=${JSON.stringify(notification)}, document.getElementById('toastShow').hidden=false)`);
    await run('set', 'viewport', '390', '844');
    await run('click', '#toastShow');
    await run('wait', '--fn', `document.getElementById('toast').hidden && document.getElementById('versionHash').textContent!==${JSON.stringify(oldHash)}`);
    assert.ok(update.json.tip.startsWith(await evaluate('document.getElementById("versionHash").textContent')), 'Show it loads the newly published version');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await run('close'); } catch (error) { if (!failure) throw error; }
  }
}
