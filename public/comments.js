// comments.js — what the viewer offers a link holder, and how a comment
// thread reads. A thread is a Fossil ticket (src/index.ts, Tickets): its
// opening text is the ticket's comment field, a reply is a change's remark,
// and a resolution sets its status.

/** The viewer controls for `info`, the reply of GET /api/artifacts/:id. */
export function controls(info) {
  const role = info.role;
  return {
    threads: role === 'read' || role === 'comment' || role === 'write',
    commentBox: role === 'comment' || role === 'write',
    edit: role === 'write', // upload, restore, delete
    publish: !!info.canManage, // public snapshots
    commentLink: role === 'write' && typeof info.commentToken === 'string',
  };
}

/** A ticket from GET …/tickets as a thread: its messages, oldest first. */
export function thread(ticket) {
  const messages = ticket.changes.map((c, i) => {
    const text = c.comment || (i === 0 ? c.fields.comment ?? '' : '');
    const status = i === 0 ? '' : c.fields.status ?? '';
    return { user: c.user, time: c.time, text, status };
  });
  return {
    uuid: ticket.uuid, title: ticket.fields.title || '(untitled)', status: ticket.status || 'Open',
    anchor: ticket.fields.subsystem ?? '', messages,
  };
}
