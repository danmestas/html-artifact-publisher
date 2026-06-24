# Agent harness integration

This guide covers every common agent harness shape. Each section is self-contained — read only the one that applies to you.

The core operation is always the same: the agent runs `node scripts/publish-html.mjs <file.html>` with two environment variables set, captures `viewerUrl` from the output, and returns it to the user. The harness-specific part is only how you make that instruction available to the agent.

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

**What the skill does:** it instructs Claude to confirm the file is self-contained, run the publisher script with an appropriate `--title`, capture `viewerUrl` from JSON output, and return it to the user. It also enforces the `--delete-local` guard (never for user-authored files, only for files the agent generated in the current session when the user explicitly asked for cleanup).

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

The fragment is self-contained: it describes the tool, required env vars, step-by-step procedure, and the key rules (fragment preservation, delete-local guard, external URL warnings). Copy-paste is the full install.

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

Windsurf applies rules globally within the workspace. The rule file explains the tool, required env vars, and the step-by-step procedure.

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

None of these harness files contain secrets. The bearer token and base URL come from environment variables that you configure separately in each environment.
