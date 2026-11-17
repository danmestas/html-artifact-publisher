// Search responses contain text and UTF-16 ranges, never executable markup.
// A malformed highlight falls back to literal text instead of guessing a range.
export function snippetParts(snippet) {
  if (!snippet || typeof snippet.text !== 'string') return [];
  const text = snippet.text.slice(0, 1200);
  const plain = () => text ? [{ text, match: false }] : [];
  if (!Array.isArray(snippet.matches) || snippet.matches.length > 64) return plain();
  let previous = 0;
  const parts = [];
  const splitsPair = at => at > 0 && at < text.length
    && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]);
  for (const range of snippet.matches) {
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end)
      || range.start < previous || range.end <= range.start || range.end > text.length
      || splitsPair(range.start) || splitsPair(range.end)) return plain();
    if (range.start > previous) parts.push({ text: text.slice(previous, range.start), match: false });
    parts.push({ text: text.slice(range.start, range.end), match: true });
    previous = range.end;
  }
  if (previous < text.length) parts.push({ text: text.slice(previous), match: false });
  return parts;
}

// The caption under an excerpt names its page. It is text, never a link, and
// a pathological path is cut rather than allowed to stretch the row.
export function snippetPath(snippet) {
  const path = typeof snippet?.path === 'string' ? snippet.path : '';
  if (!path) return 'In this artifact';
  return path.length > 200 ? path.slice(0, 200) + '…' : path;
}

// Where the words were found. With no server-provided field to tell title from
// content apart, the only honest claim is the general one.
export function matchReason(search, title) {
  if (!search) return '';
  if (search.snippet) return 'Matched in page content';
  const terms = Array.isArray(search.matchedTerms) ? search.matchedTerms : [];
  const text = String(title || '').toLocaleLowerCase();
  if (terms.length && terms.some(term => text.includes(String(term).toLocaleLowerCase()))) return 'Matched in title';
  return 'Matched in title or content';
}

// A partial search shows how many of the words it satisfied. Never claim all
// of them matched when the response says otherwise. The server sends no field
// saying where they matched, so nothing here guesses one.
export function termsNote(search) {
  if (!search || !search.partial) return '';
  const matched = Array.isArray(search.matchedTerms) ? search.matchedTerms.length : 0;
  const total = Number.isInteger(search.totalTerms) && search.totalTerms > 0 ? search.totalTerms : 0;
  if (!total) return '';
  if (matched === 0) return total === 2 ? 'Matched neither of 2 words' : `Matched none of ${total} words`;
  return `Matched ${Math.min(matched, total)} of ${total} words`;
}

const STATUS_NOTES = {
  // The indexer skips scripts and private form values, so a partial result
  // means some content may be missing from the index. It is not proof that
  // anything failed to be read.
  partial: 'Some of this page may not be searchable',
  pending: 'Content not searched yet',
  error: 'Content search failed',
  unsupported: 'Content search is not available for this page',
};
// A row's index state, said once and quietly. A complete index says nothing.
export function statusNote(searchIndex) {
  return STATUS_NOTES[searchIndex?.status] || '';
}

// Coverage counts are only printed when they are whole, non-negative and add
// up to the stated total. Anything else gets a sentence that claims no numbers.
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
function coverageCounts(coverage) {
  if (!coverage || typeof coverage !== 'object') return null;
  const fields = ['complete', 'partial', 'pending', 'error', 'unsupported'].map(key => count(coverage[key]));
  const total = count(coverage.total);
  if (total === null || fields.some(value => value === null)) return null;
  const [complete, partial, pending, error, unsupported] = fields;
  // Contradictory payloads (a sum that disagrees with the total, or a total of
  // zero with rows in a bucket) are not described as exact.
  if (complete + partial + pending + error + unsupported !== total) return null;
  return { total, complete, partial, pending, error, unsupported };
}
const listOf = entries => entries.filter(([, n]) => n > 0).map(([text, n]) => `${n} ${text}`).join(', ');
// Coverage is stated only when the index cannot answer the whole question,
// including when a search returns no rows at all. Counts are top-level totals
// the server already scoped to what this reader may see.
export function coverageNote(coverage) {
  const counts = coverageCounts(coverage);
  if (!counts) {
    // An unreadable payload still must not imply the search was complete.
    return coverage && typeof coverage === 'object' && count(coverage.total) ? 'Content search coverage could not be read.' : '';
  }
  const { total, complete, partial, pending, error, unsupported } = counts;
  if (total === 0) return '';
  if (complete === total) return '';
  const searched = complete + partial;
  if (!searched) {
    // Nothing indexed yet, but distinguish "waiting to be searched" from
    // "cannot be searched at all" rather than calling both unsearched.
    if (pending) return 'No artifact content has been searched yet.';
    return 'No artifact content in this library can be searched.';
  }
  const notes = listOf([
    ['partly searched', partial],
    ['not searched yet', pending],
    ['search failed', error],
    ['cannot be searched', unsupported],
  ]);
  return `Content search covers ${complete} of ${total} artifacts${notes ? `; ${notes}` : ''}.`;
}

const SORTS = new Set(['relevance', 'recent', 'name', 'expiry']);
const URL_SORTS = new Set(['relevance', 'recent', 'name', 'expiry']);
// A query with no explicit sort reads as relevance, which is what the server
// defaults to under a non-empty q. Expiry belongs to the admin inventory.
export function readSort(params, inventory = false) {
  return readSortState(params, inventory).sort;
}

// The sort and whether it came from the URL rather than from the default for
// the current query. The two must stay distinct: a default recent under a fresh
// query becomes relevance, while a recent the reader chose stands.
export function readSortState(params, inventory = false) {
  const requested = params.get('sort');
  if (requested && URL_SORTS.has(requested) && (requested !== 'expiry' || inventory)) {
    return { sort: requested, chosen: true };
  }
  return { sort: params.get('q')?.trim() ? 'relevance' : 'recent', chosen: false };
}

const hasQuery = q => String(q || '').trim() !== '';
// Whether the URL carries a sort the reader actually chose, as opposed to the
// default inferred from q. Only a chosen sort is preserved across query edits.
export function readSortChoice(params, inventory = false) {
  return readSortState(params, inventory).chosen;
}
// Moving between a query and no query picks the default that fits, but never
// overrides a sort the reader chose. `chosen` says whether the current sort
// came from the URL rather than from the default for the previous query.
export function sortAfterQuery(current, previousQuery, nextQuery, chosen = false) {
  const sort = SORTS.has(current) ? current : 'recent';
  if (sort === 'relevance' && !hasQuery(nextQuery)) return 'recent';
  if (!hasQuery(previousQuery) && hasQuery(nextQuery) && !chosen) return 'relevance';
  return sort;
}

// What the URL must record. Relevance is the default under a query and recent
// is the default without one, so an explicit recent needs writing when a query
// is present; otherwise Back and reload would flip it to relevance. A recent
// the reader chose is written even without a query, because otherwise a reload
// would forget the choice and the next query would treat it as the default.
export function urlSort(sort, q, chosen = false) {
  if (sort === 'expiry' || sort === 'name') return sort;
  const query = hasQuery(q);
  if (sort === 'recent' || (sort === 'relevance' && !query)) {
    // With a query, recent is not the default and must be said. Without one,
    // only a chosen recent needs saying.
    return query || chosen ? 'recent' : null;
  }
  return null;
}
