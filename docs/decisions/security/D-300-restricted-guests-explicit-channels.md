# D-300. Restricted guests use the existing membership with explicit channels, verified invitations and a strict join history floor — builds on D-21, D-34, D-115, D-179

**Context.** The requested SME/corporate chat scope includes named external people without granting them the
organization's public channels or historical messages and files. The user explicitly selected only content
shared after the guest joins. A guest flag hidden only by the client is not authority: the existing public
channel, attachment, search and notification readers all need the same boundary.

**Decision.** The existing workspace membership carries an additive member/guest access descriptor, a trusted
guest history floor, optional expiry and opaque allowed-module labels. Owner/admin/member roles remain the
existing roles; a guest can hold only the member role. Existing memberships and generic invitations are unchanged.
Named guest invitations bind a verified address, bounded explicit channels and optional access expiry; a generic
invitation or role patch cannot promote the guest. The core reaches channels through its existing port and keeps
no foreign key to a module's tables. Guests reach only explicitly granted conversations, and message visibility
starts at the later of their current guest admission and channel grant. Read/unread controls cannot move that
security floor. A removed or expired guest cannot recover scope by reconnecting or reusing old identifiers.

A post-admission reply beneath an earlier root remains useful. History, around, waiting-thread and followed
readers may return an additive `Message.historyHidden:true` container only when a currently readable reply
exists. The root's known IDs remain for traversal; its content, author, original time, files, reactions,
resolution, knowledge and integration metadata stay absent. `createdAt` is the first readable reply's activity
time, never the hidden message time; the summary counts only readable replies. `replyAllowed` is false when
new replies are unavailable. Generic message/file/action routes stay strict; a guessed earlier root without
readable continuation remains404. Eligibility precedes pagination and masked roots bypass old sidecar readers.
The thread keeps current replies, follow/read and permitted Reply, with an explicit localized history boundary
and no earlier-content actions. A container never advances the channel read receipt. A guest's first live reply
refreshes their permitted root feed; bursts share one follow-up reader per actual cached Query.

Every surface that reads or delivers messages or files enforces current scope and history, including search,
threads and quoted context, pins, questions, inbox, exports, attachment URLs and queued/live delivery. Private
integration metadata and the organization directory are not implicitly shared by workspace membership. Scope
changes are administrator actions with atomic audit records and live revocation. Converting to full membership
is explicit and explains the wider access. Guest admission is not enabled before every reader enforces the
contract; mixed-server rollout must not create guest rows for an unrestricted reader.

List and replay statements recheck current membership even when their context was captured as a full member
before removal and restricted re-admission. A sender-owned message ID identifies an idempotent retry; it does
not authorize earlier content. Every retry return applies current message visibility before building content,
knowledge, attachments or other sidecars. A hidden earlier message returns the same message-not-found refusal.

Admission is closed by default through the boot setting `GUEST_ACCESS_READY=false`. Setting it true
is the operator's explicit attestation, following D-292/D-296's cluster-ready model, that every API,
scheduler and job/outbox reader runs the guest-capable revision. API presence, an empty peer registry
or absence of Redis is not proof about background readers. This flag does not discover deployment
topology. New guest mint/mail, membership admission and expired-guest reactivation refuse with
`409 PEERS_BEHIND` until attested; ordinary invitations and existing guest reads/removal/conversion
remain available. An idempotent acceptance creates no new membership and stays idempotent. Disabling
admission does not make an old unrestricted binary safe over existing guest rows: retain capable
readers until those memberships have been removed or explicitly converted. In the managed deployment,
verify every actual API/scheduler/job image revision before enabling admission.

The same admission gate covers guest recipient resends: a replacement is a new mint/mail operation.
While closed it leaves the existing invitation, recipient attempts and mail quota unchanged; ordinary
recipient resends remain available.

Guest creation has one verified-recipient email, one to twenty explicit conversations, an optional
access end and the interface locale. Email queues through the existing quota/receipt relay after commit;
a named copy link is returned once even without SMTP. Invitation listing, recipient tracking and preview
carry an additive count/end descriptor for guests; it contains no hidden conversation IDs or names and
never claims that a guest link grants reusable full membership. The settings form defaults access to
the invitation's seven-day window, allows a deliberate no-end choice and preserves input on refusal or
the confirmed link when a subsequent list refresh fails.

Timestamped channel collaboration content follows the same current boundary: bookmarks use stored
`added_at`, incidents use stored `declared_at`, and timeline entries also use their stored `at` before
pagination. Client UUID time and captured full-member contexts cannot widen those reads. An earlier
incident's report, runbook, responders, timeline and write/idempotent responses remain hidden; its
identifier answers `404 INCIDENT_NOT_FOUND`. Current channel identity/configuration and the open-incident
status badge remain shared as current channel state. Ordinary members retain earlier history.

