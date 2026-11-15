// Opt-in real Chromium QA for the sign-in interface. It owns an isolated
// Wrangler instance and uses only the loopback test-mail transport, so no
// production mail, account or fixture is involved.
//
//   SIGNIN_BROWSER_QA=1 node test/signin-browser.mjs
//
// Requires the agent-browser executable. It can also be imported and called
// from the account suite, which owns its own Worker:
//
//   const { signinBrowserQA } = await import('./signin-browser.mjs');
//   await signinBrowserQA({ base, api, owner, artifact });
//
// `api(path, { method, body, cookie, bearer })` answers like accounts.test.mjs.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { browserDriver } from './library-browser.mjs';

export const signinBrowserChecks = [
  'the request carries a challenge and the destination; the sent state offers the code',
  'a wrong code explains itself and the form stays usable',
  'the right code returns to the library destination',
  'a signed-in visit to /login?returnTo= never asks for email',
  'an artifact destination is named and returns to the same version',
  'a denied tokenless entry offers a generic sign-in without a token',
  'a selected version is the only extra detail in the destination',
  'signing in elsewhere keeps the page and never upgrades the link role',
  'a broadcast hint is not a session',
  'an expired link asks for a new one without consuming anything',
  'a captured link requires explicit confirmation and offers remembering',
  'a refused security change offers a fresh sign-in and changes nothing',
  '/login?reauth=1 never forwards an existing session',
];

const email = 'owner@example.com';
const redact = s => String(s).replace(/[a-f0-9]{64}/g, '[redacted]');

