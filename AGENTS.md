# Working on html-artifact-publisher

Instructions for agents changing this repository. To publish pages with it instead,
use the skills in `skills/` (start with `skills/publish-html-page`). To set up a new
instance on someone's own Cloudflare account, follow `docs/self-hosting.md`.

## Build

```bash
npm ci                 # also installs the pinned wasm-opt (Binaryen 132) the build needs
npm run build:wasm     # fossil/ → src/fossil.wasm
```

- Use **TinyGo 0.43.0 exactly** and Go from `fossil/go.mod`. `fossil/build.sh` checks the
  TinyGo version and stops on any other.
- **Never install or use another `wasm-opt`** (Homebrew, apt, a TinyGo-bundled one on your
  PATH). The build uses `node_modules/.bin/wasm-opt` for TinyGo's own passes and a final
  `-Oz` pass, which is what makes the engine the same size on every OS.
- A correct build prints about **1,798,900 bytes, 753,400 gzipped**. The build fails above
  800,000 bytes gzipped. Find the cause (README, "Building the Fossil engine") rather than
  raising the budget. Raise `FOSSIL_WASM_MAX_GZIP` only when a change in the same commit
  needs it, and say so in the commit message.
- `GO_COMPILER=go` builds a much larger engine for debugging. Never deploy it.

## Test

```bash
npm run typecheck
npm run test:go        # driver and size-limit unit tests
npm test               # end-to-end and Pikchr tests (starts its own wrangler dev)
```

Run all three before pushing. CI runs the same, plus the build.

## Deploy

Merging to `main` deploys the build CI just tested. Prefer that. To deploy by hand:
`npm run build:wasm && npm run deploy:prod` (secrets come from Doppler project
`html-artifact-publisher`, config `prd`). `scripts/deploy.sh` refuses an engine over the
size budget.

## Rules

- Never print, commit or post `BEARER_TOKEN`, edit links, clone URLs, or any token.
- After publishing or updating an artifact, post its read link (`viewerUrl`).
