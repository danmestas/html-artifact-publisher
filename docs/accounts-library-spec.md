# Accounts, library, and instance administration

## Alignment

Implement the approved HTML artifact mockup as a working application, not demo screens. The instance owner can inspect and manage every artifact, including private and archived artifacts. Members see their own and explicitly shared artifacts. Preserve existing token links, Fossil sync, CLI publishing and version history. Users sign in with emailed one-time links, by invitation only. No public registration. Mobile lists must be compact rows, with navigation collapsed and management actions in a menu. Use `/tmp/artifact-library-mockup.html` as visual reference, not as production source.

Acceptance: login/logout and invitation acceptance work; unknown emails get generic responses; one-time tokens expire and cannot be replayed; users cannot access another member's unshared artifacts; instance owner can manage all; member creators manage their own sharing; read recipients cannot mutate content; archived artifacts are hidden from the default library but restorable; transfer and delete require explicit actions; listing is bounded and paginated; new publish via a personal credential appears in the correct library; legacy artifacts belong to the instance owner; phone UI handles many items without tall metadata cards; history and token links still work.

Out of scope: AI generation/chat/model integrations, real-time co-editing, marketplace, comments, complex organizations. Functional equivalence is the approved artifact library and management experience, not the whole Claude platform.

## Analysis

`src/index.ts` routes all API and viewer access. `src/repo.ts` grants read/write by link hash or instance bearer. `src/registry.ts` holds artifact identity/slug/title metadata in a singleton SQLite Durable Object. `public/viewer.js` assumes fragment tokens; make session-only viewer access work too. `public/client.js` is shared by CLI and viewer. Existing E2E tests exercise real Wrangler and Fossil sync. Repo content belongs in Repo; account membership, sessions, ownership, grants and personal stars belong in Registry. Add tables / columns, never rebuild Fossil stores. UI is static HTML/CSS/JS served by Worker assets; no frontend framework required.

## REASONS Canvas

### Requirements and entities

Account: id, email, name, role (`owner` or `member`), status (`active`, `invited`, `disabled`). The unique instance owner is configured by `OWNER_EMAIL`; use stable id `instance-owner`. The operator supplies this environment setting for each installation. Changing the configured owner email must invalidate the prior owner's sessions, pending login links and personal credentials rather than transferring their access to the new email silently. Instance-owner privileges are separate from artifact creator ownership. No endpoint lets members promote themselves. Prevent disabling/deleting the sole owner.
Artifact metadata adds ownerId, archived, personal starred, permission and sharing summary to existing data. Legacy null owners resolve to instance-owner. Archive is organization only, not access revocation: links still work; UI must say this. Every account has an Archived library view with the same access checks as its normal library, so member creators can find and restore their own archived artifacts without needing instance administration. Preserve the documented Fossil multi-request sync semantics: README Limits explains that a check-in can arrive in an earlier request than an oversized file. Atomicity is per HTTP/SQLite transaction, not across an entire clone/push exchange. Tests must verify oversized content rejection and repository recovery without incorrectly requiring rollback of check-ins committed by an earlier request. Do not expand this account feature into an upstream Fossil sync redesign. Transfer clears named grants to avoid stale sharing, does not silently invalidate capability links. Deletion preserves existing hard-delete semantics with an explicit destructive confirmation.
Login tokens: random, hash-only persisted, expire in 15 minutes, atomically consumed. Session cookies HttpOnly, SameSite=Lax, Secure on HTTPS, scoped path /, 7-day lifetime; no credentials in browser storage. User suspension revokes all sessions and API credentials. Personal API credentials are random and stored hashed; returned once, revocable. Existing BEARER_TOKEN remains privileged and compatible.

### Approach and structure

Extend Registry for accounts, sessions, invitations, grants, stars, administrative audit records and paginated library queries. Server decides privileges; UI visibility is not an authorization boundary. Do not treat a named read grant as owner access. Account-session access must not leak read or write capability tokens. Existing explicit capability-token requests retain legacy behavior. Email delivery uses Cloudflare Email Sending binding `EMAIL` with configured `EMAIL_FROM`. `APP_ORIGIN` is the only origin used for links; do not trust arbitrary Host headers or client redirects. Production must never return magic links in JSON. Local tests use an explicitly isolated loopback-only test mail transport.

### Shared API contract (frontend and backend must follow)

