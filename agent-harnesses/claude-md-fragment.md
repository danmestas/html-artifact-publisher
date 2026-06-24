## HTML artifact publishing

When asked to publish, share, or upload an HTML file, use the publisher script.

**Required env vars:** `HTML_PUBLISHER_URL` (Worker base URL) and `HTML_PUBLISHER_TOKEN` (bearer token). If either is missing, say so and stop.

**Publish:**
```bash
node scripts/publish-html.mjs --json --title "<title>" [--ttl 7d] [--slug <slug>] <file.html>
```

Capture `viewerUrl` from the JSON output and return it to the user. The `#fragment` is the AES-256-GCM decryption key — never strip it.

**Rules:**
- `--delete-local` only for files the agent generated this session when the user explicitly requests cleanup. Never for user-authored files.
- If upload fails, leave the file on disk and report the error verbatim.
- Surface `warningMessages` from JSON output to the user when non-empty.
- Provide `deleteToken` from the response if the user may need early revocation.

**TTL options:** `1h`, `6h`, `24h`, `7d`, `30d`, `never` (default `7d`). Max payload: 10 MB.
