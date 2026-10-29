import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketAuthor } from '../src/ticket-author.ts';

// The recorded author comes from the credential, and an account name that
// looks like an email address is never written into the repository, where
// every link holder and clone can read it.
test('ticket author: from the credential, never an email address', () => {
  assert.equal(ticketAuthor({ kind: 'comment' }), 'comment-link');
  assert.equal(ticketAuthor({ kind: 'owner' }), 'owner');
  assert.equal(ticketAuthor({ kind: 'edit' }), 'edit-link');
  assert.equal(ticketAuthor({ kind: 'account', name: 'Dan' }), 'Dan');
  assert.equal(ticketAuthor({ kind: 'account', name: 'member@example.com' }), 'account');
  assert.equal(ticketAuthor({ kind: 'account', name: 'Dan <dan@example.com>' }), 'account');
  assert.equal(ticketAuthor({ kind: 'account', name: '   ' }), 'account');
  assert.equal(ticketAuthor({ kind: 'account', name: 'x'.repeat(80) }), 'x'.repeat(64));
});

// An edit link may post as the attached responder. The name is
// attached.json's, never the request's, and the suffix keeps it apart from
// the owner and from accounts.
test('ticket author: the attached responder, marked as one', () => {
  assert.equal(ticketAuthor({ kind: 'responder', name: 'artifact-agent' }), 'artifact-agent (responder)');
  assert.equal(ticketAuthor({ kind: 'responder', name: 'owner' }), 'owner (responder)');
  assert.equal(ticketAuthor({ kind: 'responder', name: 'bot@example.com' }), 'account (responder)');
  assert.equal(ticketAuthor({ kind: 'responder', name: 'x'.repeat(100) }), `${'x'.repeat(52)} (responder)`);
  assert.ok(ticketAuthor({ kind: 'responder', name: 'x'.repeat(100) }).length <= 64);
});
