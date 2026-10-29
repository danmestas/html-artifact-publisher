import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrange, clock, responderAuthor, responderProgress, thread } from '../public/comments.js';
import { ticketAuthor } from '../src/ticket-author.ts';

// The thread panel's responder status is derived, with no DOM and no clock of
// its own, from the threads, the stored status entries and the time: the
// viewer re-derives it on every poll and every second.
const NAME = 'artifact-agent';
const AGENT = `${NAME} (responder)`;
const T = Date.parse('2026-10-29T10:00:00Z');
const iso = s => new Date(T + s * 1000).toISOString();
const hash = n => String(n).padStart(40, 'c');

let nextChange = 0;
function ticket(uuid, changes, status = 'Open') {
  return thread({
    uuid, status, fields: { title: `Thread ${uuid}` },
    changes: changes.map(([user, text, at], i) => ({
      artifact: hash(++nextChange), user, time: iso(at), comment: i ? text : '', fields: i ? {} : { comment: text },
    })),
  });
}
const derive = (threads, entries, nowS, name = NAME) => {
  arrange(threads);
  return responderProgress({ threads, status: { threads: entries }, responder: name, now: T + nowS * 1000 });
};
const entry = (change, state, since, updated, step) => ({ change, state, since: iso(since), updated: iso(updated), ...(step ? { step } : {}) });

test('responderAuthor: the author the ticket route records for the attached responder', () => {
  for (const name of [NAME, ' spaced ', 'dan@example.com', '', 'x'.repeat(100), '😀'.repeat(40)]) {
    assert.equal(responderAuthor(name), ticketAuthor({ kind: 'responder', name }), JSON.stringify(name));
  }
  assert.notEqual(responderAuthor('edit-link'), 'edit-link');
});

test('clock: m:ss, never negative', () => {
  assert.equal(clock(0), '0:00');
  assert.equal(clock(48_900), '0:48');
  assert.equal(clock(100_000), '1:40');
  assert.equal(clock(3_600_000 + 5000), '60:05');
  assert.equal(clock(-5000), '0:00', 'a clock behind the server reads as just now');
});

test('receipts: under the latest reader comment, by state, until the responder replies', () => {
  const t = ticket('a', [['comment-link', 'Draw me a pikchr?', 0]]);
  const change = t.messages[0].change;
  assert.equal(change, hash(nextChange), 'messages carry their change hash');
  const at = (entries, s = 5) => derive([t], entries, s).get('a');

  assert.deepEqual(at({}).receipt, { change, ticks: '✓', on: false, text: 'Sent' });
  assert.deepEqual(at({ a: entry(change, 'delivered', 1, 1) }).receipt, { change, ticks: '✓✓', on: true, text: 'Delivered' });
  assert.equal(at({ a: entry(change, 'seen', 1, 2) }).receipt.text, `Delivered · Seen by ${NAME}`);
  assert.equal(at({ a: entry(change, 'working', 1, 2, 'reading the page') }).receipt.text, `Delivered · Seen by ${NAME}`);
  assert.equal(at({ a: entry(change, 'failed', 1, 2) }).receipt.text, `Seen by ${NAME}`);

  // A reply from the responder ends it; a later reader reply starts over.
  const replied = ticket('b', [['comment-link', 'Shorter?', 0], [AGENT, 'Done.', 60]]);
  const r = derive([replied], {}, 90).get('b');
  assert.equal(r.receipt, null);
  assert.equal(r.activity, null);
  assert.deepEqual(r.row, { dots: false, ticks: '', text: 'Replied' });
  const again = ticket('c', [['comment-link', 'Shorter?', 0], [AGENT, 'Done.', 60], ['comment-link', 'Even shorter?', 70]]);
  assert.equal(derive([again], {}, 75).get('c').receipt.change, again.messages[2].change);
  // A resolve or reopen has no text: it is not a comment to answer.
  const resolvedByReader = ticket('d', [['comment-link', 'Shorter?', 0], [AGENT, 'Done.', 60], ['comment-link', '', 70]]);
  assert.equal(derive([resolvedByReader], {}, 200).get('d').receipt, null);
  // A reply from someone else (an editor) is not the responder's.
  const editor = ticket('e', [['comment-link', 'Shorter?', 0], ['edit-link', 'Looking.', 3]]);
  assert.equal(derive([editor], {}, 4).get('e').receipt.change, editor.messages[1].change, 'the editor is a reader too');
});

