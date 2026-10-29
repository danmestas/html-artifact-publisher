// A reader comment is a ticket in the stock Fossil ticket schema, so `fossil
// ui` and `fossil ticket` show it as they show any other:
//   new thread  title (the text's first line), comment (the text), status Open,
//               type Comment, subsystem (the anchor: an element id or a quote),
//               foundin (the check-in the reader was looking at, when given)
//   reply       the text as the change's remark (icomment)
//   resolve     status Closed; reopen: status Open

export const TICKET_BODY = 'Body must be JSON: text (1-8000 characters), and optionally anchor (up to 500), version (a check-in hash, for a new thread), '
  + 'ticketUuid (a full ticket id, to reply), status (Open or Closed, with ticketUuid) '
  + 'and asResponder (true, with the edit link)';
const TICKET_KEYS = ['text', 'anchor', 'version', 'ticketUuid', 'status', 'asResponder'];
// A full check-in hash: SHA1 or SHA3-256, lower case.
const VERSION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The ticket change a POST body asks for, or null when the body is not valid. */
export function ticketChange(b: Record<string, unknown>): { ticketUuid: string; fields: Record<string, string>; comment: string; asResponder: boolean } | null {
  if (Object.keys(b).some(k => !TICKET_KEYS.includes(k))) return null;
  const { text = '', anchor = '', ticketUuid = '', status = '', asResponder = false } = b;
  if (typeof asResponder !== 'boolean') return null;
  // Reported by the client: a hint for reading the anchor, not a verified fact.
  if ('version' in b && (typeof b.version !== 'string' || !VERSION.test(b.version) || ticketUuid)) return null;
  const version = b.version as string | undefined;
  if (typeof text !== 'string' || typeof anchor !== 'string' || typeof ticketUuid !== 'string' || typeof status !== 'string') return null;
  const body = text.trim();
  if (body.length > 8000 || anchor.length > 500 || /\0/.test(text + anchor)) return null;
  if (!ticketUuid) {
    if (!body || status) return null;
    return {
      ticketUuid: '',
      fields: { title: ticketTitle(body), comment: body, status: 'Open', type: 'Comment', subsystem: anchor, ...(version ? { foundin: version } : {}) },
      comment: '',
      asResponder,
    };
  }
  if (!/^[0-9a-f]{40}$/.test(ticketUuid) || anchor || (status && status !== 'Open' && status !== 'Closed') || (!body && !status)) return null;
  return { ticketUuid, fields: status ? { status } : {}, comment: body, asResponder };
}

/** A thread's title: its text's first line, at most 100 code points, so a cut never splits a surrogate pair. */
export function ticketTitle(text: string): string {
  const line = Array.from(text.trim().split('\n')[0]!.trim());
  return line.length > 100 ? `${line.slice(0, 99).join('')}…` : line.join('');
}