Collaboration writes take the channel's existing no-key-update mutex before rechecking current scope and
channel membership, so they serialize with guest scope changes/conversion. This mutex also serializes
incident edits, reports and responders, replacing their narrower incident-row mutex. Returned incident
words and responder identities use one SQL authority snapshot; timeline actors/named responders join the
final paged statement rather than a later identity lookup. Current account state, guest module, expiry,
explicit scope and the later admission/grant floor are applied in that final statement too.

A guest deliberately resharing a known URL whose bookmark is hidden creates a new share with a new ID,
time, their identity and only their supplied title. The old header entry is atomically replaced under the
same channel mutex, including at the header limit. A visible duplicate keeps the original idempotency
(D-218). A rejected or failed replacement preserves the prior row; a guessed hidden bookmark ID cannot
remove it. No invitation-creation exposure or readiness claim follows from these reader repairs.

Explicit conversion requires an affirmative full-access acknowledgment and preserves the existing role, identity,
join date and channel/read state while clearing guest metadata. An expired guest may be converted deliberately;
a repeated request preserves a later role change and records no second audit. The target's additive workspace
update hint triggers a fresh authorized socket subscription rather than discarding pending sends. That hint
is not authority: even a stale hint can only resynchronize using the current membership.

A captured guest deadline is rechecked against current membership when it is reached. Restricted output stops
while that bounded check is pending; the connection's original scopes for that workspace share the check,
including older future and unlimited snapshots.
Current full or extended membership requests a fresh authorized subscription without an access-revocation frame
that would discard pending sends. A current denial revokes those original scopes; an unavailable lookup resynchronizes
without inventing denial. Detached or replaced scopes cannot apply the answer. Concurrent checks share a lookup
only within the same database executor, user, workspace and deadline, and no answer survives its in-flight check.
An unnamed access revocation also refreshes the account's membership receipt; named channel-only reasons keep
their existing behavior. These fallbacks do not replace durable cleanup or the admission readiness gate.