test('activity: what the responder is doing, with the elapsed time since it started', () => {
  const t = ticket('a', [['comment-link', 'Draw me a pikchr?', 0]]);
  const change = t.messages[0].change;
  const at = (e, s) => derive([t], { a: e }, s).get('a');

  assert.deepEqual(at(entry(change, 'seen', 5, 5, 'reading the page'), 53).activity,
    { tone: 'working', dots: true, who: NAME, text: 'is reading the page', elapsed: '0:48' });
  assert.deepEqual(at(entry(change, 'working', 5, 100), 105).activity,
    { tone: 'working', dots: true, who: NAME, text: 'is working on it', elapsed: '1:40' });
  assert.deepEqual(at(entry(change, 'working', 5, 100), 105).row, { dots: true, ticks: '', text: 'Working' });

  // No update for 3 minutes: still working, but say it is slow.
  assert.equal(at(entry(change, 'working', 5, 20, 'publishing the page'), 200).activity.tone, 'working', 'exactly 3 minutes is not late');
  assert.deepEqual(at(entry(change, 'working', 5, 20, 'publishing the page'), 210).activity,
    { tone: 'warn', dots: false, who: '', text: 'Still working, taking longer than usual. Last step: publishing the page, 3:10 ago.', elapsed: '' });
  assert.equal(at(entry(change, 'working', 5, 20, 'publishing the page'), 210).row.text, 'Working');

  assert.deepEqual(at(entry(change, 'failed', 5, 60), 61).activity,
    { tone: 'bad', dots: false, who: '', text: `${NAME} couldn't finish this. Reply in the thread to ask again.`, elapsed: '' });
  assert.equal(at(entry(change, 'failed', 5, 60), 61).row, null);

  // Delivered and nothing else in progress: the receipt says it all.
  assert.equal(at(entry(change, 'delivered', 1, 1), 40).activity, null);
  assert.deepEqual(at(entry(change, 'delivered', 1, 1), 40).row, { dots: false, ticks: '✓✓', text: 'Delivered' });
});

test('activity: delivered behind another thread the responder is working on', () => {
  const first = ticket('a', [['comment-link', 'Draw me a pikchr?', 0]]);
  const second = ticket('b', [['comment-link', 'Also make the heading shorter.', 10]]);
  const threads = [second, first];
  const p = derive(threads, {
    a: entry(first.messages[0].change, 'working', 2, 20, 'drawing the diagram'),
    b: entry(second.messages[0].change, 'delivered', 11, 11),
  }, 31);
  assert.deepEqual(p.get('b').activity, { tone: 'waiting', dots: false, who: '', text: `Waiting behind comment ${first.label}`, elapsed: '0:20' });
  assert.equal(p.get('b').receipt.text, 'Delivered');
  assert.equal(p.get('a').activity.tone, 'working');
});

test('activity: nothing picked the comment up after 30 seconds', () => {
  const t = ticket('a', [['comment-link', 'Draw me a pikchr?', 0]]);
  assert.equal(derive([t], {}, 29).get('a').activity, null, 'not yet');
  assert.deepEqual(derive([t], {}, 30).get('a').activity, {
    tone: 'warn', dots: false, who: '',
    text: `${NAME} hasn't picked this up. It may be offline; your comment is saved and will be answered when it's back.`, elapsed: '',
  });
  assert.equal(derive([t], {}, 30).get('a').receipt.text, 'Sent');
});

test('stale entries: a delivered or failed status for an earlier comment does not speak for a newer one', () => {
  const t = ticket('a', [['comment-link', 'Draw me a pikchr?', 0], ['comment-link', 'Please?', 100]]);
  const [old, latest] = t.messages.map(m => m.change);
  const failed = derive([t], { a: entry(old, 'failed', 1, 50) }, 105).get('a');
  assert.equal(failed.receipt.text, 'Sent', 'the new comment has no status of its own yet');
  assert.equal(failed.activity, null);
  // Working on the earlier comment of an unanswered thread is still work on the thread.
  const working = derive([t], { a: entry(old, 'working', 1, 101, 'reading the page') }, 105).get('a');
  assert.equal(working.activity.tone, 'working');
  assert.equal(working.receipt.change, latest);
  // An entry for a change already answered is over.
  const answered = ticket('b', [['comment-link', 'One', 0], [AGENT, 'Done.', 40], ['comment-link', 'Two', 50]]);
  const over = derive([answered], { b: entry(answered.messages[0].change, 'working', 1, 49) }, 55).get('b');
  assert.equal(over.activity, null);
  assert.equal(over.receipt.text, 'Sent');
});

test('no responder attached, or a resolved thread: nothing to show', () => {
  const t = ticket('a', [['comment-link', 'Draw me a pikchr?', 0]]);
  const e = { a: entry(t.messages[0].change, 'working', 1, 2) };
  assert.equal(derive([t], e, 40, '').size, 0, 'no responder');
  const done = ticket('b', [['comment-link', 'Draw me a pikchr?', 0]], 'Closed');
  assert.equal(derive([done], {}, 40).get('b'), undefined);
  // A malformed status reads as none.
  assert.equal(responderProgress({ threads: [t], status: null, responder: NAME, now: T + 5000 }).get('a').receipt.text, 'Sent');
});

test('waiting: only a status still at work on an unanswered thread holds the others up', () => {
  const answered = ticket('a', [['comment-link', 'One', 0], [AGENT, 'Done.', 20]]);
  const queued = ticket('b', [['comment-link', 'Two', 10]]);
  const p = derive([answered, queued], {
    a: entry(answered.messages[0].change, 'working', 1, 19), // never cleared by a done
    b: entry(queued.messages[0].change, 'delivered', 11, 11),
  }, 30);
  assert.equal(p.get('b').activity, null);
});
