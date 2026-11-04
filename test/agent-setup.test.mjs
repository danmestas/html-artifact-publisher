// Static checks for the public agent setup page, its copyable install prompt and
// /llms.txt. These read the shipped files; they do not start Wrangler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHECKOUT_RESOLVER, copyText, envExample, installCommands, installPrompt, REPO_GIT, selectTarget, SKILLS } from '../public/agent-setup.js';

const root = new URL('..', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const REPO = 'https://github.com/danmestas/html-artifact-publisher';
const ZIP = `${REPO}/archive/refs/heads/main.zip`;

test('agent setup page is a public app page that links its assets, llms.txt and the source download', () => {
  const html = read('public/agent-setup.html');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en"/);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/);
  assert.match(html, /<script src="\/appearance\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/library\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/agent-setup\.css">/);
  assert.match(html, /<script type="module" src="\/agent-setup\.js"><\/script>/);
  assert.match(html, /href="\/llms\.txt"/);
  assert.match(html, new RegExp(`href="${ZIP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(html, new RegExp(`href="${REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(html, /Download skills \+ CLI \(\.zip\)/);
  assert.match(html, /skills\//);
  assert.match(html, /<textarea[^>]*readonly/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /type="button"/);
  assert.match(html, /data-copy/);
  assert.match(html, /href="\/agent-setup\.html"/, 'the page links itself as the setup entry point');
  assert.match(html, /href="\/\?view=credentials"/, 'credentials guidance links to the app page');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline handlers');
  assert.doesNotMatch(html, /\.workers\.dev/);
  assert.doesNotMatch(html, /<script[^>]+src="https?:/i, 'scripts are same-origin');
});

test('library index links the agent setup page plainly', () => {
  const html = read('public/index.html');
  assert.match(html, /<a href="\/agent-setup\.html"[^>]*>Set up an agent to publish<\/a>/);
});

test('install prompt uses the current origin and carries every safe installation instruction', () => {
  const origin = 'https://artifacts.example.test';
  const prompt = installPrompt(origin);
  assert.ok(prompt.includes(origin), 'prompt names the instance origin');
  assert.ok(prompt.includes(`${origin}/llms.txt`), 'prompt reads llms.txt from this origin');
  assert.ok(prompt.includes(`${origin}/?view=credentials`), 'prompt points at the app credentials page');
  assert.ok(prompt.includes(`HTML_PUBLISHER_URL=${origin}`), 'prompt configures the CLI with this origin');
  assert.ok(prompt.includes('HTML_PUBLISHER_TOKEN'), 'prompt names the token variable');
  assert.ok(prompt.includes(REPO), 'prompt names the repository');
  assert.ok(prompt.includes(ZIP), 'prompt offers the source ZIP');
  assert.match(prompt, /inspect (the )?instructions and scripts/i);
  assert.match(prompt, /dedicated local tools directory/i);
  assert.match(prompt, /not .*workspace root|do not .*workspace/i);
  for (const dir of ['~/.claude/skills', 'equivalent']) assert.ok(prompt.includes(dir), `prompt names ${dir}`);
  assert.match(prompt, /do not overwrite|without asking|preserve/i);
  assert.match(prompt, /keep (that|the) checkout|skills reference|run from the checkout/i);
  assert.match(prompt, /readlink -f/, 'prompt resolves the installed skill symlink');
  assert.match(prompt, /absolute path|absolute artifact input/i, 'prompt names the path contract');
  assert.match(prompt, /publish-html\.mjs --help/, 'prompt verifies the CLI starts');
  assert.match(prompt, /scripts\/publish-html\.mjs/);
  for (const skill of ['publish-html-page', 'artifact-design', 'artifact-runtime', 'artifact-diagrams', 'artifact-dataviz', 'pikchr', 'self-host-publisher']) {
    assert.ok(prompt.includes(skill), `prompt lists ${skill}`);
  }
  assert.match(prompt, /Node\.js 22/);
  assert.match(prompt, /do not install Go|does not need Go/i);
  assert.match(prompt, /never .*token/i);
  assert.match(prompt, /localStorage/i);
  assert.match(prompt, /curl \| sh|pipe .* install/i);
  assert.doesNotMatch(prompt, /\.workers\.dev/);
  assert.doesNotMatch(prompt, /\b[0-9a-f]{64}\b/, 'prompt never contains a real-looking token');
  assert.doesNotMatch(prompt, /document\.cookie|read cookies/i);
});

test('setup script derives the prompt origin from location.origin and copies with a selectable fallback', async () => {
  const source = read('public/agent-setup.js');
  assert.match(source, /location\.origin/);
  assert.match(source, /navigator\.clipboard/);

  const written = [];
  assert.equal(await copyText('hello', { writeText: async text => { written.push(text); } }), true);
  assert.deepEqual(written, ['hello']);
  assert.equal(await copyText('hello', { writeText: async () => { throw new Error('denied'); } }), false);
  assert.equal(await copyText('hello', null), false);

  const calls = [];
  const target = { focus: () => calls.push('focus'), select: () => calls.push('select') };
  selectTarget(target);
  assert.deepEqual(calls, ['focus', 'select']);
  selectTarget(null);
});

test('the clipboard fallback focuses and selects the real source content when permission is denied', async () => {
  const source = read('public/agent-setup.js');
  const { selectTarget } = await import('../public/agent-setup.js');
  // A non-focusable element must not report success.
  assert.equal(selectTarget({}), false, 'a target without focus() is not selectable');
  // The click handler must pass the actual source element, not the button.
  assert.match(source, /selectTarget\(source\)/);
  // The handler reads the exact copied text from the same element it selects.
  assert.match(source, /'value' in source \? source\.value : source\.textContent/);
  // Denied clipboard writes return false and never throw.
  assert.equal(await copyText('x', { writeText: () => { throw new Error('NotAllowedError'); } }), false);
  assert.equal(await copyText('x', { writeText: () => Promise.reject(new Error('denied')) }), false);
  // A status element is only described as copied after a successful write.
  assert.match(source, /if \(status\) status\.textContent = 'Copied to your clipboard\.'/);
  assert.match(source, /Clipboard unavailable/);
  // A target that cannot be focused and cannot select reports failure, so the
  // status text never claims a selection that did not happen.
  const unfocusable = { ownerDocument: { defaultView: { getSelection: () => null } } };
  assert.equal(selectTarget(unfocusable), false);
});

test('a denied clipboard write selects the source contents instead', async () => {
  // Minimal <pre>-like element: no select(), so selection goes through a Range.
  const calls = [];
  const range = { selectNodeContents: node => calls.push(['selectNodeContents', node]) };
  const selection = {
    removeAllRanges: () => calls.push('removeAllRanges'),
    addRange: r => calls.push(['addRange', r]),
  };
  const element = {
    focus: () => calls.push('focus'),
    ownerDocument: {
      defaultView: { getSelection: () => selection },
      createRange: () => range,
    },
  };
  assert.equal(selectTarget(element), true);
  assert.equal(calls[0], 'focus');
  assert.deepEqual(calls[1], ['selectNodeContents', element]);
  assert.equal(calls[2], 'removeAllRanges');
  assert.deepEqual(calls[3], ['addRange', range]);
});

test('llms.txt describes publishing accurately and links setup, source and skills', () => {
  const text = read('public/llms.txt');
  assert.match(text, /^# HTML Artifact Publisher/);
  assert.ok(text.includes('/agent-setup.html'), 'links the setup page');
  assert.ok(text.includes(REPO), 'links the source repository');
  assert.ok(text.includes(ZIP), 'links the downloadable source ZIP');
  for (const skill of ['publish-html-page', 'artifact-design', 'artifact-runtime', 'artifact-diagrams', 'artifact-dataviz', 'pikchr', 'self-host-publisher']) {
    assert.ok(text.includes(`skills/${skill}`), `links ${skill}`);
  }
  assert.match(text, /update <edit-url>|update "\$EDIT_URL"|publish-html\.mjs update/i);
  assert.match(text, /read link cannot update/i);
  assert.match(text, /--ttl[^\n]*never/);
  assert.match(text, /default[^\n]*7d/i);
  assert.match(text, /read link/i);
  assert.match(text, /comment link/i);
  assert.match(text, /edit link/i);
  assert.match(text, /clone URL|cloneUrl/i);
  assert.match(text, /blocks? (all )?network|network requests? (are )?blocked|sandbox/i);
  assert.match(text, /relative (paths|attachments|files)/i);
  assert.match(text, /256 KB/i);
  assert.match(text, /light and dark/i);
  assert.match(text, /history/i);
  assert.match(text, /never[^\n]*token|token[^\n]*never/i);
  assert.doesNotMatch(text, /\.workers\.dev/i);
  assert.doesNotMatch(text, /extend[^\n]*expir|expir[^\n]*extend/i, 'no claim about an unfinished expiry feature');
});

test('llms.txt stands alone without JavaScript and does not call the page machine-readable', () => {
  const text = read('public/llms.txt');
  const html = read('public/agent-setup.html');
  assert.doesNotMatch(text, /machine-readable setup prompt|machine readable setup prompt/i,
    'the prompt lives in a textarea filled by JS; llms.txt must not claim it is machine-readable');
  // Raw llms.txt carries its own runnable installation instructions.
  assert.match(text, /git clone "\$expected_origin"/);
  assert.match(text, /expected_origin="https:\/\/github\.com\/danmestas\/html-artifact-publisher\.git"/);
  assert.match(text, /mkdir -p "\$HOME\/\.claude\/skills"/);
  assert.match(text, /ln -s /);
  assert.match(text, /\[ -e "\$target" \] \|\| \[ -L "\$target" \]/);
  assert.match(text, /\$HOME\/tools\/html-artifact-publisher/);
  for (const skill of SKILLS) assert.ok(text.includes(skill), `llms.txt installs ${skill}`);
  // Its fallback clone block matches the JS-generated one, including the guard.
  assert.match(text, /\[ ! -d "\$checkout\/\.git" \]/);
  assert.match(text, /git -C "\$checkout" remote get-url origin/);
  assert.match(text, /Using existing checkout/);
  assert.match(text, /exists but is not a git checkout/);
  // The static HTML fallback block matches the generated skill list.
  const block = /<pre class="setup-code" id="clone-commands">([\s\S]*?)<\/pre>/.exec(html)[1];
  const listed = /for skill in ([^;]+);/.exec(block)[1].trim().split(/\s+/);
  assert.deepEqual(listed, SKILLS);
});

test('agent setup assets contain no hardcoded deployment hostname', () => {
  for (const path of ['public/agent-setup.html', 'public/agent-setup.js', 'public/agent-setup.css', 'public/llms.txt']) {
    assert.doesNotMatch(read(path), /workers\.dev/i, path);
  }
});

// The copyable examples run in a real shell. They must survive a rerun without
// cloning over (or pulling) a checkout the person already has, refuse an
// unexpected destination instead of overwriting it, create the skills directory,
// and link each skill without forcing.
test('clone and install commands are rerun-safe and never force an existing skill', () => {
  const commands = installCommands();
  assert.match(commands, /mkdir -p "\$HOME\/\.claude\/skills"/, 'destination is created');
  assert.doesNotMatch(commands, /cp -r/, 'no recursive copy that can overwrite a skill');
  assert.match(commands, /ln -s /, 'skills are symlinked into place');
  assert.doesNotMatch(commands, /ln -[a-z]*f/, 'never force a symlink');
  for (const skill of ['publish-html-page', 'artifact-design', 'artifact-runtime', 'artifact-diagrams', 'artifact-dataviz', 'pikchr']) {
    assert.ok(commands.includes(skill), `links ${skill}`);
  }
  assert.match(commands, /skip/i, 'reports what was left alone');
  assert.match(commands, /continue/, 'a skipped skill does not stop the loop');
  assert.match(commands, /\[ -e "\$target" \] \|\| \[ -L "\$target" \]/, 'tests existence including dangling symlinks');
  // The clone is guarded: never repeated, never pulled, never made over an
  // unexpected destination.
  const clone = commands.match(/^\s*git clone .*$/gm) ?? [];
  assert.equal(clone.length, 1, 'exactly one clone invocation');
  assert.match(commands, /if \[ -e "\$checkout" \] \|\| \[ -L "\$checkout" \]/, 'an existing destination is checked');
  assert.doesNotMatch(commands, /git (pull|fetch|reset|clean)\b/, 'a user checkout is never modified');
  assert.match(commands, /git -C "\$checkout" remote get-url origin/, 'the existing origin is verified');
  assert.match(commands, /\$expected_origin/, 'against this repository');
  for (const required of ['scripts/publish-html.mjs', 'public', 'skills/publish-html-page']) {
    assert.ok(commands.includes(`$checkout/$required`), `validates ${required} before reuse`);
  }
  assert.match(commands, /is a git checkout of/, 'an unrelated repository is an explicit error');
  assert.match(commands, /is missing/, 'an incomplete checkout is an explicit error');
  assert.match(commands, /exists but is not a git checkout/, 'an unexpected destination is an explicit error');
  assert.equal((commands.match(/exit 1/g) || []).length, 3, 'every refusal stops the block');
});

// Run the exact copied block, clone line included, against a local git fixture
// redirected with url.insteadOf, so git's real semantics are exercised.
test('the full copied block clones once, preserves existing entries and refuses an unexpected destination', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, lstatSync, readlinkSync, existsSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { spawnSync, execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'agent-setup-install-'));
  const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', HOME: dir, ...opts.env }, ...opts });
  try {
    // The upstream repository, as a local fixture: skills plus the CLI.
    const fixture = join(dir, 'fixture');
    for (const skill of SKILLS) {
      mkdirSync(join(fixture, 'skills', skill), { recursive: true });
      writeFileSync(join(fixture, 'skills', skill, 'SKILL.md'), skill);
    }
    mkdirSync(join(fixture, 'scripts'), { recursive: true });
    writeFileSync(join(fixture, 'scripts', 'publish-html.mjs'), '#!/usr/bin/env node\n');
    mkdirSync(join(fixture, 'public'), { recursive: true });
    writeFileSync(join(fixture, 'public', 'client.js'), '// fixture\n');
    git(['init', '-q', '-b', 'main', fixture]);
    git(['-C', fixture, 'add', '-A']);
    git(['-C', fixture, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);

    // Every clone of the GitHub URL lands on the fixture instead of the network.
    writeFileSync(join(dir, 'gitconfig'), `[url "file://${fixture}"]\n\tinsteadOf = ${REPO}.git\n\tinsteadOf = ${REPO}\n[protocol "file"]\n\tallow = always\n`);

    const home = join(dir, 'home');
    const checkout = join(home, 'tools', 'html-artifact-publisher');
    const run = script => spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });

    // First run: clones, then links every skill. The people's HOME starts empty.
    mkdirSync(home, { recursive: true });
    const first = run(installCommands());
    assert.equal(first.status, 0, first.stderr);
    assert.equal(existsSync(join(checkout, '.git')), true, 'the checkout was cloned');
    assert.equal((first.stdout.match(/^Linked /gm) || []).length, SKILLS.length);
    for (const skill of SKILLS) {
      const target = join(home, '.claude', 'skills', skill);
      assert.equal(lstatSync(target).isSymbolicLink(), true, `${skill} is a symlink`);
      assert.equal(readlinkSync(target), join(checkout, 'skills', skill));
    }
    // The redirect stores the fixture as origin; a real clone stores the GitHub
    // URL the block validates against on a rerun. Drop the redirect too, since
    // insteadOf also rewrites what `git remote get-url` reports.
    git(['-C', checkout, 'remote', 'set-url', 'origin', REPO_GIT]);
    writeFileSync(join(dir, 'gitconfig'), '');

    // Seed destinations that must survive a rerun unchanged.
    const skillsDir = join(home, '.claude', 'skills');
    const runtime = join(skillsDir, 'artifact-runtime');
    rmSync(runtime, { recursive: true, force: true });
    mkdirSync(runtime);
    writeFileSync(join(runtime, 'SKILL.md'), 'mine');
    rmSync(join(skillsDir, 'pikchr'));
    symlinkSync(join(dir, 'missing-target'), join(skillsDir, 'pikchr'));
    writeFileSync(join(skillsDir, 'unrelated.txt'), 'keep');
    const headBefore = git(['-C', checkout, 'rev-parse', 'HEAD']).trim();
    writeFileSync(join(checkout, 'local-only.txt'), 'do not touch');

    // Rerun: the existing valid checkout is used, never cloned over or pulled.
    const second = run(installCommands());
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Using existing checkout/);
    assert.equal((second.stdout.match(/^Skipped /gm) || []).length, SKILLS.length, 'every skill is skipped');
    assert.equal(readFileSync(join(runtime, 'SKILL.md'), 'utf8'), 'mine', 'existing skill files are untouched');
    assert.equal(lstatSync(join(skillsDir, 'pikchr')).isSymbolicLink(), true, 'a dangling symlink survives');
    assert.equal(readFileSync(join(skillsDir, 'unrelated.txt'), 'utf8'), 'keep');
    assert.equal(readFileSync(join(checkout, 'local-only.txt'), 'utf8'), 'do not touch', 'the checkout is never modified');
    assert.equal(git(['-C', checkout, 'rev-parse', 'HEAD']).trim(), headBefore, 'the checkout is not pulled');

    // An unexpected destination is a safe, explicit failure — nothing overwritten.
    const otherHome = join(dir, 'other-home');
    const occupied = join(otherHome, 'tools', 'html-artifact-publisher');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'precious.txt'), 'never overwrite');
    const blocked = run(installCommands().replaceAll('$HOME', otherHome));
    assert.notEqual(blocked.status, 0, 'an occupied destination is a failure, not a merge');
    assert.match(blocked.stderr, /exists but is not a git checkout/);
    assert.equal(readFileSync(join(occupied, 'precious.txt'), 'utf8'), 'never overwrite');

    // A real, unrelated git repository at the destination is refused untouched.
    const unrelatedHome = join(dir, 'unrelated-home');
    const unrelated = join(unrelatedHome, 'tools', 'html-artifact-publisher');
    mkdirSync(unrelated, { recursive: true });
    git(['init', '-q', '-b', 'main', unrelated]);
    git(['-C', unrelated, 'remote', 'add', 'origin', 'https://example.test/not-this-repo.git']);
    writeFileSync(join(unrelated, 'unrelated.txt'), 'keep');
    const refused = run(installCommands().replaceAll('$HOME', unrelatedHome));
    assert.notEqual(refused.status, 0, 'an unrelated repository is refused');
    assert.match(refused.stderr, /is a git checkout of https:\/\/example\.test\/not-this-repo\.git/);
    assert.equal(readFileSync(join(unrelated, 'unrelated.txt'), 'utf8'), 'keep', 'the unrelated repository is untouched');

    // A checkout of this repository that lost the CLI or assets is refused.
    const incompleteHome = join(dir, 'incomplete-home');
    const incomplete = join(incompleteHome, 'tools', 'html-artifact-publisher');
    mkdirSync(join(incomplete, 'skills', 'publish-html-page'), { recursive: true });
    git(['init', '-q', '-b', 'main', incomplete]);
    git(['-C', incomplete, 'remote', 'add', 'origin', REPO_GIT]);
    writeFileSync(join(incomplete, 'marker.txt'), 'keep');
    const incompleteRun = run(installCommands().replaceAll('$HOME', incompleteHome));
    assert.notEqual(incompleteRun.status, 0, 'an incomplete checkout is refused');
    assert.match(incompleteRun.stderr, /is missing (scripts\/publish-html\.mjs|public)/);
    assert.equal(readFileSync(join(incomplete, 'marker.txt'), 'utf8'), 'keep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the DOM-driven page lists the same skills as the generated commands', () => {
  const html = read('public/agent-setup.html');
  const block = /<pre class="setup-code" id="clone-commands">([\s\S]*?)<\/pre>/.exec(html)[1];
  const listed = /for skill in ([^;]+);/.exec(block)[1].trim().split(/\s+/);
  assert.deepEqual(listed, SKILLS);
  assert.doesNotMatch(html, /The installer downloads/, 'the download is a source bundle, not an installer');
  assert.match(html, /The download contains/);
});

test('every copyable command block is exactly the generated one, so static fallbacks cannot drift', () => {
  const generated = installCommands().trim();
  const unescape = s => s.replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&').trim();
  const html = read('public/agent-setup.html');
  const staticBlock = /<pre class="setup-code" id="clone-commands">([\s\S]*?)<\/pre>/.exec(html)[1];
  assert.equal(unescape(staticBlock), generated, 'the no-JS page block matches');
  const llms = read('public/llms.txt');
  const llmsBlock = /```bash\n(set -e\n[\s\S]*?)\n```/.exec(llms)[1];
  assert.equal(llmsBlock.trim(), generated, 'the llms.txt block matches');
  const resolver = /<pre class="setup-code" id="checkout-resolver">([\s\S]*?)<\/pre>/.exec(html)[1];
  assert.equal(unescape(resolver), CHECKOUT_RESOLVER.trim(), 'the resolver block matches');
});

test('the page has no dead status hooks and its shell examples use valid quoted placeholders', () => {
  const html = read('public/agent-setup.html');
  const source = read('public/agent-setup.js');
  const copyTargets = [...html.matchAll(/data-copy="([^"]+)"/g)].map(m => m[1]);
  assert.ok(copyTargets.length >= 3);
  for (const id of copyTargets) assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
  // A status hook is only valid when the handler can find it inside the same
  // action group; the handler resolves by role, so no dead attribute remains.
  assert.doesNotMatch(html, /data-copy-status/, 'dead data-copy-status attributes removed');
  assert.equal((html.match(/role="status" aria-live="polite"/g) || []).length, copyTargets.length, 'one status per copy control');
  assert.match(source, /closest\('\.setup-actions'\)\?\.querySelector\('\[role="status"\]'\)/);
  // Bare <placeholder> words are shell redirections, not values.
  for (const [name, text] of [['llms.txt', read('public/llms.txt')], ['agent-setup.html', html]]) {
    const shellBlocks = [...text.matchAll(/```bash\n([\s\S]*?)```|<pre class="setup-code"[^>]*>([\s\S]*?)<\/pre>/g)].map(m => m[1] ?? m[2]);
    for (const block of shellBlocks) {
      assert.doesNotMatch(block.replaceAll('&lt;', '<').replaceAll('&gt;', '>'), /(^|\s)<[a-z][a-z-]*(?:-[a-z]+)*>/m, `${name}: no bare <placeholder> in shell`);
    }
    assert.doesNotMatch(text, /<read-or-edit-url>/, `${name}: quoted placeholders only`);
  }
});

test('installed skills resolve the retained checkout explicitly', () => {
  const publishing = read('skills/publish-html-page/SKILL.md');
  const runtime = read('skills/artifact-runtime/SKILL.md');
  for (const text of [publishing, runtime]) {
    assert.match(text, /retained checkout|checkout/i);
    assert.match(text, /readlink -f/, 'shows how to resolve an installed symlink');
    assert.match(text, /absolute/i, 'uses absolute CLI and artifact paths');
    assert.match(text, /working directory|cwd/, 'names the working-directory contract');
    assert.match(text, /COPIED skill|installed as a cop|copy/i, 'distinguishes a copied skill');
    assert.match(text, /HTML_PUBLISHER_CHECKOUT/, 'requires an explicit checkout for copied installs');
  }
  assert.match(publishing, /node "\$CHECKOUT\/scripts\/publish-html\.mjs"|\$CLI/, 'invokes the CLI by retained absolute path');
  assert.match(publishing, /cd "\$CHECKOUT"/, 'or changes into the checkout');
});

// Exercised in an isolated HOME against a local fixture checkout: a symlinked
// skill resolves to the checkout; a copied skill never infers one and requires
// HTML_PUBLISHER_CHECKOUT; a wrong or missing value fails instead of guessing.
test('checkout resolver handles symlinked and copied skill installs without guessing', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-setup-resolve-')));
  try {
    const checkout = join(dir, 'tools', 'html-artifact-publisher');
    mkdirSync(join(checkout, 'scripts'), { recursive: true });
    writeFileSync(join(checkout, 'scripts', 'publish-html.mjs'), '// fixture\n');
    mkdirSync(join(checkout, 'public'), { recursive: true });
    mkdirSync(join(checkout, 'skills', 'publish-html-page'), { recursive: true });
    writeFileSync(join(checkout, 'skills', 'publish-html-page', 'SKILL.md'), 'fixture');

    const home = join(dir, 'home');
    const skills = join(home, '.claude', 'skills');
    mkdirSync(skills, { recursive: true });
    const run = env => spawnSync('sh', ['-c', CHECKOUT_RESOLVER], { encoding: 'utf8', env: { ...process.env, HOME: home, ...env } });

    // Symlinked skill: resolves to the checkout and validates required files.
    symlinkSync(join(checkout, 'skills', 'publish-html-page'), join(skills, 'publish-html-page'));
    const linked = run({});
    assert.equal(linked.status, 0, linked.stderr);
    assert.equal(linked.stdout.trim(), checkout);

    // Symlinked skill pointing somewhere that is not a checkout is not used.
    rmSync(join(skills, 'publish-html-page'));
    const bogus = join(dir, 'bogus', 'skills', 'publish-html-page');
    mkdirSync(bogus, { recursive: true });
    symlinkSync(bogus, join(skills, 'publish-html-page'));
    const bad = run({});
    assert.notEqual(bad.status, 0, 'an invalid symlink target is refused');
    assert.doesNotMatch(bad.stdout, new RegExp(join(dir, 'bogus').replaceAll('/', '\\/')), 'never prints an unvalidated path');

    // Copied skill: readlink resolves to the skill directory itself, so nothing
    // is inferred from it — not ~/.claude, not the skills folder.
    rmSync(join(skills, 'publish-html-page'));
    mkdirSync(join(skills, 'publish-html-page'));
    writeFileSync(join(skills, 'publish-html-page', 'SKILL.md'), 'copied');
    const copiedWithout = run({});
    assert.notEqual(copiedWithout.status, 0, 'a copied skill requires an explicit checkout');
    assert.match(copiedWithout.stderr, /HTML_PUBLISHER_CHECKOUT/);
    assert.equal(copiedWithout.stdout.trim(), '', 'never prints an inferred path');

    // The explicit retained checkout is used after validation.
    const copiedWith = run({ HTML_PUBLISHER_CHECKOUT: checkout });
    assert.equal(copiedWith.status, 0, copiedWith.stderr);
    assert.equal(copiedWith.stdout.trim(), checkout);
    const copiedWrong = run({ HTML_PUBLISHER_CHECKOUT: join(dir, 'nope') });
    assert.notEqual(copiedWrong.status, 0, 'an unvalidated explicit checkout is refused');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the resolver block is in llms.txt and the page, and the prompt names the contract', () => {
  const unescape = s => s.replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&').trim();
  const llms = read('public/llms.txt');
  assert.ok(llms.includes(CHECKOUT_RESOLVER.trim()), 'llms.txt carries the runnable resolver');
  assert.match(llms, /HTML_PUBLISHER_CHECKOUT/);
  const prompt = installPrompt('https://artifacts.example.test');
  assert.match(prompt, /readlink -f/);
  assert.match(prompt, /COPIED skill|do not infer/i);
  assert.match(prompt, /stop and tell me|rather than guessing/i);
  assert.match(unescape(read('public/agent-setup.html')), /HTML_PUBLISHER_CHECKOUT/);
});

test('the CLI runs from an unrelated working directory through its own checkout path', async () => {
  const { spawnSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const cli = new URL('../scripts/publish-html.mjs', import.meta.url).pathname;
  const run = spawnSync(process.execPath, [cli, '--help'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Usage:/);
});

test('env example quotes every placeholder and carries the instance origin', async () => {
  const origin = 'https://artifacts.example.test';
  const example = envExample(origin);
  assert.ok(example.includes(`HTML_PUBLISHER_URL="${origin}"`), 'origin is a quoted value');
  assert.match(example, /HTML_PUBLISHER_TOKEN="[^"<]+"/, 'token placeholder is a quoted token-shaped value');
  assert.doesNotMatch(example, /[=<"]<[A-Za-z][^>]*>/, 'no bare <placeholder> after =');
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync('sh', ['-n', '-c', example], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
