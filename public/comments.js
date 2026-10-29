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
    commentBox: role === 'comment' || role === 'write', // also reply, resolve and reopen
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
    const text = c.comment || (i === 0 ? c.fields.comment ?? '' : '');
    const status = i === 0 ? '' : c.fields.status ?? '';
    return { user: c.user, time: c.time, text, status, change: c.artifact };
  });
  const checkins = [...new Set(messages.slice(1).flatMap(m => [...m.text.matchAll(CHECKIN)].map(x => x[1])))];
  const status = ticket.status || 'Open';
  return {
    uuid: ticket.uuid, title: ticket.fields.title || '(untitled)', status, resolved: RESOLVED.includes(status),
    anchor: ticket.fields.subsystem ?? '', version: ticket.fields.foundin ?? '', checkins, messages,
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
export function responderProgress({ threads, status, responder, now }) {
  const out = new Map();
  if (!responder) return out;
  const name = responder, author = responderAuthor(name);
  const entries = status && typeof status.threads === 'object' && status.threads !== null ? status.threads : {};
  const states = threads.filter(t => !t.resolved).map(t => {
    const answered = t.messages.findLastIndex(m => m.user === author);
    const pending = t.messages.map((m, i) => i).filter(i => i > answered && t.messages[i].text && t.messages[i].user !== author);
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
 * route's order (newest-changed first). A thread's label is its number in the
 * panel and on its pin; `pins` is what the page is told, anchors and labels only.
 */
export function arrange(threads) {
  const open = threads.filter(t => !t.resolved), resolved = threads.filter(t => t.resolved);
  [...open, ...resolved].forEach((t, i) => { t.label = i + 1; });
  const pins = [...open, ...resolved].filter(t => t.anchor).map(t => ({ key: t.label, anchor: t.anchor, resolved: t.resolved }));
  return { open, resolved, pins };
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
