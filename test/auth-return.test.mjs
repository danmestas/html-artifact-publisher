import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeReturnTo, signinUrl, threadRef } from '../public/auth-return.js';

const uuid = 'a'.repeat(40);

test('sign-in destinations preserve an artifact and selected version, never a capability', () => {
  assert.equal(safeReturnTo('/v/artifact_123'), '/v/artifact_123');
  assert.equal(safeReturnTo('/v/artifact_123#@abcdef123456'), '/v/artifact_123#@abcdef123456');
  assert.equal(safeReturnTo('/v/artifact_123?token=secret#private-access'), '/v/artifact_123');
  assert.equal(safeReturnTo('/v/artifact_123#private-access@abcdef123456'), '/v/artifact_123');
  assert.equal(signinUrl('/v/artifact_123#@abcdef123456'), '/login?returnTo=%2Fv%2Fartifact_123%23%40abcdef123456');
});

test('a validated discussion reference survives sign-in; other artifact queries do not', () => {
  // The thread query is the one artifact query a sign-in round trip keeps, so
  // the reader comes back to the thread they were reading — and nothing else.
  assert.equal(safeReturnTo(`/v/artifact_123?thread=${uuid}`), `/v/artifact_123?thread=${uuid}`);
  assert.equal(safeReturnTo(`/v/artifact_123?thread=${uuid}#@abcdef123456`), `/v/artifact_123?thread=${uuid}#@abcdef123456`);
  assert.equal(signinUrl(`/v/artifact_123?thread=${uuid}`), `/login?returnTo=${encodeURIComponent(`/v/artifact_123?thread=${uuid}`)}`);
  // A capability or arbitrary query is dropped, even beside a valid thread.
  assert.equal(safeReturnTo(`/v/artifact_123?thread=${uuid}&token=${'f'.repeat(64)}`), `/v/artifact_123?thread=${uuid}`);
  assert.equal(safeReturnTo(`/v/artifact_123?thread=${uuid}&returnTo=https://evil.example`), `/v/artifact_123?thread=${uuid}`);
  assert.equal(safeReturnTo(`/v/artifact_123?thread=${uuid}&comment=${'0'.repeat(64)}`), `/v/artifact_123?thread=${uuid}`);
  // Only a 40- or 64-digit lowercase hex reference is a thread.
  for (const bad of ['', 'C14', 'x'.repeat(40), uuid.toUpperCase(), uuid.slice(1), uuid + 'a', `${uuid}g`, 'a'.repeat(41)]) {
    assert.equal(threadRef(bad), '', JSON.stringify(bad));
    assert.equal(safeReturnTo(`/v/artifact_123?thread=${encodeURIComponent(bad)}`), '/v/artifact_123');
  }
  assert.equal(threadRef(uuid), uuid);
  const hash = 'b'.repeat(64);
  assert.equal(threadRef(hash), hash);
});

test('sign-in destinations reject external URLs, malformed paths and redirect tricks', () => {
  for (const value of [undefined, null, {}, '', '//evil.example/v/id', '/\\evil.example', 'https://evil.example/v/id', 'javascript:alert(1)', '/login?returnTo=//evil.example', '/api/auth/verify', '/v/id%2f..', '/v/id\n', '/'.repeat(5000)]) {
    assert.equal(safeReturnTo(value), '/');
  }
});

test('library destinations preserve supported filters but remove credentials and unrecognized state', () => {
  assert.equal(safeReturnTo('/?view=starred&q=release&sort=name'), '/?view=starred&q=release&sort=name');
  assert.equal(safeReturnTo('/?view=all&token=secret&returnTo=https://evil.example#private-access'), '/?view=all');
  assert.equal(signinUrl('/'), '/login');
});

test('chosen library expiry ordering survives the sign-in round trip', () => {
  for (const view of ['all', 'mine', 'shared', 'starred', 'archived']) {
    const destination = `/?view=${view}&q=river&sort=expiry&n=24`;
    assert.equal(safeReturnTo(destination), destination);
    const login = new URL(signinUrl(destination), 'https://example.test');
    assert.equal(safeReturnTo(login.searchParams.get('returnTo')), destination);
  }
});
