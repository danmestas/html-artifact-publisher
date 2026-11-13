import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Artifact, createArtifact } from '../public/client.js';
import { ICON_NAMES, validIcon, iconSvg, inferIcon, resolveIcon } from '../public/icons.js';

test('trusted icons reject prototype keys, URLs, markup and non-string values', () => {
  for (const value of ICON_NAMES) assert.equal(validIcon(value), true);
  for (const value of ['constructor', '__proto__', 'toString', '<svg/>', 'https://example.com/a.svg', 4, true, {}, []]) {
    assert.equal(validIcon(value), false);
    assert.equal(iconSvg(value), iconSvg('document'));
  }
  assert.equal(validIcon(null), true);
  assert.equal(validIcon(undefined), true);
  assert.match(iconSvg('chart', true), /prefers-color-scheme:dark/);
  assert.notEqual(iconSvg('chart'), iconSvg('document'));
});

test('public client rejects invalid icons before uploading any file', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected network call'); });
  const files = { 'binary.png': new Uint8Array([0, 1, 2]) };
  await assert.rejects(createArtifact('https://example.com', 'unused', { files, icon: '<svg/>' }), /Invalid artifact icon/);
  await assert.rejects(new Artifact('https://example.com', 'id', 'unused').publish('tip', files, 'Update', { icon: 5 }), /Invalid artifact icon/);
  assert.equal(calls, 0);
});

test('CLI validates icons before reading files or contacting the publisher', () => {
  const cli = new URL('../scripts/publish-html.mjs', import.meta.url);
  for (const icon of ['constructor', 'https://example.com/a.svg', '<svg/>', 'unknown']) {
    const result = spawnSync(process.execPath, [cli.pathname, '--icon', icon, '/nonexistent'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--icon must be one of:/);
  }
  const help = spawnSync(process.execPath, [cli.pathname, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--icon <name>/);
});

test('title inference selects a bounded topic and is deterministic', () => {
  const cases = [
    ['Threat model for the upload pipeline', 'security'],
    ['Vulnerability triage notes', 'security'],
    ['Zero trust access control', 'security'],
    ['2026 budget and invoice reconciliation', 'finance'],
    ['Quarterly earnings forecast', 'finance'],
    ['Health check design for patients', 'health'],
    ['Clinical diagnosis workflow', 'health'],
    ['Quantum chemistry experiment log', 'science'],
    ['Peer review dataset', 'science'],
    ['System design for a distributed system', 'architecture'],
    ['Microservices topology map', 'architecture'],
    ['Course syllabus and lesson plans', 'education'],
    ['Travel itinerary for the trip', 'travel'],
    ['Song lyrics and album notes', 'music'],
    ['Board game balance notes', 'game'],
    ['Wireframes and mockups for branding', 'design'],
    ['User interviews and findings', 'research'],
    ['Stakeholder org chart and hiring plan', 'people'],
    ['Sprint backlog and roadmap', 'planning'],
    ['CLI toolkit automation setup guide', 'tool'],
    ['JavaScript API reference', 'code'],
    ['Analytics dashboard', 'chart'],
    ['Release calendar', 'calendar'],
    ['Investor presentation slides', 'slides'],
    ['Launch checklist', 'checklist'],
    ['Meeting notes', 'notes'],
    ['Photography portfolio', 'image'],
    ['Trail map', 'map'],
    ['Reading list', 'book'],
    ['Mortgage calculator', 'calculator'],
    ['Dinner recipes', 'recipe'],
    ['Project overview', 'planning'],
  ];
  for (const [title, expected] of cases) {
    assert.equal(inferIcon(title), expected, title);
    assert.equal(inferIcon(title), inferIcon(title), title);
  }
});

test('unknown, empty and non-string titles infer the document icon', () => {
  for (const title of ['', '   ', '\n\t', 'untitled', 'a', null, undefined, 0, true, {}, [], '€£¥', '...']) {
    assert.equal(inferIcon(title), 'document');
  }
  assert.equal(inferIcon('Untitled artifact'), 'document');
});

test('explicit valid non-document icons win; document and invalid values infer', () => {
  assert.equal(resolveIcon('chart', 'Threat model'), 'chart');
  assert.equal(resolveIcon('book', 'Sprint backlog'), 'book');
  assert.equal(resolveIcon('document', 'Threat model'), 'security');
  assert.equal(resolveIcon(null, 'Sprint backlog'), 'planning');
  assert.equal(resolveIcon(undefined, 'Course syllabus'), 'education');
  for (const bad of ['constructor', '__proto__', 'toString', '<svg/>', 'https://example.com/a.svg', 4, true, {}, []]) {
    assert.equal(resolveIcon(bad, 'Travel itinerary'), 'travel');
    assert.equal(resolveIcon(bad, ''), 'document');
  }
});

test('every inferable topic resolves to a real bounded icon', () => {
  const topics = ['security', 'finance', 'health', 'science', 'architecture', 'education', 'travel',
    'music', 'game', 'design', 'research', 'people', 'planning', 'tool'];
  for (const topic of topics) {
    assert.equal(ICON_NAMES.includes(topic), true, topic);
    assert.equal(validIcon(topic), true, topic);
    assert.notEqual(iconSvg(topic), iconSvg('document'), topic);
  }
});

test('inference is bounded against hostile and oversized titles', () => {
  assert.equal(inferIcon('constructor'), 'document');
  assert.equal(inferIcon('__proto__'), 'document');
  assert.equal(inferIcon('toString valueOf hasOwnProperty __proto__'), 'document');
  assert.equal(inferIcon('<script>alert(1)</script>'), 'document');
  assert.equal(inferIcon('javascript:alert(1)'), 'code', 'title text may match a topic but is never executed');
  assert.equal(inferIcon('../../etc/passwd'), 'document');
  assert.equal(inferIcon('{ icon: "<svg onload=alert(1)>" }'), 'document');
  assert.equal(inferIcon('security; DROP TABLE artifacts'), 'security');
  // Only the first 512 characters are considered, so trailing megabytes cost nothing.
  const huge = 'Threat model ' + 'a'.repeat(5_000_000);
  const started = Date.now();
  assert.equal(inferIcon(huge), 'security');
  assert.ok(Date.now() - started < 2000, 'inference over a huge title stays bounded');
  assert.equal(inferIcon('a'.repeat(5_000_000) + ' threat model'), 'document');
  assert.equal(inferIcon('x'.repeat(5_000_000)), 'document');
});

test('artwork stays bounded: fixed viewBox, no script, no external references', () => {
  for (const name of ICON_NAMES) {
    const svg = iconSvg(name);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24"/, name);
    assert.doesNotMatch(svg, /<script|<iframe|<foreignObject|javascript:|on\w+=/i, name);
    assert.doesNotMatch(svg, /(?:href|src)\s*=/i, name);
    const outside = svg.replace(/^<svg[^>]*>/, '').match(/\d+(?:\.\d+)?/g) ?? [];
    for (const value of outside) assert.ok(Number(value) <= 24 || /^[01]\.\d+$/.test(value), `${name}: ${value}`);
    assert.equal(svg.match(/<svg/g)?.length, 1, name);
  }
});
