# Account library acceptance

The implemented login, library, and instance-administration experience meets the requested experience threshold: **DX 9.13/10; Norman 9.21/10**. These are evidence-based usability assessments, not production-delivery certifications.

## Functional verification

- Full local regression suite: **30 passed, 0 failed, 0 skipped**.
- Opt-in real-browser account suite: **9 passed, 0 failed, 0 skipped**. Run with `ACCOUNTS_BROWSER_QA=1 node --test test/accounts.test.mjs` after building the engine and installing `agent-browser`.
- Local CI equivalent passed after the feature push: clean npm install, generated types, TypeScript, Go vet/tests, pinned TinyGo build, full regression suite, and dependency audit.
- Compiled engine: **852,616 bytes gzipped**, below the 880,000-byte budget.
- `npm audit`: **0 vulnerabilities** in the installed dependency tree.
- Independent static security review found no actionable defects in authentication, authorization, owner rotation, revocation, capability isolation, browser mutation protection, and the viewer sandbox. The subsequent acceptance recheck inspected the navigation-return validation and archived-library access filters.

The Fossil tests retain the existing storage-limit contract. Sync spans multiple HTTP requests: an earlier check-in is not rolled back by rejection of a file in a later request. Tests verify oversized-file rejection, continued cloning, and readability of previously stored content rather than asserting whole-push atomicity.

## Weighted DX assessment

| Workflow | Weight | Score | Observed outcome |
|---|---:|---:|---|
| Browse, find, open | 25% | 9.4 | Filtered view, page-two cursor, result set, page label, and scroll survive viewer return; browser Back preserves filters. |
| Publish/update | 20% | 9.1 | Phone HTML upload, rename, viewer rendering, version selection and restoration exercised across acceptance and regression passes. |
| Share/access | 15% | 9.1 | Named grants work; shared viewer URLs omit private search/cursor context; edit access does not confer management. |
| Owner management | 15% | 9.2 | Cross-account inventory, transfer, archive/restore, suspension and typed deletion confirmation exercised. |
| Login/invitation | 10% | 8.7 | Explicit one-time-link confirmation and owner/member sign-in work in isolated local tests. Live delivery was outside this usability audit; the later operational check is recorded below. |
| CLI setup/revocation | 10% | 8.8 | Credentials include an actionable placeholder-only example and documentation link; configuration still takes manual steps. |
| Failure recovery | 5% | 9.3 | Member creators can find and restore archived work; a failed fetch offers a working retry without dropping authentication. |
| **Weighted result** | **100%** | **9.13** | Above 9.0 without rounding a nonpassing result upward. |

## Norman assessment

Equal-weight principle scores: affordances 9.2, signifiers 9.1, mapping 9.3, feedback 9.1, conceptual models 9.2, constraints 9.4, recovery 9.2. Mean: **9.214285…**, reported as **9.21**.

The initial review scored DX 8.83 and Norman 8.95. Corrections preserved library navigation, supplied CLI guidance, reduced phone management headings, and completed member archive recovery. Earlier visual defects were also verified fixed: long titles wrap, artifact-opening regions are at least 44px, mobile Share has an accessible name, and instance-owner access is not presented as a removable named grant.

## Reproduced acceptance workflows

1. Navigate to page two, record results/cursor/scroll, open an artifact, and select Library. Repeat at 1440×1000 and 390×844 in light and dark. The same results and Page 2 returned; scroll returned to 37px on desktop and 152px on phone. Repeat from a filtered Created by me view and with browser Back.
2. Open Share from the filtered viewer. Its copied link contains no return location, search, or cursor. Eight off-origin or nonlibrary return targets were rejected in favor of `/`.
3. Upload self-contained HTML on a phone, rename it, grant viewing access, inspect the rendered page, then delete the disposable item with typed confirmation.
4. Compare member-owned, explicitly granted, and unrelated private archived fixtures. The member sees the first two only. Admin access and a grantee's restore attempt return 403. The member creator restores their own item through Archived without administration privileges.
5. Inspect credential instructions before and after creation. The setup example contains a placeholder, never the revealed credential. Revoke the disposable credential afterward.
6. Inject a single library-fetch failure, inspect the visible error, use Try again, and confirm recovery. Sign out and verify the library is no longer shown.

## Visual evidence

Desktop 1440×1000 and phone 390×844, in both themes. Ordinary phone rows measured about 80–83px with at least 44px action targets. Long titles grow rather than being clipped. No horizontal page overflow was observed in the sampled states.

[Visual matrix](evidence/accounts/visual-matrix.jpg) · [Navigation measurements](evidence/accounts/navigation-evidence.json) · [Member isolation and recovery](evidence/accounts/member-evidence.json)

All pictured content uses local test accounts and disposable fixtures. The credential reveal was redacted before capture. No production content or credentials are included.

## Operational limits

- **Hosted-preview email transport is verified.** A subsequent read-only Cloudflare activity-log query found two messages from the configured application sender to the configured owner marked `delivered`. No new email was sent for this check. [Cloudflare defines this status](https://developers.cloudflare.com/email-service/observability/logs/) as delivery to the recipient's mail server; inbox placement, human receipt, and link opening are not claimed. This operational evidence does not change the independently measured usability scores. The production application remains unchanged until the PR is merged.
- Native clipboard readback was denied by browser automation. The copy handler's exact placeholder-only payload was checked at the clipboard boundary, not through an operating-system round trip.
- Physical-device Safari and screen-reader announcement timing were not independently exercised. Viewport emulation and accessibility-tree checks are not substitutes for those tests.
- Management dialogs remain information-dense on phones, and CLI setup requires cloning and environment configuration. These are remaining minor usability costs, not blocked workflows.

[Implementation PR](https://github.com/danmestas/html-artifact-publisher/pull/8) · [Isolated live preview](https://html-artifact-publisher-preview.daniel-mestas.workers.dev)
