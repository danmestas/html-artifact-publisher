---
name: publish-html-page
version: 1.0.0
triggers:
  - publish html artifact
  - share html explainer
  - upload html to an artifact publisher
  - generate and share html
env_required:
  - HTML_PUBLISHER_URL
  - HTML_PUBLISHER_TOKEN
---

# publish-html-page

Publish a self-contained HTML file (or a directory of files) to a shareable
URL at the configured `HTML_PUBLISHER_URL`. Each artifact is a Fossil
repository stored on the server (one Durable Object per artifact): every
publish or update is a check-in, so the artifact keeps its version history.
Content is not encrypted; access is controlled by tokens carried in the URL
fragment — a read token for viewers and a write token for editors.

## When to use

After generating a standalone HTML explainer or artifact file. Confirm the
file is fully self-contained (assets inlined, no CDN deps) before uploading:
the viewer blocks all network requests, so external URLs will not load. To
revise an artifact you already published, update it instead of publishing a
new one.

## CLI reference

```bash
node scripts/publish-html.mjs [publish] [options] <file.html | dir>
node scripts/publish-html.mjs update <edit-url> <file.html | dir> [--message <text>] [--title <text>]
node scripts/publish-html.mjs read <url> [--out <dir>]    # URL may end in @<check-in>
node scripts/publish-html.mjs history <url>
node scripts/publish-html.mjs list
node scripts/publish-html.mjs delete <edit-url>

  --title <text>     Human-readable title (default: filename)
  --ttl <duration>   1h | 6h | 24h | 7d | 30d | never  (default: 7d)
  --slug <slug>      Optional vanity slug
  --message <text>   Check-in comment (default: "Publish <name>" / "Update <name>")
  --delete-local     Delete local HTML ONLY after confirmed successful upload
  --json             Machine-readable JSON output only (no friendly output)
  --copy             Copy viewer URL to clipboard even with --json
  --no-clipboard     Never attempt to copy the viewer URL to clipboard
  --help             Show full usage
```

Clipboard behavior:
- **Human mode** (no `--json`): viewer URL is copied to clipboard automatically after upload.
  Prints `Copied to clipboard` on success or `Clipboard unavailable` if no tool was found.
- **Machine mode** (`--json`): clipboard is skipped by default. Add `--copy` to opt in;
  the clipboard note then goes to **stderr** so stdout remains clean JSON.
- `--no-clipboard` suppresses clipboard in any mode.
- Clipboard failure is non-fatal — the upload is already complete and exit code is unaffected.
- Platform tools used: `pbcopy` (macOS), `clip` (Windows), then `wl-copy` / `xclip` / `xsel` in order (Linux).

A single file is stored as `index.html`; a directory is published as-is as a
multi-file page (it needs an `index.html` or another `.html` file). Updating
with a directory adds and changes files; files missing from it are kept.

Environment (must be set before running):
- `HTML_PUBLISHER_URL`   — Worker base URL, e.g. `https://artifacts.example.com`
- `HTML_PUBLISHER_TOKEN` — API bearer token

## Step-by-step

1. Confirm the HTML file starts with `<!doctype html` or `<html`. Files whose
   compressed size exceeds about 1.99 MB are refused ("too large to store").
2. Run the script with `--title` matching the artifact's purpose.
3. Capture `viewerUrl` and `editUrl` from the output. `viewerUrl` is the
   complete read link (the read token is in the `#fragment`; do not strip it).
   In human mode it is also copied to clipboard automatically.
4. Return `viewerUrl` to the user. Keep `editUrl` (and `cloneUrl`) to
   yourself for later updates.
5. To revise the artifact, run `update <editUrl> <file|dir> --message "<what changed>"`.
   This adds a new version at the same URL; do not publish a new artifact for
   every revision. A read link cannot update. Exit code 3 means a version
   conflict (someone published since); nothing was saved — rerun to build on the
   newer version (`read` it first if your change depends on it). Exit code 1
   with "nothing changed" means your files already match the latest version.
6. Add `--delete-local` only when you generated the file in this session and
   the user explicitly wants it cleaned up. Verify upload succeeded first
   (the script enforces this, but never bypass it).
7. When running as an agent and collecting the URL programmatically, use
   `--json` (omit `--copy`). Parse `viewerUrl` and `editUrl` from the JSON; ignore stderr.

## Rules

- NEVER pass `--delete-local` for user-authored files, source documents, or
  files you did not create in the current generation step.
- NEVER attempt to delete the file manually before upload completes.
- ALWAYS surface external-URL warnings to the user — in `--json` mode these
  are listed under `warningMessages`; the viewer blocks network requests, so
  those resources will not load.
- If upload fails (non-2xx or network error), leave the file untouched and
  report the error verbatim.
- The `editUrl` (`…/v/<id>#<writeToken>`) can update and delete the artifact
  (`delete <editUrl>`), and `cloneUrl` (`https://editor:<writeToken>@<host>/r/<id>`)
  works with `fossil clone`/`push`. Keep both private: never print them into
  public places (chat channels, PRs, issues, commits, logs). Give them to the
  user only if they ask or need to edit or revoke the artifact themselves.
- Clipboard copy is best-effort and non-fatal. Do not add `--no-clipboard`
  unless the user or environment explicitly requires it.
- When running in a headless or non-interactive environment without a display
  server, clipboard will silently fall back to "unavailable" — this is expected.

## Page API

Inside the viewer, pages can use `window.artifact`: `canWrite()`, `files()`,
`read(path)`, `history()`, `publish(files, message)` (a new check-in; rejects
if someone else published since — calling again builds on the new tip), and
`data.get/set/list` (small JSON values kept outside history; last writer
wins). Saving works only when the page was opened with the edit link.

## Success output

```json
{
  "id": "abc123",
  "viewerUrl": "https://artifacts.example.com/v/abc123#<readToken>",
  "editUrl":   "https://artifacts.example.com/v/abc123#<writeToken>",
  "cloneUrl":  "https://editor:<writeToken>@artifacts.example.com/r/abc123",
  "checkin":   "5f1c2e…",
  "expiresAt": "2026-07-23T00:00:00.000Z",
  "warnings": 0,
  "warningMessages": []
}
```

Tokens are 64 hex characters; a link may end in `@<check-in>` to select a
version. Share only `viewerUrl`. Keep `editUrl` for `update` and `cloneUrl`
for Fossil; do not log or expose them unless the user needs them. `update`
prints `{id, viewerUrl, checkin, warnings, warningMessages}`.

## Related skills

Load these before writing the page itself:

- `skills/artifact-design` — page contract (CSP, sandbox, theme), layout and typography.
- `skills/artifact-runtime` — `window.artifact`: saved data, self-editing pages, history, waking the agent.
- `skills/artifact-diagrams` — when a diagram is worth it and what it should show.
- `skills/pikchr` — drawing it: Pikchr source, `render.mjs`, polishing in Pikchr Studio.
- `skills/artifact-dataviz` — charts, palette and `check-contrast.mjs`.
