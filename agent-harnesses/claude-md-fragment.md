## HTML artifact publishing

When asked to publish, share, or upload an HTML file, use the publisher script.

**Required env vars:** `HTML_PUBLISHER_URL` (Worker base URL) and `HTML_PUBLISHER_TOKEN` (bearer token). If either is missing, say so and stop.

**Publish:**
```bash
node scripts/publish-html.mjs --json --title "<title>" [--ttl 7d] [--slug <slug>] <file.html | dir>
```

Capture `viewerUrl` and `editUrl` from the JSON output. Return `viewerUrl` to the user; keep `editUrl` to yourself for later updates. The `#fragment` is the AES-256-GCM decryption key — never strip it.

**Update (new version at the same URL — do this instead of publishing a new artifact per revision):**
```bash
node scripts/publish-html.mjs update --json "<editUrl>" <file.html | dir> --message "<what changed>"
```
Exit code 3 = version conflict (someone saved since; nothing saved): `read <url>` the latest, reapply, retry. Also: `history <url>`, `list`, `delete <editUrl>`.

**Rules:**
- `--delete-local` only for files the agent generated this session when the user explicitly requests cleanup. Never for user-authored files.
- If upload fails, leave the file on disk and report the error verbatim.
- Surface `warningMessages` from JSON output to the user when non-empty.
- Keep `editUrl` private (it can update and delete); never print it into public places such as PRs, issues, commits, or channels.
- Keep pages self-contained: the viewer blocks all network requests, so external URLs will not load.

**TTL options:** `1h`, `6h`, `24h`, `7d`, `30d`, `never` (default `7d`). Max payload: 10 MB.
