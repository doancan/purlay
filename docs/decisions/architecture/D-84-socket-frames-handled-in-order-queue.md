# D-84. A socket's frames are handled one at a time, in order, behind a bounded queue

*Amended by D-198: The frame budget is ten a second with a burst of sixty, decided from a measurement.*

Elysia starts a `message` handler for each frame as it arrives and does not wait for the last. A
`SUBSCRIBE` that waits on the database was therefore overtaken by an `UNSUBSCRIBE` sent after it and
then subscribed anyway, and a continuation that outlived `close` could add a dead socket back to the
bus, which then kept receiving `deliver` calls (#237).

**Decided: the hub runs one connection's frames as a promise chain.** `hub.enqueue(socketId, work)`
starts a frame's work when the previous one has settled; a frame that fails is logged and the chain
goes on; work still queued when the connection closes never runs. This is the "socket generation": a
connection's id is unique, the hub's entry for it is the generation, and everything a continuation does
afterwards is checked against it (`isOpen`, `held.get(id) === entry`) before it can subscribe.

- **The queue is bounded at `FRAME_QUEUE_MAX` (32)**, above the limiter's burst of 20, so a connection
  inside its budget never meets it. Past it the connection is closed with the new
  `CLOSE_CODES.TOO_BUSY` (1013, *try again later*) and what was queued is dropped. A client reconnects,
  and a send that was never acknowledged is retried like any other.
- **The drain waits.** `hub.settled()` resolves when no queued work is running, and `drain` awaits it
  beside the listener's own stop, so the pool is not closed under a frame being handled. The shutdown's
  existing deadline bounds it.

**Rejected — a mutex per frame handler, taken inside it.** Ordering would then depend on the order
the framework happens to call handlers, which is the thing that is not promised. **Rejected — an
unbounded queue.** A flood becomes memory. **Rejected — RATE_LIMITED for the overflow, as an error
frame.** The limiter already answers a flood that the server keeps up with; a queue that is full is
a server that cannot, and refusing frames one by one leaves the client sending into it.
**Rejected — `RESYNC` (4408).** That says the client fell behind what it was *sent*; this is the other
direction, and the two want different diagnoses in a log.

**Reversibility:** free. One constant and one close code.

**Amended 2026-10-09 (second-round audit): the budget is the user's, and so is the number of sockets.** The
per-connection bucket multiplied by the connections a user opened: one user with 100 sockets sent 20
`MESSAGE_SEND` each, all 2,000 acknowledged in about eight seconds with no `RATE_LIMITED`, against HTTP's
ten a second for the same person (D-81). `MESSAGE_SEND` is now also charged to a per-user bucket **shared
with HTTP's write budget**, so a user's writes cost the same over either door and many sockets are one
budget; the per-connection bucket still bounds every frame. A user may hold `SOCKET_CONNECTION_LIMITS.perUser`
(20) sockets and a node `total` (2,000): over them the upgrade is refused before a socket is bound — `429
RATE_LIMITED` for the user, `503` for the node. Upgrades that all passed that check at once are held to the
cap when they bind, by closing the excess with `TOO_BUSY`. A socket that stops reading costs up to 4 MB before
it is closed (D-70), so the node-wide cap is also a memory bound. **Provisional (O-4):** unmeasured, as every
number in this family. **Rejected — one bucket per user in place of the per-connection one:** it would make a
runaway tab starve the user's other tabs of pings and subscriptions. **Rejected — counting sockets in the
database:** the hub already knows, and a query per upgrade is a read on the door.

**Amended 2026-10-09 (second-round audit): a socket that cannot say who is on it is told in a frame.** When
the identity read on open failed after the upgrade was admitted, the framework answered with a raw
`{"error":…}` body that is not a `ServerFrame`; the client took it for malformed and reconnected into the
same failure at once. The open now catches it, writes the cause to the log once, sends an `ERROR` frame from
the contract and closes: `CLOSE_CODES.TOO_BUSY` when the database had no connection to give, the new
`CLOSE_CODES.INTERNAL` (1011) otherwise. The client reconnects with its backoff either way.
