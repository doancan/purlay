# D-65. A replay starts below the cursor, and says when it is not finished

The first test with two real sockets (#31) found two ways §5.4's replay lost messages without
saying so, and a third way the server broke its own contract.

**A cursor is not a watermark.** D-33 accepts an id up to a minute behind the server's clock,
because a laptop that has been asleep has not synced. A message accepted *after* a client stopped
listening can therefore sort *below* the newest id that client holds — and the obvious case is not
a slow clock but a send that sat in its author's buffer while their connection was down. Replaying
`id > cursor` skips it permanently: it is in history, at the place its id puts it, and no reconnect
will ever deliver it.

**Decided: replay from `cursor − REPLAY_OVERLAP_MS`.** The overlap is `behindMs + aheadMs`, derived
from `MESSAGE_ID_SKEW` rather than written, and it is exactly enough: a message accepted at server
time *S* has an id no older than *S* − `behindMs`, and the cursor is no newer than the moment the
client stopped listening plus `aheadMs`. The cost is re-sending up to sixty-five seconds of
messages the client already holds, which a client keyed by id (D-8) discards for nothing.

**A replay longer than a page now says so.** It returned the first hundred messages and an
acknowledgement that read like completion, so a client away for longer believed it had caught up.
The acknowledgement carries, per channel, the page's `nextCursor`; `null` means the present was
reached, and anything else is continued over HTTP with `?after=` — the cursor and the contract every
other page already uses, so there is one way to page, not two.

**And the acknowledgements now match the contract.** `SUBSCRIBE` and `UNSUBSCRIBE` were answered with
an `ACK` whose `data` the declared `AckFrame` does not allow; the router builds frames behind a
cast, so the compiler never saw it. Both have declared shapes now, and the socket tests check every
frame on the wire against `ServerFrame`, so the next one is caught by a test rather than a client.

**Rejected: a server-assigned sequence as the replay cursor.** It is a watermark, and it is the
column D-8 rejected: one counter per channel serialises every insert into it. Commit order is not
even what it would need to be: two concurrent transactions commit in either order.

**Rejected: replaying everything since the cursor, without a page limit.** A client back from a long
weekend would receive thousands of frames in one burst over the socket that §5.5 bounds.

**Rejected: a `received_at` column as the cursor.** It moves the problem rather than removing it — a
transaction that inserts at *T* and commits after *T*+1 is invisible to a reader who has already
moved past *T*+1 — and it costs a column and an index on the hottest table.
