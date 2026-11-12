import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestAuthor, guestCookie, guestInput, guestToken } from '../src/guest.ts';

// The profile body is a strict allowlist: name and email, nothing else. A
// request cannot smuggle a role, account or id through it.
test('guest profile input: optional name and email, strict allowlist', () => {
  assert.deepEqual(guestInput({}), { name: 'Guest', email: '' });
  assert.deepEqual(guestInput({ name: '  Rae  ', email: 'Rae@Example.COM' }), { name: 'Rae', email: 'rae@example.com' });
  assert.deepEqual(guestInput({ name: 'Rae' }), { name: 'Rae', email: '' });
  assert.deepEqual(guestInput({ email: 'rae@example.com' }), { name: 'Guest', email: 'rae@example.com' });
  assert.equal(guestInput(null), null);
  assert.equal(guestInput({ name: 'Rae', email: '', permission: 'write' }), null);
  assert.equal(guestInput({ name: 'Rae', email: '', userId: 'instance-owner' }), null);
  assert.equal(guestInput({ name: 42 }), null);
  assert.equal(guestInput({ email: 42 }), null);
  assert.equal(guestInput({ name: 'x'.repeat(65) }), null);
  assert.deepEqual(guestInput({ name: 'x'.repeat(64) }), { name: 'x'.repeat(64), email: '' });
  assert.equal(guestInput({ email: 'not-an-address' }), null);
  assert.equal(guestInput({ email: 'a@b' }), null);
  assert.equal(guestInput({ email: `${'x'.repeat(250)}@example.com` }), null);
  assert.equal(guestInput({ name: 'Rae\u0000' }), null);
  assert.equal(guestInput({ name: 'Rae\nSmith' }), null);
  assert.equal(guestInput({ email: 'rae@example.com\u0007' }), null);
});

// The cookie is an opaque 64-hex token, scoped to the artifact API, unreadable
// by page scripts, and Secure only where the request itself is HTTPS.
test('guest cookie: opaque, artifact-scoped, HttpOnly, Secure on HTTPS', () => {
  const token = 'a'.repeat(64);
  const http = guestCookie(new Request('http://x.test/api/artifacts/a/guest'), token);
  assert.equal(http, `hap_guest=${token}; Path=/api/artifacts/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
  assert.match(guestCookie(new Request('https://x.test/api/artifacts/a/guest'), token), /; Secure$/);
  assert.match(guestCookie(new Request('http://x.test/api/artifacts/a/guest'), token, true), /Max-Age=0/);
  assert.equal(guestToken(new Request('http://x.test/', { headers: { Cookie: `other=1; hap_guest=${token}` } })), token);
  assert.equal(guestToken(new Request('http://x.test/', { headers: { Cookie: 'hap_guest=short' } })), '');
  assert.equal(guestToken(new Request('http://x.test/')), '');
});

// The author a guest leaves in the repository is a display name with an
// explicit suffix, never an address, even if the name was stored one.
test('guest author: display name, guest suffix, never an address', () => {
  assert.equal(guestAuthor('Rae'), 'Rae (guest)');
  assert.equal(guestAuthor('owner'), 'owner (guest)');
  assert.equal(guestAuthor('rae@example.com'), 'account (guest)');
  assert.equal(guestAuthor('x'.repeat(100)), `${'x'.repeat(52)} (guest)`);
  assert.ok(guestAuthor('x'.repeat(100)).length <= 64);
});
