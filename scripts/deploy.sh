#!/bin/sh
# Deploy the Worker with its secrets, all read from the environment, so a
# secrets manager can supply them:
#
#   doppler run --project html-artifact-publisher --config prd -- sh scripts/deploy.sh
#
# Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and BEARER_TOKEN;
# NOTIFY_API_KEY is optional. Secrets ride the deploy (--secrets-file), so the
# new version never runs without them. Expects src/fossil.wasm (npm run build:wasm).
set -eu
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is not set}"
: "${BEARER_TOKEN:?BEARER_TOKEN is not set}"
: "${OWNER_EMAIL:?OWNER_EMAIL must identify the approved instance owner}"
: "${EMAIL_FROM:?EMAIL_FROM must be a verified sender}"
: "${APP_ORIGIN:?APP_ORIGIN must be the external HTTPS origin}"
# This entrypoint is production-only. The test transport is permitted only by
# isolated loopback tests, never by a deployment, even with a loopback origin.
[ -z "${TEST_MAIL_TRANSPORT:-}" ] || { printf '%s\n' 'deploy: TEST_MAIL_TRANSPORT must be empty' >&2; exit 1; }
node -e '
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const origin = new URL(process.env.APP_ORIGIN);
  if (!email.test(process.env.OWNER_EMAIL) || !email.test(process.env.EMAIL_FROM) ||
      origin.protocol !== "https:" || origin.origin !== process.env.APP_ORIGIN ||
      origin.username || origin.password || ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) {
    console.error("deploy: valid owner/sender emails and an exact non-loopback HTTPS APP_ORIGIN are required");
    process.exit(1);
  }
'
[ -f src/fossil.wasm ] || { echo "deploy: src/fossil.wasm is missing; run npm run build:wasm" >&2; exit 1; }
# The same size budget as fossil/build.sh: never deploy an oversized engine.
gz=$(gzip -9c src/fossil.wasm | wc -c)
budget="${FOSSIL_WASM_MAX_GZIP:-880000}"
[ "$gz" -le "$budget" ] || { echo "deploy: src/fossil.wasm is $gz bytes gzipped, over the $budget budget; rebuild with npm ci && npm run build:wasm (README: Building the Fossil engine)" >&2; exit 1; }

umask 077
secrets=$(mktemp)
trap 'rm -f "$secrets"' EXIT INT TERM
node -e '
  const s = { BEARER_TOKEN: process.env.BEARER_TOKEN, OWNER_EMAIL: process.env.OWNER_EMAIL };
  if (process.env.NOTIFY_API_KEY) s.NOTIFY_API_KEY = process.env.NOTIFY_API_KEY;
  process.stdout.write(JSON.stringify(s));
' > "$secrets"
npx wrangler deploy --secrets-file "$secrets" --var "APP_ORIGIN:$APP_ORIGIN" --var "EMAIL_FROM:$EMAIL_FROM" --var 'TEST_MAIL_TRANSPORT:'
