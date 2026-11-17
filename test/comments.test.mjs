import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILTERS, SORTS, anchorFor, arrange, attachmentDisplay, boundedContext, bubblePlacement, contextLine, controls, decodePointAnchor, editable, encodePointAnchor, filterThreads, findQuotes, pageContext, searchThreads, sortThreads, thread, threadLink } from '../public/comments.js';

test('a guest discussion reader can comment without editing, moderation or attachment powers', () => {
  const guest = controls({ role: 'read', canComment: true, canModerate: false });
  assert.equal(guest.threads, true);
  assert.equal(guest.commentBox, true);
  assert.equal(guest.edit, false);
  assert.equal(guest.publish, false);
  assert.equal(guest.moderate, false);
  assert.equal(guest.attach, false);
  assert.equal(controls({ role: 'read', canComment: false }).commentBox, false);
});

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

// A comment bubble opens at the reader's click, and stays inside the page
// area: it hangs below-right of the point when there is room, flips to the
// other side when there is not, and never leaves `bounds` (the viewer's page
// area, not the whole window, so the docked inspector is never covered).
test('bubblePlacement: beside the click, flipped to stay inside the page area', () => {
  const bounds = { left: 0, top: 0, width: 1000, height: 800 };
  const size = { width: 300, height: 240 };
  // Room to the right and below: the bubble sits just past the click.
  assert.deepEqual(bubblePlacement({ x: 100, y: 100 }, size, bounds), { x: 112, y: 112, flippedX: false, flippedY: false });
  // Near the right edge it flips to the left of the point, still inside.
  const nearRight = bubblePlacement({ x: 960, y: 100 }, size, bounds);
  assert.equal(nearRight.flippedX, true);
  assert.ok(nearRight.x + 300 <= 1000 && nearRight.x >= 0, JSON.stringify(nearRight));
  // Near the bottom it flips above the point, still inside.
  const nearBottom = bubblePlacement({ x: 100, y: 780 }, size, bounds);
  assert.equal(nearBottom.flippedY, true);
  assert.ok(nearBottom.y + 240 <= 800 && nearBottom.y >= 0, JSON.stringify(nearBottom));
  // A page area smaller than the bubble clamps to its top-left corner, never negative.
  assert.deepEqual(bubblePlacement({ x: 500, y: 500 }, size, { left: 20, top: 45, width: 200, height: 150 }),
    { x: 20, y: 45, flippedX: true, flippedY: true });
  // A missing or absurd point is treated as the top-left, never NaN.
  assert.deepEqual(bubblePlacement(null, size, bounds), { x: 12, y: 12, flippedX: false, flippedY: false });
  assert.deepEqual(bubblePlacement({ x: NaN, y: Infinity }, size, bounds), { x: 12, y: 12, flippedX: false, flippedY: false });
});

// A server reference is stable for a thread's life: a reply, a resolve or a
// re-sort moves it in the list, never its number or its pin's label.
test('arrange: server refs are labels, never renumbered by activity or resolution', () => {
  const mk = (uuid, status, ref, anchor = '') => ({ ...thread(ticket(status, [['u', '']], { subsystem: anchor })), uuid, ref });
  const first = arrange([mk('1', 'Open', 14, 'intro'), mk('2', 'Open', 21, 'some words')]);
  assert.deepEqual(first.open.map(t => [t.uuid, t.label]), [['1', 14], ['2', 21]]);
  // Thread 21 is resolved and a newer thread arrives ahead of both.
  const later = arrange([mk('3', 'Open', 33, 'intro'), mk('2', 'Closed', 21, 'some words'), mk('1', 'Open', 14, 'intro')]);
  assert.deepEqual(later.open.map(t => [t.uuid, t.label]), [['3', 33], ['1', 14]]);
  assert.deepEqual(later.resolved.map(t => [t.uuid, t.label]), [['2', 21]]);
  assert.deepEqual(later.pins.map(p => p.key), [33, 14, 21], 'a pin keeps the thread reference');
  // A response with no refs at all is numbered once, and stably within it.
  const legacy = arrange([{ ...thread(ticket('Open', [['u', '']])), uuid: 'a' }, { ...thread(ticket('Open', [['u', '']])), uuid: 'b' }]);
  assert.deepEqual(legacy.open.map(t => t.label), [1, 2]);
  // Mixed: a real ref is never lowered to a generated one.
  const mixed = arrange([{ ...thread(ticket('Open', [['u', '']])), uuid: 'a', ref: 0 }, { ...thread(ticket('Open', [['u', '']])), uuid: 'b', ref: 7 }]);
  assert.deepEqual(mixed.open.map(t => [t.uuid, t.label]), [['a', 8], ['b', 7]]);
});

