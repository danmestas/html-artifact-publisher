---
name: self-host-publisher
description: Load when someone wants their own copy of this HTML artifact publisher running on their own Cloudflare account - setting it up, deploying it, estimating what it costs, adding a custom domain, enabling email sign-in or automatic deploys, or pointing their agents at it. Follow docs/self-hosting.md in the repository.
---

# Set up your own publisher

The full procedure is `docs/self-hosting.md` in the html-artifact-publisher repository
(https://github.com/danmestas/html-artifact-publisher). Clone the repository, read that file,
and follow it in order. In short:

1. **Cost first.** It needs Cloudflare's Workers Paid plan ($5 a month), which covers most
   personal and team use. Tell the person this before they sign up.
2. **Build and test locally:** `npm ci && npm run build:wasm && npm test` (TinyGo 0.43.0,
   Go 1.27.3). Every test should pass before anything touches Cloudflare.
3. **The person creates credentials in the dashboard**: account ID, an API token from the
   *Edit Cloudflare Workers* template with *Workers R2 Storage: Edit*, and (for sign-in by
   email) an Email Sending domain and sender. Never ask for a token, key or password in
   chat; secrets go straight into Doppler, a password manager or their shell.
4. **Confirm the owner email and `APP_ORIGIN` with them**, then deploy:
   `npm run deploy:prod` (Doppler) or `sh scripts/deploy.sh` (variables exported).
5. **Check:** `/healthz`, publish a test page (`linkVerified: true`), and have the person
   sign in and invite a second address.
6. **Finish** by giving them the publisher URL, the test page's read link, and how to point
   their agents at it: install `skills/`, then set `HTML_PUBLISHER_URL` and a personal API
   credential as `HTML_PUBLISHER_TOKEN`.
