import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestPanel } from '../public/guest-panel.js';

// Minimal DOM port: tests observe rendered private data, not module internals.
function dom() {
  class Element {
    children = []; textContent = ''; hidden = false;
    addEventListener() {}
    setAttribute() {}
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    get childElementCount() { return this.children.length; }
  }
  const nodes = new Map();
  return {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); },
    createElement() { return new Element(); },
  };
}

test('silent participant checks do not cancel an in-flight pagination request', async () => {
  const previous = globalThis.document;
  const document = dom();
  globalThis.document = document;
  let release;
  let calls = 0;
  try {
    const panel = guestPanel({
      artifact: () => null, info: () => ({ guestDiscussion: true, canManage: true }),
      account: async () => 'owner', current: async () => true, path: p => p,
      refresh: async () => {},
      manage: async () => {
        calls++;
        if (calls === 2) return await new Promise(resolve => { release = resolve; });
        return { guests: [{ id: 'first', name: 'First' }], nextCursor: 'next' };
      },
    });
    await panel.loadGuests();
    const loading = panel.loadGuests(true);
    await Promise.resolve();
    assert.equal(typeof release, 'function');
    await panel.loadGuests(false, { revalidateOnly: true });
    release({ guests: [{ id: 'second', name: 'Second' }], nextCursor: null });
    await loading;
    assert.equal(document.getElementById('guestList').childElementCount, 2);
    assert.equal(document.getElementById('guestManagementStatus').textContent, '');
    assert.equal(document.getElementById('moreGuests').hidden, true);
  } finally { globalThis.document = previous; }
});

test('participant details disappear when a refreshed owner request is refused', async () => {
  const previous = globalThis.document;
  const document = dom();
  globalThis.document = document;
  let refused = false;
  try {
    const panel = guestPanel({
      artifact: () => null, info: () => ({ guestDiscussion: true, canManage: true }),
      account: async () => 'owner', current: async () => true, path: p => p,
      refresh: async () => {},
      manage: async () => {
        if (refused) throw new Error('Artifact owner required');
        return { guests: [{ id: 'guest', name: 'Rae', email: 'private@example.com' }], nextCursor: null };
      },
    });
    await panel.loadGuests();
    assert.equal(document.getElementById('guestList').childElementCount, 1);
    refused = true;
    await panel.loadGuests();
    assert.equal(document.getElementById('guestList').childElementCount, 0, 'a denied refresh must not retain former-owner private profiles');
    assert.equal(document.getElementById('moreGuests').hidden, true);
  } finally { globalThis.document = previous; }
});