test('thread: viewer state and context come from the server, and are never invented', () => {
  const t = thread({
    uuid: 'a'.repeat(40), status: 'Open', changed: '2026-11-01T00:00:00Z', ref: 14,
    mine: true, unread: true, following: false,
    context: { label: 'Scope', quote: 'Launch on 26 November.', extra: 'ignored' },
    fields: { title: 'T', comment: 'opening', subsystem: 'intro' },
    changes: [{ artifact: 'b'.repeat(40), user: 'Rae (guest)', time: '2026-11-01T00:00:00Z', comment: 'opening', canEdit: true, fields: {} }],
  });
  assert.equal(t.ref, 14);
  assert.deepEqual([t.mine, t.unread, t.following], [true, true, false]);
  assert.deepEqual(t.context, { label: 'Scope', quote: 'Launch on 26 November.' }, 'bounded to label and quote');
  assert.equal(t.messages[0].canEdit, true);
  assert.equal(t.changed, '2026-11-01T00:00:00Z');
  const bare = thread(ticket('Open', [['u', 'text']]));
  assert.deepEqual([bare.ref, bare.mine, bare.unread, bare.following, bare.context], [0, false, false, false, null]);
  assert.equal(bare.messages[0].canEdit, false, 'no server proof means no edit control');
});

test('filterThreads: All, Open, Resolved, Mine, Unread and Following use server flags', () => {
  const mk = (over) => ({ ...thread(ticket(over.status ?? 'Open', [['u', 'x']])), uuid: over.uuid ?? 'a', ...over });
  const all = [mk({ uuid: '1' }), mk({ uuid: '2', status: 'Closed' }), mk({ uuid: '3', mine: true }), mk({ uuid: '4', unread: true })];
  const ids = (filter) => filterThreads(all, filter).map(t => t.uuid);
  assert.deepEqual(ids('all'), ['1', '2', '3', '4']);
  assert.deepEqual(ids('open'), ['1', '3', '4']);
  assert.deepEqual(ids('resolved'), ['2']);
  assert.deepEqual(ids('mine'), ['3']);
  assert.deepEqual(ids('unread'), ['4']);
  all[1].following = true;
  assert.deepEqual(ids('following'), ['2']);
  assert.deepEqual(ids('unknown'), ['1', '2', '3', '4']);
  assert.deepEqual(FILTERS, ['all', 'open', 'resolved', 'mine', 'unread', 'following']);
  assert.deepEqual(SORTS, ['activity', 'page']);
});

