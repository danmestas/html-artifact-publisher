import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snippetParts, snippetPath, matchReason, termsNote, statusNote, coverageNote,
  readSort, readSortState, readSortChoice, sortAfterQuery, urlSort, expiryLabel, expirySoon,
} from '../public/library-search.js';

test('a body excerpt is split into literal text and matching words without interpreting markup', () => {
  const text = 'Compare <img src=x onerror=alert(1)> across five repositories.';
  const start = text.indexOf('five');
  const parts = snippetParts({ text, matches: [{ start, end: start + 4 }], path: 'index.html' });
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.deepEqual(parts.filter(part => part.match), [{ text: 'five', match: true }]);
  assert.ok(parts.some(part => part.text.includes('<img src=x onerror=alert(1)>')));
});

test('invalid, overlapping, and surrogate-splitting highlights render only literal text', () => {
  const text = '😀 five repositories';
  for (const matches of [
    [{ start: -1, end: 2 }], [{ start: 1, end: 2 }], [{ start: 0, end: 1 }],
    [{ start: 3, end: 7 }, { start: 5, end: 9 }], [{ start: 0, end: 100 }],
  ]) assert.deepEqual(snippetParts({ text, matches }), [{ text, match: false }]);
  assert.equal(snippetParts({ text, matches: [{ start: 3, end: 7 }] }).find(part => part.match).text, 'five');
});

test('the snippet caption names the page the excerpt came from, bounded and never a link', () => {
  assert.equal(snippetPath({ text: 'x', matches: [], path: 'notes/2024/index.html' }), 'notes/2024/index.html');
  assert.equal(snippetPath({ path: 'a'.repeat(400) }).length, 201, 'a long path is cut with an ellipsis');
  assert.ok(snippetPath({ path: 'a'.repeat(400) }).endsWith('…'));
  assert.equal(snippetPath({ path: '' }), 'In this artifact');
  assert.equal(snippetPath({}), 'In this artifact');
});

test('a match reason says where the words were found without overclaiming', () => {
  // Both title and content carried the words: say content, the harder claim.
  assert.equal(matchReason({ matchedTerms: ['capybara'], totalTerms: 1, partial: false, snippet: { text: 'Capybara report', matches: [], path: 'index.html' } }, 'Quarterly capybara notes'), 'Matched in page content');
  assert.equal(matchReason({ matchedTerms: ['x'], totalTerms: 1, snippet: null }, 'Title holds x'), 'Matched in title');
  assert.equal(matchReason({ matchedTerms: ['x'], totalTerms: 1, snippet: null }, 'Nothing here'), 'Matched in title or content');
  assert.equal(matchReason(null, 'anything'), '');
});

test('a partial search says how many of the words matched, never that all did', () => {
  assert.equal(termsNote({ matchedTerms: ['a', 'b'], totalTerms: 2, partial: false }), '');
  assert.equal(termsNote({ matchedTerms: ['a'], totalTerms: 3, partial: true }), 'Matched 1 of 3 words');
  assert.equal(termsNote({ matchedTerms: [], totalTerms: 2, partial: true }), 'Matched neither of 2 words');
  assert.equal(termsNote(null), '');
  // The envelope carries no matchedIn field, so no location is ever named.
  assert.equal(termsNote({ matchedTerms: ['a'], totalTerms: 3, partial: true, matchedIn: 'title' }), 'Matched 1 of 3 words');
  // A count that contradicts itself is still described as a fraction, not a
  // bigger number than the whole.
  assert.equal(termsNote({ matchedTerms: ['a', 'b', 'c'], totalTerms: 2, partial: true }), 'Matched 2 of 2 words');
});

test('an incomplete index is described quietly and truthfully per row', () => {
  assert.equal(statusNote({ status: 'complete' }), '');
  // A partial script means some content may not have made it into the index.
  // It is not proof that the page could not be read.
  const partial = statusNote({ status: 'partial' });
  assert.match(partial, /may not be searchable/);
  assert.doesNotMatch(partial, /could not be read|unreadable|cannot be read/);
  assert.equal(statusNote({ status: 'pending' }), 'Content not searched yet');
  assert.equal(statusNote({ status: 'error' }), 'Content search failed');
  assert.equal(statusNote({ status: 'unsupported' }), 'Content search is not available for this page');
  assert.equal(statusNote({ status: 'unknown' }), '');
  assert.equal(statusNote(null), '');
});

