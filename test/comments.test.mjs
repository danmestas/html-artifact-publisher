import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorFor, arrange, attachmentDisplay, decodePointAnchor, encodePointAnchor, findQuotes, thread } from '../public/comments.js';

test('point anchors have a bounded, exact wire format and round normalized positions', () => {
  const anchor = encodePointAnchor({ id: 'intro', path: [1, 0], x: .123456, y: 1 });
  assert.equal(anchor, 'hap-point:{"id":"intro","path":[1,0],"x":0.1235,"y":1}');
  assert.deepEqual(decodePointAnchor(anchor), { id: 'intro', path: [1, 0], x: .1235, y: 1 });
  assert.equal(encodePointAnchor({ id: 'a'.repeat(161), path: [], x: 0, y: .5 }), 'hap-point:{"id":"","path":[],"x":0,"y":0.5}');
  assert.equal(encodePointAnchor({ id: '\\'.repeat(160), path: Array(32).fill(65535), x: 0, y: 0 }), '');
  for (const bad of [null, {}, { id: '', path: [], x: -1, y: 0 }, { id: '', path: [], x: Infinity, y: 0 }, { id: '', path: [1.5], x: 0, y: 0 }, { id: '', path: [-1], x: 0, y: 0 }, { id: '', path: [65536], x: 0, y: 0 }, { id: '', path: Array(33).fill(0), x: 0, y: 0 }, { id: '', path: Array(1), x: 0, y: 0 }, { id: 'a\u0000b', path: [], x: 0, y: 0 }]) {
    assert.equal(encodePointAnchor(bad), '');
  }
});

test('point anchor decoder rejects malformed or extended data and is self-contained', () => {
  const good = { id: '', path: [], x: 0, y: 1 };
  for (const value of [null, '', 'intro', 'hap-point:', 'hap-point:null', 'hap-point:[]', 'hap-point:' + JSON.stringify({ ...good, extra: true }), 'hap-point:' + JSON.stringify({ ...good, x: '0' }), 'hap-point:' + JSON.stringify({ ...good, id: 'x'.repeat(161) }), 'hap-point:' + JSON.stringify({ ...good, path: Array(33).fill(0) }), 'hap-point:' + JSON.stringify({ ...good, y: 1.1 }), 'hap-point:' + ' '.repeat(501)]) assert.equal(decodePointAnchor(value), null);
  const encode = new Function('return (' + encodePointAnchor.toString() + ')')();
  const decode = new Function('return (' + decodePointAnchor.toString() + ')')();
  assert.deepEqual(decode(encode(good)), good);
});

const ticket = (status, changes, fields = {}) => ({
  uuid: 'a'.repeat(40), status, changed: '2026-10-26T00:00:00Z',
  fields: { title: 'T', comment: 'opening', subsystem: '', ...fields },
  changes: changes.map(([user, comment, f = {}]) => ({ artifact: 'b'.repeat(40), user, time: '2026-10-26T00:00:00Z', comment, fields: f })),
});

// Quote anchors are matched in the page's text nodes with whitespace runs
// collapsed, so a selection made across elements or line breaks still finds
// its place in the same page rendered again. The page text is collapsed once
// for all the anchors, so anchors that match nothing cost one search each.
test('findQuotes: quotes across text nodes, whitespace-insensitive, in one pass', () => {
  const texts = ['Intro', '\n  The heading ', 'reads', '\n oddly here.'];
  const [a, b, none, blank] = findQuotes(texts, ['heading reads oddly', '  heading\nreads  ', 'not on the page', '   ']);
  assert.deepEqual(a, { start: [1, 7], end: [3, 7] });
  assert.deepEqual(b, { start: [1, 7], end: [2, 5] }, 'the quote is normalized too');
  assert.equal(none, null);
  assert.equal(blank, null, 'a blank quote matches nothing');
  assert.deepEqual(findQuotes(['abc'], ['abc']), [{ start: [0, 0], end: [0, 3] }]);
  assert.deepEqual(findQuotes([], ['x']), [null]);
  assert.deepEqual(findQuotes(texts, []), []);
  // Many anchors that match nothing, against a large page: one answer each, in order.
  const page = Array.from({ length: 2000 }, (_, i) => `paragraph ${i} with   some\ttext `);
  const misses = Array.from({ length: 500 }, (_, i) => `x${i} `.repeat(100).slice(0, 500));
  const hits = findQuotes(page, [...misses, 'paragraph 1999 with some text']);
  assert.equal(hits.length, 501);
  assert.ok(hits.slice(0, 500).every(h => h === null));
  assert.deepEqual(hits[500], { start: [1999, 0], end: [1999, 31] });
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

test('attachmentDisplay: only an editor’s raster image shows inline; everything else is a link', () => {
  const a = (over = {}) => ({ name: 'shot.png', size: 2048, type: 'image/png', url: '/a/x?sig', user: 'edit-link', ...over });
  assert.equal(attachmentDisplay(a()).inline, true);
  assert.equal(attachmentDisplay(a({ user: 'owner' })).inline, true);
  assert.equal(attachmentDisplay(a({ user: 'comment-link' })).inline, false, 'a comment link holder\'s image is a link');
  assert.equal(attachmentDisplay(a({ type: 'image/svg+xml', name: 'x.svg' })).inline, false, 'SVG is never inline');
  assert.equal(attachmentDisplay(a({ type: 'text/html', name: 'x.html' })).inline, false);
  assert.equal(attachmentDisplay(a({ url: undefined, missing: true })).inline, false);
  assert.deepEqual(attachmentDisplay(a({ user: 'comment-link' })), { inline: false, label: 'shot.png (2 KB)', missing: false });
  assert.deepEqual(attachmentDisplay(a({ size: 300, url: undefined, missing: true })), { inline: false, label: 'shot.png (300 B)', missing: true });
  assert.equal(attachmentDisplay(a({ size: 3_500_000 })).label, 'shot.png (3.3 MB)');
});
