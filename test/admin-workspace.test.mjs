// The admin workspace's audit and inventory surfaces: searchable activity,
// expiry ordering and filtering, people counts and sign-in times, and the
// audit the Repo writes when it expires an artifact. These exercise the public
// API against a real local Worker; the database is opened only to seed a
// legacy audit row and to give artifacts exact deadlines.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, freePort } from './helpers/worker.mjs';

const work = mkdtempSync(join(tmpdir(), 'artifact-admin-workspace-'));
after(() => rmSync(work, { recursive: true, force: true }));

const seconds = s => Math.floor(Date.now() / 1000) + s;
const iso = sec => new Date(sec * 1000).toISOString();

/** The persist directory of the Worker whose test is running. */
let stateDir = '';
/** Open a table's database under the running Worker's persist directory. */
function dbWith(table, sql, ...args) {
  for (const file of readdirSync(stateDir, { recursive: true })) {
    if (!String(file).endsWith('.sqlite')) continue;
    const db = new DatabaseSync(join(stateDir, String(file)));
    try {
      if (db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table)) return db.prepare(sql).all(...args);
    } catch { /* another Durable Object's database has no such table */ }
    finally { db.close(); }
  }
  throw new Error(`no database holding ${table}`);
}
const registrySQL = (sql, ...args) => dbWith('artifacts', sql, ...args);
const activitySQL = (sql, ...args) => dbWith('activity', sql, ...args);

/** A Worker with its own state and signed-in accounts, driven by loopback mail. */
async function withWorker(vars, body) {
  const dir = mkdtempSync(join(work, 'state-'));
  stateDir = join(dir, 'state');
  const port = await freePort();
  const app = await startWorker(dir, {
    ...vars, OWNER_EMAIL: 'owner@example.com', APP_ORIGIN: `http://127.0.0.1:${port}`,
    TEST_MAIL_TRANSPORT: 'loopback',
  }, { port });
  const send = async (path, { method = 'GET', body: b } = {}, cookie = '') => {
    const res = await fetch(app.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: app.base, ...(cookie ? { Cookie: cookie } : {}) },
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
    const cookie = verified.headers.get('Set-Cookie').split(';')[0];
    return { cookie, user: verified.json.user };
  };
  const call = (cookie, path, opts) => send(path, opts, cookie);
  // An invited account that accepted its link: only known addresses may sign in.
  const account = async (ownerCookie, email) => {
    const invited = await call(ownerCookie, '/api/invitations', { method: 'POST', body: { email } });
    assert.equal(invited.status, 200, invited.text);
    assert.ok(invited.json?.loginUrl, invited.text);
    const verified = await call('', '/api/auth/verify', { method: 'POST', body: { token: new URL(invited.json.loginUrl).hash.slice(7) } });
    assert.equal(verified.status, 200, verified.text);
    return { cookie: verified.headers.get('Set-Cookie').split(';')[0], user: verified.json.user };
  };
  try {
    await body({ base: app.base, owner: app.owner, send, signIn, call, account });
  } finally { app.stop(); }
}

async function create(cookie, call, title, extra = {}) {
  const res = await call(cookie, '/api/artifacts', {
    method: 'POST',
    body: { title, ttlSeconds: null, ...extra, files: { 'index.html': Buffer.from(`<p>${title}</p>`).toString('base64') } },
  });
  assert.equal(res.status, 201, res.text);
  return res.json;
}

const events = async (call, cookie, query = '') => (await call(cookie, `/api/admin/activity?limit=100${query}`)).json.events;

test('every audited artifact action is offered by the artifacts kind', async () => {
  await withWorker({}, async ({ signIn, call, account }) => {
    const owner = await signIn('owner@example.com');
    const member = await account(owner.cookie, 'member@example.com');
    const a = await create(owner.cookie, call, 'Kind completeness');
    assert.equal((await call(owner.cookie, `/api/artifacts/${a.id}/comment-link`, { method: 'POST' })).status, 200);
    assert.equal((await call(owner.cookie, `/api/artifacts/${a.id}`, { method: 'DELETE' })).status, 204);
    const listed = await events(call, owner.cookie, '&kind=artifacts');
    const actions = new Set(listed.map(e => e.action));
    for (const action of ['publish', 'rotate-comment-link', 'delete']) assert.ok(actions.has(action), `artifacts kind shows ${action}`);
    // The same events are not smuggled into another kind.
    assert.ok(!(await events(call, owner.cookie, '&kind=people')).some(e => e.action === 'publish'));
    // Role restrictions are unchanged.
    assert.equal((await call(member.cookie, '/api/admin/activity')).status, 403);
  });
});

