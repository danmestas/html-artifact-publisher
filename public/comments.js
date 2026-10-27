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
    return { user: c.user, time: c.time, text, status };
  });
  const checkins = [...new Set(messages.slice(1).flatMap(m => [...m.text.matchAll(CHECKIN)].map(x => x[1])))];
  const status = ticket.status || 'Open';
  return {
    uuid: ticket.uuid, title: ticket.fields.title || '(untitled)', status, resolved: RESOLVED.includes(status),
    anchor: ticket.fields.subsystem ?? '', checkins, messages,
  };
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
