# D-46. Integration tests run against a real database, in a transaction, rolled back

`ARCHITECTURE.md` §10 requires integration tests against real PostgreSQL and real migrations, and
never said how they are isolated from each other. That gap decides whether the suite is fast and
trustworthy or slow and flaky, and it constrains the service signatures — so it is settled before
the first service is written, not after.

**Decided: one transaction per test, rolled back at the end. Nothing is truncated and nothing is
re-seeded.**

The consequence is architectural and is why this cannot wait: **every service and repository takes
its executor as an argument** — a `Kysely<Database>` or a `Transaction<Database>`, indistinguishable
to the caller. A service that reaches for a module-level database handle cannot be tested this way,
so the rule is enforced by the same lint boundary that enforces the layering.

**Where a transaction cannot work**, a **template database** is cloned per test file instead:
anything that commits on purpose, the realtime tests that need two connections to observe each
other, and anything touching advisory locks. Cloning a template is milliseconds; migrating a fresh
database per file is not.

*Amended 2026-10-09 (D-77): the template-database clone is also where a write that must commit is
tested — atomicity of a multi-write request, which a rolled-back transaction cannot observe.*

*Amended 2026-10-09 (#246): a hook has five seconds, and the harness must stay far inside them. The
template is built once per process by a preload (`bunfig.toml` → `packages/db/src/testing-preload.ts`),
outside every timer, so a clone is a `CREATE DATABASE` and nothing else. Every `DROP DATABASE` makes
the server run a checkpoint, and the checkpoint costs what the run has written: a file that made
thirteen databases (the migrator's) spent its `afterAll` on thirteen checkpoints and the CI job failed
with "a beforeEach/afterEach hook timed out", twice in a run. Reproduced on a disk throttled to 8 MB/s
(`docker run --device-write-bps`): 2 hook timeouts per full run before, 0 in 10 runs after. So: a test
that only needs to break the schema does it in a rolled-back transaction (readiness), one that needs
a place of its own for the migrator takes a schema, and a clone is for what must commit. A guard in
`harness.integration.test.ts` holds template build, clone and drop to budgets (2.5 s, 1 s, 1 s;
measured 0.12 s, 0.03 s, 0.01 s on a laptop).*

*Amended 2026-10-23 (the environment a run starts in): Bun loads `.env` from the working directory into
every process it starts, so a machine with a development `.env` ran the suite — and each `bun` a test
started in turn — against the developer's key, bucket and database, and three differences between that
machine and CI were found by hand in one afternoon (the demo's sessions signed with another key than the
server they were for; the browser suite's server writing to a real bucket; "without a database" finding
one). A test run, the demo, the browser suite and the budgets are therefore started `bun --no-env-file
--env-file=.env.test`: they read **one** file, the address of the database server they may create scratch
databases on, and a clone with no such file is not an error. Every `bun` they start says `--no-env-file`,
which `scripts/hermetic.test.ts` checks — a rule held by remembering is a wish (D-47). And the database
`withRollback` uses *directly* — the one place a test does not run on a clone of the migrated template —
is brought to the latest migration by the preload as the template is (`migrateIntegrationDatabase`): one
last migrated before a migration was added answered "relation does not exist" to every test that used it.
Considered and rejected: scrubbing the keys `.env` defines from the process in a preload — it cannot tell
a value the developer exported on purpose from the same value in the file.*

*Built 2026-10-08, with the first file that needed it (#31): `cloneIntegrationDatabase` in
`packages/db/src/testing.ts`. The template is `<database>_template`, and it is migrated on every
clone — a no-op when current, and the only thing stopping a template left by an older run from
hiding a migration added since. The clone is dropped in `afterAll`.*

**Rejected — truncating tables between tests.** Slower, and it leaves sequence state and ordering
coupling behind, which is how a suite starts failing only when run in a different order.

**Rejected — a mocked database.** D-21 already requires the real thing. Half of this schema's
correctness lives in partial indexes, CHECK constraints and foreign keys; a mock asserts that our
misunderstanding of them is self-consistent.

**Flaky tests are a defect with a deadline.** A test that fails intermittently is quarantined the
day it is noticed and either fixed or deleted within one working day. A suite people learn to
re-run is a suite that has stopped being a gate, and every enforcement decision in this document
rests on the gate holding.
