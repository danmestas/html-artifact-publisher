// comments.js — what the viewer offers a link holder, and how a comment
// thread reads. A thread is a Fossil ticket (src/index.ts, Tickets): its
// opening text is the ticket's comment field, a reply is a change's remark,
// and a resolution sets its status. Its anchor (the `subsystem` field) is an
// element id or a quote of the page's text.
//
// findQuotes and anchorFor also run inside the sandboxed page (page-pins.js):
// they are injected as source, so they use nothing outside themselves.

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
