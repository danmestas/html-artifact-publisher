## Publishing HTML artifacts

When the user asks you to publish, share, or upload an HTML file or explainer, use the publisher script in this repo.

### Required environment variables

- `HTML_PUBLISHER_URL` — base URL of the deployed Worker (e.g. `https://artifacts.example.com`)
- `HTML_PUBLISHER_TOKEN` — bearer token for the Worker API

Both must be set before running the script. If either is missing, tell the user what to set and stop.

### Procedure

1. Confirm the HTML file starts with `<!doctype html` or `<html`. Reject anything that does not. Keep it self-contained: the viewer blocks all network requests, so external URLs will not load.
2. Run the publisher in machine-readable mode (a directory publishes a multi-file page):
   ```bash
   node scripts/publish-html.mjs --json --title "<descriptive title>" [options] <file.html | dir>
   ```
3. Capture `viewerUrl` and `editUrl` from the JSON output (`{id, viewerUrl, editUrl, checkin, expiresAt, warnings, warningMessages}`). `viewerUrl` is the full read link including the `#fragment` key.
4. Return `viewerUrl` to the user. Keep `editUrl` to yourself for later updates.
5. If `warningMessages` is non-empty, surface those external URL warnings to the user.

### Updating an artifact

Artifacts are versioned: each publish or update is a check-in. To revise one, update it at the same URL instead of publishing a new artifact:

```bash
node scripts/publish-html.mjs update --json "<editUrl>" <file.html | dir> --message "<what changed>"
```

Exit code 3 means a version conflict (someone saved since); nothing was saved. Run `read <url> [--out dir]` to fetch the latest version, reapply your change, and retry. `history <url>` lists versions; a URL ending in `@<check-in>` reads that version. `list` shows your artifacts.

### Options reference

| Flag | Effect | Default |
|------|--------|---------|
| `--title <text>` | Display title | filename |
| `--ttl <duration>` | Expiry: `1h`, `6h`, `24h`, `7d`, `30d`, `never` | `7d` |
| `--slug <slug>` | Vanity URL slug `[a-z0-9-]{1,64}` | — |
| `--message <text>` | Check-in comment | `Publish <name>` / `Update <name>` |
| `--delete-local` | Delete local HTML after confirmed upload | off |
| `--json` | Machine-readable output only | off |

For machine-readable output (piping): add `--json`.

### Rules

- **Never strip the URL fragment.** The `#fragment` is the AES-256-GCM decryption key. A URL without it is permanently unreadable.
- **`--delete-local` only for files you generated in this session** when the user explicitly asked for cleanup. Never use it for user-authored source files.
- **If upload fails** (non-2xx or network error), leave the file untouched and report the error verbatim.
- **Keep `editUrl` private.** It can update and delete the artifact. Never print it into public places (chat channels, PRs, issues, commits, logs); give it to the user only if they need to edit or revoke the artifact themselves.

### Delete an artifact

```bash
node scripts/publish-html.mjs delete "<editUrl>"
```
