# HTML artifact publisher

You have access to a tool that publishes standalone HTML files as shareable, encrypted URLs. Each artifact is an encrypted Fossil repository; every publish or update is a check-in, so artifacts keep their version history. Metadata such as title, expiry, and slug remains plaintext. The decryption key lives exclusively in the URL fragment and never reaches the server.

## When to use

When the user asks you to publish, share, or distribute an HTML file or explainer.

## Requirements

Two environment variables must be set in the environment where you run commands:

- `HTML_PUBLISHER_URL` — base URL of the deployed Worker (e.g. `https://artifacts.example.com`)
- `HTML_PUBLISHER_TOKEN` — API bearer token

If either is missing, tell the user what to configure and stop.

## How to publish

```bash
node scripts/publish-html.mjs --json --title "<descriptive title>" <file.html | dir>
```

A single file is stored as `index.html`; a directory publishes a multi-file page. The script encrypts locally, uploads the ciphertext, and prints JSON: `{id, viewerUrl, editUrl, checkin, expiresAt, warnings, warningMessages}`. `viewerUrl` includes the `#fragment` decryption key and is the complete read link.

Return `viewerUrl` to the user. Keep `editUrl` (`…#<key>.<writeToken>`) to yourself; it is what lets you update or delete the artifact later.

## How to update

To revise an artifact you already published, add a new version at the same URL instead of publishing a new artifact for every revision:

```bash
node scripts/publish-html.mjs update --json "<editUrl>" <file.html | dir> --message "<what changed>"
```

Exit code 3 means a version conflict: someone saved since, and nothing was saved. Fetch the latest with `read <url> [--out dir]`, reapply your change, and retry. `history <url>` lists versions (a URL ending in `@<check-in>` reads that version), and `list` shows your artifacts.

## Options

- `--title <text>` — display title (default: filename)
- `--ttl 1h|6h|24h|7d|30d|never` — time to live (default: `7d`)
- `--slug <slug>` — vanity URL slug using `[a-z0-9-]`, up to 64 characters
- `--message <text>` — check-in comment
- `--delete-local` — delete the local HTML file after a confirmed successful upload
- `--json` — emit only machine-readable JSON on stdout

## Rules you must follow

**Never strip the `#fragment` from `viewerUrl`.** The fragment is the AES-256-GCM decryption key. A URL without the fragment is permanently unreadable — there is no recovery.

**`--delete-local` is only for files you generated in the current session**, and only when the user explicitly asks for cleanup. Never pass `--delete-local` for user-authored files, source documents, or any file you did not create during this interaction.

**If the upload fails** (non-2xx status or network error), leave the file on disk and report the error to the user verbatim. Do not attempt to delete the file.

**Surface external URL warnings.** If JSON output includes a non-empty `warningMessages` array, tell the user — the viewer blocks all network requests, so those resources will not load. Keep pages self-contained.

**Keep `editUrl` private.** It can update and delete the artifact. Never print it into public places (chat channels, PRs, issues, commits, logs). Give it to the user only if they need to edit or revoke the artifact themselves.

## Deleting an artifact early

```bash
node scripts/publish-html.mjs delete "<editUrl>"
```

## Size and TTL limits

Maximum payload: 10 MB (of encrypted bytes). Default TTL: 7 days. Maximum TTL: 30 days. Pass `--ttl never` for no expiry.
