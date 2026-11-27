# D-72. A restart drains: readiness first, sockets told to come back, in-flight work finished

SIGTERM ended the process where it stood (#220). A deploy cut every request in flight, dropped every
socket with an abnormal close its client had to interpret, and kept readiness answering *ready*
until the process vanished. Phase 0's exit criterion is a message that survives a restart; a restart
every client experiences as an outage meets the letter of it and not the point.

**Decided: drain, in an order where each step makes the next safe.** Readiness answers 503 first, so
a balancer stops sending new requests. Every socket is then closed with 1012 — RFC 6455's own
*service restart*, in the contract as `CLOSE_CODES.RESTARTING` — which tells the client to reconnect
and replay from its cursor (D-65), so nothing is lost and nothing is shown as an error. The listener
stops accepting while requests in flight finish; the pool closes; the process exits 0. A deadline of
ten seconds bounds it: a request that never finishes must not keep a restart from happening, and
past it the process exits 1 and writes what was still open.

Tested against a running server with a request deliberately still in flight — a sign-in waiting on
a slow GitHub — which must finish with its redirect while the socket beside it is told to come back.
Stopping abruptly fails that test; not telling the socket fails it too.

**Rejected: a configurable delay before stopping, for the balancer to notice readiness.** Useful
behind a balancer that polls slowly, and a guess about infrastructure this project does not run yet.
It can be added when a deployment measures the need; a delay nobody measured is a slower restart.

**Rejected: closing sockets with 1001 *going away*.** Clients treat it as the end of the page's
life, not as a cue to reconnect. 1012 says exactly what is happening.
