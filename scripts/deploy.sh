#!/bin/sh
# Deploy the Worker with its secrets, all read from the environment, so a
# secrets manager can supply them:
#
#   doppler run --project html-artifact-publisher --config prd -- sh scripts/deploy.sh
#
# Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and BEARER_TOKEN;
# NOTIFY_API_KEY and the wake sink (WAKE_SINK_KIND, WAKE_SINK_URL,
# WAKE_SINK_SECRET, and NOTIFY_AGENT/NOTIFY_SUBSCRIBER for a notify sink; README, Wake sinks)
# are optional. The API token also needs R2 edit permission (the
# blob bucket is created on first deploy). Secrets ride the deploy (--secrets-file), so the
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
  if (process.env.PUBLIC_ORIGIN) {
    const publicOrigin = new URL(process.env.PUBLIC_ORIGIN);
    if (publicOrigin.protocol !== "https:" || publicOrigin.origin !== process.env.PUBLIC_ORIGIN ||
        publicOrigin.origin === origin.origin || ["localhost", "127.0.0.1", "[::1]"].includes(publicOrigin.hostname)) {
      console.error("deploy: PUBLIC_ORIGIN must be a separate exact non-loopback HTTPS origin");
      process.exit(1);
    }
  }
'
[ -f src/fossil.wasm ] || { echo "deploy: src/fossil.wasm is missing; run npm run build:wasm" >&2; exit 1; }
# The same size budget as fossil/build.sh: never deploy an oversized engine.
gz=$(gzip -9c src/fossil.wasm | wc -c)
budget="${FOSSIL_WASM_MAX_GZIP:-800000}"
[ "$gz" -le "$budget" ] || { echo "deploy: src/fossil.wasm is $gz bytes gzipped, over the $budget budget; rebuild with npm ci && npm run build:wasm (README: Building the Fossil engine)" >&2; exit 1; }

umask 077
secrets=$(mktemp)
public_log=$(mktemp)
trap 'rm -f "$secrets" "$public_log"' EXIT INT TERM
node -e '
  const s = { BEARER_TOKEN: process.env.BEARER_TOKEN, OWNER_EMAIL: process.env.OWNER_EMAIL };
  if (process.env.NOTIFY_API_KEY) s.NOTIFY_API_KEY = process.env.NOTIFY_API_KEY;
  if (process.env.WAKE_SINK_SECRET) s.WAKE_SINK_SECRET = process.env.WAKE_SINK_SECRET;
  process.stdout.write(JSON.stringify(s));
' > "$secrets"
# The blob bucket (wrangler.jsonc, BLOBS) must exist before a Worker that binds it.
bucket=html-artifact-publisher-blobs
npx wrangler r2 bucket info "$bucket" >/dev/null 2>&1 || npx wrangler r2 bucket create "$bucket"
# Uploads stage under tmp/ and are copied to their name once verified; a stage
# outlives its upload only if the Worker stopped mid-upload. Expire those.
# A failure here only leaves stray stages to accumulate: warn, and deploy anyway.
if rules=$(npx wrangler r2 bucket lifecycle list "$bucket" 2>/dev/null); then
  if ! printf '%s\n' "$rules" | grep -q 'expire-tmp'; then
    npx wrangler r2 bucket lifecycle add "$bucket" expire-tmp tmp/ --expire-days 1 --force ||
      echo "deploy: warning: could not add the expire-tmp lifecycle rule to $bucket" >&2
  fi
else
  echo "deploy: warning: could not list $bucket's lifecycle rules; not adding expire-tmp" >&2
fi
# Deploy static serving first; it has only R2, never app secrets or account bindings.
if ! npx wrangler deploy --config wrangler.public.jsonc >"$public_log" 2>&1; then
  cat "$public_log" >&2
  exit 1
fi
cat "$public_log"
if [ -z "${PUBLIC_ORIGIN:-}" ]; then
  PUBLIC_ORIGIN=$(node -e '
    const log = require("node:fs").readFileSync(process.argv[1], "utf8");
    const url = log.match(/https:\/\/[A-Za-z0-9.-]+\.workers\.dev\b/);
    if (!url) { console.error("deploy: cannot discover public Worker origin; set PUBLIC_ORIGIN"); process.exit(1); }
    process.stdout.write(url[0]);
  ' "$public_log")
fi
[ "$PUBLIC_ORIGIN" != "$APP_ORIGIN" ] || { printf '%s\n' 'deploy: public and app origins must differ' >&2; exit 1; }
# The wake sink rides the deploy only when set; unset keeps wrangler.jsonc's empty values.
set --
[ -z "${WAKE_SINK_KIND:-}" ] || set -- "$@" --var "WAKE_SINK_KIND:$WAKE_SINK_KIND"
[ -z "${WAKE_SINK_URL:-}" ] || set -- "$@" --var "WAKE_SINK_URL:$WAKE_SINK_URL"
[ -z "${NOTIFY_AGENT:-}" ] || set -- "$@" --var "NOTIFY_AGENT:$NOTIFY_AGENT"
[ -z "${NOTIFY_SUBSCRIBER:-}" ] || set -- "$@" --var "NOTIFY_SUBSCRIBER:$NOTIFY_SUBSCRIBER"
npx wrangler deploy --secrets-file "$secrets" --var "APP_ORIGIN:$APP_ORIGIN" --var "PUBLIC_ORIGIN:$PUBLIC_ORIGIN" --var "EMAIL_FROM:$EMAIL_FROM" --var 'TEST_MAIL_TRANSPORT:' \
  --var 'TEST_CLEANUP_PAUSE_MS:' --var 'TEST_CLEANUP_FAULT:' --var 'TEST_TOMBSTONE_STALE_MS:' --var 'TEST_UPLOAD_HOLD_MS:' "$@"
# CI must not mistake the first (public) Worker URL for the signed-in app.
printf 'APP_URL=%s\nPUBLIC_URL=%s\n' "$APP_ORIGIN" "$PUBLIC_ORIGIN"
