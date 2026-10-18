#!/usr/bin/env node
// publish-html.mjs — publish and update encrypted HTML artifacts.
// Node 22+ required (Wrangler 4.x tooling requires Node 22+; CI uses Node 24)
//
// An artifact is a Fossil repository (built with the same wasm the viewer
// runs, public/fossil.wasm.gz), encrypted here before upload. Every publish
// or update is a check-in, so the artifact keeps its full history.

import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { loadFossil } from '../public/lib/fossil.js';
import { newKey, parseFragment, fragment } from '../public/lib/vault.js';
import { Artifact, ConflictError, createArtifact } from '../public/lib/client.js';

const HELP = `
Usage:
  node scripts/publish-html.mjs [publish] [options] <file.html | dir>
  node scripts/publish-html.mjs update <edit-url> <file.html | dir> [--message <text>] [--title <text>]
  node scripts/publish-html.mjs read <url> [--out <dir>]
  node scripts/publish-html.mjs history <url>
  node scripts/publish-html.mjs list
  node scripts/publish-html.mjs delete <edit-url>

Publish options:
  --title <text>     Title for the artifact (default: filename)
  --ttl <duration>   Time-to-live: 1h, 6h, 24h, 7d, 30d, never (default: 7d)
  --slug <slug>      Optional vanity slug
  --message <text>   Check-in comment (default: "Publish <name>" / "Update <name>")
  --delete-local     Delete the local HTML file after a successful upload
  --json             Print only machine-readable JSON (no friendly output)
  --copy             Copy the viewer URL to clipboard even with --json
  --no-clipboard     Never attempt to copy the viewer URL to clipboard
  --help             Show this help

A single file is stored as index.html; a directory is stored as-is (it needs an
index.html or another .html file). Updating with a directory adds and changes
files; files missing from the directory are kept from the previous version.
A URL may end in @<check-in> to read that version.

Environment variables:
  HTML_PUBLISHER_URL    Base URL of the publisher Worker (publish, list)
  HTML_PUBLISHER_TOKEN  Bearer token for the Worker API (publish, list; optional elsewhere)

Links:
  https://<your-domain>/v/<id>#<key>               read link: share this
  https://<your-domain>/v/<id>#<key>.<writeToken>  edit link: keep this; it can update and delete
  The key lives only in the URL fragment — the server never sees it.
`;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flagsWithValues = new Set(['--title', '--ttl', '--slug', '--message', '--out']);
const hasFlag = flag => args.includes(flag);
const flagValue = flag => {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (flagsWithValues.has(args[i])) { i++; continue; }
  if (args[i].startsWith('-')) continue;
  positional.push(args[i]);
}

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(HELP);
  process.exit(0);
}

const COMMANDS = new Set(['publish', 'update', 'read', 'history', 'list', 'delete']);
const command = COMMANDS.has(positional[0]) ? positional.shift() : 'publish';

const jsonOnly = hasFlag('--json');
const shouldCopy = !hasFlag('--no-clipboard') && (!jsonOnly || hasFlag('--copy'));
const user = process.env.USER || safeUser();

