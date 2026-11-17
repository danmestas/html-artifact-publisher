import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discussionQuery, correctionInput, viewInput, contextInput, commentIdentityPrecondition } from '../src/discussion.ts';

test('comment identity preconditions are optional bounded opaque keys, not authority input', () => {
  assert.equal(commentIdentityPrecondition(null), undefined);
  assert.equal(commentIdentityPrecondition('account:instance-owner'), 'account:instance-owner');
  assert.equal(commentIdentityPrecondition('guest:ABC_123-xyz'), 'guest:ABC_123-xyz');
  for (const value of ['', 'owner', 'account:', 'ACCOUNT:name', 'account:has space', 'guest:a\nb', 'guest:' + 'a'.repeat(129), 'a'.repeat(500), 'account:ü']) assert.equal(commentIdentityPrecondition(value), null);
});

test('discussion retrieval has bounded, explicit query semantics', () => {
  assert.deepEqual(discussionQuery(new URLSearchParams()), { limit: 100, cursor: '', q: '', filter: 'all', sort: 'activity', identity: undefined });
  assert.equal(discussionQuery(new URLSearchParams('limit=201')), null);
  assert.equal(discussionQuery(new URLSearchParams('filter=other')), null);
  assert.equal(discussionQuery(new URLSearchParams('filter=following'))?.filter, 'following');
  assert.equal(discussionQuery(new URLSearchParams('sort=unknown')), null);
  assert.equal(discussionQuery(new URLSearchParams('sort=page')), null);
  assert.equal(discussionQuery(new URLSearchParams('sort=reference'))?.sort, 'reference');
  assert.equal(discussionQuery(new URLSearchParams('identity=owner')), null);
  assert.equal(discussionQuery(new URLSearchParams(`cursor=${'x'.repeat(2049)}`)), null);
  assert.equal(discussionQuery(new URLSearchParams(`q=${'x'.repeat(241)}`)), null);
  assert.equal(discussionQuery(new URLSearchParams({ q: ' '.repeat(241) })), null);
});

test('text correction and context bodies reject authority fields and bound display text', () => {
  assert.deepEqual(correctionInput({ text: '  Revised  ', identity: 'account' }), { text: 'Revised', identity: 'account' });
  for (const invalid of [null, [], {}, { text: '' }, { text: 'x'.repeat(8001) }, { text: 'bad\0text' }, { text: 'ok', owner: 'someone' }, { text: 'ok', status: 'Closed' }, { text: 'ok', identity: 'owner' }]) assert.equal(correctionInput(invalid), null);
  assert.deepEqual(contextInput({ label: ' Heading ', quote: ' Short excerpt ' }), { label: 'Heading', quote: 'Short excerpt' });
  for (const invalid of [null, [], { label: 'x'.repeat(121) }, { quote: 'x'.repeat(241) }, { label: 'bad\0label' }, { label: 'Heading', owner: 'someone' }]) assert.equal(contextInput(invalid), null);
});

test('viewer state bodies allow only own bounded marker and boolean follow preference', () => {
  const marker = 'a'.repeat(64);
  assert.deepEqual(viewInput({ readThrough: marker, following: true, identity: 'guest' }), { readThrough: marker, following: true, identity: 'guest' });
  assert.deepEqual(viewInput({}), {});
  for (const invalid of [null, [], { readThrough: 'short' }, { following: 'true' }, { following: true, principal: 'other' }, { identity: 'owner' }]) assert.equal(viewInput(invalid), null);
});
