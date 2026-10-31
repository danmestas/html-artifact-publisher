# Run your own publisher

This guide takes you from a fresh clone of this repository to your own publisher on your own Cloudflare account. You, or an agent working for you, can follow it step by step. Steps that need a person in a browser (creating accounts and tokens) are marked **You**. Everything else is a command an agent can run and check.

## What you get, and what it runs on

A signed-in Cloudflare Worker that publishes HTML pages as private, versioned links, plus a web library where invited people sign in, browse and share them. A second Worker serves independent public snapshots on a separate origin. Everything runs on Cloudflare:

| Piece | Cloudflare product | What it holds |
|---|---|---|
| The app and the viewer | Workers (with static assets) | Code, the viewer, fonts, the Pikchr renderer |
| Public snapshots | Separate `artifact-pages` Worker (`wrangler.public.jsonc`) | Public file serving, with no account secrets or app Durable Object bindings |
| One Fossil repository per artifact | Durable Objects (SQLite storage) | Every version of each page's text files |
| The library | One Durable Object | Accounts, sharing, stars, the list of artifacts |
| Images, video, fonts, `.wasm`, databases, any file over 256 KB | R2 | Private blobs stored once by SHA-256, plus independent public snapshot copies in the same bucket |
| Sign-in links and invitations | Email Service (sending) | Nothing stored |

You need no other service. Doppler (for secrets) and GitHub Actions (for automatic deploys) are optional.

## What it costs

Cloudflare's **Workers Paid** plan costs **$5 a month** and is required (Durable Objects and Email Sending need it). Its included usage covers most personal and small-team use, so expect to pay $5 a month and nothing more.

| Usage | Included each month | Beyond that |
|---|---|---|
| Worker requests | 10 million | $0.30 per million |
| Durable Object requests | 1 million | $0.15 per million |
| Durable Object stored data (page text, history, library) | 5 GB | $0.20 per GB-month |
| R2 storage (images and large files) | 10 GB | $0.015 per GB-month |
| R2 uploads / reads | 1 million / 10 million | $4.50 / $0.36 per million |
| R2 downloads (egress) | unlimited | free |

These are Cloudflare's published rates as of October 2026; check [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/) and Email Service limits before you rely on them.

Some rough examples:

- **A person or a small team.** 500 artifacts, 2 GB of images, 20,000 views a month: **$5**.
- **A busy team.** 5,000 artifacts, 50 GB of images, 1 million views a month: about **$6–8**. Most of the extra is R2 storage above 10 GB (about $0.60) and Durable Object requests above the included million. A page view costs a handful of Worker requests and a few Durable Object requests; images are served from R2 and cached by browsers.

## What you need before you start

**You:**
- A Cloudflare account with the Workers Paid plan.
- An email address for the **instance owner**: the one person who can see and manage everything and invite others.
- For sign-in by email: a domain on your Cloudflare account, onboarded to **Email Service → Email Sending**, and a sender address on it (for example `artifacts@yourdomain.com`). Without it, the CLI and links still work, but nobody can sign in to the web library. You can add it later.
- Optional: a custom domain or subdomain for the publisher (otherwise it lives at `https://html-artifact-publisher.<your-subdomain>.workers.dev`).

