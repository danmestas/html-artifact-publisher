## Publishing HTML artifacts

When the user asks you to publish, share, or upload an HTML file or explainer, use the publisher script in this repo.

### Required environment variables

- `HTML_PUBLISHER_URL` — base URL of the deployed Worker (e.g. `https://artifacts.example.com`)
- `HTML_PUBLISHER_TOKEN` — bearer token for the Worker API

Both must be set before running the script. If either is missing, tell the user what to set and stop.

### Procedure

1. Confirm the HTML file starts with `<!doctype html` or `<html`. Reject anything that does not. Files over about 1.99 MB compressed are refused. Keep it self-contained: the viewer blocks all network requests, so external URLs will not load.
2. Run the publisher in machine-readable mode (a directory publishes a multi-file page):
   ```bash
   node scripts/publish-html.mjs --json --title "<descriptive title>" [options] <file.html | dir>
   ```
3. Capture `viewerUrl`, `editUrl` and `cloneUrl` from the JSON output (`{id, viewerUrl, editUrl, cloneUrl, checkin, expiresAt, warnings, warningMessages}`). `viewerUrl` (`/v/<id>#<readToken>`) is the full read link including the `#fragment` token; `editUrl` is `/v/<id>#<writeToken>`; `cloneUrl` is `https://editor:<writeToken>@<host>/r/<id>` for `fossil clone`/`push`.
4. Return `viewerUrl` to the user. Keep `editUrl` and `cloneUrl` to yourself for later updates.
5. If `warningMessages` is non-empty, surface those external URL warnings to the user.

### Updating an artifact

Artifacts are versioned: each publish or update is a check-in. To revise one, update it at the same URL instead of publishing a new artifact:

```bash
node scripts/publish-html.mjs update --json "<editUrl>" <file.html | dir> --message "<what changed>"
```

It needs the edit link; a read link fails. It prints `{id, viewerUrl, checkin, warnings, warningMessages}`. Exit code 3 means a version conflict (someone published since); nothing was saved. Rerun to build on the newer version (use `read <url> [--out dir]` first if your change depends on it). Exit code 1 with "nothing changed" means the files already match the latest version. `history <url>` lists versions; a URL ending in `@<check-in>` reads that version. `list` shows your artifacts.

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

- **Never strip the URL fragment.** The `#fragment` holds the 64-hex access token (optionally followed by `@<check-in>`). A URL without it cannot open the artifact.
- **`--delete-local` only for files you generated in this session** when the user explicitly asked for cleanup. Never use it for user-authored source files.
- **If upload fails** (non-2xx or network error), leave the file untouched and report the error verbatim.
- **Keep `editUrl` and `cloneUrl` private.** They can update and delete the artifact. Never print them into public places (chat channels, PRs, issues, commits, logs); give them to the user only if they need to edit or revoke the artifact themselves.

### Delete an artifact

```bash
node scripts/publish-html.mjs delete "<editUrl>"
```
