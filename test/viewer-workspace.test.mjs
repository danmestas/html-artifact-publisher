// The artifact viewer's account-side workspace, exercised against a real
// local Worker: the shell the page ships, the cookie-only sharing and
// management endpoints the viewer calls, and the ways a capability link must
// not be mistaken for account access. The browser behaviour these routes feed
// is covered opt-in by VIEWER_WORKSPACE_QA=1 (test/viewer-workspace-browser.mjs).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, freePort } from './helpers/worker.mjs';

const work = mkdtempSync(join(tmpdir(), 'artifact-viewer-workspace-'));
after(() => rmSync(work, { recursive: true, force: true }));

const iso = seconds => new Date((Math.floor(Date.now() / 1000) + seconds) * 1000).toISOString();

/** A Worker with its own state and accounts signed in over loopback mail. */
async function withWorker(vars, body) {
  const dir = mkdtempSync(join(work, 'state-'));
  const port = await freePort();
  const app = await startWorker(dir, {
    ...vars, OWNER_EMAIL: 'owner@example.com', APP_ORIGIN: `http://127.0.0.1:${port}`,
    TEST_MAIL_TRANSPORT: 'loopback',
  }, { port });
  const send = async (path, { method = 'GET', body: b, token, bearer, cookie = '', origin = app.base } = {}) => {
    const res = await fetch(app.base + path, {
      method,
      headers: {
        ...(origin === null ? {} : { Origin: origin }),
        ...(b === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Token ${token}` } : {}),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* no body */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const signIn = async email => {
    const requested = await send('/api/auth/request', { method: 'POST', body: { email } });
    assert.ok(requested.json?.loginUrl, requested.text);
    const verified = await send('/api/auth/verify', { method: 'POST', body: { token: new URL(requested.json.loginUrl).hash.slice(7) } });
    assert.equal(verified.status, 200, verified.text);
    return { cookie: verified.headers.get('Set-Cookie').split(';')[0], user: verified.json.user };
  };
  // An invited account that accepted its link: only known addresses may sign in.
  const account = async (ownerCookie, email) => {
    const invited = await send('/api/invitations', { method: 'POST', cookie: ownerCookie, body: { email } });
    assert.equal(invited.status, 200, invited.text);
    const verified = await send('/api/auth/verify', { method: 'POST', body: { token: new URL(invited.json.loginUrl).hash.slice(7) } });
    assert.equal(verified.status, 200, verified.text);
    return { cookie: verified.headers.get('Set-Cookie').split(';')[0], user: verified.json.user };
  };
  try {
    await body({ base: app.base, owner: app.owner, send, signIn, account });
  } finally { app.stop(); }
}

const tokenOf = url => url.split('#')[1] ?? '';

test('the shipped viewer shell keeps one bar, one inspector and honest boundaries', async () => {
  await withWorker({}, async ({ base, owner, send }) => {
    const created = await send('/api/artifacts', {
      method: 'POST', bearer: owner,
      body: { title: 'Shell contracts', ttlSeconds: null, files: { 'index.html': Buffer.from('<h1>shell</h1>').toString('base64') } },
    });
    assert.equal(created.status, 201, created.text);
    const html = (await send(`/v/${created.json.id}`)).text;

    // One bar owns the title, the version identity, comments and Share; the
    // inspector owns history and comments; nothing is duplicated between them.
    for (const id of ['bar', 'titleBtn', 'versionBtn', 'commentsBtn', 'shareBtn', 'moreBtn', 'inspector', 'threadPanel', 'historyPanel']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.equal((html.match(/id="bar"/g) ?? []).length, 1);
    assert.ok(!html.includes('id="versionMenu"'), 'version history is an inspector, not a second popover');
    assert.ok(!html.includes('id="toolbar"'), 'no second permanent toolbar');
    // The version identity the bar shows is a real hash and tag, not a counter.
    assert.match(html, /id="versionHash"/);
    assert.match(html, /id="versionTag"/);

    // Share keeps named access, public snapshots and capability links distinct.
    for (const id of ['peopleSection', 'publicationSection', 'linksSection', 'shareRows']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    assert.match(html, /Capability links work on their own, without signing in/, 'the shell says what a link grants and that it is separate from named access');
    assert.match(html, /These are different from named access and from public snapshots/, 'named access, links and public snapshots stay distinct');
    // Management forms are cookie-only and separate from the capability UI.
    for (const id of ['renameDialog', 'expirationDialog', 'renameForm', 'expirationForm', 'expiryMode', 'expiryDate']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }

    // The artifact page's sandbox and the viewer CSP are unchanged.
    assert.match(html, /sandbox="allow-scripts allow-forms allow-modals allow-popups"/);
    assert.ok(!/sandbox="[^"]*allow-same-origin/.test(html), 'the page still has an opaque origin');
    const csp = (await send(`/v/${created.json.id}`)).headers.get('Content-Security-Policy');
    assert.match(csp, /script-src [^;]*'wasm-unsafe-eval'/);
    assert.match(csp, /connect-src 'self'/);
  });
});

test('comments are a placement toggle; the bubble and panel are separate overlays', () => {
  const html = readFileSync(new URL('../public/viewer.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8');

  // The comments button is a toggle with a pressed state, not a panel opener.
  const toggle = /<button id="commentsBtn"[^>]*>/.exec(html)?.[0];
  assert.ok(toggle, 'the bar has a comments button');
  assert.match(toggle, /aria-pressed="false"/, 'the placement toggle declares its state');
  assert.ok(!/aria-haspopup/.test(toggle), 'it no longer opens a dialog');
  assert.match(html, /id="placementHint"/, 'the page says a click will place a comment');
  // Discussion stays reachable on its own control, with the thread count.
  const discussions = /<button id="discussionsBtn"[^>]*>/.exec(html)?.[0];
  assert.ok(discussions, 'discussion has its own control');
  assert.match(discussions, /aria-haspopup="dialog"/);
  assert.match(discussions, /aria-controls="inspector"/);
  assert.match(html, /<span id="commentCount"/);

  // The bubble is a fixed overlay in the viewer with its own composer, so a
  // placed comment never opens or resizes the inspector or the page.
  assert.match(html, /<form id="commentBubble"[^>]*role="dialog"[^>]*hidden>/);
  assert.match(html, /id="bubbleText"/);
  assert.match(html, /<form id="commentBubble"[^>]*role="dialog"[^>]*hidden>[\s\S]*?<\/form>/, 'the bubble owns a form');
  assert.match(source, /function openBubble\(point\) \{/, 'clicked points open the bubble');
  assert.match(source, /openBubble\(pagePoint\(d\)\)/, 'the page’s point message opens a bubble, not the inspector');
  assert.ok(!/openInspector\('comments', 'draft', pagePoint\(d\)\)/.test(source), 'placement no longer opens the panel');
  assert.match(source, /const spot = bubblePlacement\(point, size, bounds\);/, 'the bubble stays inside the page area');
  // Placement is a mode, not a one-shot pick: taking a point opens the bubble
  // and leaves the toggle on, so a second click moves the bubble.
  const pointBranch = /else if \(d\.type === 'point'[\s\S]*?trackAnchor\(draftAnchor\);/.exec(source)?.[0];
  assert.ok(pointBranch, 'the viewer still handles the page’s point message');
  assert.ok(!/setPlacement\(false\)/.test(pointBranch), 'taking a point does not end the placement mode');
  const pagePins = readFileSync(new URL('../public/page-pins.js', import.meta.url), 'utf8');
  assert.ok(!/setPlacement\(false\);\s*send\(\{ type: 'point'/.test(pagePins), 'the page keeps its placement layer after sending a point');
  // The toggle owns the placement state and announces it.
  assert.match(source, /\$\('commentsBtn'\)\.setAttribute\('aria-pressed', String\(placing\)\);/, 'the toggle reports its state');
  assert.match(source, /\$\('commentsBtn'\)\.setAttribute\('aria-label', placing \? 'Stop placing comments'/, 'the on state is announced');
  // The page sandbox is untouched by the interaction change.
  assert.match(html, /sandbox="allow-scripts allow-forms allow-modals allow-popups"/);
  assert.ok(!/sandbox="[^"]*allow-same-origin/.test(html));
});

test('bubble drafts stay bound to the page and version they belong to', () => {
  const source = readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8');
  const block = (start, end) => new RegExp(`${start}[\\s\\S]*?\\n${end}`).exec(source)?.[0];

  // X or Escape during a post must not copy the in-flight words into the
  // hidden general draft as a second, unsent comment.
  const close = block('function closeBubble\\(', '\\}');
  assert.ok(close, 'the viewer still has one closeBubble');
  assert.match(close, /if \(!commentBusy &&/, 'an in-flight post owns its words; closing does not duplicate them');
  assert.match(close, /\$\('bubbleStatus'\)\.textContent = ''/, 'closing clears the bubble’s status');

  // A version switch replaces the page, so the bubble’s anchor and version
  // cannot survive into the next check-in.
  const render = block('async function render\\(\\)', '\\}');
  assert.ok(render, 'render still swaps the page');
  assert.match(render, /closeBubbleForPage\(\)/, 'switching versions closes the bubble');
  const forPage = block('function closeBubbleForPage\\(', '\\}');
  assert.ok(forPage, 'the version switch has its own bubble close');
  assert.match(forPage, /keepAnchor: false/, 'the old page’s location and version are dropped');
  assert.match(forPage, /closeBubble\(/, 'the words still go through the one close path');

  // The bubble’s own cancel is not the panel’s cancel.
  const cancel = block("\\$\\('bubbleCancel'\\)\\.addEventListener", '\\}\\);');
  assert.ok(cancel, 'the bubble still has its own cancel');
  assert.ok(!cancel.includes('commentText'), 'cancelling the bubble leaves the panel draft alone');
  assert.ok(!cancel.includes('commentStatus'), 'cancelling the bubble leaves the panel status alone');

  // Reopening starts a fresh status and a fresh version binding, not the last
  // attempt’s.
  const open = block('function openBubble\\(point\\)', '\\}');
  assert.ok(open, 'clicked points still open the bubble');
  assert.match(open, /\$\('bubbleStatus'\)\.textContent = ''/, 'a reopened bubble shows no stale status');
  assert.match(open, /bubbleVersion = shown\?\.checkin/, 'the draft is bound to the version it was started on');
  const submit = block("\\$\\('commentBubble'\\)\\.addEventListener\\('submit'", '\\}\\);');
  assert.match(submit, /version: bubbleVersion/, 'the post carries the version the draft was started on');
  assert.match(submit, /anchor: bubbleAnchor/, 'the post carries the bubble’s own location');
});

test('a thread opened from a pin is an anchored card, not the docked inspector', () => {
  const source = readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8');

  assert.match(source, /\.classList\.toggle\('card', \!\!card\)/, 'thread mode puts the inspector in card form');
  const place = /function placeInspector\(\)[\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(place, 'the overlays have one placement function');
  assert.match(place, /cardPlacement\(/, 'the card is placed from its anchor');
  const geometry = /function cardPlacement\(point\)[\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(geometry, 'the card has one geometry function');
  assert.match(geometry, /bubblePlacement\(/, 'the card is placed by the same clamped anchor rule as the bubble');
  assert.match(geometry, /overlayBounds\(\)/, 'the card is clamped to the visible area');
  assert.match(source, /const spot = bubblePlacement\(point, size, bounds\);/, 'the bubble clamps to the same visible area');
  assert.match(source, /visualViewport\?\.addEventListener\('resize', placeOverlays\)/, 'the phone keyboard re-places the overlays');
  assert.match(source, /new ResizeObserver\(placeOverlays\)/, 'a frame or sidebar resize re-places the overlays');

  const open = /function openInspector\([\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(open, 'the inspector still opens in one place');
  assert.match(open, /keepPlacement/, 'a pin click does not end the placement mode');
  assert.match(open, /keepPlacing: keepPlacement/, 'the pin opens a thread card without ending the bubble’s mode');
  assert.match(source, /activateThread\(t, pagePoint\(d\) \?\? \{[^}]*\}, \{ keepPlacement: true, card: true \}\)/, 'a pin click opens its own anchored card');
});

test('dynamic viewer controls get their accessible names as attributes', () => {
  const source = readFileSync(new URL('../public/viewer.js', import.meta.url), 'utf8');
  // People rows are built at runtime; a hyphenated prop assigned as a JS field
  // leaves the permission select with no accessible name. The one helper must
  // route those names through setAttribute.
  const helper = /function el\(tag, props = \{\}, \.\.\.children\) \{[\s\S]*?\n\}/.exec(source);
  assert.ok(helper, 'the viewer still has one element helper');
  assert.match(helper[0], /setAttribute\(key, value\)/, 'hyphenated props become attributes');
  assert.match(source, /'aria-label': `Permission for \$\{personName\(user\)\}`/, 'permission controls still declare a name');
});

test('named access is cookie management; a capability link neither grants nor manages it', async () => {
  await withWorker({}, async ({ base, send, signIn, owner, account }) => {
    const creator = await signIn('owner@example.com');
    const writer = await account(creator.cookie, 'writer@example.com');
    const reader = await account(creator.cookie, 'reader@example.com');
    const outsider = await account(creator.cookie, 'outsider@example.com');

    // Created with the legacy edit link, so the artifact has all three
    // capability links alongside its account owner.
    const created = await send('/api/artifacts', {
      method: 'POST', bearer: owner,
      body: { title: 'Named access', ttlSeconds: null, files: { 'index.html': Buffer.from('<h1>named</h1>').toString('base64') } },
    });
    assert.equal(created.status, 201, created.text);
    const id = created.json.id, path = `/api/artifacts/${id}`;
    const read = tokenOf(created.json.viewerUrl), comment = tokenOf(created.json.commentUrl), write = tokenOf(created.json.editUrl);

    // The creator manages by cookie; the sharing endpoint names only eligible people.
    const sharing = await send(`${path}/sharing`, { cookie: creator.cookie });
    assert.equal(sharing.status, 200, sharing.text);
    assert.equal(sharing.json.ownerId, 'instance-owner');
    assert.deepEqual(sharing.json.grants, []);
    assert.ok(sharing.json.users.some(u => u.id === writer.user.id));
    assert.ok(!sharing.json.users.some(u => u.id === 'instance-owner'), 'administrative access is not a grant candidate');

    // Link holders with no account are refused: a token is not a session.
    for (const [who, credential] of [['read', { token: read }], ['comment', { token: comment }], ['write', { token: write }]]) {
      assert.equal((await send(`${path}/sharing`, credential)).status, 401, `${who} link cannot read people`);
      assert.equal((await send(`${path}/sharing`, { ...credential, method: 'PUT', body: { userId: writer.user.id, permission: 'write' } })).status, 401, `${who} link cannot grant`);
      assert.equal((await send(`${path}/manage`, { ...credential, method: 'PATCH', body: { title: 'Hijacked' } })).status, 401, `${who} link cannot rename`);
    }

    // A signed-in owner of nothing is refused even while holding the edit link;
    // the link itself is never account authentication, so an explicit token is
    // refused before any cookie is considered.
    assert.equal((await send(path, { cookie: outsider.cookie, token: write })).status, 200, 'a valid capability still opens the content');
    assert.equal((await send(`${path}/sharing`, { cookie: outsider.cookie })).status, 404, 'no management from the account alone');
    assert.equal((await send(`${path}/manage`, { cookie: outsider.cookie, method: 'PATCH', body: { title: 'Hijacked' } })).status, 404);
    assert.equal((await send(`${path}/sharing`, { cookie: outsider.cookie, token: write })).status, 401, 'a link is not a session');
    assert.equal((await send(`${path}/manage`, { cookie: outsider.cookie, token: write, method: 'PATCH', body: { title: 'Hijacked' } })).status, 401);
    assert.equal((await send(`${path}/sharing`, { cookie: outsider.cookie, method: 'PUT', body: { userId: outsider.user.id, permission: 'write' } })).status, 404);

    // Grants: a named writer edits content but never manages; a named reader
    // can only read, and can neither comment nor see management data.
    assert.equal((await send(`${path}/sharing`, { cookie: creator.cookie, method: 'PUT', body: { userId: writer.user.id, permission: 'write' } })).status, 200);
    assert.equal((await send(`${path}/sharing`, { cookie: creator.cookie, method: 'PUT', body: { userId: reader.user.id, permission: 'read' } })).status, 200);
    const writerInfo = await send(path, { cookie: writer.cookie });
    assert.equal(writerInfo.json.role, 'write');
    assert.equal(writerInfo.json.canManage, false);
    assert.equal(writerInfo.json.readToken, undefined, 'a cookie session never receives a capability token');
    assert.equal((await send(`${path}/sharing`, { cookie: writer.cookie })).status, 403);
    assert.equal((await send(`${path}/manage`, { cookie: writer.cookie, method: 'PATCH', body: { archived: true } })).status, 403);
    const published = await send(path, {
      method: 'PUT', cookie: writer.cookie,
      body: { parent: created.json.tip, message: 'Named writer', files: { 'index.html': Buffer.from('<h1>named v2</h1>').toString('base64') } },
    });
    assert.equal(published.status, 200, published.text);

    const readerInfo = await send(path, { cookie: reader.cookie });
    assert.equal(readerInfo.json.role, 'read');
    assert.equal(readerInfo.json.canManage, false);
    assert.equal((await send(`${path}/tickets`, { cookie: reader.cookie })).status, 200, 'readers may read threads');
    assert.equal((await send(`${path}/tickets`, { cookie: reader.cookie, method: 'POST', body: { text: 'no' } })).status, 403, 'readers may not comment');
    assert.equal((await send(`${path}/manage`, { cookie: reader.cookie, method: 'PATCH', body: { expiresAt: iso(3600) } })).status, 403);
    assert.equal((await send(`${path}/sharing`, { cookie: reader.cookie })).status, 403);

    // The creator's own cookie-first management, as the viewer's dialogs send it:
    // a rename, then a finite deadline, then clearing it.
    const renamed = await send(`${path}/manage`, { cookie: creator.cookie, method: 'PATCH', body: { title: 'Renamed in the viewer' } });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal((await send(path, { cookie: creator.cookie })).json.title, 'Renamed in the viewer');
    const expiresAt = iso(86400);
    const expired = await send(`${path}/manage`, { cookie: creator.cookie, method: 'PATCH', body: { expiresAt } });
    assert.equal(expired.status, 200, expired.text);
    assert.equal((await send(path, { cookie: creator.cookie })).json.expiresAt, expiresAt);
    const cleared = await send(`${path}/manage`, { cookie: creator.cookie, method: 'PATCH', body: { expiresAt: null } });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal((await send(path, { cookie: creator.cookie })).json.expiresAt, null);

    // Management needs a same-origin Origin header, exactly like the viewer's
    // same-origin fetch sends; a cross-site form post is refused.
    assert.equal((await send(`${path}/manage`, { cookie: creator.cookie, origin: 'https://evil.example', method: 'PATCH', body: { title: 'Cross-site' } })).status, 403);
    assert.equal((await send(`${path}/sharing`, { cookie: creator.cookie, origin: 'https://evil.example', method: 'PUT', body: { userId: writer.user.id, permission: null } })).status, 403);

    // Removing a grant ends named access but leaves capability links alone.
    assert.equal((await send(`${path}/sharing`, { cookie: creator.cookie, method: 'PUT', body: { userId: reader.user.id, permission: null } })).status, 200);
    assert.equal((await send(path, { cookie: reader.cookie })).status, 404);
    assert.equal((await send(path, { token: read })).status, 200, 'the read link still works');
    assert.equal((await send(`${path}/manage`, { cookie: creator.cookie, method: 'PATCH', body: { title: 'Untitled' } })).status, 200);
  });
});

test('anonymous capability readers get content, never account data or an inventory', async () => {
  await withWorker({}, async ({ base, owner, send }) => {
    const created = await send('/api/artifacts', {
      method: 'POST', bearer: owner,
      body: { title: 'Anonymous surface', ttlSeconds: null, files: { 'index.html': Buffer.from('<h1>anon</h1>').toString('base64') } },
    });
    assert.equal(created.status, 201, created.text);
    const id = created.json.id, path = `/api/artifacts/${id}`;
    const read = tokenOf(created.json.viewerUrl), comment = tokenOf(created.json.commentUrl);

    // The shell itself is public; the data behind it is gated by the link.
    assert.equal((await send(`/v/${id}`)).status, 200);
    const bare = await send(path);
    assert.equal(bare.status, 404, 'no link, no artifact data');
    assert.equal(bare.json.title, undefined);

    const anon = await send(path, { token: read });
    assert.equal(anon.status, 200, anon.text);
    assert.equal(anon.json.role, 'read');
    // Anonymous link holders never learn whether an account could manage it.
    assert.equal(anon.json.canManage, false);
    assert.equal(anon.json.readToken, undefined);
    for (const secret of ['ownerId', 'email', 'userId']) assert.ok(!(secret in anon.json), `the info payload carries no ${secret}`);

    // No inventory and no account endpoints without a cookie. A capability
    // token is not a session, so account routes answer "sign in required".
    assert.equal((await send('/api/library')).status, 401);
    assert.equal((await send('/api/session')).json.user, null);
    assert.equal((await send('/api/people')).status, 401);
    assert.equal((await send(`${path}/sharing`, { token: read })).status, 401);
    assert.equal((await send(`${path}/manage`, { token: read, method: 'PATCH', body: { title: 'x' } })).status, 401);

    // The read link cannot comment; the comment link can, and neither manages.
    assert.equal((await send(`${path}/tickets`, { token: read, method: 'POST', body: { text: 'nope' } })).status, 403);
    assert.equal((await send(`${path}/tickets`, { token: comment, method: 'POST', body: { text: 'hello' } })).status, 201);
    assert.equal((await send(`${path}/sharing`, { token: comment })).status, 401);
  });
});

test('a creator who is a member manages only what their own cookie authorizes', async () => {
  await withWorker({}, async ({ send, signIn, account }) => {
    const instanceOwner = await signIn('owner@example.com');
    const member = await account(instanceOwner.cookie, 'creator@example.com');
    const other = await account(instanceOwner.cookie, 'other@example.com');
    const created = await send('/api/artifacts', {
      method: 'POST', cookie: member.cookie,
      body: { title: 'Member creator', ttlSeconds: null, files: { 'index.html': Buffer.from('<h1>mine</h1>').toString('base64') } },
    });
    assert.equal(created.status, 201, created.text);
    const path = `/api/artifacts/${created.json.id}`;

    // The member creator manages their own artifact and its people.
    assert.equal((await send(path, { cookie: member.cookie })).json.canManage, true);
    assert.equal((await send(`${path}/sharing`, { cookie: member.cookie })).status, 200);
    assert.equal((await send(`${path}/sharing`, { cookie: member.cookie, method: 'PUT', body: { userId: other.user.id, permission: 'read' } })).status, 200);
    assert.equal((await send(`${path}/manage`, { cookie: member.cookie, method: 'PATCH', body: { title: 'Member renamed' } })).status, 200);

    // Transfer stays an instance-owner power; the named reader sees no management.
    assert.equal((await send(`${path}/manage`, { cookie: member.cookie, method: 'PATCH', body: { ownerId: other.user.id } })).status, 403);
    assert.equal((await send(path, { cookie: other.cookie })).json.canManage, false);
    assert.equal((await send(`${path}/sharing`, { cookie: other.cookie })).status, 403);
  });
});

if (process.env.VIEWER_WORKSPACE_QA === '1') test('real browser: the viewer workspace, inspector and account boundary', { timeout: 180000 }, async () => {
  const { viewerWorkspaceQA } = await import('./viewer-workspace-browser.mjs');
  const output = process.env.VIEWER_WORKSPACE_QA_OUTPUT || join(work, 'browser');
  const stamp = Date.now();
  await withWorker({}, async ({ base, owner, send, signIn, account }) => {
    // Owner account, one artifact the owner manages, a named editor, an
    // account that starts with no access so the viewer can grant it one, and
    // a second account with its own library for the stale-answer check.
    const creator = await signIn('owner@example.com');
    const editor = await account(creator.cookie, `editor-${stamp}@example.com`);
    const applicant = await account(creator.cookie, `applicant-${stamp}@example.com`);
    const secondAccount = await account(creator.cookie, `second-${stamp}@example.com`);
    assert.equal((await send('/api/artifacts', {
      method: 'POST', cookie: secondAccount.cookie,
      body: { title: 'Only the second account has this', ttlSeconds: null, files: { 'index.html': Buffer.from('<h1>second</h1>').toString('base64') } },
    })).status, 201);
    const created = await send('/api/artifacts', {
      method: 'POST', bearer: owner,
      body: { title: 'Workspace artifact', ttlSeconds: null, files: { 'index.html': Buffer.from('<h1>workspace</h1>').toString('base64') } },
    });
    assert.equal(created.status, 201, created.text);
    const id = created.json.id;
    const recent = await send('/api/artifacts', {
      method: 'POST', cookie: creator.cookie,
      body: { title: 'Recent artifact', ttlSeconds: null, files: { 'index.html': Buffer.from('<h1>recent</h1>').toString('base64') } },
    });
    assert.equal(recent.status, 201);
    assert.equal((await send(`/api/artifacts/${id}/sharing`, {
      cookie: creator.cookie, method: 'PUT', body: { userId: editor.user.id, permission: 'write' },
    })).status, 200);
    // A thread exists so the inspector has something to show and draft into.
    await send(`/api/artifacts/${id}/tickets`, { method: 'POST', token: tokenOf(created.json.commentUrl), body: { text: 'A thread to reply to' } });

    await viewerWorkspaceQA({
      api: send,
      base, output,
      account: creator,      artifact: { id, title: 'Workspace artifact', write: tokenOf(created.json.editUrl) },
      namedEditor: editor,
      grantCandidate: applicant,
      secondAccount,
      recentArtifact: { id: recent.json.id, title: 'Recent artifact' },
    });
  });
});
