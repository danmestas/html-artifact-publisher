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

Publish a self-contained HTML file to a shareable, encrypted URL at the
configured `HTML_PUBLISHER_URL`. The Worker stores encrypted HTML payloads;
metadata such as title, source name, expiry, and slug remains plaintext. The
decryption key lives exclusively in the URL fragment and never reaches the server.

## When to use

After generating a standalone HTML explainer or artifact file. Confirm the
file is fully self-contained (assets inlined, no CDN deps preferred) before
uploading.

## CLI reference

```bash
node scripts/publish-html.mjs [options] <file.html>

  --title <text>     Human-readable title (default: filename)
  --ttl <duration>   1h | 6h | 24h | 7d | 30d | never  (default: 7d)
  --slug <slug>      Optional vanity slug
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

Environment (must be set before running):
- `HTML_PUBLISHER_URL`   — Worker base URL, e.g. `https://artifacts.example.com`
- `HTML_PUBLISHER_TOKEN` — API bearer token

## Step-by-step

1. Confirm the HTML file starts with `<!doctype html` or `<html`.
2. Run the script with `--title` matching the artifact's purpose.
3. Capture `viewerUrl` from the output — this is the complete share link
   (key is in the `#fragment`; do not strip it). In human mode the URL is
   also copied to clipboard automatically.
4. Return `viewerUrl` to the user.
5. Add `--delete-local` only when you generated the file in this session and
   the user explicitly wants it cleaned up. Verify upload succeeded first
   (the script enforces this, but never bypass it).
6. When running as an agent and collecting the URL programmatically, use
   `--json` (omit `--copy`). Parse `viewerUrl` from the JSON; ignore stderr.

## Rules

- NEVER pass `--delete-local` for user-authored files, source documents, or
  files you did not create in the current generation step.
- NEVER attempt to delete the file manually before upload completes.
- ALWAYS surface external-URL warnings to the user — in `--json` mode these
  are listed under `warningMessages`; they mean the artifact may not render offline and could leak referrer data.
- If upload fails (non-2xx or network error), leave the file untouched and
  report the error verbatim.
- The `deleteToken` in the response is proof of ownership for later deletion
  (`DELETE /api/pages/<id>` with `X-Delete-Token: <token>`). Provide it to
  the user if they may need to revoke early.
- Clipboard copy is best-effort and non-fatal. Do not add `--no-clipboard`
  unless the user or environment explicitly requires it.
- When running in a headless or non-interactive environment without a display
  server, clipboard will silently fall back to "unavailable" — this is expected.

## Success output

```json
{
  "id": "abc123",
  "viewerUrl": "https://artifacts.example.com/v/abc123#<base64url-key>",
  "blobUrl":   "https://artifacts.example.com/blob/abc123",
  "expiresAt": "2026-07-23T00:00:00.000Z",
  "deleteToken": "deadbeef…",
  "warnings": 0,
  "warningMessages": []
}
```

Share only `viewerUrl`. Do not log or expose `deleteToken` unless the user
needs it.
