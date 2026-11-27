# D-81. HTTP is rate limited by client address for sign-in and by user for writes, and a client is only who the socket says

*Amended by D-198: The frame budget is ten a second with a burst of sixty, decided from a measurement.*

The only limiter was the socket's. `GET /auth/github` minted state cookies without limit and a valid
state made the callback call GitHub three times; `POST /api/channels/:id/messages` reached the same
`send()` as the socket with no budget at all; `sessions.ip_address` existed and was never written
(#235).

**Decided: two limiters behind the existing `RateLimiter` seam (D-7, D-25), applied before the
handler runs, after the body — already capped at 64 KiB (D-80) — is parsed, so a malformed body is
a 400 for everyone and costs no session lookup.** `/auth/*` is keyed by client address: 30 requests at once, then
one every two seconds (a sign-in is two requests, and an office behind one NAT must be able to
arrive together). Mutations under `/api/*` are keyed by the **signed-in user**: the socket's own
budget, 10 a second with a burst of 20, so the two doors to `send()` cost the same. Reads are not
limited here. A request with no valid session is not charged — it is answered `401` as before and
no bucket is created for a caller we cannot name. **Both numbers are provisional and say so (O-4);**
they are closed by the same measurement as the socket's.

**Rejected: keying writes by connection, as D-66 does for the socket.** HTTP has no connection; the
user is the only stable key, and D-66's objection (two tabs starving each other) is a socket
property — tabs share the user's HTTP budget, which is one person's writing.
**Rejected: threading a limiter through every handler's signature,** which is a change to a dozen
files for what one hook does at the edge; the cost is a second session lookup on a write.

A refusal is `429` with `RATE_LIMITED` and `Retry-After` (seconds until one more request fits, at
least one). The in-process limiter now drops buckets that have refilled once 10,000 are held,
at most once a second: with a key per client address, an attacker rotating IPv6 prefixes would
otherwise grow it without bound. An IPv6 client is keyed by its /64, because a subscriber holds a
whole one and a budget per address would be none.

**A client is who the socket says, unless `TRUST_PROXY=true`.** `X-Forwarded-For` is written by the
caller; honouring it by default lets an attacker take a fresh budget per request (tested: rotating
it with `TRUST_PROXY=false` changes nothing). With `TRUST_PROXY=true` the **last** entry is used — the
one the single proxy in front appended — and an unusable one falls back to the peer, not to an
earlier entry. Exactly one hop; a CDN in front of a load balancer is not a configuration this
product claims. **Rejected: counting hops (`TRUST_PROXY=2`),** which is a number nobody sets right
until it matters.

**`sessions.ip_address` is written at sign-in** with that address (an `INET` column; null when the
peer is unknown). It is personal data. It serves the device list and an incident (which address
created this session), and nothing else reads it. It lives and dies with the session row, and the
account erasure of D-27 must null it when it revokes sessions — recorded here because the job that
performs it does not exist yet. For a cloud this joins the data map D-28 promises.

**Reversibility:** free. Nothing is stored but the address, which can be nulled.

**Amended 2026-10-13 — reads that cost the server have a bucket of their own.** A card (`POST
/api/integrations/github/unfurl`) and an external image (`GET /api/images`) cost the server a call on
the reader's behalf, so they are charged per user. They were charged to the *writes* bucket, the one a
person sends with, and drawing a channel asks for one per link it shows. In the browser suite, a page
of GitHub links went over the burst: the unfurl was answered `429`, and the person's next message
would have been too. They are now charged to `COSTLY_READ_BUDGET`, per user, sixty at once and then
ten a second. **Provisional (O-4)**, like every number here. **Rejected — not charging them:** one
person could then spend the node's outbound calls. **Rejected — a bigger write burst:** it would let
a person send sixty messages at once to make room for drawing.

**Amended 2026-10-13 again, after a security review.** The limiter compares the path the router
matches (`routeOf`: repeated slashes one, a trailing one dropped). The router is not strict, so
`/api/images/` reached the image handler while the limiter, comparing the raw path, charged it nothing.
And calls to GitHub are charged **per workspace** too (`GITHUB_CALL_BUDGET`, a hundred at once, then one
a second, under the hourly quota of the workspace's one token). The unfurl cache is keyed by workspace
and link, and any link is accepted, so one member asking for links nobody wrote spent a call each, and
could spend the token for everyone in minutes. A card refused a call is a plain link and is not cached,
so it is drawn when there is room again. **Provisional (O-4).**
