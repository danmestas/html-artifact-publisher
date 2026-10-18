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

1. Confirm the HTML file starts with `<!doctype html` or `<html`. If it does not, explain that the publisher only accepts standalone HTML documents. Keep it self-contained: the viewer blocks all network requests, so external URLs will not load.

2. Run the publisher script in machine-readable mode:
   ```bash
   node scripts/publish-html.mjs --json --title "<descriptive title>" <file.html | dir>
   ```
   A directory publishes a multi-file page.

3. Capture `viewerUrl` and `editUrl` from the JSON output. `viewerUrl` includes the `#fragment` decryption key and is the complete share link.

4. Return `viewerUrl` to the user. Keep `editUrl` to yourself for later updates.

5. If JSON output includes non-empty `warningMessages`, surface them: those external resources will not load in the viewer.

## Updating an artifact

Each publish or update is a versioned check-in. To revise an artifact, update it at the same URL rather than publishing a new one:

```bash
node scripts/publish-html.mjs update --json "<editUrl>" <file.html | dir> --message "<what changed>"
```

Exit code 3 means a version conflict (someone saved since); nothing was saved. Use `read <url>` to fetch the latest version, reapply your change, and retry. `history <url>` lists versions and `list` shows your artifacts.

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--title <text>` | Human-readable title | filename |
| `--ttl <duration>` | `1h`, `6h`, `24h`, `7d`, `30d`, `never` | `7d` |
| `--slug <slug>` | Vanity slug `[a-z0-9-]{1,64}` | — |
| `--message <text>` | Check-in comment | `Publish <name>` / `Update <name>` |
| `--delete-local` | Delete local file after confirmed upload | off |
| `--json` | Machine-readable stdout | off |

## Rules

- **Never strip the `#fragment` from `viewerUrl`.** It is the AES-256-GCM key. Removing it makes the artifact permanently unreadable.
- **`--delete-local`** is only safe for files the agent generated in the current session, and only when the user explicitly requests cleanup. Never use it for user-authored source files.
- If the upload fails (non-2xx HTTP status or network error), leave the file on disk and report the error verbatim.
- **Keep `editUrl` private.** It can update and delete the artifact. Never print it into public places (PRs, issues, commits, channels, logs); give it to the user only if they need to edit or revoke the artifact themselves.

## Deleting an artifact

```bash
node scripts/publish-html.mjs delete "<editUrl>"
```
