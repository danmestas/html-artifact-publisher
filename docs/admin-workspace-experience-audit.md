# Admin workspace experience audit

Date: 2026-11-05. Audience: the sole instance owner of a small private team.

This is a post-change workflow audit and Norman review, not a usability study. Frequencies and scores are judgments, not usage telemetry. The initial source-only audit estimated 5.7/10; this pass uses explicit weights and real local browser observations, so the comparison is directional rather than a measured conversion lift.

## Summary

| Workflow | Assumed frequency | Weight | Before | After | Remaining friction |
| --- | --- | ---: | ---: | ---: | --- |
| Find and inspect an artifact | Weekly | 3 | 6.5 | 8 | Inspecting named access still requires Manage access. |
| Investigate an administrative change | Weekly | 3 | 5 | 8 | No date-range control or dedicated automatic-expiry quick filter. |
| Orient and navigate administration | Every visit | 2 | 7 | 7.5 | All artifacts versus Every artifact can still require a moment of interpretation. |
| Identify and adjust impending expiration | Occasional | 2 | 4 | 8 | No restore; a pending projection can require refresh to confirm. |
| Invite a collaborator | Occasional | 1 | 6.5 | 6.5 | Acceptance window is still 60 minutes; artifact sharing is separate. |
| Review and suspend a departing person | Rare | 1 | 4 | 7 | Ownership transfers remain per artifact; suspension does not revoke capability links. |
| Clean up unpublished copied files | Rare | 1 | 6 | 6 | Confirmation explains safety boundaries but has no dry-run preview. |

**After: 7.6/10**, rounded from the weighted mean of 98.5 / 13. The largest gains are the weekly investigation and inventory workflows, not cosmetic changes.

## Exact workflows and observations

### 1. Find and inspect an artifact — 8/10

Four core interactions: choose **Every artifact** → enter a title → open the artifact → use **Library** to return. Owner/status filters, sort selection and Show more each add an interaction when needed. On a phone, opening Menu adds one.

The inventory now shows expiry without opening Manage. Finite deadlines sort earliest first, ties paginate consistently, and never-expiring items sort last. Search, owner, status, expiration and expanded count survive refresh and viewer return. On narrow screens owner, visibility, status and expiry remain visible in each row instead of disappearing with desktop columns. Empty and loading copy describe instance inventory rather than the owner's personal shelf.

Named-access inspection remains a separate Manage access action; this is not yet a permission matrix.

### 2. Investigate a change — 8/10

Four core steps: choose **Activity** → enter a person/email, artifact title/ID or target → choose an event kind → read the matching entry. Show older events adds a step when needed.

Search and kind compose on the server before pagination. Both remain selected when loading older results; refresh restores the expanded result count. Publish, delete and comment-link rotation are readable sentences with artifact titles. Deadline changes distinguish a finite new deadline, removal of expiration, and historical entries whose value was not recorded. Automatic deletion appears as System activity with the title preserved. Delete/expired entries do not offer broken viewer links.

An empty search offers Clear filters; a failed request offers Try again without discarding search or kind. There is no date-range control, and identifying an unknown expired artifact still involves scanning the Artifacts kind rather than selecting an automatic-expiry-only view. Events retain the existing second-resolution timestamp and stable tie-breaker, not guaranteed subsecond causal ordering.

### 3. Orient and navigate — 7.5/10

One desktop interaction, or two on a phone: open Menu if necessary → select the named destination.

Page titles, URL state, selected navigation, context-specific loading text and relevant empty states make the current mode visible. Artifact privacy copy is no longer shown on unrelated People, Activity or credentials pages. Filled admin searches keep a visible label. A member following an admin expiry URL is returned to a usable personal library with owner-only state removed, rather than an invalid sort request.

The distinction between All artifacts and Every artifact remains a naming refinement opportunity.

### 4. Identify impending deletion and adjust it — 8/10

Three triage interactions: choose **Every artifact** → select **Expiring in 7 days** → select **Expires soonest**. To change a result, five more interactions: open Manage → Expiration → choose date/never → Save → verify the resulting state.

The seven-day filter composes with owner, status and title. Dates are shown in the browser's zone, identified in the inventory note and management dialog. Permanent private-content deletion and independent public copies are explained. A pending projection is described as accepted but not yet confirmed, not falsely saved.

Expired contents and old listings are not retained. The new Activity record is evidence of automatic deletion, not an expired-artifact library or a restore facility; old deletions cannot be backfilled from missing content.

