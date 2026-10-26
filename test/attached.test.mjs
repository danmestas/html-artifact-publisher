import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachedFrom } from '../src/attached.ts';
import { responderNote } from '../public/comments.js';

const file = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64');

// attached.json is an unversioned file any write-capable user can push, so
// whatever is in it is untrusted: only validated fields reach a reader, and a
// file that is not usable reads as no responder at all.
test('attached.json: the three fields, validated; anything else reads as absent', () => {
  const since = '2026-10-26T12:00:00Z';
  assert.deepEqual(attachedFrom(file({ responder: 'local session', since, contact: 'dan@example.com' })),
    { responder: 'local session', since, contact: 'dan@example.com' });
  assert.deepEqual(attachedFrom(file({ responder: ' doorman ' })), { responder: 'doorman', since: null, contact: null });
  assert.deepEqual(attachedFrom(file({ responder: 'x', extra: 'dropped', admin: true })), { responder: 'x', since: null, contact: null });

  // Absent, unreadable or the wrong shape: no responder.
  for (const bad of [null, undefined, '', file(''), file('not json'), file('null'), file('[]'), file('"str"'), file('42'), file({}),
    file({ responder: '' }), file({ responder: '   ' }), file({ responder: 7 }), file({ responder: ['a'] }), file({ contact: 'x' }),
    file({ responder: 'x'.repeat(101) }), file({ responder: 'a\nb' }), file({ responder: 'a\u0000b' }), '!!!not base64!!!',
    file(' '.repeat(5000) + '{"responder":"late"}')]) {
    assert.equal(attachedFrom(bad), null, String(bad).slice(0, 40));
  }
  assert.equal(attachedFrom(file({ responder: 'x'.repeat(100) })).responder.length, 100, 'the limit is inclusive');
  assert.equal(attachedFrom(file({ responder: '😀'.repeat(100) })).responder, '😀'.repeat(100), 'counted by code point');
  assert.equal(attachedFrom(file({ responder: '😀'.repeat(101) })), null);

  // A bad optional field is dropped; the responder still shows.
  assert.equal(attachedFrom(file({ responder: 'x', contact: 'c'.repeat(201) })).contact, null);
  assert.equal(attachedFrom(file({ responder: 'x', contact: 'c'.repeat(200) })).contact.length, 200);
  assert.equal(attachedFrom(file({ responder: 'x', contact: 5 })).contact, null);
  assert.equal(attachedFrom(file({ responder: 'x', contact: 'a\nb' })).contact, null);
  for (const s of ['yesterday', '2026-13-45T00:00:00Z', '2026-10-26', 5, '<b>2026-10-26T12:00:00Z</b>', '2026-10-26T12:00:00Z' + 'x'.repeat(50)]) {
    assert.equal(attachedFrom(file({ responder: 'x', since: s })).since, null, String(s));
  }
  assert.equal(attachedFrom(file({ responder: 'x', since: '2026-10-26T12:00:00.123+02:00' })).since, '2026-10-26T12:00:00.123+02:00');

  // Markup is just text here; the viewer renders it with textContent.
  assert.equal(attachedFrom(file({ responder: '<img src=x onerror=alert(1)>' })).responder, '<img src=x onerror=alert(1)>');
});

test('responderNote: what the thread panel says about a responder', () => {
  assert.deepEqual(responderNote({ attached: { responder: 'local session', since: null, contact: null } }),
    { attached: true, headline: 'A responder is attached', name: 'local session', contact: '' });
  assert.deepEqual(responderNote({ attached: { responder: 'r', since: null, contact: 'dan@example.com' } }).contact, 'dan@example.com');
  const none = { attached: false, headline: 'Comments are recorded; nothing is listening right now', name: '', contact: '' };
  assert.deepEqual(responderNote({ attached: null }), none);
  assert.deepEqual(responderNote({}), none, 'an older server');
  assert.deepEqual(responderNote({ attached: { responder: 7 } }), none, 'never trusts the reply blindly');
  assert.deepEqual(responderNote({ attached: 'yes' }), none);
});
