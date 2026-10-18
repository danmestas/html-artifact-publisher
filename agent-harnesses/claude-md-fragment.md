## HTML artifact publishing

When asked to publish, share, or upload an HTML file, use the publisher script.

**Required env vars:** `HTML_PUBLISHER_URL` (Worker base URL) and `HTML_PUBLISHER_TOKEN` (bearer token). If either is missing, say so and stop.

**Publish:**
```bash
node scripts/publish-html.mjs --json --title "<title>" [--ttl 7d] [--slug <slug>] <file.html | dir>
```

Capture `viewerUrl`, `editUrl` and `cloneUrl` from the JSON output. Return `viewerUrl` (`/v/<id>#<readToken>`) to the user; keep `editUrl` (`/v/<id>#<writeToken>`) to yourself for later updates. The `#fragment` is the access token — never strip it.

**Always post the link.** Every time you publish *or update* an artifact, give the user its read link: `viewerUrl` from the CLI output, on its own line, with the full `#…` token. It opens the newest version, and the CLI has already checked that it opens (`linkVerified: true`). Never post the edit link or clone URL in its place, and never build a link by hand. If `linkVerified` is false, say the link didn't open instead of presenting it as working.

Diagrams: write them in Pikchr inside `<pre class="pikchr" aria-label="...">` unless the user asks for another tool; the viewer renders them. `publish` and `update` refuse a page whose Pikchr doesn't render. Fonts: Instrument Sans by default (IBM Plex Mono for code, IBM Plex Serif for long reading); name them in CSS and the viewer embeds only those.

**Update (new version at the same URL — do this instead of publishing a new artifact per revision):**
```bash
node scripts/publish-html.mjs update --json "<editUrl>" <file.html | dir> --message "<what changed>"
```
Needs the edit link (a read link fails). Exit code 3 = version conflict (someone published since; nothing saved): rerun to build on the newer version. Exit 1 "nothing changed" = files match the latest version. Also: `history <url>`, `list`, `delete <editUrl>`.

**Rules:**
- `--delete-local` only for files the agent generated this session when the user explicitly requests cleanup. Never for user-authored files.
- If upload fails, leave the file on disk and report the error verbatim.
- Surface `warningMessages` from JSON output to the user when non-empty.
- Keep `editUrl` (can update and delete) and `cloneUrl` (`https://editor:<writeToken>@<host>/r/<id>`, for `fossil clone`/`push`) private; never print them into PRs, issues, commits, channels, or logs.
- Keep pages self-contained: the viewer blocks all network requests, so external URLs will not load.

**TTL options:** `1h`, `6h`, `24h`, `7d`, `30d`, `never` (default `7d`). Max payload: 10 MB; files over about 1.99 MB compressed are refused (HTTP 413).
