import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ticketChange, ticketTitle } from '../src/ticket-body.ts';

// A thread's title is its text's first line, cut to 100 characters by code
// point, so a cut never leaves half of a surrogate pair.
test('ticket title: first line, cut by code point', () => {
  assert.equal(ticketTitle('  Short heading  \nmore text'), 'Short heading');
  const whole = `${'a'.repeat(99)}😀`;
  assert.equal(ticketTitle(whole), whole, '100 code points are kept, though 101 UTF-16 units');
  const cut = ticketTitle(`${'a'.repeat(98)}😀${'b'.repeat(5)}`);
  assert.equal(cut, `${'a'.repeat(98)}😀…`);
  assert.equal(Array.from(cut).length, 100);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), 'no lone high surrogate');
});

// asResponder is a flag, not a name: only true or false is accepted, and it
// rides with any valid change.
test('ticket body: asResponder is an optional boolean', () => {
  assert.equal(ticketChange({ text: 'hi' }).asResponder, false);
  assert.equal(ticketChange({ text: 'hi', asResponder: true }).asResponder, true);
  const reply = ticketChange({ text: 'done', ticketUuid: 'a'.repeat(40), asResponder: true });
  assert.equal(reply.asResponder, true);
  assert.equal(reply.comment, 'done');
  for (const bad of ['yes', 1, null, 'artifact-agent']) {
    assert.equal(ticketChange({ text: 'hi', asResponder: bad }), null, String(bad));
  }
});
