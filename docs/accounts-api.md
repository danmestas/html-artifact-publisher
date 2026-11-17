# Accounts and library API

Reference for account sign-in, library queries and instance administration. Artifact contents, comments, attachments, public copies and Fossil sync are covered by the [HTTP API](../README.md#http-api).

## Authentication and access

- Accounts are invite-only. An account has `id`, `email`, `name`, role (`owner` or `member`) and status (`active`, `invited` or `disabled`).
- The instance owner can inspect and manage every artifact, including private and archived work. The stable owner ID is `instance-owner`; legacy artifacts without an owner belong to that account.
- Account endpoints require an account identity: the `artifact_session` cookie or a personal bearer credential. The legacy instance bearer retains artifact/CLI compatibility but does not itself identify an account. Its only management exception is `PATCH /api/artifacts/:id/manage` with exactly `{expiresAt: ISO|null}`; it cannot rename, archive, transfer or manage sharing through that endpoint. Read/edit/comment links do not authorize expiration changes.
- A creator or instance owner manages named sharing, title, expiration, archive and deletion. A named editor can edit content but cannot manage access, ownership or deletion. Read grants do not permit content mutations or comment moderation. With guest discussion enabled, readers may identify separately and post text-only discussion.
- `GET /api/artifacts/:id` includes `readToken` for the artifact owner and instance owner so Share can offer a reusable read link without signing out. Named readers and editors do not receive that token through account access; edit tokens are never returned. A read link permits viewing and guest discussion, not page editing or deletion. Existing read, edit and comment links remain separate access mechanisms.
- JSON responses are private/no-store. Errors use `{error:string}`. A supplied Origin must match the request origin; browser writes without an explicit credential require that matching Origin. Explicit authenticated CLI clients remain supported.

## Sign-in and invitations

| Route | Body | Result |
| --- | --- | --- |
| `GET /api/session` | — | `{user:{id,email,name,role}\|null}` |
| `POST /api/auth/request` | `{email,challenge?,returnTo?}` | Generic `{ok:true}` for unknown, invalid or disabled addresses; sends a link for eligible accounts, plus an alternative code when a valid challenge is supplied |
| `POST /api/auth/verify` | `{token,rememberDevice?}` **or** `{challenge,code,rememberDevice?}` | `{user,returnTo}` and the authentication cookie; invalid/expired/replayed credentials return 401 |
| `POST /api/auth/logout` | — | Clears the cookie and returns `{ok:true}` |
| `POST /api/invitations` | `{email,name?}` | Instance owner only; invites or resends to a pending account, without demoting an active member |

Sign-in links are single-use, expire after 60 minutes and are consumed only after the recipient explicitly continues. The login page removes the token fragment before making requests. Link requests are limited to five per email and 60 per client IP in 15 minutes. Requests past the limit keep the generic response; an invitation resend can return `429 {error,retryAfter}` with a Retry-After header in seconds.

The sign-in UI generates a random 256-bit `challenge` (64 lowercase hexadecimal characters) in the requesting browser. The email includes an alternative eight-digit code, valid for ten minutes and at most five attempts for that challenge. Code verification is also limited to 60 attempts per client IP in 15 minutes. The challenge is not authentication by itself; its raw value is never stored server-side. Code hashes include the challenge as a salt, so a stored code hash alone does not permit guessing the small code space. A link and its alternative code consume the same login atomically; using either invalidates both. Exhausting code attempts disables the code but leaves the high-entropy email link usable until its own deadline. Legacy clients that omit `challenge` continue to receive link-only email.

`returnTo` is sanitized and stored with the login at issuance, so opening email in another tab does not lose the destination. Allowed destinations are the library's supported filters or `/v/<id>` with an optional `#@<version>`; external URLs, capability fragments and artifact query strings are discarded. Confirmation returns the stored destination, not a new client-supplied redirect. This does not grant artifact access. Login links still require explicit confirmation and never authenticate on GET.

The authentication cookie is HttpOnly, SameSite=Lax, path `/`, Secure on HTTPS, with a seven-day lifetime by default. An explicit boolean `rememberDevice:true` at confirmation selects 30 days in both the cookie and server-side session. A successful sign-in rotates any prior session cookie supplied by that browser. Cookies are host-scoped, not shared between unrelated hostnames. Sign-out, suspension and owner rotation continue to revoke sessions server-side. Login links use configured `APP_ORIGIN`; sender configuration uses `EMAIL_FROM` and the email binding. Known-account delivery/configuration failures return 503 rather than a false success.

A remembered session older than 15 minutes may still read and edit ordinary content, but must sign in again before creating an API credential, sending an invitation, adding a named grant (including guest upgrades), transferring ownership or reactivating an account. These actions return `403 {error,reauthRequired:true}` without performing the mutation. Revoking credentials/grants, withdrawing invitations, suspending accounts and signing out remain immediately available. Existing seven-day sessions and explicit authenticated CLI credentials retain their previous behavior. The UI does not automatically replay a security-sensitive action after reauthentication.

Changing `OWNER_EMAIL` preserves the owner ID and artifact ownership but revokes prior owner authentication, credentials and pending links. An address already used by a member is rejected rather than silently merged.

## Library and inventory

| Route | Query | Access |
| --- | --- | --- |
| `GET /api/library` | `view=all\|mine\|shared\|starred\|archived`, `q`, `sort=relevance\|recent\|name`, `cursor`, `limit` | Account's authorized library |
| `GET /api/admin/artifacts` | `q`, `ownerId`, `status=all\|active\|archived`, `sort=relevance\|recent\|name\|expiry`, `expiry=all\|soon`, `cursor`, `limit` | Instance owner only |
| `GET /api/search` | Same search/filter/cursor fields; optional `scope=inventory`, `artifactId` | Personal credentials: authorized library; legacy instance bearer: inventory; artifact Token: required exact-artifact scope |

See [Content search](search-api.md) for remote-agent CLI/HTTPS examples, credential boundaries, snippets, coverage and resumable backfill.

Results contain `{artifacts,total,nextCursor,searchCoverage}`. Inventory also returns `counts:{all,active,archived}` under the same search, owner and expiration filters. Counts are computed before pagination; status counts are available for the status tabs. `limit` defaults to 25 and is bounded to 1–100. Treat `nextCursor` as opaque and reuse it only with the same query and ordering.

Each artifact includes `id`, `title`, `ownerId`, `ownerName`, `updatedAt`, `createdAt`, `expiresAt`, `viewerUrl`, `permission`, `canManage`, `archived`, `starred`, `visibility` and `accessLabel`.

- Recent order is updated time descending with a stable ID tie-breaker.
- Name order uses SQLite's ASCII NOCASE ordering, not locale-specific Unicode collation.
- Expiry order puts finite deadlines first, earliest first with ID ties; never expires comes last. This ordering is admin-only.
- `expiry=soon` selects live deadlines within the next seven days, inclusive, combined with owner, search and status filters.
- With a non-empty `q`, the default is relevance. Current titles and server-extracted current HTML are searched; complete term matches precede explicitly labelled partial matches. Returned excerpts are plain text with UTF-16 match ranges, never HTML. Historical versions, script execution, private discussion/profile fields and PDF/OCR are outside scope.
- `searchCoverage` counts complete/partial/pending/error/unsupported artifacts in the authorized view before `q`. It does not count inaccessible artifacts. A stale known-version body is not used; its current title can still match while projection is pending. Existing artifacts require explicit owner-controlled backfill; a query does not start one.
- Default library views exclude archived work; the Archived view uses the same permission checks. Expired listings are excluded, not retained as a restorable library.

`GET /p/:id` serves an authorized, private/no-store static preview with restrictive response and iframe sandboxes. It does not execute artifact scripts or fetch external resources. Unsupported or oversized entries show a fallback; the interactive viewer remains authoritative.

## People and credentials

| Route | Body/result | Access |
| --- | --- | --- |
| `GET /api/people` | `{users:[{id,email,name,role,status,createdAt,artifactCount,lastSignInAt,resendAfter?,inviteExpiresAt?}]}` | Instance owner |
| `PATCH /api/people/:id` | `{status:'active'\|'disabled'}` → `{ok:true}` | Instance owner; cannot modify the owner account |
| `DELETE /api/people/:id` | `{ok:true}` for an unaccepted invitation; 409 after a completed sign-in | Instance owner |
| `GET /api/credentials` | `{credentials:[{id,name,createdAt}]}` | Own credentials |
| `POST /api/credentials` | `{name}` → `{id,name,token}`; plaintext appears once | Own credentials |
| `DELETE /api/credentials/:id` | `{ok:true}` | Own credentials |

`artifactCount` includes currently live owned work, including archived artifacts, but excludes expired content. `lastSignInAt` is the latest audited sign-in, or null when none was recorded; legacy activation markers are not treated as recorded timestamps. Invited people carry resend cooldown and pending-link expiry metadata. `createdAt` is invitation time, or null for older accounts without a recorded value.

Suspension revokes authentication, personal credentials and pending login links; artifacts remain. Reactivation does not revive revoked credentials. An account that never completed sign-in returns to invited status. Previously issued artifact capability links remain valid after suspension or credential revocation.

## Sharing and management

| Route | Body/result | Access |
| --- | --- | --- |
| `GET /api/artifacts/:id/sharing` | `{ownerId,grants:[{userId,email,name,status,permission}],users:[{id,email,name,status}]}` | Creator or instance owner; eligible people include invited and active accounts |
| `PUT /api/artifacts/:id/sharing` | `{userId,permission:'read'\|'write'\|null}` → `{ok:true}` | Creator or instance owner; new grants require an invited or active eligible account; revocation also permits suspended accounts |
| `PATCH /api/artifacts/:id/manage` | `{archived?,ownerId?,title?,expiresAt?}` → `{ok:true}` or `202 {ok:true,expirationPending:true}` | Creator or instance owner; transfer is instance-owner only. Legacy instance bearer accepts only an expiration-only body |
| `PUT /api/artifacts/:id/star` | `{starred:boolean}` → `{ok:true}` | Account with access; stars are per account |
| `DELETE /api/artifacts/:id` | 204 | Account creator/instance owner, or an authorized legacy edit link |

The sharing response supplies eligible people without giving members access to the owner-only people endpoint. Invited accounts can receive view or edit grants immediately; saving a grant neither accepts the invitation nor creates a session. Their named access becomes usable only after verified sign-in. Both sharing surfaces label pending invitees. Pending grants can be changed or removed; withdrawing an unaccepted invitation removes its pending login and grants. A new invitation to the same address receives a new identity and does not inherit withdrawn access. Suspended accounts cannot receive new grants, but existing grants can be revoked. Ownership transfer and guest-identity upgrades still require an active, verified account. The artifact owner and instance owner's inherent permissions are not removable named grants.

`expiresAt` is a real future UTC ISO instant ending in `Z`, within `MAX_TTL_SECONDS`, or null for never. Omission preserves the deadline. A date that does not exist is rejected, not normalized. Changing expiration preserves the artifact ID, content, tip and history. A pending response means the deadline is stored but its library projection is unconfirmed; retries are automatic, and refreshing confirms convergence. Expiration permanently removes private content and history; it is not an archive or restore facility.

Archive only changes organization and does not revoke access. Transfer clears named grants but leaves capability links valid. Deletion is permanent. Independent public copies remain until explicitly unpublished, including after source deletion or expiry.

## Guest discussion

A valid read link or named read grant permits text-only discussion without granting the broader comment role. Guest names are self-identified and marked unverified. Optional email is private to that browser identity, the artifact owner and instance owner; it is not included in Fossil tickets or shared discussion responses.

A named account using its account-only URL defaults to its verified account identity. A capability link defaults to its guest/browser identity; selecting `identity:"account"` separately verifies the current account cookie and changes authorship only, never the capability's content or moderation role. A named reader may deliberately select `identity:"guest"`, in which case a real private guest profile is still required. Selecting account identity does not bypass a block on the browser's existing guest profile.

| Route | Body/result | Access |
| --- | --- | --- |
| `GET /api/artifacts/:id/guest` | `{guest,canComment,canManage}`; guest is null before identification | Current artifact reader; does not create an identity |
| `PUT /api/artifacts/:id/guest` | `{name,email}` → own private guest profile | Current artifact reader; matching Origin required |
| `POST /api/artifacts/:id/guest/claim` | `{}` → identity claim, not an access grant | Guest cookie plus independent verified active account session and current artifact access |
| `GET /api/artifacts/:id/guests` | `{guests,nextCursor}` | Artifact owner or instance owner only |
| `PATCH /api/artifacts/:id/guests/:guestId` | `{blocked:boolean}` | Artifact owner or instance owner only |
| `POST /api/artifacts/:id/guests/:guestId/upgrade` | `{permission:'read'\|'write'}` | Owner approval of an already claimed, active verified account |

The guest cookie is opaque, HttpOnly, SameSite=Lax, Secure on HTTPS and scoped to `/api/artifacts/`. Its continuity lasts at most 30 days, enforced by the server; clearing it loses continuity. It never grants artifact access by itself. Blank name and email are supported. Neither a matching claimed email nor a display name proves an account identity. A claimed guest identity cannot be relinked to a different account; repeating the claim as the same account is safe. An upgrade grants named access to the verified account, not to the shared capability link, and does not rewrite historical comment authors.

Guest posting cannot resolve/reopen threads, attach files, change page content, publish or delete. A separate message-correction route permits only server-proven authors to append a correction to their own text, retaining original text and visible history; a shared token or matching display name is not authorship. Private read/follow state is likewise personal review metadata, not a ticket mutation or permission grant. Owner blocks apply to the current guest identity; clearing cookies can create a different identity, so blocking is not a verified-person ban. Posting is limited over five-minute windows to 10 posts per guest identity, 60 per artifact and 30 per client address. Profile changes and identity claims have separate limits. Rejected writes return 429 with Retry-After; client addresses are hashed rather than stored raw. Ordinary discussion does not request agent execution. Explicit agent Q&A and independent share-link expiration/revocation are separate capabilities; artifact expiration still permanently deletes content as described above.

**Rollout prerequisite:** guest discussion must not be deployed alongside a responder that treats every unanswered comment as an editing request. The responder must enforce server-owned per-change authority and intent, fail closed on unmarked discussion-enabled artifacts, and use a separately scoped Q&A path before an Ask action is exposed.

## Activity

`GET /api/admin/activity?limit=25&kind=&q=&cursor=` is instance-owner only and returns `{events,nextCursor}`. Event fields are `id`, `actorName`, `action`, `artifactId`, `artifactTitle`, `target`, `createdAt` and optional `details`.

- `kind` is `artifacts`, `people`, `credentials` or `sign-ins`. The Artifacts kind includes publish, delete, comment-link rotation, management changes and automatic expiration.
- `q` is bounded to 300 characters and searches actor name/email, artifact title/ID and target before pagination, combined with kind. Search uses SQLite case folding.
- `target` identifies the account involved in an invitation, withdrawal, suspension or reactivation; older entries may have no target.
- Accepted expiration changes carry `details:{expiresAt:ISO|null}`. Null means never; absent metadata means the historical value was not recorded.
- Automatic deletion records `expired` once as System, retaining title/ID and reason/deadline metadata after content is gone. This is an audit record, not retained artifact content.

## Local verification

The account and browser suites use isolated local Workers with `TEST_MAIL_TRANSPORT=loopback` and an exact matching loopback `APP_ORIGIN`. Only that isolated transport returns a login URL in JSON; normal responses never do. Local mail fixtures do not prove production delivery. Build and test commands live in [AGENTS.md](../AGENTS.md).
