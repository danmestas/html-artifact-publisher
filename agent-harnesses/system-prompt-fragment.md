# HTML artifact publisher

You have access to a tool that publishes standalone HTML files as shareable, encrypted URLs. The server stores encrypted HTML payloads; metadata such as title, source name, expiry, and slug remains plaintext. The decryption key lives exclusively in the URL fragment and never reaches the server.

## When to use

When the user asks you to publish, share, or distribute an HTML file or explainer.

## Requirements

Two environment variables must be set in the environment where you run commands:

- `HTML_PUBLISHER_URL` — base URL of the deployed Worker (e.g. `https://artifacts.example.com`)
- `HTML_PUBLISHER_TOKEN` — API bearer token

If either is missing, tell the user what to configure and stop.

## How to publish

```bash
node scripts/publish-html.mjs --json --title "<descriptive title>" <file.html>
```

The script encrypts the file locally, uploads the ciphertext, and prints a JSON result including `viewerUrl`. The `viewerUrl` includes the `#fragment` decryption key and is the complete share link.

Return `viewerUrl` to the user. This is the only URL that grants access to the artifact.

## Options

- `--title <text>` — display title (default: filename)
- `--ttl 1h|6h|24h|7d|30d|never` — time to live (default: `7d`)
- `--slug <slug>` — vanity URL slug using `[a-z0-9-]`, up to 64 characters
- `--delete-local` — delete the local HTML file after a confirmed successful upload
- `--json` — emit only machine-readable JSON on stdout

## Rules you must follow

**Never strip the `#fragment` from `viewerUrl`.** The fragment is the AES-256-GCM decryption key. A URL without the fragment is permanently unreadable — there is no recovery.

**`--delete-local` is only for files you generated in the current session**, and only when the user explicitly asks for cleanup. Never pass `--delete-local` for user-authored files, source documents, or any file you did not create during this interaction.

**If the upload fails** (non-2xx status or network error), leave the file on disk and report the error to the user verbatim. Do not attempt to delete the file.

**Surface external URL warnings.** If JSON output includes a non-empty `warningMessages` array, tell the user — the artifact may not render offline and could leak referrer data to those domains.

**Share `deleteToken` when appropriate.** The upload response includes a `deleteToken` that lets the artifact be deleted before it expires. If the user may want early revocation, provide it.

## Deleting an artifact early

```bash
curl -X DELETE $HTML_PUBLISHER_URL/api/pages/<id> \
  -H "X-Delete-Token: <deleteToken>"
```

## Size and TTL limits

Maximum payload: 10 MB (of encrypted bytes). Default TTL: 7 days. Maximum TTL: 30 days. Pass `--ttl never` for no expiry.
