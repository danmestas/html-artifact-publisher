// comments.js — what the viewer offers a link holder, and how a comment
// thread reads. A thread is a Fossil ticket (src/index.ts, Tickets): its
// opening text is the ticket's comment field, a reply is a change's remark,
// and a resolution sets its status. Its anchor (the `subsystem` field) is an
// element id, a quote of the page's text, or a bounded element-relative point.
//
// The anchor helpers also run inside the sandboxed page (page-pins.js):
// they are injected as source, so they use nothing outside themselves.

/** A bounded element-relative point, safe to store in the ticket anchor field. */
export function encodePointAnchor(point) {
  if (!point || typeof point !== 'object') return '';
  const { id, path, x, y } = point;
  if (typeof id !== 'string' || id.includes('\0') || !Array.isArray(path) || path.length > 32 ||
      !Array.from(path).every(i => Number.isInteger(i) && i >= 0 && i <= 65535) ||
      !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return '';
  const anchor = 'hap-point:' + JSON.stringify({ id: id.length <= 160 ? id : '', path, x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 });
  return anchor.length <= 500 ? anchor : '';
}

/** Decode independently: this function is injected into the sandbox as source. */
export function decodePointAnchor(anchor) {
  if (typeof anchor !== 'string' || anchor.length > 500 || anchor.includes('\0') || !anchor.startsWith('hap-point:')) return null;
  try {
    const point = JSON.parse(anchor.slice(10));
    if (!point || typeof point !== 'object' || Array.isArray(point) ||
        Object.keys(point).sort().join(',') !== 'id,path,x,y') return null;
    const { id, path, x, y } = point;
    if (typeof id !== 'string' || id.length > 160 || id.includes('\0') || !Array.isArray(path) || path.length > 32 ||
        !Array.from(path).every(i => Number.isInteger(i) && i >= 0 && i <= 65535) ||
        !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { id, path, x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
  } catch { return null; }
}

/** The viewer controls for `info`, the reply of GET /api/artifacts/:id. */
export function controls(info) {
  const role = info.role;
  return {
    threads: role === 'read' || role === 'comment' || role === 'write',
    commentBox: info.canComment ?? (role === 'comment' || role === 'write'),
    moderate: info.canModerate ?? (role === 'comment' || role === 'write'),
    attach: role === 'comment' || role === 'write',
    edit: role === 'write', // upload, restore, delete
    publish: !!info.canManage, // public snapshots
    commentLink: role === 'write' && typeof info.commentToken === 'string',
  };
}

/**
 * What the thread panel says about a responder, from `info.attached` (the
 * reply of GET /api/artifacts/:id; the server validated it, and the viewer
 * renders every field as text, never as markup or a link).
 */
export function responderNote(info) {
  const a = info.attached;
  if (a && typeof a === 'object' && typeof a.responder === 'string' && a.responder) {
    return { attached: true, headline: 'A responder is registered. Registration does not verify that it is online.', name: a.responder, contact: typeof a.contact === 'string' ? a.contact : '' };
  }
  return { attached: false, headline: 'No responder is registered. Comments remain available for later review.', name: '', contact: '' };
}

// Fossil's stock ticket statuses that mean the thread was answered. The
// viewer writes only Open and Closed; the others come from a terminal.
const RESOLVED = ['Closed', 'Fixed', 'Tested'];

// A check-in a reply names: `@` and 4 to 64 hex digits, not inside a word or an address.
const CHECKIN = /(?<![\w.@])@([0-9a-f]{4,64})(?![\w@])/g;

/** A ticket from GET …/tickets as a thread: its messages, oldest first. */
export function thread(ticket) {
  const messages = ticket.changes.map((c, i) => {
    // The server sends the canonical text (`text`, with earlier revisions in
    // `history`) and keeps the raw field for older clients.
    const text = typeof c.text === 'string' ? c.text : c.comment || (i === 0 ? c.fields.comment ?? '' : '');
    const status = i === 0 ? '' : c.fields.status ?? '';
    return { user: c.user, time: c.time, text, status, change: c.artifact, canEdit: c.canEdit === true,
      edited: c.edited === true,
      // Earlier revisions, oldest first, each {artifact, text, time}; never
      // includes the canonical text itself.
      history: Array.isArray(c.history) ? c.history.filter(h => h && typeof h.text === 'string' && typeof h.artifact === 'string').slice(0, 16) : [],
      ...(c.fields.authority ? { authority: c.fields.authority, intent: c.fields.intent } : {}) };
  });
  const checkins = [...new Set(messages.slice(1).flatMap(m => [...m.text.matchAll(CHECKIN)].map(x => x[1])))];
  const status = ticket.status || 'Open';
  const context = ticket.context && typeof ticket.context === 'object'
    && typeof ticket.context.label === 'string' ? { label: ticket.context.label, quote: typeof ticket.context.quote === 'string' ? ticket.context.quote : '' } : null;
  return {
    uuid: ticket.uuid, title: ticket.fields.title || '(untitled)', status, resolved: RESOLVED.includes(status),
    anchor: ticket.fields.subsystem ?? '', version: ticket.fields.foundin ?? '', checkins, messages, context,
    // A server-assigned reference is stable for the thread's life; it never
    // changes with activity, replies, resolution or pagination. 0 means the
    // server did not supply one (an older response), and arrange() numbers it.
    ref: Number.isInteger(ticket.ref) && ticket.ref > 0 ? ticket.ref : 0,
    mine: ticket.mine === true, unread: ticket.unread === true, following: ticket.following === true,
    changed: typeof ticket.changed === 'string' ? ticket.changed : '',
    // The raw latest event, including a correction event that the canonical
    // changes[] hides. Read state is marked through this, never through
    // changes.at(-1).artifact, or a correction would stay unread forever.
    lastChange: typeof ticket.lastChange === 'string' ? ticket.lastChange : '',
  };
}

/**
 * The author the ticket route records for a reply posted as the attached
 * responder `name` (src/ticket-author.ts), so a reply can be told apart from
 * a reader's change.
 */
export function responderAuthor(name) {
  const n = String(name ?? '').trim();
  const safe = n && !n.includes('@') ? n.slice(0, 64) : 'account';
  return `${safe.slice(0, 52)} (responder)`;
}

/** A duration as m:ss; a negative one (a clock behind the server's) as 0:00. */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const OFFLINE_AFTER_MS = 30_000; // no status this long after a comment: nothing picked it up
const QUIET_AFTER_MS = 180_000; // no status update this long: the work is slow
const BUSY = ['seen', 'working'];

/** The status entry that speaks for the unanswered comments `pending` (indexes into t.messages), or null. */
function entryFor(t, entry, pending) {
  if (!entry || typeof entry !== 'object' || typeof entry.change !== 'string') return null;
  const i = pending.findIndex(p => t.messages[p].change === entry.change);
  if (i < 0) return null;
  // Delivered or failed speaks only for the comment it names; busy is busy with the thread.
  return i === pending.length - 1 || BUSY.includes(entry.state) ? entry : null;
}

function activity(t, entry, ctx) {
  const since = ms => clock(ctx.now - Date.parse(ms));
  const box = (tone, text, extra = {}) => ({ tone, dots: false, who: '', text, elapsed: '', ...extra });
  if (!entry) {
    const latest = t.messages[ctx.latest];
    return ctx.now - Date.parse(latest.time) >= OFFLINE_AFTER_MS
      ? box('warn', `${ctx.name} hasn't picked this up. It may be offline; your comment is saved and will be answered when it's back.`)
      : null;
  }
  if (BUSY.includes(entry.state)) {
    const step = entry.step || 'working on it';
    if (ctx.now - Date.parse(entry.updated) > QUIET_AFTER_MS) {
      return box('warn', `Still working, taking longer than usual. Last step: ${step}, ${since(entry.updated)} ago.`);
    }
    return { tone: 'working', dots: true, who: ctx.name, text: `is ${step}`, elapsed: since(entry.since) };
  }
  if (entry.state === 'failed') return box('bad', `${ctx.name} couldn't finish this. Reply in the thread to ask again.`);
  if (entry.state === 'delivered' && ctx.busy && ctx.busy.uuid !== t.uuid) {
    return box('waiting', `Waiting behind comment ${ctx.busy.label ?? ''}`.trim(), { elapsed: since(entry.since) });
  }
  return null;
}

function receipt(change, entry, name) {
  const state = entry?.state;
  if (state === 'delivered') return { change, ticks: '✓✓', on: true, text: 'Delivered' };
  if (BUSY.includes(state)) return { change, ticks: '✓✓', on: true, text: `Delivered · Seen by ${name}` };
  if (state === 'failed') return { change, ticks: '✓✓', on: true, text: `Seen by ${name}` };
  return { change, ticks: '✓', on: false, text: 'Sent' };
}

/**
 * What the thread panel shows of the attached responder's progress, by
 * thread uuid: { receipt, activity, row }. `threads` are arranged threads,
 * `status` the `responder` of GET …/tickets, `responder` the attached name
 * ('' for none, which shows nothing), `now` epoch milliseconds. Resolved
 * threads show nothing. Pure, so the viewer can re-derive it every second.
 */
export function responderProgress({ threads, status, responder, now, guestDiscussion = false }) {
  const out = new Map();
  if (!responder) return out;
  const name = responder, author = responderAuthor(name);
  const entries = status && typeof status.threads === 'object' && status.threads !== null ? status.threads : {};
  const states = threads.filter(t => !t.resolved).map(t => {
    const answered = t.messages.findLastIndex(m => m.user === author);
    // On discussion-enabled artifacts, unmarked history fails closed too.
    // Only server-proven privileged requests participate in editor progress.
    const pending = t.messages.map((m, i) => i).filter(i => i > answered && t.messages[i].text && t.messages[i].user !== author
      && (!guestDiscussion || t.messages[i].authority === 'edit'));
    return { t, answered, pending, entry: entryFor(t, entries[t.uuid], pending) };
  });
  // Only a status that still speaks for an unanswered thread holds the others up.
  const busy = states.find(s => BUSY.includes(s.entry?.state))?.t ?? null;
  for (const { t, answered, pending, entry } of states) {
    if (!pending.length) {
      out.set(t.uuid, { receipt: null, activity: null, row: answered >= 0 ? { dots: false, ticks: '', text: 'Replied' } : null });
      continue;
    }
    const latest = pending[pending.length - 1];
    const row = BUSY.includes(entry?.state) ? { dots: true, ticks: '', text: 'Working' }
      : entry?.state === 'delivered' ? { dots: false, ticks: '✓✓', text: 'Delivered' } : null;
    out.set(t.uuid, {
      receipt: receipt(t.messages[latest].change, entry, name),
      activity: activity(t, entry, { now, name, latest, busy }),
      row,
    });
  }
  return out;
}

/**
 * Threads as the panel lists them: open ones, then resolved ones, each in the
 * route's order (newest-changed first). A thread's label is its stable
 * server reference, so activity, replies, resolution, sorting and pagination
 * never renumber it; `pins` is what the page is told, anchors and labels only.
 */
export function arrange(threads) {
  const open = threads.filter(t => !t.resolved), resolved = threads.filter(t => t.resolved);
  // A server ref is preferred. Only a response without one is numbered, and
  // then in this order, so a pin and its row still agree within one render.
  let next = threads.reduce((max, t) => Math.max(max, t.ref || 0), 0);
  for (const t of [...open, ...resolved]) if (!t.ref) t.ref = ++next;
  for (const t of [...open, ...resolved]) t.label = t.ref;
  const pins = [...open, ...resolved].filter(t => t.anchor).map(t => ({ key: t.label, anchor: t.anchor, resolved: t.resolved }));
  return { open, resolved, pins };
}

// The filters the panel offers, and what each one keeps. Unread and Mine are
// the server's per-viewer flags, never a guess from the text.
export const FILTERS = ['all', 'open', 'resolved', 'mine', 'unread', 'following'];
export const SORTS = ['activity', 'page'];

/** Keep only the threads a filter names. An unknown filter means all. */
export function filterThreads(threads, filter) {
  return threads.filter(t => filter === 'open' ? !t.resolved
    : filter === 'resolved' ? t.resolved
    : filter === 'mine' ? t.mine
    : filter === 'unread' ? t.unread
    : filter === 'following' ? t.following
    : true);
}

/**
 * Threads in the chosen order: recent activity (newest change first, as the
 * route sends them) or page order (their place in the document). `placed` is
 * the labels the page reported, top to bottom; a thread whose pin the page
 * could not place comes last, and with no placement yet the route's order
 * stands.
 */
export function sortThreads(threads, sort, placed = null) {
  if (sort !== 'page') return [...threads];
  const order = Array.isArray(placed) ? placed : [];
  const at = label => { const i = order.indexOf(label); return i < 0 ? Infinity : i; };
  return [...threads].sort((a, b) => at(a.label) - at(b.label));
}

/** A silent, case-insensitive match of a search over a thread's title, text and context. */
export function searchThreads(threads, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [...threads];
  return threads.filter(t => [t.title, t.context?.label, t.context?.quote, ...t.messages.map(m => m.text)]
    .some(value => typeof value === 'string' && value.toLowerCase().includes(q)));
}

/**
 * The copyable link to a thread: the current URL without capabilities, with
 * only a validated `?thread=` and the version on screen kept. A read token the
 * viewer legitimately holds is preserved; nothing else about the query is.
 */
export function threadLink({ origin, pathname, token, version, thread }) {
  const ref = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(String(thread)) ? String(thread) : '';
  const query = ref ? `?thread=${ref}` : '';
  const hash = token ? `#${token}${version ? `@${encodeURIComponent(version)}` : ''}` : version ? `#@${encodeURIComponent(version)}` : '';
  return origin + pathname + query + hash;
}

/** Whether a message shows an Edit control: the server said so, and it has text. */
export function editable(message) {
  return !!message && message.canEdit === true && typeof message.text === 'string' && message.text.trim() !== '';
}

/**
 * A heading or landmark enclosing `el`, and the block it sits in: the nearest
 * ancestor (or `el` itself) with a heading, then the nearest block of text
 * inside it. The label is the heading's own text; the quote is `quote` (a
 * selection) when given, else that block's text, bounded.
 *
 * This function is injected into the sandboxed page as source, so it must use
 * nothing outside itself — including boundedContext, which the viewer side
 * re-applies to whatever the page sends.
 */
export function pageContext(el, quote = '') {
  const MAX_LABEL = 120, MAX_QUOTE = 240;
  const SECTION = 'H1,H2,H3,H4,H5,H6,SECTION,ARTICLE,MAIN,[role="region"],[role="group"],NAV,ASIDE,FIGURE,TABLE,LI,BLOCKQUOTE,PRE';
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA)$/;
  // Only rendered text: an injected runtime script or a stylesheet is not page
  // content, and its source must never become a comment's excerpt.
  const clean = node => {
    let text = '';
    const walk = n => {
      if (!n) return;
      if (n.nodeType === 3) { text += n.data; return; }
      if (n.nodeType === 1 && SKIP.test(n.tagName)) return;
      // A real DOM exposes firstChild/nextSibling; the unit tests' minimal
      // nodes carry a children array instead, and text in textContent.
      const kids = n.firstChild !== undefined ? (() => { const out = []; for (let c = n.firstChild; c; c = c.nextSibling) out.push(c); return out; })() : Array.isArray(n.children) ? n.children : null;
      if (!kids || !kids.length) { text += typeof n.textContent === 'string' ? n.textContent : ''; return; }
      for (const c of kids) walk(c);
    };
    walk(node);
    return text.replace(/\s+/g, ' ').trim();
  };
  const bounded = text => {
    let cut = String(text || '').slice(0, MAX_QUOTE);
    if (String(text || '').length > MAX_QUOTE) {
      const stop = cut.lastIndexOf(' ');
      if (stop > MAX_QUOTE * 0.6) cut = cut.slice(0, stop);
      cut = cut.replace(/[\s,;:.\-–—]+$/, '');
    }
    return cut;
  };
  if (!el || el.nodeType !== 1) return null;
  // A click on the runtime or a stylesheet is not a comment location with any
  // readable text; say nothing rather than quoting its source.
  if (SKIP.test(el.tagName)) return null;
  let block = el.closest('p, li, blockquote, pre, figcaption, td, th, dd, dt, h1, h2, h3, h4, h5, h6') || el.closest(SECTION) || el;
  if (SKIP.test(block.tagName)) return null;
  // A click on a container (a section or the page body) should quote a block
  // of text, not the whole container run together. Prefer the first real text
  // block inside it, when the container itself is not one.
  const isBlock = /^(P|LI|BLOCKQUOTE|PRE|FIGCAPTION|TD|TH|DD|DT|H[1-6])$/.test(block.tagName);
  if (!isBlock) {
    const first = block.querySelector('p, li, blockquote, pre, figcaption, td, th, dd, dt, h1, h2, h3, h4, h5, h6');
    if (first && !SKIP.test(first.tagName)) block = first;
  }
  const region = el.closest(SECTION) || block;
  const heading = region.querySelector('h1, h2, h3, h4, h5, h6')
    || (region.previousElementSibling && /^H[1-6]$/.test(region.previousElementSibling.tagName) ? region.previousElementSibling : null)
    || region.closest('section, article, [role="region"]')?.querySelector('h1, h2, h3, h4, h5, h6')
    || null;
  if (block === heading) {
    // A click on the heading itself: the text that follows it is what the
    // reader is pointing at, falling back to the heading's own words.
    const next = heading.nextElementSibling;
    block = next && /^(P|LI|BLOCKQUOTE|PRE|FIGCAPTION|TD|TH|DD|DT|DIV)$/.test(next.tagName) && clean(next) ? next : heading;
  }
  let label = clean(heading).slice(0, MAX_LABEL);
  if (!label && heading && heading.id) label = heading.id.slice(0, MAX_LABEL);
  // The element itself may be the only heading around (a click on it).
  if (!label && /^H[1-6]$/.test(el.tagName)) label = clean(el).slice(0, MAX_LABEL);
  const text = bounded(quote || clean(block));
  return label || text ? { label, quote: text } : null;
}

/**
 * Bounded context for a new comment, from text the page supplied. The page is
 * untrusted, so the viewer re-checks the shape and the limits here: a section
 * label of at most 120 characters and an excerpt of at most 240, both plain
 * text. Null when there is nothing honest to show.
 */
export function boundedContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const clean = s => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  const label = clean(value.label).slice(0, 120);
  // Cut an excess excerpt at a word boundary, never leaving a trailing fragment.
  let quote = clean(value.quote);
  if (quote.length > 240) {
    quote = quote.slice(0, 240);
    const stop = quote.lastIndexOf(' ');
    if (stop > 144) quote = quote.slice(0, stop);
    quote = quote.replace(/[\s,;:.\-–—]+$/, '');
  }
  return label || quote ? { label, quote } : null;
}

/** A thread's context, as the panel says it: a section label and a bounded excerpt. */
export function contextLine(context) {
  if (!context || typeof context !== 'object') return '';
  const label = typeof context.label === 'string' ? context.label.trim().slice(0, 120) : '';
  const quote = typeof context.quote === 'string' ? context.quote.trim().slice(0, 240) : '';
  if (!label) return quote ? `“${quote}”` : '';
  return quote ? `${label} · “${quote}”` : label;
}

/**
 * Where each of `quotes` is in the text nodes `texts`, comparing with
 * whitespace runs collapsed: { start: [node, offset], end: [node, offset] }
 * (end exclusive), or null, in the order of `quotes`. The page's text is
 * collapsed once for all of them.
 */
export function findQuotes(texts, quotes) {
  // The page's text with whitespace runs collapsed, and where each character came from.
  const chars = [], from = [];
  let space = false;
  for (let n = 0; n < texts.length; n++) {
    const s = texts[n];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const blank = /\s/.test(c);
      if (blank && space) continue;
      space = blank;
      chars.push(blank ? ' ' : c);
      from.push([n, i]);
    }
  }
  const flat = chars.join('');
  return quotes.map(quote => {
    const want = String(quote).replace(/\s+/g, ' ').trim();
    const at = want ? flat.indexOf(want) : -1;
    if (at < 0) return null;
    const last = from[at + want.length - 1];
    return { start: from[at], end: [last[0], last[1] + 1] };
  });
}