### 5. Invite a collaborator — 6.5/10

Four owner interactions: People & invitations → Invite someone → enter email (and optionally name) → Send invitation. The recipient then opens the email and confirms the link. Sharing an artifact remains a separate owner action after the recipient is eligible.

The interface explains membership versus artifact access. Invitations show link expiry, sent time and resend cooldown. The 60-minute acceptance window and actual production email delivery were not changed by this work. Local loopback-mail verification does not prove recipient delivery.

### 6. Review and suspend a departing person — 7/10

Eight core interactions: People & invitations → search the person → View N artifacts → inspect their inventory → Back → open person actions → Suspend account → confirm.

The person row shows current artifact count, including archived work, and the latest actually recorded sign-in. A missing sign-in record is not labeled never signed in; legacy activation markers are not treated as timestamps. Suspended people retain the link to their work. The confirmation explains retained artifacts and that previously issued capability links still work, so suspension is not presented as complete access revocation.

Transfers remain per artifact. A complete offboarding process can still require separate ownership and capability-link decisions.

### 7. Clean up copied files — 6/10

Four interactions: Published links → Clean up unpublished files → review/confirm → inspect the reported count.

The existing confirmation describes what is eligible and says live public snapshots and original histories are not removed. This work does not add a preflight list or dry-run count. The score is intentionally unchanged.

## Norman review

| Principle | Assessment |
| --- | --- |
| Affordances | Search fields, native filters, underlined View N artifacts links and existing management controls are perceivable actions. Person links have 44px targets. |
| Signifiers | Filled searches retain visible labels; Expires soonest and Expiring in 7 days describe their effects. Phone Activity filter targets are 44px. |
| Mapping | Person links set the exact owner filter, including suspended owners; Activity kind and search remain coupled; expiry columns retain a mobile equivalent. |
| Feedback | Loading, result counts, selected filters, suspension notification, error retry and pending-expiration messaging expose state without false success. |
| Conceptual models | Archive, suspension, private expiration and public-copy lifetime remain distinct. Missing historical metadata is not interpreted as never expires or never signed in. |
| Constraints | Owner gates remain enforced by the API; owner-only sorts are removed during member fallback; existing destructive confirmation remains intact. |
| Prevention and recovery | Clear filters and Try again recover empty/error states. Deleted entries do not send the owner to a known-dead viewer. Suspension warns about capability links. |

**Result:** the reviewed admin workflows have no remaining release-blocking interaction issue. The signifier, phone-target and suspension-model findings from this pass were addressed rather than merely scored.

## Evidence and verification boundaries

- `test/admin-workspace.test.mjs`: real local Worker API coverage for filters, pagination, role restrictions, metadata, idempotent automatic-expiration audit, counts and recorded sign-in semantics.
- `test/admin-workspace-browser.mjs`: real local browser coverage for inventory, people, suspension, Activity, member fallback and recovery. The legacy-Activity presentation case injects the historical public-response shape once; ordinary search, pagination and deletion checks use the real Worker.
- Inventory screenshots: 320, 390, 768 and 1280px, light and dark. People: 320/1280px. Activity: 320/390/1280px. Generated under `.wrangler/admin-workspace-qa/` and not committed.
- Run the focused browser flow with `ACCOUNTS_BROWSER_QA_ADMIN=1 node --test --test-concurrency=1 --test-name-pattern='real browser: admin workspace' test/accounts.test.mjs`.
- Full local CI and the existing complete navigation/browser matrix remain release gates. This audit does not substitute for them.
- No production test artifacts, emails, publications or destructive operations were used for the audit. Native mobile accessibility and real-user timing have not been studied.

## Remaining improvements, ranked by leverage

For this small-team owner, the next candidates are:

1. Add Activity date-range and automatic-expiry quick filtering, making unknown-artifact investigations easier without changing content retention.
2. Refine All artifacts versus Every artifact naming so personal browsing and instance administration need less interpretation.
3. Consider a reviewed bulk-transfer workflow if owners regularly leave with many artifacts; preserve explicit consequences for named grants and capability links.
4. Decide whether invitations need a separate, longer acceptance lifetime. This is a security-policy decision, not a cosmetic default.
5. Add a read-only cleanup preflight if maintenance volume justifies it.

A restorable Expired library would require a separate retention decision. It is not implied by the new expiry visibility or audit metadata.