test('sortThreads and searchThreads never renumber and never mutate the input', () => {
  const rows = [
    { uuid: 'late', label: 30, title: 'Rollout', context: null, messages: [{ text: 'Later in the page' }] },
    { uuid: 'early', label: 12, title: 'Scope', context: { label: 'Scope', quote: 'launch date' }, messages: [{ text: 'Earlier' }] },
    { uuid: 'off', label: 21, title: 'Unplaced', context: null, messages: [{ text: 'Not on the page' }] },
  ];
  const copy = [...rows];
  assert.deepEqual(sortThreads(rows, 'activity').map(t => t.uuid), ['late', 'early', 'off'], 'activity keeps the route order');
  assert.deepEqual(sortThreads(rows, 'page', [12, 30]).map(t => t.uuid), ['early', 'late', 'off'], 'page order follows placed pins, unplaced last');
  assert.deepEqual(sortThreads(rows, 'page', []).map(t => t.uuid), ['late', 'early', 'off'], 'no placements keeps the route order');
  assert.deepEqual(rows, copy, 'sorting never mutates');
  assert.equal(searchThreads(rows, 'launch')[0].uuid, 'early', 'the context quote is searched');
  assert.equal(searchThreads(rows, 'SCOPE')[0].uuid, 'early', 'the section label is searched, case-insensitively');
  assert.equal(searchThreads(rows, 'rollout')[0].uuid, 'late');
  assert.deepEqual(searchThreads(rows, '  ').map(t => t.uuid), ['late', 'early', 'off'], 'blank search keeps everything');
  assert.deepEqual(searchThreads(rows, 'nothing here'), []);
});

test('threadLink copies a thread and version, and only a capability the reader legitimately holds', () => {
  const uuid = 'c'.repeat(40);
  assert.equal(threadLink({ origin: 'https://a.example', pathname: '/v/page', token: '', version: '', thread: uuid }), `https://a.example/v/page?thread=${uuid}`);
  assert.equal(threadLink({ origin: 'https://a.example', pathname: '/v/page', token: 'd'.repeat(64), version: 'abcdef12', thread: uuid }), `https://a.example/v/page?thread=${uuid}#${'d'.repeat(64)}@abcdef12`);
  assert.equal(threadLink({ origin: 'https://a.example', pathname: '/v/page', token: '', version: 'abcdef12', thread: 'C14' }), 'https://a.example/v/page#@abcdef12', 'a non-uuid reference is not copied as a query');
  assert.equal(threadLink({ origin: 'https://a.example', pathname: '/v/page', token: '', version: '', thread: `${uuid}&token=${'e'.repeat(64)}` }), 'https://a.example/v/page', 'no smuggling through the reference');
});

test('editable and contextLine bound what the UI may show of a message', () => {
  assert.equal(editable({ canEdit: true, text: 'mine' }), true);
  assert.equal(editable({ canEdit: false, text: 'theirs' }), false);
  assert.equal(editable({ canEdit: true, text: '   ' }), false);
  assert.equal(editable(null), false);
  assert.equal(contextLine({ label: 'Scope', quote: 'Launch date' }), 'Scope · “Launch date”');
  assert.equal(contextLine({ label: '  ', quote: 'Launch date' }), '“Launch date”');
  assert.equal(contextLine({ label: 'x'.repeat(200), quote: 'y'.repeat(400) }).length, 120 + 3 + 240 + 2);
  assert.equal(contextLine(null), '');
  assert.equal(contextLine({}), '');
});

test('boundedContext accepts only plain, bounded text from the page', () => {
  assert.deepEqual(boundedContext({ label: '  Scope\n heading ', quote: 'Launch   on 26 November.' }), { label: 'Scope heading', quote: 'Launch on 26 November.' });
  assert.equal(boundedContext({ label: '', quote: '' }), null);
  assert.equal(boundedContext({ label: '   ', quote: '\n\t' }), null);
  assert.equal(boundedContext(null), null);
  assert.equal(boundedContext('Scope'), null);
  assert.equal(boundedContext([{ label: 'x' }]), null);
  assert.equal(boundedContext({ label: 42, quote: null }), null);
  const long = boundedContext({ label: 'L'.repeat(300), quote: `${'word '.repeat(100)}` });
  assert.equal(long.label.length, 120);
  assert.ok(long.quote.length <= 240);
  assert.ok(!/\s$/.test(long.quote), 'no dangling space in a cut excerpt');
  assert.ok(!long.quote.endsWith('wor'), 'a long excerpt cuts at a word boundary');
});