/** Drive one signed-out browser through the sign-in interface. */
export async function signinBrowserQA({ base, api, owner, artifact, output, clearRateLimits, ageSession }) {
  const dir = output ?? join(tmpdir(), 'hap-signin-browser-qa');
  mkdirSync(dir, { recursive: true });
  const { run } = browserDriver('signin-browser-qa', { asyncCommands: true });
  const evaluate = async source => {
    const response = JSON.parse(await run('--json', 'eval', source));
    assert.equal(response.success, true, JSON.stringify(response).slice(0, 400));
    return response.data.result;
  };
  const waitFn = async (source, label) => {
    try { await run('wait', '--fn', source); }
    catch (error) { throw new Error(`wait ${label}: ${redact(error.stderr || error.message)}`); }
  };
  const setSession = cookie => run('cookies', 'set', 'artifact_session', cookie.split('=')[1],
    '--url', base, '--httpOnly', '--sameSite', 'Lax');
  // Record what the page itself sends and what the loopback transport answers
  // for it, without changing either: the page's own challenge receives its code.
  const recordLogin = () => evaluate(`(()=>{
    window.__login={};
    const original=window.fetch;
    window.fetch=async (input,init)=>{
      const path=String(input);
      if((path==='/api/auth/request'||path==='/api/auth/verify')&&init&&init.body){
        try { window.__login[path.replace('/api/auth/','')]=JSON.parse(init.body); } catch {}
      }
      const response=await original(input,init);
      if(path==='/api/auth/request'){ try { window.__login.response=await response.clone().json(); } catch {} }
      return response;
    };
    return true;
  })()`);
  const asked = async (returnTo, rememberDevice = false) => {
    clearRateLimits?.();
    const requested = await api('/api/auth/request', { method: 'POST', body: { email, returnTo } });
    assert.ok(requested.json?.loginUrl, `the loopback transport answered: ${requested.text}`);
    const verified = await api('/api/auth/verify', { method: 'POST', body: { token: new URL(requested.json.loginUrl).hash.slice(7), rememberDevice } });
    assert.equal(verified.status, 200, verified.text);
    return verified.headers.get('set-cookie').split(';')[0];
  };
  const fixtures = [];

  try {
    let artifactId = artifact?.id;
    let linkToken = artifact?.linkToken;
    if (!artifactId) {
      const created = await api('/api/artifacts', { method: 'POST', bearer: owner.bearer, cookie: owner.cookie,
        body: { title: 'Sign-in browser fixture', ttlSeconds: null, files: { 'index.html': Buffer.from('<h1>Sign-in fixture</h1>').toString('base64') } } });
      assert.equal(created.status, 201, created.text);
      artifactId = created.json.id;
      linkToken = new URL(created.json.viewerUrl).hash.slice(1);
      fixtures.push(artifactId);
    }

    await run('set', 'viewport', '390', '844');

    // ── Library: code sign-in ──────────────────────────────────────────────
    await run('open', base + '/login?returnTo=' + encodeURIComponent('/?view=starred&q=release'));
    await waitFn('!document.getElementById("login").hidden', 'login visible');
    assert.equal(await evaluate('document.getElementById("login-title").textContent'), 'Sign in to Artifacts');
    await recordLogin();
    await run('fill', '#login-email', email);
    await run('click', '#login-submit');
    await waitFn('!document.getElementById("sent-panel").hidden', 'sent panel');
    const request = await evaluate('window.__login.request');
    assert.equal(request.email, email);
    assert.match(request.challenge, /^[a-f0-9]{64}$/, 'the browser generates a challenge before the request');
    assert.equal(request.returnTo, '/?view=starred&q=release', 'the library destination travels with the request');
    assert.match((await evaluate('window.__login.response')).loginCode, /^\d{8}$/, 'the same request issued a code');
    assert.equal(await evaluate('document.getElementById("login-code").getAttribute("autocomplete")'), 'one-time-code');
    assert.equal(await evaluate('document.getElementById("login-code").getAttribute("inputmode")'), 'numeric');
    assert.equal(await evaluate('document.activeElement.id'), 'login-code', 'the code field takes focus');
    assert.equal(await evaluate('document.getElementById("code-remember").checked'), false, 'remembering is opt-in');
    assert.equal(await evaluate('document.getElementById("link-remember").checked'), false, 'link remembering is opt-in');
    assert.ok((await evaluate('document.getElementById("sent-text").textContent')).includes('10 minutes'), 'the code lifetime is stated');
    await run('screenshot', join(dir, 'library-sent-code-phone.png'));

    await run('fill', '#login-code', '00000000');
    await run('click', '#code-submit');
    await waitFn('!document.getElementById("login-feedback").hidden', 'wrong-code feedback');
    assert.equal(await evaluate('document.getElementById("login-feedback").classList.contains("is-error")'), true);
    assert.equal(await evaluate('document.getElementById("code-submit").disabled'), false, 'a wrong code can be retried');
    assert.equal(await evaluate('document.getElementById("sent-panel").hidden'), false, 'the code form stays available');

    await run('open', base + '/login?returnTo=' + encodeURIComponent('/?view=starred&q=release'));
    await waitFn('!document.getElementById("login").hidden', 'login visible');
    await recordLogin();
    await run('fill', '#login-email', email);
    await run('click', '#login-submit');
    await waitFn('!document.getElementById("sent-panel").hidden', 'sent panel');
    await run('fill', '#login-code', (await evaluate('window.__login.response')).loginCode);
    await run('click', '#code-submit');
    await waitFn('!document.getElementById("app").hidden', 'library app');
    assert.equal(await evaluate('location.pathname + location.search'), '/?view=starred&q=release', 'the destination is restored');
    assert.equal(await evaluate('document.getElementById("account-email").textContent'), email);

    await run('open', base + '/login?returnTo=' + encodeURIComponent('/?view=starred'));
    await waitFn('!document.getElementById("app").hidden', 'library app');
    assert.equal(await evaluate('location.pathname + location.search'), '/?view=starred');
    assert.equal(await evaluate('document.getElementById("login").hidden'), true, 'no sign-in screen for a signed-in visit');

    // ── Library: an artifact destination ───────────────────────────────────
    await run('cookies', 'clear');
    const destination = `/v/${artifactId}#@deadbeef1234`;
    await run('open', base + '/login?returnTo=' + encodeURIComponent(destination));
    await waitFn('!document.getElementById("login").hidden', 'login visible');
    assert.ok((await evaluate('document.getElementById("login-description").textContent')).includes('continue to this artifact'), 'copy is artifact-aware');
    await recordLogin();
    await run('fill', '#login-email', email);
    await run('click', '#login-submit');
    await waitFn('!document.getElementById("sent-panel").hidden', 'sent panel');
    assert.equal((await evaluate('window.__login.request')).returnTo, destination, 'the artifact version travels with the request');
    await run('fill', '#login-code', (await evaluate('window.__login.response')).loginCode);
    await run('click', '#code-submit');
    await waitFn(`location.pathname===${JSON.stringify('/v/' + artifactId)}`, 'viewer after code sign-in');
    assert.equal(decodeURIComponent(await evaluate('location.pathname + location.hash')), destination, 'the same version reopens');
    await waitFn('document.getElementById("signinAction").hidden===true', 'reader known after sign-in');
    assert.equal(await evaluate('document.getElementById("shellSignin").hidden'), true, 'a signed-in reader is offered no sign-in');

    // ── Viewer: a tokenless entry leads with a neutral sign-in, not an error ─
    await run('cookies', 'clear');
    await run('open', base + `/v/${artifactId}`);
    await waitFn('!document.getElementById("shellSignin").hidden', 'sign-in offer');
    await waitFn(`document.getElementById("msg").textContent==="Sign in to continue"`, 'neutral entry text');
    const expected = `${base}/login?returnTo=${encodeURIComponent('/v/' + artifactId)}`;
    assert.equal(await evaluate('document.getElementById("msg").classList.contains("err")'), false, 'the entry is not styled as an error');
    assert.equal(await evaluate('document.getElementById("shellSigninHint").textContent'), 'Use the email address it was shared with. Signing in does not grant new access; the link may also be unavailable or expired.', 'the hint is neutral and grants nothing');
    assert.equal(await evaluate('document.getElementById("shellSignin").textContent'), 'Sign in');
    assert.equal(await evaluate('document.getElementById("shellSignin").href'), expected, 'the destination is the artifact path, without a token');
    assert.equal(await evaluate('document.getElementById("signinAction").href'), expected);
    for (const id of ['shellSignin', 'signinAction']) {
      assert.equal(await evaluate(`document.getElementById("${id}").target`), '_blank', `${id} opens in a separate tab`);
      assert.equal(await evaluate(`document.getElementById("${id}").rel`), 'noopener', `${id} cannot reach back into this page`);
    }
    await run('screenshot', join(dir, 'viewer-denied-signin-phone.png'));
    // Light theme, for contrast and legibility review of the neutral entry.
    await run('set', 'media', 'light');
    await run('screenshot', join(dir, 'viewer-denied-signin-light-phone.png'));
    await run('set', 'media', 'dark');

    // A signed-in reader gets the honest error: sign-in is already done, so it
    // cannot be the answer, and the page must not pretend otherwise.
    await run('cookies', 'clear');
    const deniedCookie = await asked(`/v/${artifactId}`);
    await setSession(deniedCookie);
    await run('open', base + '/v/doesNotExist000000000');
    await waitFn('document.getElementById("msg").classList.contains("err")', 'signed-in failure is an error');
    assert.equal(await evaluate('document.getElementById("msg").textContent'), 'This artifact does not exist, has expired, or the link is wrong.');
    assert.equal(await evaluate('document.getElementById("shellSignin").hidden'), true, 'no sign-in prompt for a known reader');
    assert.equal(await evaluate('document.getElementById("signinAction").hidden'), true);

    // An invalid capability link keeps its own honest error too.
    await run('cookies', 'clear');
    await run('open', base + `/v/${artifactId}#${'0'.repeat(64)}`);
    await waitFn('document.getElementById("msg").classList.contains("err")', 'invalid link is an error');
    assert.equal(await evaluate('document.getElementById("msg").textContent'), 'This artifact does not exist, has expired, or the link is wrong.');
    assert.equal(await evaluate('document.getElementById("shellSignin").hidden'), true, 'a wrong capability link offers no sign-in, which would grant nothing');

    // A version hash with no capability is still an ordinary tokenless entry,
    // so it gets the same neutral words and the same version-aware destination.
    await run('cookies', 'clear');
    await run('open', base + `/v/${artifactId}#@deadbeef1234`);
    await waitFn(`document.getElementById("msg").textContent==="Sign in to continue"`, 'neutral version entry');
    assert.equal(await evaluate('document.getElementById("msg").classList.contains("err")'), false);
    const versioned = `${base}/login?returnTo=${encodeURIComponent(`/v/${artifactId}#@deadbeef1234`)}`;
    await waitFn(`document.getElementById("signinAction").href===${JSON.stringify(versioned)}`, 'version-aware destination');

    // ── Viewer: signing in elsewhere keeps the page, its draft and the role ─
    const cookie = await asked(`/v/${artifactId}`);
    await run('cookies', 'clear');
    await run('open', base + `/v/${artifactId}#${linkToken}`);
    await waitFn('document.getElementById("frame").style.display==="block"', 'artifact renders');
    const roleBefore = await evaluate('document.getElementById("role").textContent');
    assert.equal(await evaluate('document.getElementById("signinAction").hidden'), false, 'a signed-out reader sees the sign-in action');
    // The working viewer with the sign-in action in its toolbar, for width review.
    await run('screenshot', join(dir, 'viewer-signed-out-working-phone.png'));
    await run('set', 'media', 'light');
    await run('screenshot', join(dir, 'viewer-signed-out-working-light-phone.png'));
    await run('set', 'media', 'dark');
    // A real unsent comment, written in the composer before signing in.
    const draft = 'Unsigned draft kept across sign-in';
    await run('click', '#discussionsBtn');
    await waitFn('!document.getElementById("threadPanel").hidden', 'discussion panel');
    await run('click', '#generalComment');
    await run('fill', '#commentText', draft);
    assert.equal(await evaluate('document.getElementById("commentText").value'), draft, 'the composer holds the draft');
    await setSession(cookie);
    await evaluate('window.dispatchEvent(new Event("focus"));true');
    await waitFn('document.getElementById("signinAction").hidden===true', 'sign-in action hidden once known');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(await evaluate('document.getElementById("commentText").value'), draft, 'the unsent draft survives sign-in in another tab');
    assert.equal(await evaluate('document.getElementById("role").textContent'), roleBefore, 'an account does not upgrade the link role');
    assert.equal(await evaluate('document.getElementById("frame").style.display'), 'block', 'the page is still rendered');
    assert.ok((await evaluate('location.hash')).includes(linkToken), 'the capability token is unchanged');
    assert.equal(await evaluate('document.getElementById("navBtn").hidden'), false, 'the account gets its library navigation');
    const drafted = await evaluate(`fetch('/api/artifacts/${artifactId}/tickets',{credentials:'same-origin',headers:{Authorization:'Token ${linkToken}'}}).then(r=>r.json())`);
    assert.ok(!(drafted.tickets ?? []).some(t => (t.title ?? '').includes(draft)), 'the draft was never submitted');

    await run('cookies', 'clear');
    await run('open', base + `/v/${artifactId}#${linkToken}`);
    await waitFn('document.getElementById("frame").style.display==="block"', 'artifact renders');
    await evaluate(`(()=>{const c=new BroadcastChannel('artifact-signin');c.postMessage({type:'signed-in'});c.close();return true})()`);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(await evaluate('document.getElementById("signinAction").hidden'), false, 'a hint is not a session');

    // ── Library: links ─────────────────────────────────────────────────────
    await run('open', base + '/login#token=' + '0'.repeat(64));
    await waitFn('!document.getElementById("verify-panel").hidden', 'verify step');
    assert.equal(await evaluate('document.getElementById("verify-button").textContent'), 'Continue to your library');
    await run('click', '#verify-button');
    await waitFn('!document.getElementById("login-form").hidden', 'form after an invalid link');
    assert.equal(await evaluate('document.getElementById("login-title").textContent'), 'This link has expired');
    assert.equal(await evaluate('document.activeElement.id'), 'login-email');

    clearRateLimits?.();
    const linkRequest = await api('/api/auth/request', { method: 'POST', body: { email, returnTo: `/v/${artifactId}` } });
    assert.ok(linkRequest.json?.loginUrl, linkRequest.text);
    await run('cookies', 'clear');
    await run('open', linkRequest.json.loginUrl);
    await waitFn('!document.getElementById("verify-panel").hidden', 'verify step');
    assert.equal(await evaluate('document.getElementById("verify-button").textContent'), 'Continue to your artifact');
    assert.equal(await evaluate('location.hash'), '', 'the token leaves the URL before any request');
    await run('click', '#verify-button');
    await waitFn('document.getElementById("signinAction").hidden===true', 'reader known after confirmation');
    await waitFn('document.getElementById("frame").style.display==="block"', 'the artifact renders');
    await run('screenshot', join(dir, 'library-link-confirm-phone.png'));

    // ── Fresh auth: a refused security change keeps the page and offers one ─
    if (ageSession) {
      // A second active account exists to be granted access; inviting and
      // activating are themselves gated, so they happen on a fresh session.
      clearRateLimits?.();
      const freshCookie = await asked('/');
      const invited = await api('/api/invitations', { method: 'POST', cookie: freshCookie, body: { email: 'granted@example.com', name: 'Granted person' } });
      assert.equal(invited.status, 200, invited.text);
      const activated = await api('/api/auth/verify', { method: 'POST', body: { token: new URL(invited.json.loginUrl).hash.slice(7) } });
      assert.equal(activated.status, 200, activated.text);
      await run('cookies', 'clear');
      const remembered = await asked(`/v/${artifactId}`, true);
      await setSession(remembered);
      ageSession();
      await run('open', base + `/v/${artifactId}`);
      await waitFn('document.getElementById("frame").style.display==="block"', 'artifact renders for the account');
      assert.equal(await evaluate('document.getElementById("signinAction").hidden'), true, 'a known reader has no sign-in prompt');
      await evaluate(`(()=>{document.getElementById('shareBtn').click();return true})()`);
      await waitFn('!document.getElementById("shareMenu").hidden', 'share panel open');
      await waitFn(`(()=>{const p=document.getElementById('peoplePick');return p&&p.options.length>1})()`, 'a person can be granted access');
      await evaluate(`(()=>{const p=document.getElementById('peoplePick');p.value=p.options[1].value;document.getElementById('peopleForm').requestSubmit();return true})()`);
      await waitFn('document.getElementById("reauthAction")&&!document.getElementById("reauthAction").hidden', 'fresh sign-in action after a refused change');
      const refusal = await evaluate('document.getElementById("toastText").textContent');
      assert.ok(refusal.includes('Sign in again') && refusal.includes('Nothing was changed'), `the refusal is explicit: ${refusal}`);
      const reauthHref = await evaluate('document.getElementById("reauthAction").href');
      const reauthTarget = new URL(reauthHref);
      assert.equal(reauthTarget.pathname, '/login');
      assert.equal(reauthTarget.searchParams.get('reauth'), '1', 'the fresh sign-in is marked');
      assert.equal(reauthTarget.searchParams.get('returnTo'), `/v/${artifactId}`, 'the same artifact is kept');
      assert.equal(await evaluate('document.getElementById("reauthAction").target'), '_blank', 'it opens in a separate tab');
      assert.equal(await evaluate('document.getElementById("reauthAction").rel'), 'noopener');
      assert.equal(await evaluate('document.getElementById("signinAction").hidden'), true, 'one account action at a time');
      assert.equal(await evaluate('document.getElementById("frame").style.display'), 'block', 'the page still renders');
      assert.equal((await api(`/api/artifacts/${artifactId}/sharing`, { cookie: remembered })).json.grants?.length ?? 0, 0, 'the refused write changed nothing');
      // An ungated write (renaming) succeeds on the old session and must not
      // clear the prompt: only a gated action proves fresh authentication.
      await evaluate(`(()=>{document.getElementById('shareMenu').hidden=true;document.getElementById('titleBtn').click();return true})()`);
      await waitFn('!document.getElementById("titleMenu").hidden', 'details panel');
      await evaluate(`(()=>{document.getElementById('renameBtn').click();return true})()`);
      await waitFn('document.getElementById("renameDialog").open', 'rename dialog');
      await run('fill', '#renameTitle', 'Renamed on an old session');
      await evaluate(`(()=>{document.getElementById('renameForm').requestSubmit();return true})()`);
      await waitFn('!document.getElementById("renameDialog").open', 'rename saved');
      assert.equal(await evaluate('document.getElementById("reauthAction").hidden'), false, 'an ungated write does not clear the fresh sign-in prompt');
      await run('screenshot', join(dir, 'viewer-reauth-required-phone.png'));

      // /login?reauth=1 must not forward the still-valid session.
      await run('open', base + '/login?reauth=1&returnTo=' + encodeURIComponent(`/v/${artifactId}`));
      await waitFn('!document.getElementById("login").hidden', 'reauth form');
      assert.equal(await evaluate('document.getElementById("app").hidden'), true, 'an existing session is not forwarded');
      assert.equal(await evaluate('document.getElementById("login-title").textContent'), 'Confirm it’s you');
      assert.ok((await evaluate('document.getElementById("login-feedback").textContent')).includes('Nothing was changed'));
      assert.equal(await evaluate('document.getElementById("login-form").hidden'), false, 'a link or code is required');
      assert.equal(await evaluate('document.activeElement.id'), 'login-email');
      assert.equal(await evaluate('document.getElementById("sent-panel").hidden'), true);
      await run('screenshot', join(dir, 'library-reauth-phone.png'));

      // A real code earns a fresh session and returns to the artifact.
      await recordLogin();
      await run('fill', '#login-email', email);
      await run('click', '#login-submit');
      await waitFn('!document.getElementById("sent-panel").hidden', 'sent panel');
      await run('fill', '#login-code', (await evaluate('window.__login.response')).loginCode);
      await run('click', '#code-submit');
      await waitFn(`location.pathname===${JSON.stringify('/v/' + artifactId)}`, 'viewer after reauth');
      await waitFn('document.getElementById("frame").style.display==="block"', 'artifact renders with the fresh session');
      // The renewed session may now make the gated change the reader retried.
      await evaluate(`(()=>{document.getElementById('shareBtn').click();return true})()`);
      await waitFn('!document.getElementById("shareMenu").hidden', 'share panel open');
      await waitFn(`(()=>{const p=document.getElementById('peoplePick');return p&&p.options.length>1})()`, 'the grant is still offered');
      await evaluate(`(()=>{const p=document.getElementById('peoplePick');p.value=p.options[1].value;document.getElementById('peopleForm').requestSubmit();return true})()`);
      await waitFn(`(()=>{const p=document.getElementById('peopleStatus');return p&&/saved|access/i.test(p.textContent)&&!/sign in again/i.test(p.textContent)})()`, 'the retried grant succeeds');
      assert.equal(await evaluate('document.getElementById("reauthAction").hidden'), true, 'a successful gated write clears the fresh sign-in action');
    }
    return { output: dir, checks: signinBrowserChecks.length };
  } finally {
    try { await run('close'); } catch { /* an earlier failure matters more */ }
    for (const id of fixtures) await api(`/api/artifacts/${id}`, { method: 'DELETE', cookie: owner.cookie }).catch(() => {});
  }
}

