# HTML artifact publisher

You have access to a tool that publishes standalone HTML files as shareable URLs. Each artifact is a Fossil repository stored on the server (one Durable Object per artifact); every publish or update is a check-in, so artifacts keep their version history. Content is not encrypted; access is controlled by tokens in the URL fragment — a read token for viewers and a write token for editors.

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

A single file is stored as `index.html`; a directory publishes a multi-file page. The script uploads the files and prints JSON: `{id, viewerUrl, editUrl, cloneUrl, checkin, expiresAt, warnings, warningMessages}`. `viewerUrl` (`https://<host>/v/<id>#<readToken>`) is the complete read link; tokens are 64 hex characters, and `…@<check-in>` after the token selects a version.

Return `viewerUrl` to the user. Keep `editUrl` (`https://<host>/v/<id>#<writeToken>`) to yourself; it is what lets you update or delete the artifact later. `cloneUrl` (`https://editor:<writeToken>@<host>/r/<id>`) works with `fossil clone`/`push`; keep it private too.

**Always post the link.** Every time you publish *or update* an artifact, give the user its read link: `viewerUrl` from the CLI output, on its own line, with the full `#…` token. It opens the newest version, and the CLI has already checked that it opens (`linkVerified: true`). Never post the edit link or clone URL in its place, and never build a link by hand. If `linkVerified` is false, say the link didn't open instead of presenting it as working.

Diagrams: write them in Pikchr inside `<pre class="pikchr" aria-label="...">` unless the user asks for another tool; the viewer renders them. `publish` and `update` refuse a page whose Pikchr doesn't render. Fonts: Instrument Sans by default (IBM Plex Mono for code, IBM Plex Serif for long reading); name them in CSS and the viewer embeds only those.

## How to update

To revise an artifact you already published, add a new version at the same URL instead of publishing a new artifact for every revision:

```bash
node scripts/publish-html.mjs update --json "<editUrl>" <file.html | dir> --message "<what changed>"
```

It needs the edit link (a read link fails) and prints `{id, viewerUrl, checkin, linkVerified, warnings, warningMessages}`; `viewerUrl` is the read link, which opens the new version. Exit code 3 means a version conflict: someone published since, and nothing was saved. Rerun to build on the newer version (fetch it with `read <url> [--out dir]` first if your change depends on it). Exit code 1 with "nothing changed" means the files already match the latest version. `history <url>` lists versions (a URL ending in `@<check-in>` reads that version), and `list` shows your artifacts.

## Options

- `--title <text>` — display title (default: filename)
- `--ttl 1h|6h|24h|7d|30d|never` — time to live (default: `7d`)
- `--slug <slug>` — vanity URL slug using `[a-z0-9-]`, up to 64 characters
- `--message <text>` — check-in comment
- `--delete-local` — delete the local HTML file after a confirmed successful upload
- `--json` — emit only machine-readable JSON on stdout

## Rules you must follow

**Never strip the `#fragment` from `viewerUrl`.** The fragment is the access token. A URL without it cannot open the artifact.

**`--delete-local` is only for files you generated in the current session**, and only when the user explicitly asks for cleanup. Never pass `--delete-local` for user-authored files, source documents, or any file you did not create during this interaction.

**If the upload fails** (non-2xx status or network error), leave the file on disk and report the error to the user verbatim. Do not attempt to delete the file.

**Surface external URL warnings.** If JSON output includes a non-empty `warningMessages` array, tell the user — the viewer blocks all network requests, so those resources will not load. Keep pages self-contained.

**Keep `editUrl` and `cloneUrl` private.** They can update and delete the artifact. Never print them into public places (chat channels, PRs, issues, commits, logs). Give them to the user only if they need to edit or revoke the artifact themselves.

## Deleting an artifact early

```bash
node scripts/publish-html.mjs delete "<editUrl>"
```

## Size and TTL limits

Maximum payload: 10 MB per request. Images, video, audio, fonts, PDFs and other binary files, and any file over 256 KB, are stored in R2 instead of Fossil (the CLI uploads them automatically, up to 100 MB each); smaller text files must compress under about 1.99 MB. Default TTL: 7 days. Maximum TTL: 30 days. Pass `--ttl never` for no expiry.
