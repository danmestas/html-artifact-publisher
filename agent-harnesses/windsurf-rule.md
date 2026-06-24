# Publishing HTML artifacts

Use this when the user asks to publish, share, or upload an HTML file or explainer.

## Required environment variables

Set these in your shell or workspace environment before running the script:

```
HTML_PUBLISHER_URL=https://<your-worker-domain>
HTML_PUBLISHER_TOKEN=<your-bearer-token>
```

If either variable is absent, tell the user what to set and stop. Do not attempt to guess or hard-code values.

## Steps

1. Confirm the HTML file starts with `<!doctype html` or `<html`. If it does not, explain that the publisher only accepts standalone HTML documents.

2. Run the publisher script in machine-readable mode:
   ```bash
   node scripts/publish-html.mjs --json --title "<descriptive title>" <file.html>
   ```

3. Capture `viewerUrl` from the JSON output. This URL includes the `#fragment` decryption key and is the complete share link.

4. Return `viewerUrl` to the user.

5. If JSON output includes non-empty `warningMessages`, surface them: the artifact may not render offline and could leak referrer data.

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--title <text>` | Human-readable title | filename |
| `--ttl <duration>` | `1h`, `6h`, `24h`, `7d`, `30d`, `never` | `7d` |
| `--slug <slug>` | Vanity slug `[a-z0-9-]{1,64}` | — |
| `--delete-local` | Delete local file after confirmed upload | off |
| `--json` | Machine-readable stdout | off |

## Rules

- **Never strip the `#fragment` from `viewerUrl`.** It is the AES-256-GCM key. Removing it makes the artifact permanently unreadable.
- **`--delete-local`** is only safe for files the agent generated in the current session, and only when the user explicitly requests cleanup. Never use it for user-authored source files.
- If the upload fails (non-2xx HTTP status or network error), leave the file on disk and report the error verbatim.
- The `deleteToken` in the upload response is a one-time credential for early deletion. Provide it to the user if they may need to revoke the artifact before it expires.

## Deleting an artifact

```bash
curl -X DELETE $HTML_PUBLISHER_URL/api/pages/<id> \
  -H "X-Delete-Token: <deleteToken>"
```
