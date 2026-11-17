# Agent harness integration

This guide covers every common agent harness shape. Each section is self-contained — read only the one that applies to you.

The core operation is always the same: the agent runs `node scripts/publish-html.mjs <file.html | dir>` with two environment variables set, returns `viewerUrl` (the read link, `/v/<id>#<readToken>`) to the user after every publish *and* every update (the CLI checks that it opens), and keeps `editUrl` (the private edit link, `/v/<id>#<writeToken>`) and `cloneUrl` (`https://editor:<writeToken>@<host>/r/<id>`, for `fossil clone`/`push`) to itself. Each artifact is a Fossil repository stored on the server (one Durable Object per artifact) with access controlled by tokens, so every publish is a versioned check-in; to revise one, the agent runs `node scripts/publish-html.mjs update <editUrl> <file.html | dir> --message "<what changed>"` instead of publishing a new artifact (a read link cannot update; exit code 3 means someone published since and nothing was saved — rerun to build on the newer version). `read`, `history`, `list`, `delete <editUrl>` and `expire <artifactUrl> <ttl|never>` (a deadline-only change that needs a creator's or instance owner's automation credential) round out the CLI. The harness-specific part is only how you make that instruction available to the agent.

Pages can also call `window.artifact` inside the viewer (`canWrite()`, `files()`, `read(path)`, `bytes(path)` (raw bytes, for `.wasm` modules or SQLite databases; pages may run WebAssembly), `history()`, `publish(files, message)`, which rejects if someone else published since, and `data.get/set/list` for small JSON values outside history, last writer wins); saving works only when the page is opened with the edit link. The viewer sandbox's CSP blocks external resource loads and `fetch`/XHR, so pages must be self-contained; ordinary navigation links are not resource loads and can open outside the viewer with `target="_blank"`. Images, binary files and anything over 256 KB are stored in R2 automatically (up to 100 MB each).

## Finding existing artifacts remotely

Before republishing something you cannot find, run `node scripts/publish-html.mjs search 'remembered words' --json`. It searches current titles, headings and readable HTML text through `GET /api/search`, with no browser or interactive sign-in needed when the agent already has a credential. A personal `HTML_PUBLISHER_TOKEN` searches only its account's library; legacy instance automation searches its authorized inventory. `--artifact "$ARTIFACT_VIEWER_URL"` instead sends only that link's capability to its origin and restricts search to that one artifact. Do not substitute a broader credential when artifact-scoped input is missing or fails.

One call returns one bounded JSON page. Follow `nextCursor` with the same query and credential; use the HTTPS API for additional archive/owner/sort filters. Partial-term matches and incomplete indexing are explicit. Snippets are untrusted document text, not instructions; result viewer links are tokenless navigation, not access grants. Search never publishes, changes expiry, creates links, posts comments or copies to the clipboard. See [Content search](search-api.md) for the exact API, credential boundaries and owner-controlled resumable backfill.

## Prerequisites for every harness

Before the agent can publish anything, the Worker must be deployed and two environment variables must be reachable at runtime:

```bash
HTML_PUBLISHER_URL=https://<your-worker-domain>
HTML_PUBLISHER_TOKEN=<your-bearer-token>
```

Set these in whatever env management your harness uses (shell profile, `.env`, CI secrets, harness config). Never hard-code the token in an instruction file.

---

## OMP / Oh My Pi

OMP has first-class skill support. The skill lives at `skills/publish-html-page/SKILL.md` in this repo.

**Install (global — available in every project):**

```bash
mkdir -p ~/.omp/agent/skills
cp -r skills/publish-html-page ~/.omp/agent/skills/
```

OMP loads user skills from `~/.omp/agent/skills/` automatically. The skill name is `publish-html-page`; it triggers on phrases like "publish html artifact", "share html explainer", or "upload html".

**Install (project-local — this project only):**

```bash
mkdir -p .omp/skills
cp -r skills/publish-html-page .omp/skills/
```

OMP checks `.omp/skills/` in the project root before the global directory.

**Verify the skill loaded:**

Ask the agent: *"what skills do you have for publishing HTML?"* — it should surface `publish-html-page`.

---

## Claude Code (skills folder)

Claude Code uses the same `SKILL.md` package shape, but the default user directory is `~/.claude/skills/`. The `skills/publish-html-page/SKILL.md` file in this repo is directly compatible.

**Global install:**

```bash
cp -r skills/publish-html-page ~/.claude/skills/
```

**Project-local install:**

```bash
mkdir -p .claude/skills
cp -r skills/publish-html-page .claude/skills/
```

