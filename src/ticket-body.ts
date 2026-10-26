// A reader comment is a ticket in the stock Fossil ticket schema, so `fossil
// ui` and `fossil ticket` show it as they show any other:
//   new thread  title (the text's first line), comment (the text), status Open,
//               type Comment, subsystem (the anchor: an element id or a quote)
//   reply       the text as the change's remark (icomment)
//   resolve     status Closed; reopen: status Open

export const TICKET_BODY = 'Body must be JSON: text (1-8000 characters), and optionally anchor (up to 500), '
  + 'ticketUuid (a full ticket id, to reply) and status (Open or Closed, with ticketUuid)';
const TICKET_KEYS = ['text', 'anchor', 'ticketUuid', 'status'];

/** The ticket change a POST body asks for, or null when the body is not valid. */
export function ticketChange(b: Record<string, unknown>): { ticketUuid: string; fields: Record<string, string>; comment: string } | null {
  if (Object.keys(b).some(k => !TICKET_KEYS.includes(k))) return null;
  const { text = '', anchor = '', ticketUuid = '', status = '' } = b;
  if (typeof text !== 'string' || typeof anchor !== 'string' || typeof ticketUuid !== 'string' || typeof status !== 'string') return null;
  const body = text.trim();
  if (body.length > 8000 || anchor.length > 500 || /\0/.test(text + anchor)) return null;
  if (!ticketUuid) {
    if (!body || status) return null;
    return {
      ticketUuid: '',
      fields: { title: ticketTitle(body), comment: body, status: 'Open', type: 'Comment', subsystem: anchor },
      comment: '',
    };
  }
  if (!/^[0-9a-f]{40}$/.test(ticketUuid) || anchor || (status && status !== 'Open' && status !== 'Closed') || (!body && !status)) return null;
  return { ticketUuid, fields: status ? { status } : {}, comment: body };
}

/** A thread's title: its text's first line, at most 100 code points, so a cut never splits a surrogate pair. */
export function ticketTitle(text: string): string {
  const line = Array.from(text.trim().split('\n')[0]!.trim());
  return line.length > 100 ? `${line.slice(0, 99).join('')}…` : line.join('');
}
