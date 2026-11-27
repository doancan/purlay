# D-83. A subscription is made before its replay is read, and live frames wait behind the replay

`router.ts` read a channel's replay and then subscribed the socket. A message committed between the
two was in neither — the replay had been read without it and the subscription did not exist when it
was published — and the client's cursor then advanced past it for good. Found by the audit of
2026-10-09 (#237).

**Decided: subscribe first, hold, reply, release.** The router subscribes the socket to every
channel it names, tells the hub to **hold** live frames for that connection, and reads the replay.
The hub then writes the acknowledgement and the replay, and after them the frames it held — **minus
any message the replay already carried, by id**. A message committed before the read is in both and
is sent once; one committed after is only live and follows the replay; none is in neither.

- **A held frame is bounded.** Past `HELD_FRAMES_MAX` the connection is closed `RESYNC` — a channel
  outrunning its own subscription is what a resync is for, and the held list cannot grow without limit.
- **`SESSION_ENDED` is never held.** The end of a session does not wait behind a replay.
- **A subscription that fails undoes only what it added.** `EventBus.subscribe` reports whether the
  socket was already listening, so a failing resubscribe leaves the earlier subscription alone.
- **A connection that closed meanwhile subscribes nothing.** The router asks the hub whether the
  connection is still held before it subscribes, and the replay read is no longer a window in which a
  closed socket is added back.
- **The replay read is a seam** (`RouterDependencies.readReplay`) so a test commits a message at the
  exact point the old order lost one. Production passes nothing.

**Rejected — read the replay again after subscribing.** Doubles the query for the common case to
repair the rare one, and still needs the de-duplication. **Rejected — a transaction around read and
subscribe.** The bus is not transactional; a commit after the read is not blocked by it.
**Rejected — hold every frame, not only subscriptions.** It would put a send's own echo after its
`ACK`, reversing the order D-35 fixes (published, then acknowledged).

**Reversibility:** free. The hold is one list in the hub.
