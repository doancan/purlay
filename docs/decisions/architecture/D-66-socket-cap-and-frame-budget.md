# D-66. The socket's two limits: a cap the server enforces, and a budget it refuses by frame

*Amended by D-198: The frame budget is ten a second with a burst of sixty, decided from a measurement.*

§5.5 stated both limits and nothing enforced either (#174).

**The 64 KB cap is server-wide, because the per-route option is ignored.** Measured, with Elysia
1.4.30 on Bun 1.4.2: setting `maxPayloadLength` on the `.ws()` route let a 100 KB frame reach the
handler; setting it on the application let the same frame end the connection before any handler ran,
and a 60 KB frame through. The router's own size check was removed rather than kept beside it: by
the time the router sees a JSON frame the framework has parsed it, so the check measured what had
already been paid for. A connection that sends an oversized frame is dropped, which is the right
answer to a client that ignored a published limit — and the wrong one for a person whose message
is merely long, which is the open question about message length (#190).

**The budget is a token bucket per connection, and over it a frame is refused, not the
connection.** A bucket because §5.5 states a rate *and* a burst, which are exactly a bucket's two
parameters; a sliding window has one. The refusal is an `ERROR` carrying `RATE_LIMITED` and the
frame's id, so the client marks that one send failed and offers a retry, and a resend with the same
id is idempotent (D-8). The budget is spent **before** the frame is parsed: if malformed bytes cost
nothing, they are the cheapest flood there is. The number itself stays open (O-4).

**Rejected: closing the connection over budget.** It turns one burst — a paste of several lines,
each a frame — into a reconnect, a replay and a resubscribe, all of which cost more than the frames
did.

**Rejected: keying the budget by user.** Two tabs would share one budget and starve each other.
The quota a user could multiply by opening connections is bounded by the connection count, which
is an instance-level concern rather than this one.
