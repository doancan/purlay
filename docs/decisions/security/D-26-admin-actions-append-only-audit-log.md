# D-26. Administrative actions are recorded in an append-only audit log

A deployment carrying a thousand accounts and a retention policy (D-27) must be able to answer
"who removed that member", "when was the integration token replaced", "who ran the purge".
Nothing in the previous documents could answer any of them.

**Decided: an `audit_log` table, append-only, workspace-scoped, written by the service layer.**

Recorded: sign-in and sign-out, session revocation, role change, member added or removed,
workspace settings change, channel creation and deletion, integration credential set or removed,
retention purge, export, and account erasure.

**Amended 2026-10-12 (#69).** Also recorded: an invitation link made or revoked, a person joining by
one (D-115), and **a message deleted by somebody other than its author** — moderation, with the
message's id and its author's, never what it said. An author taking back their own words is not an
administrative act and is not recorded. Every role-gated write in the permission table
(`testing/permissions.ts`) is held to exactly one row by a test that reads the same table, so an
administrative endpoint added there cannot ship off the trail. Sign-in, sign-out and session
revocation, which have no workspace, are the `sessions` table's to record (D-116).

**Amended 2026-10-13 (D-123).** A channel renamed (from and to) and a channel archived (its name) are
recorded; a topic is not, being somebody's words.

**Not recorded: message content, message sends, reads, or anything already recoverable from the
domain tables.** An audit log that duplicates the message table is a second copy of the most
sensitive data in the product, and `ARCHITECTURE.md` §10 already forbids logging content. The
audit log answers *who did an administrative thing*, never *what was said*.

Append-only is enforced by convention plus a test, not by a database grant: the application user
needs `INSERT` on this table and nothing else, and a test asserts no service issues `UPDATE` or
`DELETE` against it. The workspace foreign key is `ON DELETE RESTRICT` so the record outlives
the thing it describes.

**Rejected:** logging to stdout only. Structured logs are rotated, shipped and eventually
dropped by whoever operates the box; an audit trail that a log-retention setting can silently
erase is not an audit trail.