Captured subscriptions are not current authority before their deadline either. A socket opened as a full
member may outlive removal and restricted re-admission while control publications are lost. Every chat
channel subscription therefore installs current delivery authority, including full members; an older
transport without that gate refuses the subscription before replay. A captured full policy still delivers
ordinary member history, but a current guest policy requests reauthorization before any payload.
Ordinary personal updates, acknowledgments and PONG keep their causal order behind queued channel
authority reads, sharing the existing byte bound. Session end and access-change resync bypass obsolete
projection immediately; the policy hint is written before close and the queued tail is retired. Every channel
publication reads the canonical active account, workspace, applicable module and channel membership,
current history floor and access end before writing words. Recipients queued for the same publication share
bounded batches of at most 500 waiters. Pending `CHANNEL_STATE` authority reads also share a batch across
recipient-specific frames (#1388); those frames retain their independent transport queues and payloads.
The database executor, channel, workspace, message and recipient remain
part of the lookup's identity; the batch detaches before dispatch, so neither a started nor a completed
statement authorizes a later arrival. Message creation time comes from the stored row, including a readable
tombstone's clearing event, rather than a publisher's event time or supplied creation time. A current denial
releases that channel; changed active access requests fresh authentication and history without discarding
pending sends. An unavailable lookup resynchronizes rather than inventing denial. This also covers control
events lost by one publisher while another publisher continues to send. On the access-change hint the client
resets affected cached feeds and related workspace content immediately, cancelling old reads instead of
keeping their words visible until invalidation finishes; the pending send store is independent.

Content cache cleanup also runs before a current account receipt reaches the UI when a membership disappears,
its guest kind/history/end changes or chat becomes unavailable. A stable receipt and an omitted legacy full-member
descriptor do not reset content. Channel revocation cleans resource-only caches before removing channel-list
ownership. The cleanup takes one ownership snapshot of cached channel lists and message/window/thread payloads,
retains content proven to belong elsewhere and resets uncertain ownership rather than treating a missing list as
proof of another workspace. Direct cards, edit versions, file text, channel content and workspace aggregates use
the same boundary. Existing followed rows retain their filtering and optimistic-undo contract; an uncached first
page is cancelled so its late answer cannot briefly restore a revoked root. Personal settings and pending sends
remain independent. This cache boundary must also invalidate old optimistic content and late accepted mutation
fallbacks; a response authorized before the change cannot restore words after the current history floor changes.

Optimistic pins/saves and bookmark writes capture the current resource Query identity and a weak access marker.
The same ownership selection invalidates those markers before reset/notification. Reset can keep the Query
instance but replaces its marker; removal or an account clear replaces the instance. Neither reset counters nor
timestamps can revive an old completion. A per-client revision only notifies mounted intent providers; each
intent's resource ticket decides validity, so proven unrelated pending work survives. Stale intents are filtered
during render, and Retry/Undo plus asynchronous acceptance/refusal and confirmed-refresh fallback check the
captured ticket. A stale response cannot clear a newer intent. Successful sign-out, erasure and link sign-in
remove old Queries before notifying subscribers; an actual account switch also notifies after clearing prior
content. Current immediate optimism and confirmed fallback remain, without changing pending sends or drafts.
This metadata is weak and carries no content, server authority, schema, persisted cache or infrastructure.

Workspace access changes also clear the former channel list and member directory after taking the ownership
snapshot; a re-admitted guest cannot reuse full-member names or contacts. Channel-only revocation retains its
existing filtered channel list and unrelated rooms. When a current receipt removes a membership or chat itself,
cleanup resets/cancels and removes selected Queries without eagerly refetching under the previous receipt.
Allowed active readers with uncertain ownership then bind fresh Queries after publication; closed readers
unmount without an extra module request. A temporarily absent refreshed channel list is not a membership-loss
receipt and cannot discard an otherwise retained pending guest send.

Account reconciliation runs synchronously on the exact account Query's committed network success, after
its current receipt is cached and before queued React readers render. Cleaning active content while the
cache still holds the old receipt can start a request for an unavailable module. A concurrent manual
profile-cache write cannot consume that success; the one-shot subscription ends on success, failure,
removal or abort. A cancelled transport answer is rejected before any cache or draft-ownership effect.
An account switch preserves only the exact session Query, also clearing personal subkeys such as quiet
hours and missed-mail preferences before notifying optimistic content providers.
Channel-list observers (including code-repository lookups) also recheck the current cached workspace
and module receipt when subscribing: a render prepared under the prior context can subscribe after
that receipt has closed chat. They retain render-time enablement as well, so reopening still starts
the newly allowed read. This prevents obsolete requests without replacing server authorization.

Live engine callbacks also belong to the session Query's captured weak marker and current receipt actor.
A real account change invalidates that marker before notifying mounted readers, even when the session
Query itself is retained. Clearing/recreating it or returning A→B→A cannot revive an old engine's
projection; an ordinary same-actor receipt refresh keeps the marker. The immediate actor comparison also
covers a callback at the new receipt's commit before reconciliation listeners run. Old frames, status
reconnects and subscription refusals cannot project, invalidate current queries or apply a session-ended
side effect while React still owes the old provider its passive stop. The replacement engine captures the
new marker and continues normally. The provider keeps a valid session lifetime across ordinary receipt
or workspace updates, but rebuilds an invalidated lifetime even when React coalesces A→B→A into one
render with the same final actor ID. This preserves unrelated pending sends instead of rebuilding an
engine on every access revision. Private child state remounts at that account lifetime boundary,
including a coalesced A→B→A receipt, so old composer words/files and queued uploads cannot acquire the
replacement engine. Ordinary transport or workspace changes preserve the valid account's work.

Outgoing enqueue, retry, typing/activity, reconnect and public presence callbacks use the same captured
account owner. A refused enqueue throws an explicit client `UNAUTHENTICATED` error before the composer
can clear text or files. The current composer keeps them and asks the person to review and send again;
an offscreen refusal keeps its draft/files and stops automatic waiting. Old account callbacks cannot
name their private file or channel in a new-account toast, overwrite a newly claimed draft or allocate
new HTTP deadline work. Pending notification observers may synchronously change accounts, so ownership
is checked again before persisting the edited pending list. Native socket send exceptions close the
broken socket and use the existing same-message-ID HTTP fallback. The session-ended frame and physical
close announce one loss; a fresh authenticated open may announce a later loss. These client guards do
not depend on storage availability or replace server authority or the remaining late-callback audit.

Imperative HTTP send echoes and replay pages also capture the channel's resource access marker before
starting. An ordinary empty feed Query anchors that marker before the first feed mounts; a valid first
send must still learn its accepted row. Changed access prevents an old echo from inserting words while
its accepted send is retired. A stopped engine ignores its old success or refusal and preserves the
idempotent retry. Replay work checks subscription ownership and current resource access before another
page and before each projection. Every socket status transition cancels and releases its active owners.
An obsolete completion cannot acknowledge
a replacement gap or remove its owner. Browser pending-message writes also require the same personal
storage claim, so late acknowledgments/refusals after sign-out or account change cannot recreate cleared
private keys. Existing scopes, ordinary retries and independent pending sends retain their behavior.

Each active replay owns one AbortController passed through the real API/HTTP adapter, including while
reading a response body and across its later pages/retries. Stop, socket changes, unwatch, permanent
subscription refusal, tracked Query removal and selected access changes release the owner and its cache/
access subscriptions immediately, then abort transport. An adapter ignoring abort still cannot hold a
replacement owner or retain subscriptions until its promise settles. Unrelated resource changes do not
cancel a valid replay. Retry waits cancel their timer and remove their signal listener; success or
exhausted retries release subscriptions without later aborting the completed signal. This replaces the
separate replay-generation/waker bookkeeping and keeps only active owners in the replay map.

The retention job `sweep:guest-expiry` runs every quarter hour even with chat disabled. Access is
already denied at the exact database expiry; the job is no grace period. It cancels pending sends,
releases their unused file reservations, removes reminders and notices, and clears unread counters,
while retaining expired membership and explicit channel choices for administrator review/renewal.
Each run takes at most 100 guests, each at most 100 schedules/reservations/reminders, 500 notices and 20
counters. The existing pending rows are its durable queue; partial/busy work and late commits remain
eligible on the next run, with no processed cache or cursor to lose at restart. Each guest commits
atomically. Ordered child/reservation/file claims precede nonblocking workspace/membership locks;
a fresh database-time guest check protects renewal/conversion, and a busy parent or child is skipped,
never waited on while holding the opposing lock. Job outcomes report counts/deferred work through
`job_runs`, without claiming that a guest was removed or exposing content.

Guest administration pages memberships by join time and identity, including expired guests. Search is literal
username/display-name text rather than account email. The module batches visible scope identities for the
page; private or unavailable assignments contribute only a count. Scope replacement preserves those hidden
assignments, and an empty visible selection is allowed. A preparation snapshot changed while waiting for the
membership mutex is refused and refreshed rather than acquiring newly discovered channel locks out of order.
Explicit extension of expired access starts a new admission/history floor and resets channel read baselines;
a scope-only edit never reactivates it. Expiry changes revoke retained live policies too, so captured old expiry
cannot outlive a shortened grant or prematurely end an extended one. Audit metadata records counts and expiry
changes, not hidden channel identities. Identical edits record and publish nothing. After commit, revocation
precedes channel invalidation, followed by workspace invalidation for the guest and its current administrators.

Installed chat data keeps membership deletion authoritative even when its runtime is absent: a chat-owned
membership lifecycle trigger clears that workspace/person's conversation memberships and remembered departures.
It adds no core column or core-to-module foreign key and is absent from a core-only schema. The application
still captures revocation identities before deletion. Fresh named guest admission also replaces legacy orphan
conversation grants left by an older runtime or restore; an existing guest grant extension keeps its current
scope. A new invitation cannot silently reactivate an unselected private conversation. Removal or voluntary
leave invalidates the guest's memberships and current administrators' directories after revocation.

The guest metadata migrations expand constant-default columns first, validate their constraints in separate
statements and build the expiry/directory indexes concurrently. A legacy guest-token backfill commits at most
1,000 rows per batch. Every step outside the wrapping transaction can resume after interruption; no shipped
migration or stored checksum is rewritten.

Guest invitations store a type-tagged digest (`guest:` followed by the SHA-256 hexadecimal digest). A normal
invitation retains its plain hexadecimal digest, and the database binds each encoding to its access kind.
An older invitation reader can therefore never match a guest link and accidentally admit its holder as a
full member. This encoding does not replace the cluster's guest-reader readiness gate: old readers must
still be absent before a guest membership is created.

Guest admission locks its selected channels for update before the workspace membership mutex. Message
inserts take a channel foreign-key key-share lock before choosing their recipients, so an overlapping
send waits until the grant commits and counts a newly readable message for the guest. Invitation
creation uses a no-key-update workspace mutex: it still serializes with membership administration but
does not block a sender holding a workspace foreign-key key-share lock while waiting for the channel.
Real concurrent transactions reproduced both a deadlock and a missing initial unread count with weaker
locks. Expiry is checked again after lock waits, and the guest admission/history timestamp is taken then,
not when the request arrived.

**Rejected.** A second Better Auth organization membership authority beside the existing one; an ordinary member
role with client-only hiding; public discovery followed by a denied message; reusing mutable unread scopes as
history permission; email-only automatic account linking; treating a library plugin's availability as a shipped
application feature. Provider-neutral OIDC/SCIM remains the enterprise identity path, including Google Workspace,
without assuming an outbound provisioning feature is present on every provider plan.

**Cost of reversing.** Guest admission can be disabled while restrictive readers remain. Revoke or explicitly
convert guest memberships before removing those readers; never roll an unrestricted server back over live
guest rows. Additive metadata remains and no earlier content or membership is discarded.
