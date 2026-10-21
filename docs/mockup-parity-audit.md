# Approved mockup parity acceptance

## Scope and verdict

**Pass for the user-confirmed approved mockup scope.** The user explicitly selected “Complete the approved mockup” rather than a broader artifact platform. This release closes the four remaining gaps: A–Z sorting, artifact-specific static previews, visible access labels, and consistent appearance. It retains the later approved compact phone layout.

This is not a claim of equivalence with every feature of another platform. Native AI authoring, comments, connectors, document-format exports, embedding and organizational groups were explicitly excluded from this follow-up. Upload, CLI and existing artifact APIs remain the authoring paths.

The [control inventory](mockup-control-map.md) is the requirement trace, not merely a feature summary. Every production control has an implemented equivalent; prototype role/device/login bypass controls are intentionally replaced by real authentication and responsive layouts.

### Subsequent approved refinement

After this audit, the user requested that login follow system appearance without a selector. The current implementation preserves the saved in-app theme while signed out and restores it after sign-in. The browser regressions now check this behavior on desktop and phone. References below to a login selector describe the originally audited release, not the current requirement.

## Measured experience

| Workflow | Weight | Score | Evidence / remaining cost |
|---|---:|---:|---|
| Browse/find/open | 25% | 9.3 | Search/sort/pagination and viewer return preserve state; actual previews improve recognition. Management remains behind a named menu. |
| Publish/update | 20% | 9.1 | Upload, viewer history and restoration work; prepared HTML is still required, as intended. |
| Share/access | 15% | 9.1 | Named grants and visible labels work. Capability links remain a separate, disclosed access model. |
| Owner management | 15% | 9.0 | Inventory filters, totals and confirmed management work; dialogs remain information-dense. |
| Login/invitation | 10% | 8.7 | Explicit confirmation, invitations and recovery work locally; delivery was not rerun in this usability pass. |
| CLI setup/revocation | 10% | 8.8 | Placeholder-only setup guidance and revocation work; manual CLI configuration remains. |
| Failure recovery | 5% | 9.1 | Fetch retry, upload correction, fresh-link recovery and member archive restoration work. |
| **Weighted DX** | **100%** | **9.065 → 9.07** | Strictly above 9.0. |

Norman principle scores, equally weighted: affordances 9.1, signifiers 9.1, mapping 9.0, feedback 9.1, conceptual models 9.0, constraints 9.3, recovery 9.0. **Mean 9.085714… → 9.09.** Scores are the independent review's assessment, not inflated after the small polish corrections below.

## Executed checks

- Exact local CI steps: clean install, generated Wrangler types, TypeScript, Go vet/tests, pinned TinyGo build and the complete test suite.
- Regression suite: **32 passed, zero failures or skips**.
- Opt-in account/browser suite: **11 passed, zero failures or skips**. Repeated after the last UI polish.
- Build: **2,441,338 bytes raw; 853,142 gzipped**, below the 880,000-byte engine budget.
- Existing real-browser navigation matrix: **48 permutations**, no horizontal overflow, ordinary phone rows **83–84px**, minimum sampled text contrast **4.73:1**.
- Independent captures: **16 current-app states** at **1440×1000 and 390×844**, light/dark, covering login, library, inventory and viewer. Original mockup captured for paired comparison.
- Independent source security/compatibility review found no actionable defects in preview authorization/isolation, bounded extraction, sorted cursors/totals, appearance storage or legacy links. This was supplemented by runtime preview/browser regressions, not treated as a substitute for them.

Run browser verification with `ACCOUNTS_BROWSER_QA=1 node --test test/accounts.test.mjs` after building the engine and installing `agent-browser`. Test fixtures and mail transport are isolated and local; no real mail is sent by these suites.

## Control-to-implementation trace

