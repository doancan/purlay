# D-60. `last_used_at` is refreshed lazily, and every refusal to resolve looks the same

`SCHEMA.md` §3.2 gives `sessions` a `last_used_at` and says nothing about when it moves. Two
answers were available and neither is obviously right, so it is recorded rather than chosen in
passing.

**Refreshed at most once an hour.** Writing it on every request puts an `UPDATE` on the hottest
path in the system — every HTTP request and every socket upgrade validates a session — to maintain
a column whose only consumer is a device list nobody has built. An hour is precise enough for
*when was this device last seen* and costs one write per session per hour. The resolve already
reads the column, so a stale value is noticed without an extra query.

**Rejected: writing it on every resolve.** Correct, and it turns a read path into a write path at
the exact point the system is busiest. **Rejected: not maintaining it at all.** A column that never
moves is worse than an absent one: it reads as data and is fiction.

**Every reason to refuse produces the same answer.** Expired, revoked, unknown, or belonging to a
user who has been deleted — all resolve to nothing, with no way for the caller to tell which. The
alternative hands an unauthenticated caller an oracle about accounts it does not own: *this token
was real once* is information, and so is *this account was deleted*. It is the same argument as
404-not-403 at the tenant boundary (D-21), one layer earlier.

A deleted user's live session stopping is the part that would otherwise be missed: the session row
is untouched by a soft delete, so without the join it keeps working.