// A tiny DOM good enough for pageContext: elements with closest/querySelector
// semantics over an explicit parent/child tree.
test('pageContext labels a section from its heading and quotes the clicked block', () => {
  const node = (tag, text = '', children = [], attrs = {}) => {
    const el = {
      nodeType: 1, tagName: tag.toUpperCase(), textContent: text, id: attrs.id ?? '', parentElement: null,
      previousElementSibling: null, nextElementSibling: null, children,
      closest(selector) { const tags = selector.split(',').map(s => s.trim().toUpperCase()); for (let n = el; n; n = n.parentElement) if (tags.includes(n.tagName)) return n; return null; },
      querySelector(selector) { const tags = selector.split(',').map(s => s.trim().toUpperCase()); const walk = n => { for (const c of n.children) { if (tags.includes(c.tagName)) return c; const f = walk(c); if (f) return f; } return null; }; return walk(el); },
    };
    for (let i = 0; i < children.length; i++) { children[i].parentElement = el; if (i) children[i].previousElementSibling = children[i - 1]; if (i < children.length - 1) children[i].nextElementSibling = children[i + 1]; }
    return el;
  };
  const paragraph = node('p', 'Launch on 26 November, after the accessibility review.');
  const heading = node('h2', 'Scope');
  const other = node('p', 'Keep existing links working.');
  const section = node('section', '', [heading, paragraph], { id: 'scope' });
  const root = node('main', '', [section, node('section', '', [node('h2', 'Rollout'), other])]);
  assert.deepEqual(pageContext(paragraph), { label: 'Scope', quote: 'Launch on 26 November, after the accessibility review.' });
  assert.deepEqual(pageContext(heading), { label: 'Scope', quote: 'Launch on 26 November, after the accessibility review.' }, 'a heading click quotes the paragraph it introduces');
  assert.deepEqual(pageContext(other), { label: 'Rollout', quote: 'Keep existing links working.' });
  // A selection overrides the block excerpt; the section label still applies.
  assert.deepEqual(pageContext(other, 'existing links'), { label: 'Rollout', quote: 'existing links' });
  // No heading anywhere: no invented label, only the text that is there.
  const bare = node('p', 'Just a line.');
  node('div', '', [bare]);
  assert.deepEqual(pageContext(bare), { label: '', quote: 'Just a line.' });
  assert.equal(pageContext(null), null);
});

test('pageContext: a click on a heading quotes the paragraph it introduces, or its own text', () => {
  const node = (tag, text = '', children = [], attrs = {}) => {
    const el = {
      nodeType: 1, tagName: tag.toUpperCase(), textContent: text, id: attrs.id ?? '', parentElement: null,
      previousElementSibling: null, nextElementSibling: null, children,
      closest(selector) { const tags = selector.split(',').map(s => s.trim().toUpperCase()); for (let n = el; n; n = n.parentElement) if (tags.includes(n.tagName)) return n; return null; },
      querySelector(selector) { const tags = selector.split(',').map(s => s.trim().toUpperCase()); const walk = n => { for (const c of n.children) { if (tags.includes(c.tagName)) return c; const f = walk(c); if (f) return f; } return null; }; return walk(el); },
    };
    for (let i = 0; i < children.length; i++) { children[i].parentElement = el; if (i) children[i].previousElementSibling = children[i - 1]; if (i < children.length - 1) children[i].nextElementSibling = children[i + 1]; }
    return el;
  };
  const bareHeading = node('h2', 'Standalone');
  node('main', '', [bareHeading]);
  assert.deepEqual(pageContext(bareHeading), { label: 'Standalone', quote: 'Standalone' }, 'nothing follows: the heading is the excerpt');
});

