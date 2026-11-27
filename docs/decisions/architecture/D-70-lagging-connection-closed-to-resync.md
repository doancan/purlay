# D-70. A connection that falls behind is closed to resync, never left open with a gap

§5.5 promised a high-water mark and nothing implemented it (#197). Measured against a reader that
stops reading: the transport answered each send with bytes written, then `-1` (queued), then `0` —
**dropped** — once it held 16 MB for that one connection, and the connection stayed open. The client
missed messages without knowing, and since it was never disconnected it never asked for a replay. A
slow phone on a bad network becomes a person who silently does not see part of the conversation.

**Decided: every frame to a socket goes through the hub, and the hub closes a connection the moment it
cannot be trusted to have everything** — a send the transport dropped, or more than
`OUTBOUND_HIGH_WATER_MARK` (4 MiB) queued. The close is `CLOSE_CODES.RESYNC` (4408), which says
*reconnect*: the client resubscribes with its cursors and D-65's replay fills the gap. A dropped frame
becomes a reconnect, never a hole.

**The mark and the replay are one decision.** A replay is sent as one burst; if it could exceed the
mark, a slow but healthy reader would be closed by its own replay, reconnect, receive the same replay,
and loop. So a replay is bounded in bytes as well as messages — `REPLAY_BYTES_MAX`, 1 MiB, the
thousand-message count alone being up to 48 MB — and a test requires the mark to exceed it plus a
frame. When the byte budget stops a channel, its cursor resumes after the last message sent, or from
its start; a test continues every channel from its cursor over HTTP and requires every message back.

**Measured honestly: loopback cannot show the loop.** A local reader drains faster than any burst
fills the queue, so a socket test passed with the mark set below the replay. That test now claims only
what it shows, and the relation is enforced where it can be.

**The transport's buffer is read through a checked adapter.** Bun has `getBufferedAmount`; the
framework's copy of the socket type does not declare it. A runtime without it refuses the first
connection rather than running every connection without backpressure.

**Rejected: Bun's own `closeOnBackpressureLimit`.** It closes without a code the client can act on, at
a limit the replay budget is not bound to.
