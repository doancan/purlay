# D-309. Company sign-in is bounded by its retained workspace origin

**Context.** A native user can belong to several unrelated workspaces and be a server
administrator. An exact company identity binding proves who the person is for that company;
it does not authorize that company's provider to exercise the person's other authorities.
The real native callback followed by HTTP access reproduced the cross-workspace gap.

**Decision.** Capture `sessions.company_workspace_id` in the same native transaction as
the company session and its exact binding proof. It is deliberately not a foreign key: a
company, provider, proof or membership purge must never make a surviving session global.
Independent sign-ins leave it null. Session resolution and canonical resource guards consult
the current provider revision, domain proof, exact binding and full native membership. A
company session can use only its origin workspace and cannot exercise server administration
or change global authentication credentials without an independent sign-in.

Company cookies use a separate Host cookie and a domain-separated MAC. Only a new reader
verifying that MAC may translate it internally for native session lookup; it never returns the
native MAC to the browser. An old reader therefore rejects the credential even if renamed.
Session refresh and sign-out preserve the same boundary; an independent successful sign-in
clears the company cookie. Malformed company credentials never fall back to a stronger cookie.

**Rejected.** Email-domain authority, treating a canonical user ID as a global company grant,
using the presence of a cascade-deleted proof as the source marker, and a cookie-name-only
boundary that an old reader accepts after renaming. The full corporate scope of D-308 remains.

The origin is immutable after native creation commits. Request and socket scope carry only that
server-observed classification, so independent sessions do not plan company proof joins on the hot
path. Provider state, binding, membership, account admission and expiry are always read again for
company authority; none is cached as a grant. Independent reauthentication creates a new session.

Company output uses one bounded projection queue, including replies and replay. Source retirement
ends the session, terminal session events preempt queued work, and a failed or unavailable projection
closes to resynchronize. Workspace events, mixed channel revocations and account-wide presence are
projected before side effects or bytes leave the socket. A live publication received during replay
cannot overtake its acknowledgement. The batched liveness sweep also checks retained company origins.

Push capture selects only current devices authorized for the source workspace. Prepared chat/inbox
payloads and the final leased handoff repeat that authority check, so recovery cannot revive a retired
provider or route a different company's content to the old subscription. Independent devices retain
the canonical person's normal workspace access. No provider I/O holds a SQL transaction.

An independently proved password, authenticator step or email link replaces the browser's company
cookie only after completing that proof. A pending second step keeps its challenge cookie and the
existing company session. Company device enrollment cannot claim an independent endpoint without
its browser keys, prune independent devices at the cap, or remove them through unsubscribe. Global
profile and credential management require an independently established session.

Company identity contracts have their own `@purlay/types/workspace-identity` entry point; the client
loads their request implementation on use. Provider decoders stay out of the first chat bundle.
The measured initial JavaScript is 257.96 KB gzipped, within the unchanged 258 KB shell bound.
Configuration follows the existing settings primitives: DNS proof, saved provider, real sign-in
test, explicit enablement and observed revisions. Own linking is explicit. Failed save, removal
and unlink operations report inside the focused task and retain input for retry.

Native authorization codes retain the company workspace and source session without cascading foreign
keys. Their digest domain differs from independent codes, so an older binary cannot exchange one for
global authority. Exchange locks and rechecks the source, then copies its exact current provider proof
and origin into the new native session atomically. Native clients retain the established cookie name
with the separate company MAC; old readers still reject it. Workspace retirement invalidates the
native session through the same proof checks as the browser session.

Unsent upload removal applies the same source-aware SQL predicate as reading an own upload. The push
pump exits the waking request's async context; its work is authorized by each durable claim and device,
so one company's request cannot cancel an independent device's other-workspace work.

**Cost of reversing.** Close company admission and end company-origin sessions before removing
these readers. Retain the additive origin column and existing audit evidence; do not reinterpret
a source-bearing row as independent or rewrite an applied migration. Independent sessions,
canonical accounts and chat data remain.
