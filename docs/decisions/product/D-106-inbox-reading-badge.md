# D-106. The inbox, and what reading it does to the badge

`API.md` listed the two endpoints and `SCHEMA.md` §7.4 the table; nothing said what the inbox shows or
what marking it read moves. Served by #58.

**Amended 2026-10-28 (#787).** A client can ask for one or more stored notification reasons before
pagination, independently of All/Unread; `API.md` §6 owns the wire details. One bounded CSV string
keeps the existing single-value query convention and fits the contract generator's current JSON
Schema vocabulary. Repeated query keys, an implicit array serializer and a new custom string format
were rejected because each would make the wire contract depend on a second rule a client does not
currently receive. The filter changes neither generation/preferences nor workspace-wide mark-read
semantics; category counts remain separate. Omission includes every supported reason.

**1 · One workspace, the caller's own, newest first by when they were told.** A resolution of an old
question is told today, and belongs at the top though its message is old. At the same instant the
message orders them (UUIDv7), then the notification's id, so the order is total and the cursor exact.
`notifications.id` is not time-ordered, so the cursor is a notification of the caller's, compared as
`(created_at, message_id, id)` in the database: its timestamps are finer than a JavaScript date, and a
cursor that went through one sorts after its own row. A cursor that is not one of the caller's
notifications in that workspace is `400`, not an empty page that looks like the end.

**2 · Only from channels the caller can see now (D-34), never about a deleted message.** The rows are
kept (D-15, D-103); the inbox does not show what the person can no longer read. A notification of the
kinds that do not need anybody (`thread_resolved`) is listed like the rest: the inbox is what happened
to you, the badge is what needs you.

**3 · Reading here moves the badge, not the read position.** `unread_mention_count` is bounded by the
notifications still waiting in the channel (D-99 §4), so marking them read counts each channel's badge
again from the rows — one expression, shared with the read position — and tells the caller's devices
`CHANNEL_STATE`. The messages are still unread; they no longer need the person. A channel whose
notifications were already read is not told again. The membership rows are locked first, in one order,
as the read position locks its own, so a read here and a read of the channel at once take turns.
*(Amended 2026-10-19 by D-147: a reply the feed was read past is unread only because its notification
waits, so reading it here takes it out of the unread count too.)*

**4 · `{ workspaceId, before }` reads up to and including `before`.** "Mark all read" sends the newest
notification the person saw, so one that arrived after they looked is still waiting for them.

**5 · The query's workspace is asked of the guard first; a body is read against the contract first.**
`GET` names the workspace in its query, so a stranger, a workspace that never existed and a malformed
id are the same `404` before anything else is read, and a key given twice is `400` (the guard and
the schema would each read a different one). `PUT` names it in a body, and every body in this API is
validated before anything is looked up: a malformed id there is `400`, a well-formed one the caller
is not in is the stranger's `404`.

**Rejected: reading a notification moves the channel's read position to its message.** It would mark
everything before it read, which the person has not seen. **Rejected: deleting a notification once
read.** It is the history the inbox exists to keep (D-15). **Accepted:** the full list (not
`unreadOnly`) has no index of its own and is found through the `(user_id, message_id, type)` unique
index, sorted per request; a person's notifications are few enough that this is measured before it is
indexed (D-49). **Accepted:** `created_at` is the time the writing transaction *started*, so a send
that commits after a later one sorts behind it. A page already read past it, or a "mark all read" sent
with a `before` the person saw, can pass over a notification that arrived late by the length of one
send — it is then not on that page, or read without being shown. The window is milliseconds and the
message is still in its channel, unread; ordering by a commit-ordered key is the fix if dogfooding
shows it (#58).

**Amended 2026-10-12 (#350) — one lock order for messages, memberships and notifications.** A delete
updated the notifications before the memberships, the reverse of a read, and took the message row
`FOR UPDATE`, which a read position's foreign key check waits on: a person reading a channel while
its author deleted a message naming them deadlocked with the delete, and one failed as a `500`. Now
every writer takes, in order, the message row `FOR NO KEY UPDATE` — what its own `UPDATE` takes
anyway; edits, deletes and resolutions of one row still take turns, and a row that only points at it
is not made to wait — then the channel's memberships ordered by `user_id` (one person's, ordered by
`channel_id`), then the notifications. A send carrying attachments (D-109 §7) locks the uploads it
links, after the message row, and its workspace row last, beside the channel's: an upload holds the
workspace row and locks no existing upload, so the two cannot wait on each other.

**Amended 2026-10-13 (#491) — the tab's title says the same fact.** Phase 1 tells nobody anything
outside the page (D-12), so a tab in the background had no way to say something was waiting. The title
is `(N) <place> · <workspace> · Purlay` — `#channel`, the other person's display name in a direct
message, or the screen's own name — and N is the sum of the channels' `unreadMentionCount`: what the
badges and the inbox dot already say, read from the same cache entry the socket writes, so the three
cannot disagree. Absent at zero, and absent in Deep Work, where the badges are not drawn either.
**Rejected:** counting unread messages, which would light the tab for every message in a busy channel —
the noise D-12 exists to prevent; and counting only mentions and direct messages, a second definition
of "needs you" beside `NEEDS_YOU`, which D-29 and D-107 already settled.

**Amended 2026-10-19 — an open inbox hears every notification, not only those that move a counter.** The
client asked an open inbox again when a channel's `unreadMentionCount` rose. A notification that moves
no counter — a `thread_resolved` (§2: told, not counted), or a mention in a public channel the person is
not in, where they have no counter — never reached it before a reload. Each write that creates a
notification now tells its person `NOTIFICATIONS_UPDATED` on their `user:` topic after the commit, with
nothing but the workspace in it — a send, an edit naming somebody new, a resolution — and the client
reads that workspace's inbox again, as `SAVED_UPDATED` does for saves (D-128); a reconnect reads it again
too. The counters no longer ask: one frame per notification, not two. **Rejected:** reading the inbox
again on `THREAD_UPDATED`, which the whole room hears for every reply — the client cannot tell from it
whose question was closed without holding the root, and would ask on every reply in every channel;
and carrying the notification in the frame, which would be a second shape of it beside the page's,
for a list the client reads whole anyway.

**Amended 2026-10-31 — `created_at` is the server's clock, as the message's time is.** It was the
database's `now()`, while the message, its resolution and every other stamp of a send come from the
server's injected clock. Live the two agree to the millisecond; under a clock that is not the wall's —
the demo seed plays two days of history (D-33) — every notification read as the moment of seeding, so
the inbox gave all its rows one time beside a feed of many. Now the send, the edit that names somebody
new and the resolution write the instant they already hold. §1's order and the accepted late-commit
window are unchanged: the instant is still taken before the transaction commits.
