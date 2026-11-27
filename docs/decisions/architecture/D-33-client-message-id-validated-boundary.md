# D-33. A client-supplied message id is validated at the boundary, and a conflict is never an ACK

D-8 made `messages.id` a client-generated UUIDv7 and called it the highest-leverage decision in
the document. It did not say what happens when the client sends something else. `ARCHITECTURE.md`
§5.3 went straight from "validate (TypeBox)" to "INSERT with the client's id", and TypeBox can
only assert *this is a UUID* — not *this is a v7 carrying a plausible timestamp*.

Three failures follow from trusting it, and all three are permanent because the value becomes a
primary key:

1. A v4 id in a channel makes that channel's ordering wrong forever.
2. A v7 id with a year-2099 timestamp pins itself above every future message **and** breaks
   keyset pagination for every reader, because `id < cursor` now skips real rows.
3. `ON CONFLICT (id) DO NOTHING` returning an ACK turns a send into an existence oracle, and
   lets a client silently discard its own message by colliding with someone else's id.

**Decided: the id is untrusted input and is checked like any other.**

- **Shape.** Version nibble is `7` and the variant bits are RFC-conformant, or the frame is
  rejected with `INVALID_MESSAGE_ID`.
- **Time.** The embedded millisecond timestamp lies within `[now − 60 s, now + 5 s]`. Generous
  enough for a laptop that has not synced, tight enough that nothing can be pinned to the top of
  a channel.
- **Conflict.** After `ON CONFLICT (id) DO NOTHING`, the existing row is read back and its
  `sender_id` and `channel_id` are compared with the requester. A match is the idempotent retry
  D-8 designed for and returns the same ACK. A mismatch returns `409 MESSAGE_ID_CONFLICT` and
  **no ACK, and no field of the existing row** — the response must not confirm what it collided
  with.

**Clock skew, which the documents never acknowledged as a cost.** Two clients with skewed clocks
interleave against real time. The correction already exists and was unused: `ServerFrame.ts` is
defined as "server clock, for drift correction only". The client derives an offset from the first
`PONG` after connect and generates ids against the corrected clock. Sends before that offset
exists are rare — the handshake completes long before a person finishes typing — and a rejected
frame surfaces as `failed` with retry, which is the path §5.3 already specifies.

**Amended 2026-10-09 (#21): how the offset is measured.** The client takes the offset from the first
`PONG`, as the paragraph above says, and places the server's `ts` at the **midpoint** of the round
trip — the two directions are not measured separately, so the midpoint is the least biased guess. It
is taken once and kept: a later sample would only move the clock mid-session, and a message already
in the list was made against the earlier value. A `PONG` that arrives before its `PING` was sent is
refused rather than averaged in. **Rejected — the lowest-latency of several samples:** more accurate
by a few tens of milliseconds, against a window of 65 seconds; the accuracy buys nothing the window
does not already forgive.

**Rejected — generating ids on the server.** It removes the problem and the benefit together:
D-8's entire payoff is that the optimistic row and the durable row share one id, so the message
never moves in the list. Server ids bring back the temporary-id mapping table that D-8 deleted.

**Rejected — validating shape but not time.** The shape check alone stops case 1 and neither of
the other two. The expensive failure is the poisoned cursor, and only the time bound prevents it.

**Reversibility:** free now, impossible later. Validation added after the first bad row still
leaves the bad row, and the row is a primary key referenced by `mentions`, `reactions` and
`channel_members.last_read_message_id`.

**Amended 2026-10-08 (#198): the window guards new ids, not the retry of a stored one.** It was
checked before the idempotency lookup, so an outbox drained after a long disconnect — the retry
D-8 exists for — had its stored message refused as `INVALID_MESSAGE_ID` and marked failed. An id
outside the window that matches the sender's own row in the same channel now returns that row. Any
other id outside the window — a stranger's stored id, the sender's own in another channel, or one
never used — is refused with the same body after the same one query, so the window still admits no
new row and the late path is not an oracle.
