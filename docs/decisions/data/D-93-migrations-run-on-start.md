# D-93. Migrations run on start: every node calls the migrator, which makes starters take turns

Migrations were run by hand with `bun run db:migrate`, and nothing designed what happens when several API
nodes start together — which a deploy of the cloud shape (D-25, D-44) does every time (#248). Readiness
already answers 503 while migrations are pending (#108) and reports a history the files no longer describe
(D-86), so a node ahead of its schema takes no traffic; what was missing was something to apply them.

**Decided: `MIGRATE_ON_START=true` makes the process migrate itself after its listener opens**, through the
migrator's public `migrateToLatest` (D-86). It is off by default: a developer's `bun run dev:api` should not
rewrite a database by being started. It listens first, so liveness answers during a long migration and
readiness says 503, which is the state a balancer already understands; a request sent straight to the node
can reach an unmigrated schema, and the production compose puts the proxy behind readiness. A node whose
migration fails logs it and exits 1, so an orchestrator shows a crash loop instead of a half-started node.
Every node calls the migrator and the migrator's session advisory lock makes them take turns; the starter
that comes second finds nothing to do.

**What this change first found, and what removed it.** The migrator's lock was at first a blocking
`pg_advisory_lock`, and two real API processes started together against an empty database deadlocked: a
starter waiting in that statement is inside a transaction, the running migration `0009` builds its indexes
with `CREATE INDEX CONCURRENTLY`, which waits for every transaction that could see the table to end, and the
waiter waits for the runner's lock. PostgreSQL aborted one with `deadlock detected` and that node exited 1,
three runs in three. This change therefore carried a lock of its own, taken without waiting, to keep
waiters out of the migrator. **That lock was removed when the migrator was fixed (#286)**: it now polls
`pg_try_advisory_lock`, so a waiting starter holds nothing open. The two-process test is unchanged in what it
asks and now passes because of the migrator; with the migrator's lock taken out it fails three runs in three
(the node that lost the race exits), which is the honest check that the test still needs the protection
it claims.

**What this still adds**, since the lock it carried is gone: the opt-in, the order (listener first, so
liveness and readiness tell the truth during a migration), the exit on failure, and the process-level proof
that two nodes starting together both become ready with every migration recorded once.

**Rejected: a separate migration job (an init container, `compose run`).** Right for a large cloud and wrong
for a one-container self-host, where the second thing to remember is the thing nobody installed; it stays
possible by leaving the variable off and running `bun run db:migrate` from the same image. **Rejected: leader
election or a heartbeat table.** The database already provides a lock that disappears with its owner.
**Rejected: keeping a second lock "in case".** Two locks that must agree are one more thing to be wrong; the
test is what would show the migrator regressing.

**Reversibility:** free. A variable and a function; migrations themselves are unchanged.

*Amended 2026-10-09:* `migrateOnStart` takes the connection settings, not the application's pool, and
opens and closes a connection of its own (D-87, amended): the pool's 30 s statement limit must not apply to a
migration. A test has the migration record the `statement_timeout` its own session was given (`0`, where
the application's pool shows `30s`) and counts sessions afterwards (none left, on success or failure).
