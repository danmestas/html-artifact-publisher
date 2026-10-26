import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorFor, arrange, findQuote, thread } from '../public/comments.js';

const ticket = (status, changes, fields = {}) => ({
  uuid: 'a'.repeat(40), status, changed: '2026-10-26T00:00:00Z',
  fields: { title: 'T', comment: 'opening', subsystem: '', ...fields },
  changes: changes.map(([user, comment, f = {}]) => ({ artifact: 'b'.repeat(40), user, time: '2026-10-26T00:00:00Z', comment, fields: f })),
});

// A quote anchor is matched in the page's text nodes with whitespace runs
// collapsed, so a selection made across elements or line breaks still finds
// its place in the same page rendered again.
test('findQuote: a quote across text nodes, whitespace-insensitive', () => {
  const texts = ['Intro', '\n  The heading ', 'reads', '\n oddly here.'];
  assert.deepEqual(findQuote(texts, 'heading reads oddly'), { start: [1, 7], end: [3, 7] });
  assert.deepEqual(findQuote(texts, '  heading\nreads  '), { start: [1, 7], end: [2, 5] }, 'the quote is normalized too');
  assert.deepEqual(findQuote(['abc'], 'abc'), { start: [0, 0], end: [0, 3] });
  assert.equal(findQuote(texts, 'not on the page'), null);
  assert.equal(findQuote(texts, '   '), null, 'a blank quote matches nothing');
  assert.equal(findQuote([], 'x'), null);
});

// A selection that is an element's whole text anchors to the element's id,
// which survives edits to its words; anything else is quoted, capped at the
// 500 characters the ticket route accepts, by code point.
test('anchorFor: an element id for a whole element, else a capped quote', () => {
  assert.equal(anchorFor({ text: ' The  heading\n', id: 'intro', idText: 'The heading' }), 'intro');
  assert.equal(anchorFor({ text: 'heading', id: 'intro', idText: 'The heading' }), 'heading');
  assert.equal(anchorFor({ text: 'some  words\nhere', id: '', idText: '' }), 'some words here');
  assert.equal(anchorFor({ text: '  ', id: 'x', idText: '' }), '');
  const long = anchorFor({ text: `${'a'.repeat(499)}😀tail`, id: '', idText: '' });
  assert.equal(Array.from(long).length, 500);
  assert.ok(long.endsWith('😀'), 'never half a surrogate pair');
  assert.ok(long.length <= 501);
});

// A reply naming a check-in (`@<hash>`) links the version that answered it;
// the opening text and words like an email address do not.
test('thread: resolved state and the check-ins replies name', () => {
  const t = thread(ticket('Closed', [
    ['comment-link', ''],
    ['edit-link', 'Fixed in @0123abcd, see also @89ef4567 and @0123abcd.'],
    ['comment-link', 'mail me@cafe1234 or @xyz or @12'],
  ], { comment: 'see @deadbeef' }));
  assert.equal(t.resolved, true);
  assert.deepEqual(t.checkins, ['0123abcd', '89ef4567']);
  assert.equal(thread(ticket('Open', [['comment-link', '']])).resolved, false);
  assert.equal(thread(ticket('', [['comment-link', '']])).resolved, false);
  assert.equal(thread(ticket('Fixed', [['editor', '']])).resolved, true, 'a status set in a terminal');
});

// Open threads first, then resolved ones, each in the order the route gave
// (newest-changed first); a thread's number is its pin's label.
test('arrange: open then resolved, numbered for their pins', () => {
  const mk = (uuid, status, anchor) => ({ ...thread(ticket(status, [['u', '']], { subsystem: anchor })), uuid });
  const { open, resolved, pins } = arrange([mk('1', 'Closed', 'intro'), mk('2', 'Open', ''), mk('3', 'Open', 'some words')]);
  assert.deepEqual(open.map(t => [t.uuid, t.label]), [['2', 1], ['3', 2]]);
  assert.deepEqual(resolved.map(t => [t.uuid, t.label]), [['1', 3]]);
  assert.deepEqual(pins, [{ key: 2, anchor: 'some words', resolved: false }, { key: 3, anchor: 'intro', resolved: true }],
    'only anchored threads get a pin; the key is the label');
});
