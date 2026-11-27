# D-85. A change that removes visibility is a bus event: a membership is unsubscribed, a session or an account is closed

A subscription is authorised once, at `SUBSCRIBE`. A user taken out of a workspace and a channel kept
receiving the channel on an open socket while every HTTP read answered 404 (verified with the rows
removed directly, #203). And `SESSION_ENDED` reached only the node that handled the sign-out, so on a
second node a revoked session's sockets lived until the session's fixed expiry — up to 30 days; deleting
a user ended nothing (#238). Phase 0 has no endpoint that removes a member, so none of this is reachable
today; Phase 1 adds them, and private channels turn a miss into a disclosure.

**Decided: three events on the bus, none of which makes the hub read the database.**

| Event | Topic | Effect on every node holding a matching socket |
|---|---|---|
| `SESSION_ENDED` (`signed-out`) | `session:{id}` | Frame, then close `SESSION_ENDED` — as before, now shown across nodes |
| `SESSION_ENDED` (`account-deleted`) | `user:{id}` | The same, for every session the user holds |
| `ACCESS_REVOKED {channelIds}` | `user:{id}` (one user lost channels) or `channel:{id}` (the channel is gone) | The socket is **unsubscribed** from those channels and told; it stays open |

Every socket subscribes to its `session:` and its `user:` topic when it opens. A node needs no list of
who may see what: the publisher names the channels, and the hub only unsubscribes. A message delivered
costs no visibility query.

**Unsubscribe or close — the cost of each, written down.**

- *Closing* is correct by construction (a reconnect re-authorises everything) and needs no
  bookkeeping, but it costs every **other** channel the user has open a reconnect, a resubscribe of
  all of them and a replay — and removing someone from a workspace, or deleting a channel many people
  watch, is a reconnect burst from sockets that did nothing wrong. It is the right tool when
  *everything* is gone: a session, an account. It is what those two do.
- *Unsubscribing* touches only what was lost and costs the client one frame, but it must be told
  (`ACCESS_REVOKED`) and it can race a `SUBSCRIBE` in flight. The race is closed by order, not by a
  check: a subscription is made **before** its channels are authorised (extending D-83's
  subscribe-first), so a revocation published at any moment finds it and ends it, and a refused
  subscription undoes what it added and drops what was kept for it. It is what membership does.

**What Phase 1 must publish** — the decision binds it, and the tests call these functions
(`platform/events.ts`) because there is nothing else to call yet:
removing a member from a workspace (#51) → `publishAccessRevoked(bus, clock, userId, <every channel of
that workspace they could see>)`; leaving a channel, or being removed from a private one →
`publishAccessRevoked(…, [channelId])`; deleting a channel (#98) → `publishChannelRevoked`; deleting a
user → `publishUserDeleted`. **After the transaction commits**, as every publish does (D-35).

**Two nodes are demonstrated, not argued.** `Backplane` (`realtime/bus.ts`) is the shared transport
that nodes publish through; one process makes its own, and a test shares one between two
applications. A sign-out on one closes the socket the other holds; an account deletion and a removal
published from a third node that holds no sockets reach both. Phase 3's Redis adapter is this
interface across processes.

**Rejected — re-checking visibility per delivered frame.** A read on the hottest path to answer a
question whose answer changes at three moments. **Rejected — closing on every membership change.**
The reconnect burst above, for the common case, to avoid a frame. **Rejected — a `workspace:` topic
that sockets listen to for membership.** It would make every socket listen to every workspace and
still not say which channels. **Rejected — the hub resolving which channels a workspace holds.** It
would make the hub touch the database, which is the separation D-7 stands on.

**Left:** `ACCESS_REVOKED` for a channel turning private is not published by anything yet; nothing
makes a channel private in Phase 0–1's endpoints, and the event it needs is this one.

**Amended 2026-10-09 (second-round attack): a send re-proves its session in the transaction that
writes it.** A socket authenticates once and caches the identity; a sign-out racing a send let one
write commit *after* `revoked_at` (found by attack: one write, zero frames reaching the closed
socket). The guard query that runs per send cannot carry the session — it answers about the
channel — so the send path adds one primary-key read of the session row, `FOR SHARE`, as the first
statement of its transaction (`requireLiveSession`). Revocation updates that row, so it waits for the
transaction holding the lock: **a write by a session commits before the session's revocation does,
or is refused `UNAUTHENTICATED`; there is no third order.** Measured on a cloned database with real
commits: a revocation held open while a send starts makes the send wait and then refuse, writing
nothing (without the lock the same test commits the write); a send holding the session makes the
revocation wait (it does not complete while the transaction is open). Cost: one indexed read per
send, share locks being compatible with each other. Both doors use it — the socket's cached identity
and the HTTP `POST /messages` — because they share `send()`. **Left, stated:** other HTTP writes
(workspace, channel, join) resolve the session at the start of the request and are not locked, so
their window is one request's duration; none writes into another member's view (a message is the
only thing that reaches a room), and the cost of locking every write was not justified by a
measurement. A socket frame other than a send only reads.

**Reversibility:** one frame and one close behaviour; nothing is stored.

**Amended 2026-10-09 (second-round audit): the contract is watched, and out-of-band SQL is not
covered.** The three publish functions had no caller, so nothing noticed when a path that removes
visibility did not publish. `revocation-contract.test.ts` now finds every production statement that
revokes a session, soft-deletes a user, workspace or channel, or deletes or updates a membership, and
holds each to a table of the event it publishes (or, with an owner, why none): a new write path with no
decision fails the build, and a row whose write has gone fails it too. Today's sites are all sessions —
sign-out publishes after the write, and the dead-session purge removes only rows already announced or
expired. Nothing existing needed wiring; no path soft-deletes a user, workspace or channel yet.
**A write made outside the application** — SQL by hand, a script — **does not end open sockets** until
the session expires or the process restarts, because the bus is in-process (D-7): a command-line tool is
another process and cannot reach this one's bus, and a network bus is not built for it (`CONTRIBUTING.md`
§1.11). An operator who revokes by SQL restarts the node (a drain, D-72) to make it take effect.

**Amended 2026-10-09 (second-round audit): a socket is listening before its session is confirmed.** The hub
read the session and only afterwards did the socket subscribe to `session:` and `user:`, so a sign-out
published between the two reached nobody and the socket stayed open and authenticated — a `MESSAGE_SEND`
sent in that window was acknowledged and stored. The hub now reads the session, calls `listen` (which
subscribes), and **reads it again**: a sign-out before the second read is seen by it, one after is heard on
the topic, and no instant is in neither. Reproduced deterministically by a hook that runs the sign-out when
the first read returns. **Rejected — subscribing to a topic named after the cookie's token:** the topic would
carry a credential, and the session id is what the rest of the system names.

**Amended 2026-10-09 (second-round audit): a replay never outlives a revocation seen while it was read.** A
subscription is authorised, the member is removed and `ACCESS_REVOKED` published, a message commits, and
the replay — read after the removal — carried that message to the socket ahead of the notice. The hub now
remembers which channels were revoked while a connection's frames were being held, and does not write
replayed messages of those channels; the notice still follows. Deterministic: the replay read's seam
publishes the revocation and commits a message before reading. **Rejected — authorising again after the
read:** a second query on every subscription for a race the hub already hears about as an event.
