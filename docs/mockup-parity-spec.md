# Approved mockup parity

## Scope confirmation

The user explicitly selected **Complete the approved mockup**, not a broader artifact platform. Complete A–Z sorting, artifact-specific gallery previews, visible access badges, and consistent themes. Authoring remains upload, CLI, and existing artifact APIs. Native AI authoring, comments, connectors, new export formats, embedding, and organizational groups are not part of this change.

Reference: `/tmp/artifact-library-mockup.html`. Preserve the later approved compact phone rows and collapsed navigation; the mockup's device and role switchers are simulation controls, not production impersonation features.

## Requirements

1. Library sort offers Recently updated and Name A–Z. Sorting is server-side, deterministic and case-insensitive, with stable pagination. Changing sort resets pagination; viewer return and browser Back retain the selected sort, query, view and cursor. Existing clients default to recent order. Reject incompatible/malformed cursors. Apply to personal and instance-owner inventory.
2. Replace generic identical gallery glyphs with previews derived from each artifact's actual HTML. A preview is static: it must never execute artifact JavaScript, invoke its runtime bridge, load remote resources, or mutate data. Clearly identify static previews and open the ordinary interactive viewer on activation. Mobile lists stay compact and do not load hidden preview frames.
3. Visible shelf permissions distinguish Private, Shared by you, Can view and Can edit; instance-owner access must not imply creator ownership. Maintain readable visibility/status/owner/update labels in desktop inventory, without expanding ordinary phone rows beyond the approved compact design. Report a real filtered total when showing N of total, not an invented count.
4. Per the subsequent user refinement, signed-out login follows system appearance and has no appearance selector. Once signed in, restore the saved system/light/dark choice for the library and viewer without overwriting it during login or logout. Store only local preferences, never credentials. Preserve correct contrast and explicit mobile Share label.

## Design constraints

Use existing vanilla JS/CSS, Registry SQLite, Repo/WASM and Worker routing. No new paid service, AI provider or auth system. Sorting may use SQLite NOCASE with an ID tie-breaker; document deterministic collation rather than claiming locale-specific ordering. Add a sort option to existing APIs without breaking default recent cursors or legacy lists.

For previews prefer a same-origin authenticated `/p/:id` document route with a **response CSP sandbox** (opaque origin, no allow-scripts or allow-same-origin), `default-src 'none'`, inline styles only, data images/fonts only, no forms/base/object/frames, and `frame-ancestors 'self'`. Parent library CSP can retain its strict script/style policy; its existing default-src self can load a same-origin preview route. Native iframe also uses an empty sandbox, no focus or pointer interaction; card activation stays in the trusted parent. Strip scripts, nested frames/objects, base elements, meta refresh, handlers, and navigation targets. Do not loosen the host library CSP to allow arbitrary inline scripts/styles merely to support previews. Responses private/no-store and authorized with existing caller permissions. Mark unsupported/no-HTML/oversized preview cases honestly and retain usable title/open controls.

Avoid loading every file of a large artifact to obtain its entry HTML. A small application-owned Fossil `preview` operation can resolve the current check-in, ListFiles, prefer index.html then another HTML file, and read a bounded preview payload. This uses existing go-libfossil APIs, not an upstream workaround. Keep payload bounded (e.g. 256 KiB), return a safe fallback when it cannot provide a meaningful static preview. Use lazy frame loading and cleanup on navigation/layout changes; no execution of untrusted scripts as an implementation shortcut. Multi-file assets may be omitted in static previews; the full viewer remains authoritative and the UI must not pretend a fallback is a screenshot.

Use actual permission/ownership fields, not client-inferred privileges. Member previews, totals, sorted lists, and archived views must preserve the same server-side ownership/grant restrictions. Anonymous private previews must be denied; revocation/suspension must affect new preview requests. Capability links and existing viewer behavior remain compatible.

## Verification

- Add tests for alpha/recent order differing, case ties, duplicate-free pagination, filtered/archived sorting, invalid cursors and viewer-return sort continuity.
- Add preview permission tests (owner, creator, read grantee, write grantee, unrelated member, anonymous) and hostile HTML fixtures. Verify CSP/sandbox, script non-execution, no outbound resource requests, and static-preview click opening the real viewer.
- Browser tests verify permission labels and desktop inventory headings, compact mobile rows, no hidden mobile preview loading, actual distinct preview content, and theme consistency across login/library/viewer at desktop and phone sizes.
- Produce a control-by-control mockup parity matrix. Explicitly identify simulation-only controls and the user's approved replacement of mobile cards with compact rows.
- Run exact CI with Node24, Go1.26, TinyGo0.43.0 and pinned Binaryen. Repeat DX and Norman visual/functional checks, retaining the >9.0 target without score inflation.

The first account/library release is already merged and deployed as a994e1f. Preserve production's existing artifacts and links. Follow-up changes go through a separate PR; do not write directly to main.