// ── Standalone runner ────────────────────────────────────────────────────────
// `node test/signin-browser.mjs` owns its Worker; importing this module does not.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.env.SIGNIN_BROWSER_QA !== '1') {
    console.log('Skip: set SIGNIN_BROWSER_QA=1 to run the real-browser sign-in checks.');
    process.exit(0);
  }
  try { execFileSync('agent-browser', ['--version'], { stdio: 'ignore' }); }
  catch {
    console.error('Skip: agent-browser is not installed.');
    process.exit(0);
  }
  const { startWorker, freePort } = await import('./helpers/worker.mjs');
  const work = mkdtempSync(join(tmpdir(), 'hap-signin-browser-'));
  let worker;
  try {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    worker = await startWorker(work, { OWNER_EMAIL: email, APP_ORIGIN: base, TEST_MAIL_TRANSPORT: 'loopback' }, { port });
    const api = async (path, { method = 'GET', body, cookie, bearer } = {}) => {
      const headers = { Origin: base };
      if (cookie) headers.Cookie = cookie;
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let json; try { json = JSON.parse(text); } catch { /* no body */ }
      return { status: response.status, json, text, headers: response.headers };
    };
    // The rate limiter is real; only this throwaway database is relaxed so each
    // scenario can request its own link.
    const eachState = visit => {
      for (const file of readdirSync(join(work, 'state'), { recursive: true })) {
        if (!String(file).endsWith('.sqlite')) continue;
        const db = new DatabaseSync(join(work, 'state', String(file)));
        try { visit(db); }
        catch { /* not this database */ }
        finally { db.close(); }
      }
    };
    const has = (db, name) => db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);
    const clearRateLimits = () => eachState(db => { if (has(db, 'rate_limits')) db.exec('DELETE FROM rate_limits'); });
    // A remembered session whose proof is old enough to need a fresh one. This
    // is the disposable test database only; the server's rule is untouched.
    const ageSession = () => eachState(db => { if (has(db, 'sessions')) db.exec('UPDATE sessions SET authenticated_at=0 WHERE remembered=1'); });
    await signinBrowserQA({ base, api, owner: { bearer: worker.owner }, clearRateLimits, ageSession });
    console.log(`PASS: ${signinBrowserChecks.length} real-browser sign-in checks`);
  } catch (error) {
    console.error('FAILED:', redact(error.stack || error));
    process.exitCode = 1;
  } finally {
    worker?.stop();
    rmSync(work, { recursive: true, force: true });
  }
}