test('activity search matches actor, artifact and target, before the page limit', async () => {
  await withWorker({}, async ({ signIn, call, send, account }) => {
    const owner = await signIn('owner@example.com');
    const member = await account(owner.cookie, 'wombat-keeper@example.com');
    const keep = [];
    for (const title of ['Wombat one', 'Wombat two', 'Wombat three']) keep.push(await create(member.cookie, call, title));
    await create(owner.cookie, call, 'Unrelated');
    await send('/api/invitations', { method: 'POST', cookie: owner.cookie, body: { email: 'wombat-invite@example.com' } }, owner.cookie);

    // Every matching title is reachable through pages shorter than the match set.
    const seen = new Set();
    let cursor = '';
    for (;;) {
      const page = (await call(owner.cookie, `/api/admin/activity?kind=artifacts&limit=2&q=WOMBAT${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json;
      assert.ok(page.events.length <= 2);
      for (const e of page.events) {
        assert.match(e.artifactTitle, /wombat/i);
        seen.add(e.artifactId);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    for (const a of keep) assert.ok(seen.has(a.id), 'every Wombat artifact is paged through');

    // Actor email and invitation target match too, and kind still applies.
    assert.ok((await events(call, owner.cookie, '&q=wombat-keeper@example.com')).some(e => e.artifactId === keep[0].id));
    const invited = await events(call, owner.cookie, '&kind=people&q=wombat-invite@example.com');
    assert.equal(invited.length, 1);
    assert.equal(invited[0].action, 'invite');
    // A search with no hits pages nothing.
    assert.deepEqual((await call(owner.cookie, '/api/admin/activity?q=no-such-actor-anywhere')).json, { events: [], nextCursor: null });
  });
});

test('a structured expiration says never or a deadline; a legacy entry says neither', async () => {
  await withWorker({}, async ({ signIn, call }) => {
    const owner = await signIn('owner@example.com');
    const finite = await create(owner.cookie, call, 'Finite deadline');
    const never = await create(owner.cookie, call, 'Never expires');
    const deadline = seconds(3600);
    assert.equal((await call(owner.cookie, `/api/artifacts/${finite.id}/manage`, { method: 'PATCH', body: { expiresAt: iso(deadline) } })).status, 200);
    assert.equal((await call(owner.cookie, `/api/artifacts/${never.id}/manage`, { method: 'PATCH', body: { expiresAt: null } })).status, 200);

    // A row written before the metadata column existed.
    activitySQL('INSERT INTO activity (id,actor_id,action,artifact_id,artifact_title,created_at,target,details) VALUES (?,?,?,?,?,?,?,?)',
      'legacy-expiration', 'instance-owner', 'expiration', null, 'Legacy entry', seconds(-60), null, null);

    const listed = await events(call, owner.cookie, '&kind=artifacts');
    const fin = listed.find(e => e.artifactId === finite.id && e.action === 'expiration');
    const nev = listed.find(e => e.artifactId === never.id && e.action === 'expiration');
    assert.deepEqual(fin.details, { expiresAt: iso(deadline) });
    assert.deepEqual(nev.details, { expiresAt: null }, 'null is "never", not unknown');
    const legacy = listed.find(e => e.id === 'legacy-expiration');
    assert.equal(Object.hasOwn(legacy, 'details'), false, 'a historical entry carries no details at all');
  });
});

test('an artifact that expires is audited once, as System, with its title and reason', async () => {
  await withWorker({}, async ({ signIn, call }) => {
    const owner = await signIn('owner@example.com');
    const a = await create(owner.cookie, call, 'Soon gone', { ttlSeconds: 4 });
    let expired;
    for (let i = 0; i < 40 && !expired; i++) {
      await new Promise(r => setTimeout(r, 1000));
      expired = (await events(call, owner.cookie, '&kind=artifacts')).find(e => e.action === 'expired' && e.artifactId === a.id);
    }
    assert.ok(expired, 'the expiry is audited');
    assert.equal(expired.actorName, 'System');
    assert.equal(expired.artifactTitle, 'Soon gone', 'the title outlives the listing row');
    assert.deepEqual(expired.details, { reason: 'expired', expiresAt: a.expiresAt });
    assert.equal((await call(owner.cookie, `/api/artifacts/${a.id}`)).status, 404);
    // The removal is idempotent: no retry writes a second event.
    await new Promise(r => setTimeout(r, 3000));
    const after = (await events(call, owner.cookie, '&kind=artifacts')).filter(e => e.action === 'expired' && e.artifactId === a.id);
    assert.equal(after.length, 1);
    const byTitle = (await call(owner.cookie, '/api/admin/activity?kind=artifacts&q=' + encodeURIComponent('Soon gone'))).json.events;
    assert.ok(byTitle.some(e => e.action === 'expired' && e.artifactTitle === 'Soon gone'), 'the expired event stays searchable by title');
    assert.ok(byTitle.every(e => e.artifactTitle === 'Soon gone'), 'the search excludes other titles');
    const sys = (await call(owner.cookie, '/api/admin/activity?kind=artifacts&q=system')).json.events;
    assert.deepEqual(sys.map(e => [e.action, e.actorName]), [['expired', 'System']], 'the System actor is searchable');
  });
});

test('expiry sort orders finite deadlines first then never, with stable ties and null pages', async () => {
  await withWorker({}, async ({ signIn, call, send, account }) => {
    const owner = await signIn('owner@example.com');
    const member = await account(owner.cookie, 'member@example.com');
    const soon = await create(member.cookie, call, 'Expiry soonest');
    const tieA = await create(member.cookie, call, 'Expiry tie A');
    const tieB = await create(member.cookie, call, 'Expiry tie B');
    const never = await create(member.cookie, call, 'Expiry never');
    const archived = await create(member.cookie, call, 'Expiry archived');
    const late = await create(member.cookie, call, 'Expiry later');
    const base = seconds(1000);
    for (const [a, at] of [[soon, base], [tieA, base + 500], [tieB, base + 500], [late, base + 900], [archived, base + 20]]) {
      registrySQL('UPDATE artifacts SET expires_at=? WHERE id=?', at, a.id);
    }
    registrySQL('UPDATE artifacts SET expires_at=NULL WHERE id=?', never.id);
    assert.equal((await call(member.cookie, `/api/artifacts/${archived.id}/manage`, { method: 'PATCH', body: { archived: true } })).status, 200);

    const ids = [];
    let cursor = '';
    for (;;) {
      const page = (await call(owner.cookie, `/api/admin/artifacts?sort=expiry&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json;
      assert.ok(page.artifacts.length <= 2);
      ids.push(...page.artifacts.map(a => a.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    // Finite deadlines ascending (archived included), ties by id, never last.
    const expected = [soon.id, archived.id, ...[tieA.id, tieB.id].sort(), late.id, never.id];
    assert.deepEqual(ids, expected);
    assert.equal(ids.at(-1), never.id, 'a never-expiring artifact is last');

    const expiryCursor = JSON.parse((await call(owner.cookie, '/api/admin/artifacts?sort=expiry&limit=1')).json.nextCursor);
    assert.equal(expiryCursor[0], 'expiry');
    assert.equal(typeof expiryCursor[1], 'number');
    // A cursor of null seeks within the never-expiring block only.
    // '-' sorts before every letter and digit an id may start with.
    const nullCursor = JSON.stringify(['expiry', null, '-'.repeat(21)]);
    const afterNull = (await call(owner.cookie, `/api/admin/artifacts?sort=expiry&cursor=${encodeURIComponent(nullCursor)}`)).json;
    assert.deepEqual(afterNull.artifacts.map(a => a.id), [never.id]);

    // Invalid values are refused, and members keep their old sort contract.
    for (const bad of ['sort=expiry&cursor=' + encodeURIComponent('["name","x","id"]'),
      'sort=expiry&cursor=' + encodeURIComponent('["expiry","soon","id"]'),
      'sort=expiry&cursor=' + encodeURIComponent('["expiry",null,"bad id"]'),
      'sort=expiry&cursor=' + encodeURIComponent('null'), 'sort=invalid', 'expiry=soonish']) {
      assert.equal((await call(owner.cookie, `/api/admin/artifacts?${bad}`)).status, 400, bad);
    }
    assert.equal((await call(member.cookie, '/api/library?sort=expiry')).status, 400, 'non-admins cannot sort by expiry');
    assert.equal((await call(member.cookie, '/api/library?expiry=soon')).status, 400, 'nor filter by it');
  });
});

// Kept out of the fixture above so `late` reads as a plain artifact.
test('expiry=soon keeps deadlines within seven days and composes with every filter', async () => {
  await withWorker({}, async ({ signIn, call, account }) => {
    const owner = await signIn('owner@example.com');
    const member = await account(owner.cookie, 'member@example.com');
    const soonActive = await create(member.cookie, call, 'Soon active alpha');
    const soonArchived = await create(member.cookie, call, 'Soon archived');
    const later = await create(member.cookie, call, 'Later alpha');
    const never = await create(member.cookie, call, 'Never alpha');
    const past = await create(member.cookie, call, 'Past alpha');
    const now = seconds(0);
    registrySQL('UPDATE artifacts SET expires_at=? WHERE id=?', now + 86400, soonActive.id);
    registrySQL('UPDATE artifacts SET expires_at=? WHERE id=?', now + 6 * 86400, soonArchived.id);
    registrySQL('UPDATE artifacts SET expires_at=? WHERE id=?', now + 8 * 86400, later.id);
    registrySQL('UPDATE artifacts SET expires_at=NULL WHERE id=?', never.id);
    registrySQL('UPDATE artifacts SET expires_at=? WHERE id=?', now - 60, past.id);
    assert.equal((await call(member.cookie, `/api/artifacts/${soonArchived.id}/manage`, { method: 'PATCH', body: { archived: true } })).status, 200);

    const soon = (await call(owner.cookie, '/api/admin/artifacts?expiry=soon')).json;
    assert.deepEqual(soon.artifacts.map(a => a.id).sort(), [soonActive.id, soonArchived.id].sort());
    assert.equal(soon.total, 2);
    assert.deepEqual(soon.counts, { all: 2, active: 1, archived: 1 }, 'totals and counts are filtered together');

    const active = (await call(owner.cookie, '/api/admin/artifacts?expiry=soon&status=active&q=alpha')).json;
    assert.deepEqual(active.artifacts.map(a => a.id), [soonActive.id]);
    assert.equal(active.total, 1);
    assert.deepEqual(active.counts, { all: 1, active: 1, archived: 0 });

    const byOwner = (await call(owner.cookie, `/api/admin/artifacts?expiry=soon&ownerId=${member.user.id}`)).json;
    assert.equal(byOwner.total, 2);
    // Omitted and 'all' mean the same thing.
    assert.equal((await call(owner.cookie, '/api/admin/artifacts?expiry=all')).json.total, (await call(owner.cookie, '/api/admin/artifacts')).json.total);
    // The later, never and past rows are not "soon".
    assert.ok(!soon.artifacts.some(a => [later.id, never.id, past.id].includes(a.id)));
  });
});

test('people carry live artifact counts and recorded sign-in times', async () => {
  await withWorker({}, async ({ signIn, call, send, account }) => {
    const owner = await signIn('owner@example.com');
    const member = await account(owner.cookie, 'signed-in@example.com');
    // An invitation that was never accepted.
    const invited = await send('/api/invitations', { method: 'POST', cookie: owner.cookie, body: { email: 'pending@example.com' } }, owner.cookie);
    assert.equal(invited.status, 200);

    await create(member.cookie, call, 'Counted live');
    const archived = await create(member.cookie, call, 'Counted archived');
    const expiring = await create(member.cookie, call, 'Counted expiring');
    assert.equal((await call(member.cookie, `/api/artifacts/${archived.id}/manage`, { method: 'PATCH', body: { archived: true } })).status, 200);
    // An artifact from before accounts: no owner row, so the instance owner holds it.
    const legacy = await create(owner.cookie, call, 'Legacy owned');
    registrySQL('UPDATE artifacts SET owner_id=NULL WHERE id=?', legacy.id);

    let people = (await call(owner.cookie, '/api/people')).json.users;
    const byId = id => people.find(u => u.id === id);
    assert.equal(byId(member.user.id).artifactCount, 3, 'archived counts too');
    assert.equal(byId('instance-owner').artifactCount, 1, 'a row with no owner counts for the instance owner');
    assert.equal((await call(member.cookie, '/api/people')).status, 403, 'people is owner-only');

    // Suspended accounts keep their counts and their recorded sign-in.
    const disabled = await send(`/api/people/${member.user.id}`, { method: 'PATCH', cookie: owner.cookie, body: { status: 'disabled' } }, owner.cookie);
    assert.equal(disabled.status, 200);
    people = (await call(owner.cookie, '/api/people')).json.users;
    const suspended = people.find(u => u.id === member.user.id);
    assert.equal(suspended.status, 'disabled');
    assert.equal(suspended.artifactCount, 3, 'a suspended owner still shows what they hold');
    assert.match(suspended.lastSignInAt, /^\d{4}-\d{2}-\d{2}T/);

    // The pending invitation never signed in: null, not a claim it never will.
    const pending = people.find(u => u.email === 'pending@example.com');
    assert.equal(pending.lastSignInAt, null);
    assert.ok(people.every(u => Object.hasOwn(u, 'artifactCount') && Object.hasOwn(u, 'lastSignInAt')));
    // No secrets ride along.
    assert.ok(people.every(u => !('token' in u) && !('hash' in u) && !('session' in u)));

    // A past deadline takes it out of the count, archived rows still in it.
    registrySQL('UPDATE artifacts SET expires_at=? WHERE id=?', seconds(-60), expiring.id);
    people = (await call(owner.cookie, '/api/people')).json.users;
    assert.equal(people.find(u => u.id === member.user.id).artifactCount, 2, 'an expired artifact no longer counts');
    assert.equal(people.find(u => u.id === member.user.id).artifactCount, 2);
  });
});