| Mockup control / outcome | Implemented equivalent | Evidence |
|---|---|---|
| Email, send link, Continue, sign out | Invite-only request, explicit one-time confirmation and revocation; no demo bypass | `test/accounts.test.mjs`, `test/library-browser.mjs` |
| Theme toggle | System/light/dark selectors on login, library and viewer; shared safe preference | `public/appearance.js`, `test/parity-browser.mjs` |
| All / Mine / Shared / Starred | Actual authorized collections and per-account stars | `src/registry.ts`, account and browser suites |
| Search | Real title filtering; filter/view survives viewer return and Back | Account and browser suites |
| Recently updated / Name A–Z | Server-side recent and case-insensitive name order, stable ID ties, compatible cursor validation | `src/accounts.ts`, `src/registry.ts`, sort tests |
| Preview cards / open | Distinct sanitized HTML from the artifact, not a generic glyph; activation opens the interactive viewer | `src/preview.ts`, `fossil/main_js.go`, `test/parity-browser.mjs` |
| Private / Shared by you / Can view / Can edit | Server-derived labels shown on the shelf without pretending instance authority means creator ownership | Account tests and four-label browser assertions |
| Star / Unstar | Persistent per-account toggle | Account and browser suites |
| Manage access, recipient, read/write/no access | Grant, change and remove named permissions; inherent owner authority is not a removable grant | Account tests, sharing source and browser workflow |
| Publish | Browser HTML upload plus CLI guidance/credentials; validation failures allow correction | Browser upload and credential workflows |
| People / pending / member / owner | Real account states and owner-only management | Account tests and navigation captures |
| Invite someone / Member role | Real invitation; single Member choice is enforced rather than simulated | Account tests and browser invitation workflow |
| Every artifact | Owner-only inventory includes other accounts, private and archived items | Account tests and inventory captures |
| Owner/status/search filters and N of total | Actual filters with the same permission constraints on rows and totals; total computed before pagination | Sort/filter/total tests |
| Desktop metadata labels | Visible inventory headings and self-describing screen-reader labels on list metadata | `public/library.js`, browser label assertions |
| Open / sharing / archive / restore | Real viewer/sharing actions and persistent archive recovery, including members' Archived view | Account and browser suites |
| Transfer | Active-account choice, acknowledgement and named-grant clearing | Account and browser suites |
| Delete / cancel / confirm | Typed DELETE; cancellation closes without mutation | Browser deletion workflow and inspected cancellation handler |
| Administrative activity | Dedicated persistent Activity view rather than an inline demo log | Registry/account source and navigation matrix |
| Dialogs / empty states / feedback | Close/Escape, focus recovery, loading/success/error states and retry | Browser workflows and source review |
| Sidebar account divider | Tightened spacing and edge-to-edge divider, including expanded phone navigation | Browser geometry assertion |
| Phone view | Approved compact rows/collapsed navigation; no hidden gallery frames or preview requests | Layout matrix and preview browser tests |
| Preview-bar shortcuts / role switch / device switch | Simulation-only controls, replaced by actual navigation, separate accounts and viewport responsiveness | Original prototype and real authentication/layout evidence |
| Fictional card headings/types | Actual content and metadata replace sample records | Paired captures and distinct-content assertions |

## Preview and sort security evidence

Tests cover owner, creator, read/write grantee, unrelated member and anonymous preview requests, plus revocation and suspension. Preview documents have both a response-level opaque sandbox and an empty native iframe sandbox. Scripts, navigation targets, event handlers and nested frames are removed; CSP blocks resource attempts. Browser inspection found no executing scripts or runtime bridge, and hostile resource attempts failed with CSP blocking rather than receiving responses. Directly opening a preview retains its restrictive policy.

Sorting tests distinguish name order from recency, cover case ties and duplicate-free pages, preserve filtering/archives and reject incompatible or malformed cursors. Filtered totals do not count inaccessible artifacts. Viewer return preserves query/sort/page; shared links omit private browsing context.

## Paired and final visual evidence

- Desktop reference: [original dark](evidence/mockup-parity/original-library-dark-desktop.png), [original light](evidence/mockup-parity/original-library-light-desktop.png).
- Implemented desktop: [final dark](evidence/mockup-parity/current-library-dark-desktop.png), [independent light capture](evidence/mockup-parity/current-library-light-desktop.png).
- Phone comparison: [original tall layout](evidence/mockup-parity/original-library-dark-phone.png), [approved compact implementation](evidence/mockup-parity/current-library-dark-phone.png).
- [Final compact phone viewer](evidence/mockup-parity/current-viewer-dark-phone.png).
- [Independent capture measurements](evidence/mockup-parity/capture-measurements.json). The `frames` field counts gallery-preview frames, not the interactive viewer's content frame.

Fixtures are explicitly local test content. The final dark desktop capture includes deliberately hostile markup rendered as inert text to verify isolation; it is not production content. No credentials appear in these images.

After review, small corrections added screen-reader metadata labels, corrected member archive-recovery wording, made the unavailable-preview document theme-aware, reduced the phone viewer bar to two rows, and restored the requested full-width account divider. Browser assertions cover those corrections. Earlier independent captures are retained as comparison evidence; the final dark desktop and phone-viewer captures reflect the polish.

## Deliberate limits

- Previews are sanitized static HTML, not screenshots or miniature executing apps. Script-only, SVG/canvas-only, oversized, non-HTML and dependent external/multi-file content may require a fallback or have reduced fidelity. The full viewer remains authoritative.
- Preview output is bounded at 256 KiB; that bound applies after reading the selected file, not before its allocation. Existing artifact/file limits still apply.
- Name sorting uses deterministic SQLite ASCII NOCASE, not locale-specific Unicode collation.
- No physical-device Safari or complete screen-reader timing certification is claimed. Inventory is a labelled list, not a semantic data table.
- Real delivery was not rerun during this local parity audit. The earlier hosted-preview delivery check remains recorded in [accounts-audit.md](accounts-audit.md).
- A nonrequired installed linter panicked because its Go version did not match the selected toolchain. Required Go vet/tests and exact CI commands passed; that optional tool is not reported as passing.
