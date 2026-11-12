// Opt-in first-party viewer QA. The HTTP suite owns server and fixture cleanup.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function guestDiscussionQA({ base, artifact: a, api }) {
  const sessions = [`guest-qa-${process.pid}`, `guest-reader-${process.pid}`];
  const run = async (session, ...args) => {
    try {
      return (await exec('agent-browser', ['--session', session, ...args], {
        encoding: 'utf8', timeout: 45000,
        env: { ...process.env, AGENT_BROWSER_IDLE_TIMEOUT_MS: '120000' },
      })).stdout;
    } catch { throw new Error(`Guest browser QA failed during ${args[0]} (private fixture details withheld)`); }
  };
  const evaluate = async (session, source) => {
    await run(session, 'frame', 'main');
    const response = JSON.parse(await run(session, '--json', 'eval', source));
    assert.equal(response.success, true, 'browser evaluation succeeded');
    return response.data.result;
  };
  try {
    const [guest, reader] = sessions;
    await run(guest, 'open', `${base}/v/${a.id}#${a.read}`);
    await run(guest, 'wait', '#bar:not([hidden])');
    await run(guest, 'click', '#commentsBtn');
    await run(guest, 'wait', '#guestProfile:not([hidden])');
    await run(guest, 'fill', '#guestName', 'Browser Guest');
    await run(guest, 'fill', '#guestEmail', 'private-browser@example.com');
    await run(guest, 'click', '#saveGuestProfile');
    await run(guest, 'wait', '--text', 'Comment identity saved.');
    await run(guest, 'click', '#generalComment');
    await run(guest, 'wait', '#commentForm:not([hidden])');
    await run(guest, 'fill', '#commentText', 'A shared browser discussion');
    await run(guest, 'click', '#commentForm button[type=submit]');
    await run(guest, 'wait', '--fn', `!![...document.querySelectorAll('#threadList .thread')].find(t => t.textContent.includes('A shared browser discussion'))`);
    const result = await api(`/api/artifacts/${a.id}/tickets`, { token: a.read });
    assert.ok(result.json.tickets.some(t => t.fields.comment === 'A shared browser discussion'));
    assert.equal(result.text.includes('private-browser@example.com'), false, 'private email is absent from shared threads');
    await run(reader, 'open', `${base}/v/${a.id}#${a.read}`);
    await run(reader, 'wait', '#bar:not([hidden])');
    await run(reader, 'click', '#commentsBtn');
    await run(reader, 'wait', '--text', 'A shared browser discussion');
    assert.equal(await evaluate(reader, `!!document.querySelector('#threadPanel .resolve:not([hidden]), #threadPanel .attach:not([hidden])')`), false, 'read viewers have no moderation or attachment controls');
    assert.equal(await evaluate(reader, `document.body.innerText.includes('private-browser@example.com')`), false, 'another browser cannot see the private email');
    for (const theme of ['light', 'dark']) {
      await run(guest, 'set', 'viewport', '375', '812');
      await run(guest, 'set', 'media', theme);
      assert.equal(await evaluate(guest, 'document.documentElement.scrollWidth <= innerWidth'), true, `phone ${theme} has no page overflow`);
    }
  } finally {
    for (const session of sessions) await run(session, 'close').catch(() => {});
  }
}
