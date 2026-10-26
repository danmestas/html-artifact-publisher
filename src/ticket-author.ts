/** The credential that wrote a ticket change, as the API resolved it. */
export type TicketWriter =
  | { kind: 'comment' }
  | { kind: 'account'; name: string }
  | { kind: 'owner' }
  | { kind: 'edit' };

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
    case 'account': {
      const name = writer.name.trim();
      return name && !name.includes('@') ? name.slice(0, 64) : 'account';
    }
    case 'owner':
      return 'owner';
    case 'edit':
      return 'edit-link';
  }
}
