# D-307. Capture browser push work with its source and recover bounded attempts from PostgreSQL — amends D-126, D-286 §9, D-298 and D-299; closes #1405, #1312

**Context.** Keeping a browser subscription after a temporary provider failure did not retry the failed
notification. The RAM queue and quiet-hour map also disappeared on restart. An after-commit enqueue
would still lose work if the process died after committing its source. Durable missed mail (D-302)
solves a different transport. The first real SQL regression reproduced a retained unread notification
which a fresh sender never attempted again.

**Decision.** The source owner captures the exact notification occurrence and the devices registered
with its current server key **inside the source transaction**, through the core's push admission port
(`modules/push/notices.ts`). Chat send/edit, scheduled delivery, due reminders and pushed module inbox
notices use this path. After-commit calls only wake a worker; API startup and a one-second poll recover
committed work even without those calls. No new broker, dependency or external request in the write.
Nothing is captured while disabled or without a device, and a later device never replays older sources.
The composition root opens durable processing only after migrations and persisted settings settle;
construction, recovery polling and shutdown before readiness must not query an unmigrated schema.
Chat notices born suppressed remain suppressed; accepted work which later becomes quiet can wait.

`push_intents` is unique by source kind/occurrence, has a fixed expiry within one day of original
creation, and bounds active work to 1,000 occurrences per recipient, retiring the oldest overflow.
`push_deliveries` captures subscription/generation/session, not endpoint, keys or payload. A database
trigger rotates the generation on identity or key change, even when later changed back; renewal and
sound updates preserve it. Terminal receipts deduplicate repeated capture until original expiry.
`push_notice_budgets` admits a module/person/kind once per occurrence (three at once, then one a minute),
shared by all its devices, retries and nodes. Quiet work does not spend delivery attempts while held.

Claims use short transactions, a recipient advisory lock, parent/target row locks and a fresh lease UUID.
At most 16 handoffs run per node and two live claims per recipient across nodes. Eight eligible attempts,
a 60-second lease, exponential 5-second-to-15-minute backoff and bounded Retry-After are capped by the
original expiry. A result can settle only its own still-live lease, judged after row-lock waits; an
expired owner leaves unreplaced work recoverable. A module-none/older node leaves kinds it cannot
interpret to another node. Provider I/O and cryptography never hold claim locks.

Every attempt rebuilds metadata and rechecks exact occurrence, current source visibility, unread/mute/
hidden/deleted state, current module grant, account/session/subscription generation, attention, quiet
hours and sound. Inbox module availability is checked again after a quiet hold (#1312). Global disable
serializes with capture and marks pending parents canceled while retaining server keys/device choices.
Their bounded receipts remain until original expiry; re-enabling cannot revive them.

**Lock ordering is part of the contract.** Capture reads sessions without taking a late row lock: the
source already holds workspace FK locks, while account erasure owns sessions before workspaces. The
redundant target-session FK was removed in additive 0103; session → subscription → delivery still
cascades. A real `send`/`eraseAccount` interleaving first reproduced PostgreSQL `40P01`, then both writes
completed after this change. Erasure takes the recipient advisory lock before touching push parents or
subscriptions. Provider-result side effects take that same lock before the subscription and target,
then check the lease with a fresh clock after waits. The read of ownership alone cannot authorize a
later blocked device UPDATE/DELETE. Parent acknowledgement follows in a separate transaction. No
network work runs under these locks.

Expiry and diagnostic cleanup uses indexed batches of 500, at most four passes per pump before yielding
and continuing a full backlog. Parents are locked before a fresh snapshot locks all their children
with SKIP LOCKED. Only parents whose entire child set was obtained may cascade; another device
logout or 410 may own several children in a different order. A completely busy batch yields until
the next sweep instead of spinning, and only actually retired rows count as expired. The workspace purge uses the same
whole-child-set retirement in bounded transactions before content removal, and refuses to mark a
workspace purged while busy push records remain; a later job resumes it. State cancellation and
terminal reporting use the concurrent state/id index in additive 0104, which replaces the redundant
partial ID-only index without rewriting 0102 or 0103. Real two-intent
410/disable and 410/expiry interleavings reproduced 40P01 before this correction. It runs with all
modules off too; a fixed 500/minute sweep would grow
without bound under ordinary fanout. Stale admission budgets are swept only without live work. Account
erasure, workspace/user/subscription cascades and both export exclusions name every new operational
table. No message text, inbox params or credentials are copied into the work journal.

A stable per-occurrence/device Topic coalesces outstanding provider work, and every retry sends only
remaining TTL ([RFC 8030 §5.2/§5.4](https://www.rfc-editor.org/rfc/rfc8030.html#section-5.4)). An acceptance
followed by lost acknowledgement can still repeat: no exactly-once native alert claim. Tests kill an
actual process with SIGKILL after source commit and during provider handoff; they use real PostgreSQL and
WebCrypto, faking only the provider. Separate deterministic regressions cover two-node fairness,
per-device success/retry, stale/replaced/unreplaced leases, subscription-row waits, eight-attempt bounds,
Retry-After, authority revocation, disable/re-enable and multi-batch retention.

**Cost of reversing.** Apply additive migrations and deploy all API/scheduler readers through the normal
release path; keep the encryption key and backups. Old binaries ignore the new tables but do not provide
durable push recovery. Disable push through the existing administrator control to retire pending work;
do not rewrite applied migrations or rotate server keys to undo this feature. Native/mobile OS receipt
and corporate identity management remain separate acceptance work in #1372; Shared is already
delivered in D-306.