/**
 * Where a comment bubble sits for a click at `point` in the page area
 * `bounds` ({left, top, width, height}, in viewport coordinates). Inset by
 * GAP from the click, below-right when there is room, flipped to the other
 * side when there is not, and clamped so no part leaves the page area. The
 * bubble is a floating overlay: it never changes the page's layout.
 */
export function bubblePlacement(point, size, bounds) {
  const GAP = 12;
  const x = Number.isFinite(point?.x) ? point.x : bounds.left;
  const y = Number.isFinite(point?.y) ? point.y : bounds.top;
  const maxX = bounds.left + Math.max(0, bounds.width - size.width);
  const maxY = bounds.top + Math.max(0, bounds.height - size.height);
  let left = x + GAP, top = y + GAP;
  const flippedX = left > maxX;
  if (flippedX) left = x - GAP - size.width;
  const flippedY = top > maxY;
  if (flippedY) top = y - GAP - size.height;
  const clamp = (n, min, max) => Math.min(Math.max(n, min), Math.max(min, max));
  // When the flipped side overflows too (a card taller or wider than either
  // side has room for), align to the far edge rather than the near one, so
  // the point the reader clicked stays inside the card instead of beyond it.
  if (flippedX && left < bounds.left) left = maxX;
  if (flippedY && top < bounds.top) top = maxY;
  return { x: clamp(left, bounds.left, maxX), y: clamp(top, bounds.top, maxY), flippedX, flippedY };
}

/**
 * The anchor for a selection: `id` when the selection is the whole text of
 * that element, else the quoted text, at most 500 code points (the ticket
 * route's limit), so a cut never splits a surrogate pair. '' for no text.
 */
export function anchorFor({ text, id, idText }) {
  const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const quote = squash(text);
  if (!quote) return '';
  if (id && squash(idText) === quote) return id;
  return Array.from(quote).slice(0, 500).join('');
}

// Attachment types the thread panel may show as an image. Never SVG: it is
// script on whatever origin shows it.
const INLINE_IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const sizeLabel = n => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * How the panel shows an attachment from GET …/attachments: a link with its
 * name and size, or, for a raster image an editor attached, the image. Anyone
 * with a comment link can attach, so their images stay links.
 */
export function attachmentDisplay(a) {
  const missing = !!a.missing || !a.url;
  return {
    inline: !missing && INLINE_IMAGES.includes(a.type) && a.user !== 'comment-link',
    label: `${a.name} (${sizeLabel(Math.max(0, a.size))})`,
    missing,
  };
}