test('coverage is shown only when the index cannot answer the whole question', () => {
  const full = { total: 10, complete: 10, partial: 0, pending: 0, error: 0, unsupported: 0 };
  assert.equal(coverageNote(full), '');
  const partial = { total: 10, complete: 7, partial: 1, pending: 1, error: 0, unsupported: 1 };
  assert.equal(coverageNote(partial), 'Content search covers 7 of 10 artifacts; 1 partly searched, 1 not searched yet, 1 cannot be searched.');
  const none = { total: 4, complete: 0, partial: 0, pending: 4, error: 0, unsupported: 0 };
  assert.equal(coverageNote(none), 'No artifact content has been searched yet.');
  assert.equal(coverageNote(null), '');
  assert.equal(coverageNote({ total: 0, complete: 0, partial: 0, pending: 0, error: 0, unsupported: 0 }), '');
});

test('a partly searched index is never described as nothing searched, and its counts are exact', () => {
  // complete 0 with a partial artifact: some content WAS searched. Saying
  // nothing has been searched would be false.
  const partialOnly = { total: 5, complete: 0, partial: 1, pending: 4, error: 0, unsupported: 0 };
  const note = coverageNote(partialOnly);
  assert.doesNotMatch(note, /No artifact content has been searched/);
  assert.equal(note, 'Content search covers 0 of 5 artifacts; 1 partly searched, 4 not searched yet.');
  // Every remainder bucket is accounted for, and its numbers are the counts.
  assert.equal(coverageNote({ total: 6, complete: 2, partial: 0, pending: 0, error: 3, unsupported: 1 }),
    'Content search covers 2 of 6 artifacts; 3 search failed, 1 cannot be searched.');
  // All-unsupported is not "nothing searched yet" either.
  assert.equal(coverageNote({ total: 3, complete: 0, partial: 0, pending: 0, error: 0, unsupported: 3 }),
    'No artifact content in this library can be searched.');
  // Out-of-range or contradictory counts are not printed as if exact.
  for (const broken of [
    { total: 5, complete: -1, partial: 1, pending: 5, error: 0, unsupported: 0 },
    { total: 5, complete: 9, partial: 0, pending: 0, error: 0, unsupported: 0 },
    { total: 5, complete: 2, partial: 1, pending: 1, error: 0, unsupported: 0 },
    { total: 5, complete: 2.5, partial: 1, pending: 1, error: 0, unsupported: 0 },
    { total: 5, complete: '2', partial: 1, pending: 2, error: 0, unsupported: 0 },
  ]) {
    const generic = coverageNote(broken);
    assert.doesNotMatch(generic, /\d+ of \d+/, 'no precise counts from an inconsistent payload');
  }
});

