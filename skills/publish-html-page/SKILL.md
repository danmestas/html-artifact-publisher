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

Publish a self-contained HTML file (or a directory of files) to a shareable,
encrypted URL at the configured `HTML_PUBLISHER_URL`. Each artifact is an
encrypted Fossil repository: every publish or update is a check-in, so the
artifact keeps its version history. Metadata such as title, expiry, and slug
remains plaintext. The decryption key lives exclusively in the URL fragment and
never reaches the server.

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

1. Confirm the HTML file starts with `<!doctype html` or `<html`.
2. Run the script with `--title` matching the artifact's purpose.
3. Capture `viewerUrl` and `editUrl` from the output. `viewerUrl` is the
   complete read link (key is in the `#fragment`; do not strip it). In human
   mode it is also copied to clipboard automatically.
4. Return `viewerUrl` to the user. Keep `editUrl` to yourself for later
   updates.
5. To revise the artifact, run `update <editUrl> <file|dir> --message "<what changed>"`.
   This adds a new version at the same URL; do not publish a new artifact for
   every revision. Exit code 3 means a version conflict (someone saved since);
   nothing was saved — `read` the latest version, reapply your change, and retry.
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
- The `editUrl` (`…#<key>.<writeToken>`) can update and delete the artifact
  (`delete <editUrl>`). Keep it private: never print it into public places
  (chat channels, PRs, issues, commits, logs). Give it to the user only if
  they ask or need to edit or revoke the artifact themselves.
- Clipboard copy is best-effort and non-fatal. Do not add `--no-clipboard`
  unless the user or environment explicitly requires it.
- When running in a headless or non-interactive environment without a display
  server, clipboard will silently fall back to "unavailable" — this is expected.

## Page API

Inside the viewer, pages can use `window.artifact`: `canWrite()`, `files()`,
`read(path)`, `history()`, `publish(files, message)` (a new check-in; rejects
on conflict), and `data.get/set/list` (small JSON page data; last writer
wins). Saving works only when the page was opened with the edit link.

## Success output

```json
{
  "id": "abc123",
  "viewerUrl": "https://artifacts.example.com/v/abc123#<key>",
  "editUrl":   "https://artifacts.example.com/v/abc123#<key>.<writeToken>",
  "checkin":   "5f1c2e…",
  "expiresAt": "2026-07-23T00:00:00.000Z",
  "warnings": 0,
  "warningMessages": []
}
```

Share only `viewerUrl`. Keep `editUrl` for `update`; do not log or expose it
unless the user needs it. `update` prints the same shape without `editUrl`
or `expiresAt`.