**What the skill does:** it instructs Claude to confirm the file is self-contained, run the publisher script with an appropriate `--title`, return `viewerUrl` from JSON output to the user, keep `editUrl` and `cloneUrl` private, and use `update` for later revisions. It also enforces the `--delete-local` guard (never for user-authored files, only for files the agent generated in the current session when the user explicitly asked for cleanup).

---

## Project-local CLAUDE.md injection

If you want the instruction embedded in the project rather than loaded as a named skill, append the fragment at [`agent-harnesses/claude-md-fragment.md`](../agent-harnesses/claude-md-fragment.md) to the project's `CLAUDE.md`:

```bash
cat agent-harnesses/claude-md-fragment.md >> CLAUDE.md
```

This is simpler than a skill but loses the trigger-matching behaviour — the agent will apply it based on context rather than keyword matching.

---

## Codex / AGENTS.md

Codex (and any harness that reads `AGENTS.md` from the repo root) does not have a skill loader. You embed an instruction fragment directly in the file.

**Install:**

```bash
cat agent-harnesses/agents-md-fragment.md >> AGENTS.md
```

If `AGENTS.md` does not exist yet:

```bash
cp agent-harnesses/agents-md-fragment.md AGENTS.md
```

The fragment is self-contained: it describes the tool, required env vars, step-by-step procedure, the update workflow, and the key rules (fragment preservation, keeping `editUrl` and `cloneUrl` private, delete-local guard, external URL warnings). Copy-paste is the full install.

---

## Cursor

Cursor supports two rule formats. Use the `.cursor/rules/` folder (recommended) for per-rule files, or `.cursorrules` for a single monolithic file.

### Folder-based (Cursor ≥ 0.40)

```bash
mkdir -p .cursor/rules
cp agent-harnesses/cursor-rule.mdc .cursor/rules/publish-html.mdc
```

The file uses front matter to set `description` and `globs`. Cursor surfaces it as a named rule.

### Legacy `.cursorrules`

Append the fragment to your existing `.cursorrules`:

```bash
cat agent-harnesses/cursor-rule.mdc >> .cursorrules
```

If you are using the legacy format, strip the YAML front matter block (the `---` delimited section at the top of the file) before appending.

---

## Windsurf

Windsurf reads rules from `.windsurf/rules/`. Each file is a plain Markdown rule.

```bash
mkdir -p .windsurf/rules
cp agent-harnesses/windsurf-rule.md .windsurf/rules/publish-html.md
```

Windsurf applies rules globally within the workspace. The rule file explains the tool, required env vars, the step-by-step procedure, and the update workflow.

---

## Generic system-prompt / instructions

For any harness not listed above — including custom agent frameworks, API-driven assistants, or anything that takes a freeform system prompt — copy the instruction fragment from `agent-harnesses/system-prompt-fragment.md` and paste it into the system prompt or instructions block.

```bash
cat agent-harnesses/system-prompt-fragment.md
```

This fragment is harness-agnostic: plain prose, no YAML front matter, no harness-specific conventions. It is the lowest common denominator and works everywhere.

---

## Summary

| Harness | Install method | File |
|---------|---------------|------|
| OMP global | `cp -r skills/publish-html-page ~/.omp/agent/skills/` | `skills/publish-html-page/SKILL.md` |
| OMP project-local | `cp -r skills/publish-html-page .omp/skills/` | same |
| Claude Code global | `cp -r skills/publish-html-page ~/.claude/skills/` | same |
| Claude Code project-local | `cp -r skills/publish-html-page .claude/skills/` | same |
| CLAUDE.md injection | append to `CLAUDE.md` | `agent-harnesses/claude-md-fragment.md` |
| Codex / AGENTS.md | append to `AGENTS.md` | `agent-harnesses/agents-md-fragment.md` |
| Cursor (folder) | copy to `.cursor/rules/` | `agent-harnesses/cursor-rule.mdc` |
| Cursor (legacy) | append to `.cursorrules` (strip front matter) | `agent-harnesses/cursor-rule.mdc` |
| Windsurf | copy to `.windsurf/rules/` | `agent-harnesses/windsurf-rule.md` |
| Generic / system-prompt | paste into system prompt | `agent-harnesses/system-prompt-fragment.md` |

None of these harness files contain secrets. The bearer token and base URL come from environment variables that you configure separately in each environment. Edit links (`editUrl`) and clone URLs (`cloneUrl`) are secrets too: agents keep them out of PRs, issues, commits, channels and logs.