test('near-term expiration uses local calendar days, not an unexplained date', () => {
  const now = new Date(2026, 10, 24, 12, 0, 0).getTime();
  const at = (day, hour = 13) => new Date(2026, 10, day, hour).toISOString();
  assert.equal(expiryLabel(null, now), 'Never');
  assert.equal(expiryLabel('invalid', now), 'Unknown date');
  assert.equal(expiryLabel(at(24, 11), now), 'Expired');
  assert.equal(expiryLabel(at(24), now), 'Today');
  assert.equal(expiryLabel(at(25, 1), now), 'Tomorrow', 'a deadline less than 24 hours away may still be tomorrow');
  assert.equal(expiryLabel(at(27), now), 'In 3 days');
  assert.equal(expiryLabel(at(30), now), 'In 6 days');
  const later = new Date(2026, 11, 15, 13);
  assert.equal(expiryLabel(later.toISOString(), now), later.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
  for (const [month, day] of [[2, 7], [9, 31]]) {
    const start = new Date(2026, month, day, 12);
    const end = new Date(2026, month, day + 2, 12);
    assert.equal(expiryLabel(end.toISOString(), start.getTime()), 'In 2 days', 'calendar labels survive daylight-saving changes');
  }
});

test('urgency is limited to valid near deadlines, never the Never label', () => {
  const now = new Date(2026, 10, 24, 12).getTime();
  const at = day => new Date(2026, 10, day, 23).toISOString();
  assert.equal(expirySoon(null, now), false);
  assert.equal(expirySoon('invalid', now), false);
  assert.equal(expirySoon(at(23), now), true, 'a stale expired row still needs attention');
  assert.equal(expirySoon(at(24), now), true);
  assert.equal(expirySoon(at(25), now), true);
  assert.equal(expirySoon(at(31), now), true, 'seven local calendar days includes the whole seventh day');
  assert.equal(expirySoon(at(32), now), false);
});

test('the sort choice keeps an explicit recent or name across query edits', () => {
  // Regression: an explicit recent in the URL is honored under a query.
  assert.equal(readSort(new URLSearchParams('q=a&sort=recent')), 'recent');
  assert.equal(readSort(new URLSearchParams('sort=relevance&q=a')), 'relevance');
  assert.equal(readSort(new URLSearchParams('q=a')), 'relevance', 'a query with no sort reads as relevance');
  assert.equal(readSort(new URLSearchParams('')), 'recent');
  assert.equal(readSort(new URLSearchParams('sort=name')), 'name');
  assert.equal(readSort(new URLSearchParams('sort=expiry'), true), 'expiry');
  assert.equal(readSort(new URLSearchParams('sort=expiry')), 'recent', 'expiry requires a library or inventory caller to opt in');
  // Only a sort named in the URL is the reader's choice.
  assert.equal(readSortChoice(new URLSearchParams('sort=name')), true);
  assert.equal(readSortChoice(new URLSearchParams('q=a')), false);
  assert.equal(readSortChoice(new URLSearchParams('sort=bogus')), false);
  // Typing a query where none was: a chosen recent/name is kept; an unchosen
  // default becomes relevance, which is what a fresh query means.
  assert.equal(sortAfterQuery('expiry', '', 'capybara', true), 'expiry');
  assert.equal(sortAfterQuery('expiry', 'capybara', '', true), 'expiry');
  assert.equal(sortAfterQuery('recent', '', 'capybara', true), 'recent');
  assert.equal(sortAfterQuery('name', '', 'capybara', true), 'name');
  assert.equal(sortAfterQuery('recent', '', 'capybara', false), 'relevance');
  assert.equal(sortAfterQuery('relevance', '', 'capybara', false), 'relevance');
  // Clearing the query returns relevance to recent; explicit choices survive.
  assert.equal(sortAfterQuery('relevance', 'capybara', '', true), 'recent');
  assert.equal(sortAfterQuery('relevance', 'capybara', '', false), 'recent');
  assert.equal(sortAfterQuery('name', 'capybara', '', true), 'name');
  assert.equal(sortAfterQuery('recent', 'x', 'y', true), 'recent');
  // A query that is only whitespace is not a query.
  assert.equal(sortAfterQuery('relevance', 'capybara', '   ', false), 'recent');
});

test('a default recent is distinguishable from a recent the reader chose', () => {
  // Same sort value, different provenance: the UI must know which it holds so
  // a first query only becomes relevance when nobody chose the order.
  assert.deepEqual(readSortState(new URLSearchParams('')), { sort: 'recent', chosen: false });
  assert.deepEqual(readSortState(new URLSearchParams('q=a')), { sort: 'relevance', chosen: false });
  assert.deepEqual(readSortState(new URLSearchParams('q=a&sort=recent')), { sort: 'recent', chosen: true });
  assert.deepEqual(readSortState(new URLSearchParams('sort=recent')), { sort: 'recent', chosen: true });
  assert.deepEqual(readSortState(new URLSearchParams('sort=name')), { sort: 'name', chosen: true });
  assert.deepEqual(readSortState(new URLSearchParams('sort=expiry'), true), { sort: 'expiry', chosen: true });
  assert.deepEqual(readSortState(new URLSearchParams('sort=expiry')), { sort: 'recent', chosen: false },
    'expiry without a library or inventory opt-in is not a usable choice');
  // First query from a default recent: relevance. First query after the reader
  // picked recent: their choice stands.
  const fresh = readSortState(new URLSearchParams(''));
  assert.equal(sortAfterQuery(fresh.sort, '', 'capybara', fresh.chosen), 'relevance');
  const picked = readSortState(new URLSearchParams('sort=recent'));
  assert.equal(sortAfterQuery(picked.sort, '', 'capybara', picked.chosen), 'recent');
  const named = readSortState(new URLSearchParams('sort=name'));
  assert.equal(sortAfterQuery(named.sort, '', 'capybara', named.chosen), 'name');
});

test('the URL writes an explicit recent when a query would otherwise default to relevance', () => {
  assert.equal(urlSort('relevance', 'capybara'), null, 'relevance is the default under a query');
  assert.equal(urlSort('recent', 'capybara'), 'recent', 'an explicit recent survives a query');
  assert.equal(urlSort('name', 'capybara'), 'name');
  assert.equal(urlSort('recent', ''), null, 'a default recent without a query writes nothing');
  assert.equal(urlSort('name', ''), 'name');
  assert.equal(urlSort('relevance', ''), null, 'relevance without a query means recent');
  assert.equal(urlSort('expiry', 'x'), 'expiry');
});

test('a recent the reader chose is written even without a query, so a reload keeps it', () => {
  // Without a query, recent is the default and normally writes nothing. But a
  // chosen recent must survive a reload, or the next query would flip it to
  // relevance as though the reader had never chosen.
  assert.equal(urlSort('recent', '', true), 'recent');
  assert.equal(urlSort('recent', 'capybara', true), 'recent');
  assert.equal(urlSort('recent', '', false), null, 'the untouched default stays unwritten');
  assert.equal(urlSort('relevance', '', true), 'recent', 'relevance without a query is still recent');
  assert.equal(urlSort('name', '', true), 'name');
});
