# D-68. A socket ends when its session does, announced over the bus, not checked per frame

A socket resolved its session on its first frame and kept the answer (#194). Verified against a
running server: after *sign out everywhere* returned 204 and every HTTP request answered 401, the
same socket kept receiving the channel and kept having its sends acknowledged. *Sign out everywhere*
is the capability D-11 chose database-backed sessions for, and a live socket defeated it — the
stolen-laptop case it exists for.

**Decided: the two moments a session ends end its connections.** Revocation writes the session row,
then publishes `SESSION_ENDED` on `session:{id}`, the topic each socket subscribes to when it opens;
the hub delivers the frame and closes the connection with `CLOSE_CODES.SESSION_ENDED`. Expiry is a
timer from `expires_at`. Identity is resolved when the socket opens rather than on its first frame,
so a socket that only listens is reached too.

**Through the bus, because a call reaches one node.** On several nodes (Phase 3) the sign-out lands
on one of them and the socket may be on another. Publishing on a topic is what the shared bus
adapter already carries, so this needs nothing new when that adapter arrives (D-7, D-25).

**The timer is chained.** A JavaScript timer longer than 2³¹−1 ms — about 24.8 days — fires at once,
and the default session lives thirty days: an unchunked timer would have closed every connection the
moment it opened, and every test with a short session would have passed.

**Rejected: re-reading the session on every frame.** It puts a query on the hottest path to answer a
question whose answer changes at two known moments, and it still never closes a socket that only
listens.

**Rejected: closing without announcing.** A client sees an abnormal close, reconnects with backoff,
and is refused by a handshake it then has to interpret. One frame first makes the reason part of the
protocol.
