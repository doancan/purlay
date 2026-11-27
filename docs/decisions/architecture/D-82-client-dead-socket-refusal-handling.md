# D-82. The client notices a dead socket, stops retrying a refusal, ignores what it does not know, and does not trust a cursor past an unfinished replay

D-76 made reconnecting polite. Four ways the client still failed to come back, or came back wrong
(#239).

**Decided: a heartbeat, with any frame counting as proof of life.** After `PING_AFTER_IDLE_MS`
(25 s) of silence the client sends `PING`; with no frame of any kind within `PONG_DEADLINE_MS` (15 s)
it closes the socket and reconnects *without waiting for the `close` event* — a half-open socket's
may be minutes away, and the late one is ignored by the generation. A busy connection is never
pinged. The first `PING` leaves as the socket opens, and its `PONG` (matched by `refId`) feeds the
server clock (D-33); a sample whose round trip is negative, because the local clock stepped back, is
skipped and measured again at the next `PING`. The real clock is read in
`apps/web/src/system-clock.ts` and nowhere else in the client.

**Decided: refusal and outage are told apart by asking.** The browser hides a handshake's status, so a
401 and a dead server both read as close code 1006. After `CHECK_SESSION_AFTER_FAILURES` (3)
consecutive attempts that never reached `open`, the client calls an injected `checkSession()`
(`GET /api/me`, written where the client is assembled) while the retry timer keeps running. `ended`
means a 401 or an identity response for a different account; the latter ends the old connection
and rereads identity rather than signing the new account out. A network error, a 5xx, a rejected check
or its 30-second diagnostic deadline means `unknown`, and retrying goes on. An outage never means a
sign-out. Each active check owns its AbortController and deadline. Successful socket open, stop or
session end releases the owner before aborting the real HTTP fetch/body. Timeout releases the slot
even when an adapter ignores abort; an obsolete completion cannot end a new connection or release a
replacement check. A completed check cancels its deadline without later aborting the completed
request. One check is in flight at a time.

**Decided: an event the contract does not define is ignored, and still proves the peer is alive.**
`parseServerMessage` replaces `parseServerFrame` with three outcomes: a frame, an `unknown` event
(an object with a string `event` the contract lacks) and `malformed`. A known event with the wrong data
stays malformed and ends the connection, so validation of what the client does understand is not
weakened. Without this a rolling deploy that adds an event makes every older client loop
close-and-reconnect.

**Decided: the cursor is withheld while a replay's continuation is owed.** The cursor advances on any
live frame, and that is unsafe in one case: a replay was one page, a live frame moves the cursor
past the rest, and the socket drops again — the next `SUBSCRIBE` skips the gap silently. The
connection records each channel's `nextCursor` from the `ACK` as pending and ignores live frames
above it for the cursor (still delivering them) until the store calls `continuationDone(channelId,
from)` with the cursor the continuation started from. A mismatching `from` is ignored, so an old
continuation cannot release a newer replay's. Pages the store `observe`s meanwhile advance the
cursor, being contiguous. Each connection discards what the last one owed.

**Decided: `ended` is a state `start()` leaves.** Signing in again is how a session comes back, and
the watched channels and cursors are still what to resume from. Entering `ended` forgets the failures,
so the first retry after it is the shortest delay, not the cap earned by the last session.

**Rejected — waiting for the browser's `close` event after a missed deadline:** that is the bug.
**Rejected — a `PING` on a fixed interval regardless of traffic:** it spends frames, and rate-limit
tokens (§5.5), on connections already proving themselves. **Rejected — ending on the first 1006:** a
restart or a Wi-Fi change is a 1006. **Rejected — checking the session before the third failure:**
every blip would cost a request. **Rejected — one global "unfinished replay" flag:** a hundred
channels, one of them a page behind, would freeze every cursor. **Rejected — dropping live frames
while a continuation is owed:** the user would see messages arrive late for no reason; only the
cursor needs withholding. **Rejected — relaxing `parseServerFrame` to let unknown events through:**
the same function would then let a known event with garbage data through as well.

**Reversibility:** free for the numbers. The `parseServerMessage` rename is a contract change inside
the monorepo, with one caller.

**Amended 2026-10-09 — a large subscription is paced.** A second-round audit drove the real client
against the real server: 2,500 watched channels (25 chunks) got 20 acknowledgements and five
`RATE_LIMITED` errors nothing retried; 3,500 (35 chunks) got a close with `TOO_BUSY` (D-84) on every
attempt, so the client looped for good. All chunks left in one synchronous burst.
**Decided: one `SUBSCRIBE` in flight; the next leaves when the last is acknowledged** (matched by
`refId`). A `RATE_LIMITED` or `DATABASE_UNAVAILABLE` answer to a chunk sends it again, with the channels
still watched, after the reconnect ladder's wait (reset by any acknowledgement); any other error moves
on, because waiting will not change it. A close with `TOO_BUSY` starts the reconnect wait at
`TOO_BUSY_BACKOFF_STEP` (4–8 s), never lower than the failures already counted. Cursors are read when a
chunk leaves, and a chunk is dropped if its channel was unwatched while it waited. **Rejected — a
fixed number in flight, or a fixed gap between chunks:** either needs the server's budget (10 a second,
burst 20, `FRAME_QUEUE_MAX` 32), which lives in `apps/api` and may change; waiting for the answer is
correct at any budget and costs one round trip a chunk. **Rejected — importing the budget into the
contract:** a client written against today's number is wrong the day it changes. **Rejected — only
retrying `RATE_LIMITED`:** pacing alone cannot honour a budget that refills with time, and the
fix for the close is to not cause it. Sustained pacing faster than the budget is still answered
`RATE_LIMITED`; the retry is what makes that safe.
