import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore } from '../public/comment-drafts.js';

function storage() {
  const values = new Map();
  return { get length() { return values.size; }, key: n => [...values.keys()][n] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const binding = { artifact: 'artifact-one', version: 'version-one', thread: '', kind: 'new', identity: 'guest-one' };

test('draft discovery exposes only valid drafts for the current artifact, version and identity', () => {
  const tab = storage(), store = createDraftStore({ storage: tab });
  store.save(binding, { text: 'New comment' });
  store.save({ ...binding, kind: 'reply', thread: 'older-thread' }, { text: 'Unloaded reply' });
  store.save({ ...binding, identity: 'another-person' }, { text: 'Private to someone else' });
  store.save({ ...binding, artifact: 'another-artifact' }, { text: 'Different artifact' });
  const found = createDraftStore({ storage: tab }).list(binding);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(entry => entry.binding.kind).sort(), ['new', 'reply']);
  assert.ok(found.every(entry => entry.binding.identity === binding.identity));
  const memory = createDraftStore({ storage: null });
  memory.save(binding, { text: 'Memory recovery' });
  assert.equal(memory.list(binding)[0].draft.text, 'Memory recovery');
});

test('expired drafts are removed and successful posting or explicit discard clears recovery', () => {
  const tab = storage(); let time = 1000;
  const store = createDraftStore({ storage: tab, now: () => time, maxAgeMs: 50 });
  store.save(binding, { text: 'Draft before deadline' });
  time += 50;
  assert.equal(store.load(binding), null);
  assert.equal(tab.length, 0);
  store.save(binding, { text: 'Draft to discard' });
  store.remove(binding);
  assert.equal(store.load(binding), null);
  store.save(binding, { text: 'Another draft' });
  store.save(binding, { text: '' });
  assert.equal(store.load(binding), null);
});

test('blocked or exhausted storage preserves the live draft without promising reload recovery', () => {
  const blocked = createDraftStore({ storage: { setItem() { throw new Error('quota'); }, getItem() { throw new Error('blocked'); }, removeItem() {} } });
  assert.equal(blocked.save(binding, { text: 'Keep this text' }), true);
  assert.equal(blocked.persistent, false);
  assert.equal(blocked.load(binding).text, 'Keep this text');
  const unavailable = createDraftStore({ storage: null });
  unavailable.save(binding, { text: 'Page-only draft' });
  assert.equal(unavailable.persistent, false);
  assert.equal(unavailable.load(binding).text, 'Page-only draft');
});

test('account loss can clear all draft principals without clearing unrelated tab state', () => {
  const tab = storage(), store = createDraftStore({ storage: tab });
  tab.setItem('unrelated-preference', 'kept');
  store.save(binding, { text: 'Guest draft' });
  store.save({ ...binding, identity: 'account-one' }, { text: 'Account draft' });
  store.clearAll();
  assert.equal(store.list(binding).length, 0);
  assert.equal(store.load({ ...binding, identity: 'account-one' }), null);
  assert.equal(tab.getItem('unrelated-preference'), 'kept');
});

test('changing identity clears only that identity and leaves other browser data alone', () => {
  const tab = storage(), store = createDraftStore({ storage: tab });
  tab.setItem('unrelated-preference', 'kept');
  store.save(binding, { text: 'First identity' });
  const second = { ...binding, identity: 'second-identity' };
  store.save(second, { text: 'Second identity' });
  store.clearIdentity(binding.identity);
  assert.equal(store.load(binding), null);
  assert.equal(store.load(second).text, 'Second identity');
  assert.equal(tab.getItem('unrelated-preference'), 'kept');
});

test('only bounded recovery content is stored, never arbitrary caller metadata', () => {
  const tab = storage(), store = createDraftStore({ storage: tab });
  store.save({ ...binding, accessToken: 'must-not-be-stored' }, { text: 'Draft', accessToken: 'must-not-be-stored', email: 'not-stored@example.com', context: { label: 'x'.repeat(500), quote: 'y'.repeat(1000) } });
  const raw = tab.getItem(tab.key(0));
  assert.ok(!raw.includes('must-not-be-stored') && !raw.includes('not-stored@example.com'));
  assert.equal(store.load(binding).context.label.length, 120);
  assert.equal(store.load(binding).context.quote.length, 240);
  assert.equal(store.save(binding, { text: 'x'.repeat(8001) }), false);
  assert.equal(store.load(binding).text, 'Draft', 'an invalid save cannot replace a valid draft');
  const loaded = store.load(binding); loaded.context.label = 'changed outside store';
  assert.notEqual(store.load(binding).context.label, loaded.context.label);
});

test('malformed or mismatched records never restore another binding', () => {
  const tab = storage(), store = createDraftStore({ storage: tab });
  store.save(binding, { text: 'Draft' });
  const key = tab.key(0), record = JSON.parse(tab.getItem(key));
  record.key = 'different-binding';
  tab.setItem(key, JSON.stringify(record));
  assert.equal(store.load(binding), null);
  tab.setItem(key, '{broken JSON');
  assert.equal(store.load(binding), null);
  assert.equal(store.save({ ...binding, identity: '' }, { text: 'Unscoped' }), false);
});

test('a new viewer document restores a draft only for the same artifact, version, thread and identity', () => {
  const tab = storage();
  const first = createDraftStore({ storage: tab });
  assert.equal(first.save(binding, { text: 'Please clarify the date.', anchor: 'hap-point:sample', context: { label: 'Scope', quote: 'Launch on 26 November.' } }), true);
  const restored = createDraftStore({ storage: tab }).load(binding);
  assert.equal(restored.text, 'Please clarify the date.');
  assert.equal(restored.anchor, 'hap-point:sample');
  assert.equal(restored.context.label, 'Scope');
  for (const changed of [{ artifact: 'another' }, { version: 'another' }, { thread: 'another' }, { identity: 'another' }, { kind: 'reply' }]) {
    assert.equal(first.load({ ...binding, ...changed }), null);
  }
});
