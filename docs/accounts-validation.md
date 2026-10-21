# Account library validation

## Status

Implementation and validation in progress. The tables below are acceptance criteria, not claims of passing results.

## Behavioral acceptance

| Workflow | Positive checks | Boundaries and recovery |
| --- | --- | --- |
| Sign in and out | Owner receives a link, explicitly confirms, opens library, signs out | Unknown email generic response; expired/replayed link rejected; no token in production response; return to login after session expiry |
| Invite a member | Owner invites, member accepts, owns a separate library | Members cannot invite/promote; duplicate invitation cannot demote active user; disabled user cannot authenticate |
| Publish and find work | HTML upload and personal API credential publishing appear for actual owner | Failed upload gives actionable error; title treated as text; first page and next page do not duplicate entries |
| Share an artifact | Creator grants read/write; recipient sees Shared with me and viewer | Named viewer cannot mutate; edit recipient cannot delete/manage access; revoked grant takes effect; capability links explicitly separate |
| Instance administration | Owner sees private artifacts across accounts, searches, transfers, archives/restores, deletes with confirmation | Member cannot call admin endpoints or select arbitrary owner; sole instance owner cannot be disabled; administrative activity reflects successful actions |
| Personal organization | Stars are personal; view/search/pagination state persists during routine navigation | One member's star does not affect another; archived artifacts excluded from main library but restorable |
| CLI credentials | Generate, copy once, publish with credential, revoke | Hash-only storage; other user cannot list/revoke credential; revoked/disabled credentials fail |
| Existing viewer/history | Existing token links open; logged-in viewer opens without token; history and previous versions remain usable | Do not leak account cookie or capability tokens into iframe; old link behavior and Fossil sync tests remain green |

## Browser matrix

Desktop: 1440×1000, light and dark. Phone: 390×844, light and dark. Use isolated browser sessions and local-only test mail transport; never real addresses for fixtures. Review screenshots and exercise actual controls. Phone list rows should use approximately 72–88 px for ordinary names, grow safely for long titles, keep 44 px menu targets, and avoid horizontal page overflow. Navigation and account controls belong in a collapsible menu. Dialogs fit phone width and keyboard focus returns to their trigger.

## Experience audit scoring

Use actual workflow evidence from the built application. Target weighted score greater than 9.0/10; do not assign scores based on feature presence alone. A broken core workflow blocks readiness regardless of average.

Weights: browse/find/open (25%), publish/update (20%), share/access (15%), owner management (15%), login/invitation (10%), CLI setup/revocation (10%), failure recovery (5%). Report exact steps, observed friction, and score justification for each. Production email deliverability is a separate operational gate; a loopback mailbox does not prove real mail delivery.

## Norman review

Review affordances, signifiers, mapping, feedback, conceptual models, constraints, and error prevention/recovery. Specifically check private versus instance-owner access, archive versus revoke, named grants versus bearer links, one-time credential reveal, destructive confirmation, busy/error feedback, and navigation on small screens.

## Release gate

Run the exact CI commands with Node 24, Go 1.26 and TinyGo 0.43.0. Record all failures and corrections. Run local checks again after each PR push and inspect remote checks. Do not merge automatically. Owner email and production sender/origin configuration must be correct before deploying; never guess the identity of the privileged account.