function die(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function safeUser() {
  try { return userInfo().username || 'cli'; } catch { return 'cli'; }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function env(name) {
  const v = process.env[name];
  if (!v) die(`${name} environment variable is required`);
  return v.replace(/\/$/, '');
}

function parseTtl(raw) {
  if (raw === 'never') return 0;
  const m = raw.match(/^(\d+)(h|d)$/);
  if (!m) die(`invalid --ttl "${raw}". Expected e.g. 1h, 6h, 24h, 7d, 30d, never`);
  const n = parseInt(m[1], 10);
  return m[2] === 'h' ? n * 3_600 : n * 86_400;
}

/** Parse an artifact link into its origin, id and fragment parts. */
function parseLink(raw) {
  let url;
  try { url = new URL(raw); } catch { die(`not a URL: ${raw}`); }
  const m = /^\/v\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
  if (!m) die(`not an artifact link (expected /v/<id>#<key>): ${raw}`);
  let parts;
  try { parts = parseFragment(url.hash); } catch (e) { die(e.message); }
  return { base: url.origin, id: m[1], ...parts };
}

/** Read a file or directory into { path: bytes }, with warnings for external URLs. */
function readInput(path) {
  let st;
  try { st = statSync(path); } catch (err) { die(`cannot read ${path}: ${err.message}`); }
  const files = {};
  if (st.isDirectory()) {
    const walk = dir => {
      for (const name of readdirSync(dir)) {
        if (name.startsWith('.')) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else files[relative(path, full).split(sep).join('/')] = readFileSync(full);
      }
    };
    walk(path);
    if (!Object.keys(files).some(n => /\.html?$/i.test(n))) die(`${path} has no .html file`);
  } else {
    const html = readFileSync(path, 'utf8');
    const head = html.trimStart().toLowerCase();
    if (!head.startsWith('<!doctype html') && !head.startsWith('<html')) {
      die('file does not appear to be a standalone HTML document.\n  Expected content to start with <!doctype html or <html');
    }
    files['index.html'] = Buffer.from(html);
  }

  const warnings = [];
  for (const [name, data] of Object.entries(files)) {
    if (!/\.(html?|css|js|mjs)$/i.test(name)) continue;
    const urls = new Set(data.toString('utf8').match(/https?:\/\/[^\s"'>)\]]+/g) ?? []);
    for (const u of urls) warnings.push(`external URL: ${u}`);
  }
  if (warnings.length > 0 && !jsonOnly) {
    console.warn(`\nWarning: ${warnings.length} external reference(s) detected.`);
    for (const w of warnings.slice(0, 10)) console.warn(`  Warning: ${w}`);
    if (warnings.length > 10) console.warn(`  … and ${warnings.length - 10} more`);
    console.warn('  The viewer blocks network requests, so these will not load.\n');
  }
  return { files, warnings };
}

const fossil = await loadFossil(readFileSync(new URL('../public/fossil.wasm.gz', import.meta.url)));

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function publish() {
  const filePath = positional[0];
  if (!filePath) die('HTML file path is required.\nRun with --help for usage.');
  const base = env('HTML_PUBLISHER_URL');
  const token = env('HTML_PUBLISHER_TOKEN');
  const { files, warnings } = readInput(filePath);
  const sourceName = basename(filePath);
  const title = flagValue('--title') ?? sourceName;

  fossil.create(title, user);
  const checkin = fossil.commit(files, flagValue('--message') ?? `Publish ${sourceName}`, user);
  const key = newKey();
  const result = await createArtifact(base, token, key, fossil, {
    title,
    sourceName,
    ttlSeconds: parseTtl(flagValue('--ttl') ?? '7d'),
    slug: flagValue('--slug'),
  });

  const viewerUrl = result.viewerUrl + fragment({ key });
  const editUrl = result.viewerUrl + fragment({ key, write: result.writeToken });
  output({
    id: result.id,
    viewerUrl,
    editUrl,
    checkin: checkin.uuid,
    expiresAt: result.expiresAt ?? null,
    warnings: warnings.length,
    warningMessages: warnings,
  }, viewerUrl);

  if (hasFlag('--delete-local') && !statSync(filePath).isDirectory()) {
    try {
      unlinkSync(filePath);
      if (!jsonOnly) console.log(`   Deleted:   ${filePath}`);
    } catch (err) {
      if (!jsonOnly) console.warn(`   Warning: could not delete ${filePath} — ${err.message}`);
    }
  }
}

async function update() {
  const [rawUrl, filePath] = positional;
  if (!rawUrl || !filePath) die('usage: update <edit-url> <file.html | dir>');
  const link = parseLink(rawUrl);
  if (!link.write && !process.env.HTML_PUBLISHER_TOKEN) {
    die('this is a read link; updating needs the edit link (…#<key>.<writeToken>) or HTML_PUBLISHER_TOKEN');
  }
  const { files, warnings } = readInput(filePath);
  const art = await Artifact.open(link.base, link.id, link.key, link.write, fossil,
    { bearer: process.env.HTML_PUBLISHER_TOKEN });

  const forks = fossil.leaves();
  if (forks.length > 1 && !jsonOnly) {
    console.warn(`Warning: the artifact has ${forks.length} leaves (concurrent edits); committing on the latest.`);
  }
  let checkin;
  try {
    checkin = fossil.commit(files, flagValue('--message') ?? `Update ${basename(filePath)}`, user);
  } catch (e) {
    die(e.message);
  }
  try {
    await art.save({ title: flagValue('--title') });
  } catch (e) {
    if (e instanceof ConflictError) die(`${e.message}. Nothing was saved.`, 3);
    throw e;
  }
  const viewerUrl = `${link.base}/v/${link.id}${fragment({ key: link.key })}`;
  output({ id: art.id, viewerUrl, checkin: checkin.uuid, warnings: warnings.length, warningMessages: warnings }, viewerUrl);
}

async function read() {
  const [rawUrl] = positional;
  if (!rawUrl) die('usage: read <url> [--out <dir>]');
  const link = parseLink(rawUrl);
  await Artifact.open(link.base, link.id, link.key, '', fossil);
  const names = fossil.files(link.at);
  const out = flagValue('--out');
  if (!out) {
    const entry = names.includes('index.html') ? 'index.html' : names.find(n => /\.html?$/i.test(n));
    process.stdout.write(fossil.read(entry, link.at));
    return;
  }
  for (const name of names) {
    const dest = join(out, ...name.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, fossil.read(name, link.at));
  }
  if (!jsonOnly) console.log(`Wrote ${names.length} file(s) to ${out}`);
}

async function history() {
  const [rawUrl] = positional;
  if (!rawUrl) die('usage: history <url>');
  const link = parseLink(rawUrl);
  await Artifact.open(link.base, link.id, link.key, '', fossil);
  const timeline = fossil.timeline();
  if (jsonOnly) return console.log(JSON.stringify(timeline));
  for (const c of timeline) console.log(`${c.uuid.slice(0, 12)}  ${c.time}  ${c.user.padEnd(10)}  ${c.comment}`);
}

async function list() {
  const res = await fetch(`${env('HTML_PUBLISHER_URL')}/api/artifacts`, {
    headers: { Authorization: `Bearer ${env('HTML_PUBLISHER_TOKEN')}` },
  });
  if (!res.ok) die(`list failed with HTTP ${res.status}`);
  const { artifacts } = await res.json();
  if (jsonOnly) return console.log(JSON.stringify(artifacts));
  for (const a of artifacts) console.log(`${a.id}  ${a.updatedAt}  ${a.title}`);
}

async function remove() {
  const [rawUrl] = positional;
  if (!rawUrl) die('usage: delete <edit-url>');
  const link = parseLink(rawUrl);
  const headers = {};
  if (link.write) headers['X-Write-Token'] = link.write;
  if (process.env.HTML_PUBLISHER_TOKEN) headers.Authorization = `Bearer ${process.env.HTML_PUBLISHER_TOKEN}`;
  const res = await fetch(`${link.base}/a/${link.id}`, { method: 'DELETE', headers });
  if (res.status !== 204) die(`delete failed with HTTP ${res.status}`);
  if (!jsonOnly) console.log(`Deleted ${link.id}`);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function copyToClipboard(text) {
  const { platform } = process;
  if (platform === 'darwin') {
    const r = spawnSync('pbcopy', { input: text });
    return !r.error && r.status === 0;
  }
  if (platform === 'win32') {
    // clip.exe reads from stdin; shell:true handles cmd.exe path resolution
    const r = spawnSync('clip', { input: text, shell: true });
    return !r.error && r.status === 0;
  }
  // Linux — try each tool in order; skip when not installed (ENOENT)
  for (const [cmd, extra] of [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ]) {
    const r = spawnSync(cmd, extra, { input: text });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

function output(result, viewerUrl) {
  if (jsonOnly) {
    console.log(JSON.stringify(result));
  } else {
    console.log(JSON.stringify(result, null, 2));
    console.log(`\nPublished: ${viewerUrl}`);
    if (result.editUrl) console.log(`   Edit link (keep private): ${result.editUrl}`);
    if (result.expiresAt) console.log(`   Expires:   ${new Date(result.expiresAt).toLocaleString()}`);
  }
  // Clipboard — best-effort; the upload already succeeded
  if (shouldCopy) {
    const copied = copyToClipboard(viewerUrl);
    if (jsonOnly) process.stderr.write(copied ? '# clipboard: copied\n' : '# clipboard: unavailable\n');
    else console.log(copied ? '   Copied to clipboard' : '   Clipboard unavailable');
  }
}

const run = { publish, update, read, history, list, delete: remove }[command];
try {
  await run();
} catch (e) {
  die(e.message);
}
process.exit(0);