**Tools (an agent can check these):**
- Git, and Node.js 24 or newer (the version CI uses; the tests need it).
- Go 1.26 and exactly TinyGo 0.43.0, to build the Fossil engine. See [Building the Fossil engine](../README.md#building-the-fossil-engine). If you deploy only through GitHub Actions, CI builds it for you and you can skip these.

## Step by step

### 1. Clone, build and test

```bash
git clone https://github.com/danmestas/html-artifact-publisher
cd html-artifact-publisher
npm ci                 # also installs the pinned wasm-opt the build needs
npm run build:wasm     # about 2.9 MB, 1.0 MB gzipped
npm run typecheck && npm run test:go && npm test
```

All tests should pass before you deploy. They run the Worker locally, with local stand-ins for Durable Objects and R2, so nothing touches Cloudflare yet.

### 2. Create the Cloudflare credentials (You)

1. Find your **Account ID**: Cloudflare dashboard → *Workers & Pages* → it's shown on the right (or `npx wrangler whoami` after `npx wrangler login`).
2. Find your **workers.dev subdomain**: *Workers & Pages* → *Settings* (set one if you haven't).
3. Create an **API token**: *My Profile → API Tokens → Create Token → Edit Cloudflare Workers* template. Make sure it includes **Workers R2 Storage: Edit** (add it if it's missing), and limit it to your account.

Never paste the token into a chat with an agent. Put it straight into your secrets store (next step).

### 3. Put the settings somewhere safe

`scripts/deploy.sh` reads everything from environment variables:

| Variable | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | The token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID |
| `BEARER_TOKEN` | The instance owner's API token for the CLI. Generate it: `openssl rand -hex 32` |
| `OWNER_EMAIL` | The instance owner's email |
| `EMAIL_FROM` | The sender address on your Email Sending domain |
| `APP_ORIGIN` | The signed-in publisher's exact HTTPS origin, e.g. `https://html-artifact-publisher.yourname.workers.dev` (no trailing slash) |
| `PUBLIC_ORIGIN` | Optional separate exact HTTPS origin for public snapshots (no trailing slash). Omit to discover `artifact-pages`'s `workers.dev` origin automatically; set it when using a custom public domain |
| `NOTIFY_API_KEY` | Optional, for waking an agent through notify |

Choose one place to keep them:

- **Doppler** (what this repository uses): create a project `html-artifact-publisher` with a config `prd` holding the variables above. Then `npm run deploy:prod` runs the deploy with them. Doppler's free tier is enough.
- **Your shell or password manager**: export them in the terminal you deploy from and run `sh scripts/deploy.sh`. Don't commit them to any file in the repository.

### 4. Deploy

```bash
npm run deploy:prod          # with Doppler
# or, with the variables exported in your shell:
sh scripts/deploy.sh
```

The first deploy:
- refuses to run if a setting is missing or unsafe (for example an `http://` origin);
- refuses an engine over the size budget;
- creates the R2 bucket `html-artifact-publisher-blobs` if it doesn't exist, and gives it a lifecycle rule, `expire-tmp`, that deletes objects under `tmp/` after a day (uploads stage there until they are verified);
- deploys `artifact-pages` from `wrangler.public.jsonc`, using the same R2 bucket as the app but no app bindings or secrets;
- discovers its `workers.dev` origin unless you supplied `PUBLIC_ORIGIN`;
- creates the Durable Object classes (`Repo`, `Registry`);
- uploads the signed-in app with its secrets and the resolved `PUBLIC_ORIGIN` variable, and prints `APP_URL` and `PUBLIC_URL`.

The public origin must differ from `APP_ORIGIN`. Keep both configurations' `BLOBS` bindings pointed at the same bucket if you rename it. Both Workers need deploying when updating; `deploy.sh` handles their order.

### 5. Check it works

With the variables from step 3 in your shell (with Doppler, run `doppler run -- sh` first):

```bash
curl -s "$APP_ORIGIN/healthz"                     # {"status":"ok",...}
export HTML_PUBLISHER_URL="$APP_ORIGIN" HTML_PUBLISHER_TOKEN="$BEARER_TOKEN"
printf '<!doctype html><title>Hello</title><style>body{font-family:"Instrument Sans",sans-serif}</style><h1>Hello</h1><pre class="pikchr">box "it"; arrow; box "works"</pre>' > /tmp/hello.html
node scripts/publish-html.mjs --json --title "Hello" /tmp/hello.html
```

The output should say `"linkVerified": true`. Open its `viewerUrl`: you should see the heading in Instrument Sans and a small diagram.

**You:** open `APP_ORIGIN` in a browser, sign in with the owner email, and check that the sign-in email arrives. Then invite a second address that you control, and check that it can sign in too.

To check public snapshots, open the test artifact as its owner, choose **Share → Publish**, and confirm that every file in the selected version will become public. Open the resulting public URL in a signed-out/private browser window. Check both the page and its local supporting files. Standalone JavaScript can work; external/CDN dependencies are blocked by the public CSP. Then unpublish it from **Published links** and check that its public URL and copied-file URLs return 404 while the private source and history still open.

### 6. Automatic deploys from GitHub (optional)

Fork the repository. With Doppler: create a Doppler **service token** for the `prd` config and add it to your fork as the GitHub Actions secret `DOPPLER_TOKEN` (`gh secret set DOPPLER_TOKEN`). From then on, every merge to `main` runs the tests, builds the engine, deploys the build that passed and checks `/healthz`. Until the secret exists, merges skip the deploy with a warning.

Without Doppler, store the same variables as GitHub Actions secrets instead. Then change the *Deploy to Cloudflare* step in `.github/workflows/ci.yml` to pass them as `env:` and run `sh scripts/deploy.sh`.

### 7. A custom domain (optional)

Add a route to `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "artifacts.yourdomain.com", "custom_domain": true }]
```

Set `APP_ORIGIN` to `https://artifacts.yourdomain.com`, then deploy again.

For public snapshots on a custom domain, add a separate route to **`wrangler.public.jsonc`**, for example:

```jsonc
"routes": [{ "pattern": "pages.yourdomain.com", "custom_domain": true }]
```

Set `PUBLIC_ORIGIN=https://pages.yourdomain.com` in the deployment environment and deploy again. It must be an exact HTTPS origin with no trailing slash, different from `APP_ORIGIN`. The signed-in app remains on its own origin; never route public snapshot files through that origin. Without this override, `deploy.sh` uses the public Worker's discovered `workers.dev` address.

### 8. Point your agents at it

On each machine where an agent will publish:

```bash
cp -r skills/* ~/.claude/skills/        # or your harness's skills folder: docs/agent-harnesses.md
export HTML_PUBLISHER_URL="$APP_ORIGIN"
export HTML_PUBLISHER_TOKEN=<a personal API credential>
```

Give each person or agent their own **personal API credential** (library → account menu → API credentials) rather than the owner's `BEARER_TOKEN`. What they publish then lands in their own library, and you can revoke a credential on its own.

## Public snapshots and collaboration

The artifact owner or instance owner can use **Share → Publish** to publish an immutable copy of an exact selected check-in, up to **250 files and 250 MiB**. Every file in that version becomes publicly accessible, including images, scripts and supporting files. Publishing a newer version creates a new public snapshot rather than replacing the old one.

Public snapshots do **not** include private history, shared page data or the app's `window.artifact` runtime bridge. Existing collaboration links and named access are separate: they still open the private viewer and its full history according to their permissions. The exporter rejects private-runtime dependencies it detects, missing source files, missing referenced local scripts/stylesheets, unsupported base URLs and diagram/font preparation failures. It prepares Pikchr diagrams and house fonts before copying.

The public Worker's CSP applies an opaque-origin sandbox and allows standalone scripts and bundled/local resources, but blocks external/CDN resources, remote fonts and external API requests. The exporter rejects detected non-local resource dependencies, bare module imports, literal root-relative JavaScript loads (for example `fetch('/data.json')`), root-relative import-map URLs and embedded frames/objects. Use document/module-relative imports and local `fetch()` paths instead: these work on public snapshots, unlike private viewer rendering. Static checks cannot guarantee that dynamically constructed loads will work. Bundle dependencies into the selected check-in and verify the public result before sharing it.

**Deleting or expiring the private source does not unpublish a public copy.** Use the library's **Published links** view to unpublish a snapshot explicitly. Members see their own publications; the instance owner sees all accounts'. Unpublishing (`DELETE /api/publications/:id`) revokes the public link and deletes its independent copied files without changing the private artifact or history. Deleted records are retained for cleanup bookkeeping but hidden from the default list. Copies already downloaded cannot be recalled.

The instance owner can choose **Clean up unpublished files** (`POST /api/publications/cleanup` with `{}`) to retry cleanup of failed/deleted publications and builds older than one hour. It never deletes live snapshots. Cleanup keeps a durable cursor for bounded 25-record passes and resweeps retained deleted records to collect late orphan writes. The response reports `cleaned` and `remaining`; repeat the action if more work remains.

## Day to day

- **Updating.** Pull the latest code and deploy again, or merge to `main` if you set up step 6. Storage changes only ever add tables and columns, so your data carries over.
- **Backups.** Each artifact is a Fossil repository: `fossil clone` it with its clone URL. Images and large files are in R2 and are not in the clone; `node scripts/publish-html.mjs read <url> --out <dir>` writes a version with the real files.
- **Removing everything.** Unpublish public snapshots first if you need their links revoked while the service still runs. Delete both Workers with `npx wrangler delete` and `npx wrangler delete --config wrangler.public.jsonc`, then `npx wrangler r2 bucket delete html-artifact-publisher-blobs` (the bucket must be empty first). Then delete the API token. Deleting only the signed-in app does not remove the public Worker or its copied files.

## When something goes wrong

| What you see | What to do |
|---|---|
| `deploy: valid owner/sender emails and an exact non-loopback HTTPS APP_ORIGIN are required` | A setting is missing or malformed. `APP_ORIGIN` must be `https://`, with no trailing slash |
| Deploy fails creating or binding the R2 bucket | The API token lacks **Workers R2 Storage: Edit** |
| `src/fossil.wasm is ... over the ... budget` | Wrong toolchain. Use TinyGo 0.43.0 and Go 1.26, run `npm ci` first, and don't install your own `wasm-opt` |
| The sign-in email never arrives | The sender domain isn't onboarded to Email Sending, or `EMAIL_FROM` isn't on it. Check Email Sending's delivery logs in the dashboard |
| `Email sign-in is not configured` (503) | `EMAIL_FROM` or `APP_ORIGIN` isn't set on the deployed Worker |
| The CLI says `missing_blob` | An image upload didn't finish. Run the same command again: uploads that already arrived are reused |
| `A separate PUBLIC_ORIGIN must be configured before publishing` (503) | Run `deploy.sh` so it deploys the public Worker and sets the app's resolved public origin, or correct the separate HTTPS override |
| A public page loses scripts, fonts or other external assets | The public CSP blocks external/CDN resources. Bundle them in the selected version and publish a new snapshot |
| `Unsupported static export` | Remove the detected private runtime dependency or unsupported base URL before publishing; a snapshot has no private runtime/data bridge |

## For agents setting this up

If a person asks you to set up their own publisher, follow this guide in order, and:

1. Run the checks yourself (tools, build, tests, `/healthz`, the test publish) and report each result.
2. Hand the **You** steps to the person, with the exact dashboard path. Never ask them to paste a token, key or password into the chat. Have them put secrets straight into Doppler, their password manager or their shell.
3. Before the first deploy, confirm the owner email and `APP_ORIGIN` with them; don't guess either.
4. Tell them the expected cost (usually $5 a month) before they upgrade to Workers Paid.
5. Finish by giving them the publisher's URL, the test page's read link, and the commands for their own agents (step 8).
