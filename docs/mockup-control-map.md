# Approved mockup control map

The user explicitly chose **Complete the approved mockup** after reviewing the distinction from a broader artifact-authoring platform. This matrix defines the control-level acceptance scope. It does not claim parity with AI authoring, comments, connectors, native document exports, or other excluded platform features.

The source prototype is the interactive Artifact Library Preview. Its later mobile redesign was approved separately: compact rows and collapsed navigation replace the prototype's tall phone cards. Production behavior replaces simulations; imitation of demo-only bypasses is not required.

| Original control or state | Required real behavior |
|---|---|
| Login email and send-link button | Invite-only email-link request; actionable failure and generic unknown-account response. |
| Continue to library | Explicit one-time-token confirmation, not the prototype's unauthenticated bypass. |
| Sign out | Revoke the current authentication and remove library contents from the page. |
| Appearance toggle | Updated user requirement: login follows the system without a selector; the saved system/light/dark choice is restored inside the app and retained across logout. Artifact-authored colors remain the author's choice. |
| All artifacts / Created by me / Shared with me / Starred | Permission-filtered views; stars belong to each account. Instance owner retains access to every artifact. |
| Search artifacts | Search actual titles; preserve query/view when opening and returning from an artifact. |
| Recently updated / Name A–Z | Both actual server-side sort orders, including stable pagination, filters and viewer-return continuity. |
| Preview cards | Artifact-specific static HTML previews where supported, with honest fallbacks. No artifact script or external resource execution in the library. |
| Open artifact | Preview/title activation opens the interactive viewer; metadata/management remains available separately. |
| Private / Shared by you / Can view / Can edit | Visible access signifiers based on actual ownership and grants; instance-owner authority is not misrepresented as creator ownership. |
| Star / Unstar | Persistent per-account toggle; not a shared mock-data flag. |
| Manage access and recipient selector | Creator/instance owner can add active members, choose read/write, change or remove grants. The instance owner's inherent access is not a removable grant. |
| Publish artifact | Real HTML upload; CLI guidance and personal credentials also available. Upload errors allow correction without losing the flow. |
| People & invitations | Owner-only membership management, including owner/member/pending states. |
| Invite someone | Real member invitation by email. A member-only role chooser may be omitted because there is no alternate invitation role. |
| Every artifact | Owner-only inventory across accounts, including private and archived work. |
| Admin search, owner and status filters | Real filtered results; totals and displayed records have the same authorization filter. |
| Desktop inventory column labels | Clear mapping for artifact, owner, access/visibility, status and update information; phone metadata stays compact. |
| Open preview / Manage sharing | Actual viewer and sharing actions from an artifact's management menu. |
| Archive / Restore | Persistent state, explicit warning that archive is not access revocation, and a member-accessible Archived view for recovery. |
| Transfer ownership | Instance owner selects an active account, confirms, and named grants are cleared as disclosed. |
| Delete / Cancel / Confirm | Destructive confirmation; cancellation has no effect. Typed DELETE is an intentional safeguard beyond the prototype. |
| Administrative activity | Persistent successful-action records. A dedicated Activity view is equivalent to the prototype's inline log. |
| Dialog close, empty states, feedback | Keyboard-accessible close/cancel, focus recovery, loading/success/failure feedback and usable empty states. |
| Phone version | Compact ordinary rows, wrapped long names, 44px targets, collapsed navigation, readable dialogs, no page overflow; gallery frames are not loaded while hidden on phones. |

## Simulation-only controls

- **Login / Library / Instance owner shortcuts in the design-preview bar:** replaced by actual navigation and authorization.
- **Preview as owner/member:** replaced by separate authenticated accounts. Shipping an identity bypass would be a security defect.
- **Desktop / Phone switch:** replaced by responsive behavior on real browser viewports; development screenshots cover both sizes.
- **Fictional artifact headings and types:** replaced by actual artifact content and metadata, not copied sample records.

## Intentional extensions

Pagination, browser upload, persistent activity, account suspension/reactivation, personal credential revocation, typed deletion confirmation, and member archive recovery extend the prototype while retaining its intended workflows.

## Evidence required for completion

The final parity audit must pair this map with source/test references and observed desktop/phone, light/dark behavior. Passing UX scores alone do not establish coverage. Record unsupported preview cases and any remaining deviations explicitly rather than treating decorative placeholders as functional previews.
