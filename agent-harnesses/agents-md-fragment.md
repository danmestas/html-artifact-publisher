## Publishing HTML artifacts

When the user asks you to publish, share, or upload an HTML file or explainer, use the publisher script in this repo.

### Required environment variables

- `HTML_PUBLISHER_URL` — base URL of the deployed Worker (e.g. `https://artifacts.example.com`)
- `HTML_PUBLISHER_TOKEN` — bearer token for the Worker API

Both must be set before running the script. If either is missing, tell the user what to set and stop.

### Procedure

1. Confirm the HTML file starts with `<!doctype html` or `<html`. Reject anything that does not.
2. Run the publisher in machine-readable mode:
   ```bash
   node scripts/publish-html.mjs --json --title "<descriptive title>" [options] <file.html>
   ```
3. Capture `viewerUrl` from the JSON output. This is the full share URL including the `#fragment` key.
4. Return `viewerUrl` to the user. This is the only URL that lets someone view the artifact.
5. If `warningMessages` is non-empty, surface those external URL warnings to the user.

### Options reference

| Flag | Effect | Default |
|------|--------|---------|
| `--title <text>` | Display title | filename |
| `--ttl <duration>` | Expiry: `1h`, `6h`, `24h`, `7d`, `30d`, `never` | `7d` |
| `--slug <slug>` | Vanity URL slug `[a-z0-9-]{1,64}` | — |
| `--delete-local` | Delete local HTML after confirmed upload | off |
| `--json` | Machine-readable output only | off |

For machine-readable output (piping): add `--json`.

### Rules

- **Never strip the URL fragment.** The `#fragment` is the AES-256-GCM decryption key. A URL without it is permanently unreadable.
- **`--delete-local` only for files you generated in this session** when the user explicitly asked for cleanup. Never use it for user-authored source files.
- **If upload fails** (non-2xx or network error), leave the file untouched and report the error verbatim.
- **`deleteToken`** in the response is proof of ownership for early deletion. Provide it to the user if they may need to revoke the artifact before it expires.

### Delete an artifact

```bash
curl -X DELETE $HTML_PUBLISHER_URL/api/pages/<id> \
  -H "X-Delete-Token: <deleteToken>"
```
