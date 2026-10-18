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

1. Confirm the HTML file starts with `<!doctype html` or `<html`. If it does not, explain that the publisher only accepts standalone HTML documents. Keep it self-contained: the viewer blocks all network requests, so external URLs will not load. Files over about 1.99 MB compressed are refused.

2. Run the publisher script in machine-readable mode:
   ```bash
   node scripts/publish-html.mjs --json --title "<descriptive title>" <file.html | dir>
   ```
   A directory publishes a multi-file page.

3. Capture `viewerUrl`, `editUrl` and `cloneUrl` from the JSON output. `viewerUrl` (`/v/<id>#<readToken>`) is the complete share link; `editUrl` (`/v/<id>#<writeToken>`) can update and delete; `cloneUrl` (`https://editor:<writeToken>@<host>/r/<id>`) works with `fossil clone`/`push`.

4. Return `viewerUrl` to the user. Keep `editUrl` and `cloneUrl` to yourself for later updates.

5. If JSON output includes non-empty `warningMessages`, surface them: those external resources will not load in the viewer.

## Updating an artifact

Each publish or update is a versioned check-in. To revise an artifact, update it at the same URL rather than publishing a new one:

```bash
node scripts/publish-html.mjs update --json "<editUrl>" <file.html | dir> --message "<what changed>"
```

It needs the edit link; a read link fails. Exit code 3 means a version conflict (someone published since); nothing was saved. Rerun to build on the newer version (`read <url>` first if your change depends on it). Exit code 1 "nothing changed" means the files match the latest version. `history <url>` lists versions and `list` shows your artifacts.

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

- **Never strip the `#fragment` from `viewerUrl`.** It is the access token. Without it the link cannot open the artifact.
- **`--delete-local`** is only safe for files the agent generated in the current session, and only when the user explicitly requests cleanup. Never use it for user-authored source files.
- If the upload fails (non-2xx HTTP status or network error), leave the file on disk and report the error verbatim.
- **Keep `editUrl` and `cloneUrl` private.** They can update and delete the artifact. Never print them into public places (PRs, issues, commits, channels, logs); give them to the user only if they need to edit or revoke the artifact themselves.

## Deleting an artifact

```bash
node scripts/publish-html.mjs delete "<editUrl>"
```
