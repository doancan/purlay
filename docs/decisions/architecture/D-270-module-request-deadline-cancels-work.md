# D-270. A module's request has a deadline that answers it and cancels its database work, and a failure in one handler stays its own — builds on D-266, D-269; amends D-250 rule 7

**Context.** Isolation by budget (`MODULES.md` §7) bounded what a module takes of the pool and left what a request does
with its time open: a module's route that waited on a lock, a slow query or a service that never answered held its
connection and its client for as long as the wait lasted, bounded only by the pool's own thirty seconds, and nothing
cancelled the work of one the client had given up on. And "an error boundary around each handler" was listed as not
built, when the framework's error hook already answers an uncaught throw as `INTERNAL` and a handler that throws holds
no connection after it; what was missing was saying so, with a test, for a module and for a socket frame.

**Decision.**

1. **A deadline per module, in the manifest.** `deadline` is optional: `{ ms }` (1000 to 120000: under a second is no
   wait, over two minutes is past what a proxy in front of the process waits) or `{ none: reason }`, which a test lists as it
   lists a budget exemption (`module-deadlines.test.ts`, empty). A module that says nothing has twenty seconds
   (`DEFAULT_DEADLINE_MS`: past the pool's three, a statement's five of issues and the module's own queue, under the
   pool's thirty); issues says eight. A constant in the manifest, not an environment variable: the limits of a module are
   its own (D-266 §4), and a variable per module is a configuration surface for a number nobody has needed to change.
2. **A request or frame past its deadline is answered `504 REQUEST_TIMEOUT`**, a new code of the envelope: it is not a
   `503` because, unlike an empty pool, it may have changed something before it ran out, so a client reads again before it
   repeats a write that is not idempotent. HTTP is run against the deadline by the framework's `wrap` hook, which has
   nothing else to do with it (`docs/spikes/elysia.md`: measured, what was loosened, and a test that fails on an upgrade
   that changes it); a socket frame by `routeFrame`, which answers the frame that was sent. The request's id and the
   edge's headers are on the answer; a log line names the module.
3. **The work stops with the answer.** The request's signal aborts, and the lease that holds each of its connections
   asks the database to cancel the statement running there, from a connection of its own, outside the pool (`pg_cancel_backend`:
   at the deadline the pool is what is full), and refuses the request the next connection it asks for. A request that waits on
   something that is not the database is answered at its deadline too and left to its own bound: the answer is not held for
   it, and what it asks of the database after is refused. A cancellation can land on the statement that began in the
   milliseconds it took, which that request is told as the database being busy.
4. **A throw in one handler is that request's alone.** The framework's error hook answers the standard `INTERNAL` and
   writes the cause once, with the module's label; a socket frame the same (`frame failed` now carries the module); the lease
   gives back its connection and its slot whatever the body did, so neither the process nor the pool is changed.
   `deadline.integration.test.ts` throws inside chat's handler on a pool where chat's share is one connection and finds
   it whole afterwards. A statement cancelled for running past its limit is `DATABASE_UNAVAILABLE` over the socket as over
   HTTP (D-266).
5. **What is not bounded, and why.** The core's own routes: uploads, downloads and exports are bounded by their own limits,
   and the core's reads take their connections as the pool gives them. The socket's connection and upgrade are the core's.
   No module route streams or long-polls, so there is no exemption today; a module that adds one declares `none` with its
   reason or its own bound.

**Rejected.** *Answering only through the database* (a statement limit shortened to what is left of the deadline): it
sets the connection's limit on every acquisition, a round trip on chat's hot path, and does nothing for a request that waits
on GitHub. *Cancelling by dropping the connection*: the server keeps running a statement whose client went away until it
finishes. *Cancelling with `pg_cancel_backend` through the pool*: the pool is what is full when a deadline passes. *A new
`503` code for the deadline*: it would tell a client the request changed nothing. *An environment variable*: see 1.

**Cost of reversing.** `deadline` in the manifest and the wrap, `routeFrame`'s race and the lease's signal; `REQUEST_TIMEOUT`
stays in the contract, which only adds. Nothing is stored.
