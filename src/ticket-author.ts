/** The credential that wrote a ticket change, as the API resolved it. */
export type TicketWriter =
  | { kind: 'comment' }
  | { kind: 'account'; name: string }
  | { kind: 'owner' }
  | { kind: 'edit' }
  | { kind: 'responder'; name: string };

/**
 * A name fit to leave the Worker as an author: an empty name or one that looks
 * like an email address becomes "account", and every name is capped at 64.
 */
export function authorName(name: string): string {
  const n = name.trim();
  return n && !n.includes('@') ? n.slice(0, 64) : 'account';
}

/**
 * The author recorded on a ticket change. It comes from the credential, never
 * from the request body. A ticket author is readable by every link holder and
 * every clone, and an account's name defaults to its email address, so a name
 * that looks like an address is recorded as "account" instead.
 */
export function ticketAuthor(writer: TicketWriter): string {
  switch (writer.kind) {
    case 'comment':
      return 'comment-link';
    case 'account':
      return authorName(writer.name);
    case 'owner':
      return 'owner';
    case 'edit':
      return 'edit-link';
    case 'responder':
      // The name is attached.json's, which an edit link can already set;
      // the suffix keeps it from passing for the owner or an account.
      return `${authorName(writer.name).slice(0, 52)} (responder)`;
  }
}
