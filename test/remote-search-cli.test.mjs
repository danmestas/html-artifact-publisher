import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = new URL('..', import.meta.url);

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function search(base, args, credential = 'fixture-search-credential') {
  try {
    const result = await exec(process.execPath, ['scripts/publish-html.mjs', 'search', ...args], {
      cwd: root, timeout: 30000,
      env: { ...process.env, HTML_PUBLISHER_URL: base, HTML_PUBLISHER_TOKEN: credential },
    });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

test('remote agents search over authenticated HTTPS-compatible API without a browser and receive structured matches', async t => {
  const requests = [];
  const base = await fixture(t, (req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ artifacts: [{ id: 'one', title: 'Storage experiment', viewerUrl: '/v/one',
      searchIndex: { status: 'complete', version: 1 },
      search: { matchedTerms: ['five'], totalTerms: 2, partial: true, snippet: { text: 'five repositories', matches: [{ start: 0, end: 4 }], path: 'index.html' } },
    }], total: 1, nextCursor: null }));
  });
  const result = await search(base, ['five big', '--json']);
  assert.equal(result.code, 0, 'authorized remote search succeeds');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  const url = new URL(requests[0].url, base);
  assert.equal(url.pathname, '/api/search');
  assert.equal(url.searchParams.get('q'), 'five big');
  assert.equal(requests[0].authorization === 'Bearer fixture-search-credential', true);
  const data = JSON.parse(result.stdout);
  assert.equal(data.total, 1);
  assert.equal(data.artifacts[0].search.partial, true);
  assert.equal(data.artifacts[0].search.snippet.text, 'five repositories');
  assert.equal(result.stdout.includes('fixture-search-credential'), false);
});

test('an artifact-link search sends only that capability and never the configured instance credential', async t => {
  const capability = 'a'.repeat(64);
  const requests = [];
  const base = await fixture(t, (req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ artifacts: [{ id: 'one', title: 'One artifact', viewerUrl: `/v/one#${capability}`,
      editUrl: `/v/one#${capability}`, cloneUrl: 'private-clone-must-not-be-returned' }], total: 1, nextCursor: null }));
  });
  const result = await search('http://127.0.0.1:1', ['five', '--artifact', `${base}/v/one#${capability}`, '--json'], 'instance-credential-must-not-leave');
  assert.equal(result.code, 0, 'the supplied link authorizes only its own artifact search');
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url, base).searchParams.get('artifactId'), 'one');
  assert.equal(requests[0].authorization === 'Token ' + capability, true);
  assert.equal(result.stdout.includes(capability), false, 'results never echo the artifact capability');
  assert.equal(result.stdout.includes('instance-credential-must-not-leave'), false);
  const data = JSON.parse(result.stdout);
  assert.equal(new URL(data.artifacts[0].viewerUrl, base).hash, '');
  assert.equal(Object.hasOwn(data.artifacts[0], 'editUrl'), false);
  assert.equal(Object.hasOwn(data.artifacts[0], 'cloneUrl'), false);
});

test('a missing artifact argument cannot silently widen the request to the configured account or instance scope', async t => {
  let requests = 0;
  const base = await fixture(t, (_req, res) => {
    requests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ artifacts: [], total: 0, nextCursor: null }));
  });
  const result = await search(base, ['five', '--json', '--artifact']);
  assert.notEqual(result.code, 0);
  assert.equal(requests, 0, 'an explicitly requested artifact scope must never fall back to a broader credential');
});

test('search never follows a redirect carrying the authorization header to another origin', async t => {
  let received = 0;
  const other = await fixture(t, (_req, res) => { received++; res.end('{}'); });
  const base = await fixture(t, (_req, res) => { res.writeHead(302, { Location: other + '/collect' }); res.end(); });
  const result = await search(base, ['five', '--json']);
  assert.notEqual(result.code, 0);
  assert.equal(received, 0);
  assert.equal(result.stderr.includes('fixture-search-credential'), false);
});

test('pagination returns one bounded page and accepts the opaque cursor with the same query', async t => {
  const requests = [];
  const cursor = 'opaque-query-bound-continuation';
  const base = await fixture(t, (req, res) => {
    requests.push(new URL(req.url, 'http://localhost'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ artifacts: [], total: 0, nextCursor: cursor }));
  });
  const result = await search(base, ['five big', '--limit', '2', '--cursor', cursor, '--json']);
  assert.equal(result.code, 0);
  assert.equal(requests.length, 1, 'the CLI does not silently enumerate every authorized result');
  assert.equal(requests[0].searchParams.get('q'), 'five big');
  assert.equal(requests[0].searchParams.get('limit'), '2');
  assert.equal(requests[0].searchParams.get('cursor'), cursor);
  assert.equal(JSON.parse(result.stdout).nextCursor, cursor);
});

test('authorization failures remain failures and echoed request credentials never reach output', async t => {
  const base = await fixture(t, (req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Rejected ' + req.headers.authorization }));
  });
  const result = await search(base, ['five', '--json']);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /HTTP 401/);
  assert.equal(result.stderr.includes('fixture-search-credential'), false);
});

test('a publisher URL carrying credentials or a path is rejected before sending the configured credential', async t => {
  let requests = 0;
  const base = await fixture(t, (_req, res) => { requests++; res.end('{}'); });
  for (const value of [base + '/other', base + '?other=1', base + '#fragment', base.replace('://', '://user:password@')]) {
    const result = await search(value, ['five', '--json']);
    assert.notEqual(result.code, 0);
  }
  assert.equal(requests, 0);
});

test('an oversized search response is refused instead of buffering arbitrary remote data', async t => {
  const base = await fixture(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ artifacts: [], total: 0, nextCursor: null, unexpected: 'x'.repeat(2 * 1024 * 1024) }));
  });
  const result = await search(base, ['five', '--json']);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /response.*too large/i);
});
