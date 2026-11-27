# D-87. The pool waits a bounded time and says what is wrong; a session that cannot authenticate can be purged

`createDatabase` set a pool size and nothing else (#243). With a pool of two, a third query waited 7,612 ms
for a connection to free: no timeout, so under load every request queues behind the slowest query and the
client sees a hang. A dropped idle connection emitted `error` on a pool with no listener, which ends the
process. TLS was `rejectUnauthorized: true` and nothing more, so a database behind a private or managed
root could not be reached with verification on.

**Decided: fixed limits, in code, published in `CONFIG.md`.** A 3 s wait for a connection; a 30 s
`statement_timeout`; a 15 s `idle_in_transaction_session_timeout`; a 30 s idle connection; and an
`application_name`. Running out of connections raises `DatabaseUnavailableError`, which the HTTP boundary
maps to a new code, `DATABASE_UNAVAILABLE`, with status `503` and no detail: it is the server being busy,
the request changed nothing, and a client may retry. The wait is bounded at the moment the connection is
asked for, in the pool wrapper, so no caller has to remember to classify a driver error by its text. A
pool error is handed to a callback, and the composition root logs it.

**Decided: `DATABASE_SSL_CA_FILE`, a path.** A mounted file is how a deployment already carries a
certificate, and it keeps a multi-line PEM out of an environment variable. It needs `DATABASE_SSL=true` and
a file that cannot be read stops the boot; the migration CLI reads the same two variables.

**Decided: `purgeDeadSessions(db, now, batch)`.** Deletes at most `batch` expired or revoked sessions per
call and returns the count; a scheduler (#71) calls it until it returns zero.

**Rejected — configurable limits (`DATABASE_*_TIMEOUT`).** Each is a way to lower a safety into an outage
and a line of operator documentation to get wrong; the three numbers are defaults a deployment has no
measured reason to change. They become variables when one does. **Rejected — matching the driver's
`timeout exceeded when trying to connect` text:** it is a string in another package's source. **Rejected — a
statement timeout for the migrator:** an index build on a large table is meant to take as long as it takes,
and a migration cut off halfway leaves an invalid index.

**Reversibility:** free. The numbers are one constant each; the error code is the only part clients see.

*Amended 2026-10-09:* a frame that fails for want of a connection is answered with the same
`DATABASE_UNAVAILABLE` `ERROR` frame, with the HTTP body word for word, instead of `INTERNAL`; the cause is
still logged. A client that retries a refused request now has one code to recognise on either transport.

*Amended 2026-10-09 — the migrator is not the application:* the 30 s statement limit belongs to the
application's pool alone. A node migrating as it starts (D-93) ran `migrateToLatest` on that pool, so a
migration with a 33 s statement was cancelled, the node exited, and its restart was cancelled at the same
point; a large `CREATE INDEX CONCURRENTLY` or `VALIDATE` would have kept a node in that loop. Migrating now
always opens a connection of its own through `createMigrationDatabase`, which `bun run db:migrate` uses too:
one connection, no statement timeout, the idle-in-transaction limit kept (the runner is never idle inside its
transaction). **Rejected — raising the application's limit:** it exists to bound a runaway request.
**Rejected — `SET statement_timeout = 0` inside the migrator on the borrowed connection:** it would work
until someone reused the connection, and leaves the pool's other users one forgotten reset from running
unbounded.
