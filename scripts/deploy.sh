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
[ -f src/fossil.wasm ] || { echo "deploy: src/fossil.wasm is missing; run npm run build:wasm" >&2; exit 1; }
# The same size budget as fossil/build.sh: never deploy an oversized engine.
gz=$(gzip -9c src/fossil.wasm | wc -c)
budget="${FOSSIL_WASM_MAX_GZIP:-880000}"
[ "$gz" -le "$budget" ] || { echo "deploy: src/fossil.wasm is $gz bytes gzipped, over the $budget budget; rebuild with npm ci && npm run build:wasm (README: Building the Fossil engine)" >&2; exit 1; }

secrets=$(mktemp)
trap 'rm -f "$secrets"' EXIT INT TERM
node -e '
  const s = { BEARER_TOKEN: process.env.BEARER_TOKEN };
  if (process.env.NOTIFY_API_KEY) s.NOTIFY_API_KEY = process.env.NOTIFY_API_KEY;
  process.stdout.write(JSON.stringify(s));
' > "$secrets"
npx wrangler deploy --secrets-file "$secrets"
