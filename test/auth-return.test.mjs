import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeReturnTo, signinUrl } from '../public/auth-return.js';

test('sign-in destinations preserve an artifact and selected version, never a capability', () => {
  assert.equal(safeReturnTo('/v/artifact_123'), '/v/artifact_123');
  assert.equal(safeReturnTo('/v/artifact_123#@abcdef123456'), '/v/artifact_123#@abcdef123456');
  assert.equal(safeReturnTo('/v/artifact_123?token=secret#private-access'), '/v/artifact_123');
  assert.equal(safeReturnTo('/v/artifact_123#private-access@abcdef123456'), '/v/artifact_123');
  assert.equal(signinUrl('/v/artifact_123#@abcdef123456'), '/login?returnTo=%2Fv%2Fartifact_123%23%40abcdef123456');
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