All JSON errors `{error: string}`, no-store. Browser fetch uses same-origin cookies. All browser state-changing API requests validate Origin equals request origin; do not introduce wildcard credentialed CORS. Explicit bearer/token clients preserve compatibility.
- GET `/api/session` -> `{user: {id,email,name,role}|null}`. Also returns `csrfToken` only if needed by implementation; prefer strict Origin check.
- POST `/api/auth/request` body `{email}` -> generic `{ok:true}`. Rate-limit requests by normalized email and client IP; handle absent mail configuration safely with 503 (not pretend success for known users if delivery fails). Generic unknown/disabled email responses.
- POST `/api/auth/verify` body `{token}` -> session cookie and `{user}`. Login page reads token from URL fragment, removes it immediately, then POSTs only on explicit Continue click so mail scanners do not consume it. Callback URL `APP_ORIGIN/login#token=...`.
- POST `/api/auth/logout` -> clear cookie + `{ok:true}`.
- GET `/api/library?view=all|mine|shared|starred|archived&q=&cursor=&limit=25` -> `{artifacts:[{id,title,ownerId,ownerName,updatedAt,createdAt,expiresAt,viewerUrl,permission:'read'|'write',canManage:boolean,archived:boolean,starred:boolean,visibility:'private'|'shared'|'link'}],nextCursor:string|null}`. Archive excluded by default.
- GET `/api/admin/artifacts?q=&ownerId=&status=all|active|archived&cursor=&limit=25` -> same list. Instance owner only. Sort updatedAt descending plus id for stability.
- GET `/api/people` -> `{users:[{id,email,name,role,status}]}`. Instance owner only.
- POST `/api/invitations` body `{email,name?}` -> `{ok:true}` sends invite/login link; owner only; existing active members must not be demoted or reinvited accidentally.
- PATCH `/api/people/:id` body `{status:'active'|'disabled'}` -> `{ok:true}`, owner only, not owner target.
- GET `/api/artifacts/:id/sharing` -> `{ownerId,grants:[{userId,email,name,permission:'read'|'write'}]}` creator/instance-owner only. Include users eligible to share via `users:[{id,email,name}]` so members do not need `/api/people` access.
- PUT `/api/artifacts/:id/sharing` body `{userId,permission:'read'|'write'|null}` -> `{ok:true}` creator/instance-owner only; target active account.
- PATCH `/api/artifacts/:id/manage` body `{archived?:boolean,ownerId?:string,title?:string}` -> `{ok:true}`; owner transfer instance-owner only, rename/archive creator or instance owner.
- PUT `/api/artifacts/:id/star` body `{starred:boolean}` -> `{ok:true}` account with access; per user.
- DELETE `/api/artifacts/:id` -> existing 204; session-based deletion only creator/instance owner, not ordinary edit grantee.
- GET `/api/admin/activity?limit=25` -> `{events:[{id,actorName,action,artifactId,artifactTitle,createdAt}]}` instance owner only.
- GET `/api/credentials` -> `{credentials:[{id,name,createdAt}]}` own credentials only.
- POST `/api/credentials` body `{name}` -> `{id,name,token}` one-time display.
- DELETE `/api/credentials/:id` -> `{ok:true}` own credentials only.
- Existing POST `/api/artifacts` accepts personal bearer credentials or session and attributes owner server-side; browser UI supports single self-contained HTML file upload (base64 files), title, persistent ttlSeconds:null. Existing CLI default TTL remains unchanged.

Frontend paths `/` and `/login` serve new application shell. Worker first for `/`, `/login`, `/api/*`, existing viewer/sync/health routes. `/v/:id` without fragment uses session; existing fragment-token links retain explicit token access. UI can link directly to viewer. Sharing dialog distinguishes named people from existing capability links; do not promise link revocation unless fully implemented across API and Fossil sync.

### Operations and ownership of files

Backend implementer owns `src/*`, `wrangler.jsonc`, `.dev.vars.example`, backend test `test/accounts.test.mjs`, `scripts/deploy.sh` if required, `README.md`. Frontend implementer owns new `public/index.html`, `public/library.css`, `public/library.js`, modifications to `public/viewer.js`, `public/client.js` ONLY where needed for session access. Do not change viewer API behavior for existing tokens. Controller owns CI/build tooling and integration tests. Coordinate contract changes through report, don't silently invent different routes.

### Norms and safeguards

Use existing TypeScript/vanilla JS style. No extra architecture layers. No secrets or AI attribution in commits/docs/PRs. Never log tokens. Add regression tests before claiming completion; tests must run in CI with real local Wrangler. Include IDOR, CSRF, replay, expiry, invitation restrictions, pagination, revoked sessions, read/write grants, personal credential isolation and legacy compatibility. Database changes additive and idempotent. Do not weaken test timeouts or skip tests to get green. Bound inputs, result sizes and upload sizes. UI must use textContent for user-supplied titles/emails, accessible controls, focus restoration on dialogs, visible error/loading/empty states, 44px touch targets and reduced-motion support. Destructive changes require confirmation. Users must see that private artifacts are accessible to instance owner.

## Validation target

Replicate CI: npm ci, npm run types, npm run typecheck, npm run test:go, npm run build:wasm (TinyGo 0.43.0, Go 1.26, pinned Binaryen), npm test. Functional browser tests cover owner/member workflows, desktop and phone, light/dark, long names and many artifacts. Run independent security review and `/dx-audit` and `/norman`; target >9.0 with evidence, not score inflation. Production email delivery must be separately proven or clearly marked unverified. PR stays unmerged pending user approval under current pr-policy.