test('pageContext never reads injected script or style source as page text', () => {
  const textNode = data => ({ nodeType: 3, data, textContent: data });
  const el = (tag, children = [], attrs = {}) => {
    const node = { nodeType: 1, tagName: tag.toUpperCase(), id: attrs.id ?? '', parentElement: null, previousElementSibling: null, nextElementSibling: null, children,
      get firstChild() { return children[0] ?? null; },
      get textContent() { return children.map(c => c.textContent).join(''); },
      closest(selector) { const tags = selector.split(',').map(s => s.trim().toUpperCase()); for (let n = node; n; n = n.parentElement) if (tags.includes(n.tagName)) return n; return null; },
      querySelector(selector) {
        const tags = selector.split(',').map(s => s.trim().toUpperCase());
        const walk = n => { for (const c of n.children ?? []) { if (tags.includes(c.tagName)) return c; const found = walk(c); if (found) return found; } return null; };
        return walk(node);
      } };
    children.forEach((c, i) => { c.parentElement = node; c.nextSibling = children[i + 1] ?? null; if (i) c.previousElementSibling = children[i - 1]; if (i < children.length - 1) children[i].nextElementSibling = children[i + 1]; });
    return node;
  };
  // The viewer's injected runtime is a first-child script; its source is not content.
  const injected = el('script', [textNode('(function pageAppearance(){/* runtime */})')]);
  const paragraph = el('p', [textNode('Launch on 26 November.')]);
  const heading = el('h2', [textNode('Scope')]);
  const section = el('section', [heading, paragraph]);
  el('main', [injected, section]);
  assert.deepEqual(pageContext(paragraph), { label: 'Scope', quote: 'Launch on 26 November.' });
  // Clicking the runtime itself yields nothing rather than the script source.
  assert.equal(pageContext(injected), null);
  const styled = el('div', [el('style', [textNode('.x{color:red}')]), el('p', [textNode('Visible words')])]);
  assert.deepEqual(pageContext(styled), { label: '', quote: 'Visible words' });
});

test('pageContext is self-contained: it can be injected into the sandbox as source', () => {
  // The viewer injects these functions as text, so a reference to a helper
  // that is not also injected would throw inside the page. pageContext must
  // not call boundedContext (or anything else) at all.
  const source = pageContext.toString();
  assert.ok(!/\bboundedContext\b/.test(source), 'pageContext never calls the viewer-only helper');
  assert.equal(typeof pageContext, 'function');
  const node = (tag, text = '') => ({ nodeType: 1, tagName: tag.toUpperCase(), textContent: text, id: '', parentElement: null, previousElementSibling: null, nextElementSibling: null, children: [], closest() { return null; }, querySelector() { return null; } });
  const p = node('p', 'Launch on 26 November.');
  assert.deepEqual(pageContext(p), { label: '', quote: 'Launch on 26 November.' });
});

test('bubblePlacement keeps the clicked point inside a card too tall for either side', () => {
  // A card taller than the space below OR above the pin cannot sit beside it
  // without leaving the page area; it aligns to the far edge instead, so the
  // pin stays within the card rather than beyond its bottom.
  const bounds = { left: 0, top: 45, width: 1280, height: 855 };
  const size = { width: 380, height: 700 };
  const point = { x: 712, y: 255 };
  const spot = bubblePlacement(point, size, bounds);
  // Below needs 912px of room and above needs 723px; neither fits, so the
  // card aligns to the bottom and the pin at y=255 lies inside it.
  assert.equal(spot.flippedY, true);
  assert.equal(spot.y, 45 + 855 - 700, 'bottom-aligned so the pin lies inside the card');
  assert.ok(spot.y <= point.y && spot.y + size.height >= point.y);
  assert.ok(spot.x >= bounds.left && spot.x + size.width <= bounds.left + bounds.width);
});

test('thread carries lastChange so a hidden correction event still marks as read', () => {
  const t = thread({ ...ticket('Open', [['u', 'text']]), lastChange: 'e'.repeat(64), ref: 3 });
  assert.equal(t.lastChange, 'e'.repeat(64));
  // The canonical changes[] may hide the newest correction event; lastChange is
  // what discussionView must be given, so the thread does not stay unread.
  const noLast = thread(ticket('Open', [['u', 'text']]));
  assert.equal(noLast.lastChange, '', 'an older response names no last event');
});
