# D-76. Reconnect waits in the upper half of each step, and forgives only a connection that held

`ARCHITECTURE.md` §5.4 said *exponential backoff with jitter, capped at 30 s* and left two things
open that decide whether it protects the server: where in the step the jitter lands, and when a
connection counts as having recovered.

**Decided: the delay is drawn from the upper half of the exponential step** — 0.5–1 s, then 1–2 s,
2–4 s, up to 15–30 s. Every client of a server that restarted lost its connection in the same
instant, so without jitter they return in lockstep at each step; with it they spread across half
the step.

**Decided: the backoff starts over only after a connection has stayed open for ten seconds**, not
at the moment it opens. A server that accepts a connection and then drops it — a crash loop, a
proxy refusing after the upgrade — is "successfully connected" every time by the first rule, and
would be retried at the shortest delay for as long as it kept failing.

**A close with `SESSION_ENDED` is not retried.** Reconnecting into it is refused each time and
teaches the user nothing; the application is told the session is over instead (#194). Every other
close — a restart (`1012`), a resync (`4408`), a network drop — is reconnected from, because the
cursor makes the gap recoverable (D-65).

**Rejected — full jitter (any delay from 0).** The most even spread, and it also lets one client
retry at once, repeatedly, against a server that is refusing it. **Rejected — resetting on open:**
above. **Rejected — resetting on the subscription's ACK:** a client watching no channel never
receives one, so its backoff would never recover.

**Reversibility:** free. Nothing is stored; the numbers are one constant each.
