# D-35. The message write path is one transaction, and the event is published after it commits

`ARCHITECTURE.md` §5.3 described the send path as `INSERT → publish → ACK`. A message write is
not one statement. It is: insert the message; bump `thread_reply_count` and
`thread_last_reply_at` on the parent; set `channels.last_message_at`; insert `mentions`; insert
`notifications` (including D-29's participants); increment `channel_members.unread_count` and
`unread_mention_count`.

Two things were undefined, and both are correctness issues rather than performance ones.

**1 · One transaction.** All of the above commits together or none of it does. A message that
exists without its mention rows produces a notification that never arrives; a counter incremented
without the message produces a badge for nothing.

**2 · Publish after commit, and ACK after publish.** Publishing from inside the transaction lets
a subscriber receive a message that then rolls back — and because the id is durable and
client-generated (D-8), the receiving client has no way to learn it should forget it. The
`EventBus` call therefore happens after the commit returns, never before.

**Unread counters stay denormalized and stay on the write path.** D-13's reasoning is unchanged.
The increment is one set-based statement — `UPDATE channel_members SET unread_count =
unread_count + 1 WHERE channel_id = $1 AND user_id <> $2` — not a row per member. Concurrent
sends in the same channel run the same plan over the same predicate and therefore take row locks
in the same order, so they serialize rather than deadlock.

**Rejected — write-behind counters.** They are the right answer at some scale and are premature
now. D-25 owns the threshold: if send-path p95 crosses 120 ms and profiling attributes it to
this statement, that is the measurement D-7 requires. Not before.

**Rejected — computing unread with a bounded `COUNT(*)`.** It is defensible and it is a second
mechanism for a fact that already has one. `channel_members.unread_count` is the value; deriving
it somewhere else too is the duplication `OVERVIEW.md`'s ownership rule exists to prevent.
