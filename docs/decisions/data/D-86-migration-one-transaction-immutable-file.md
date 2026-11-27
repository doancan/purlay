# D-86. A migration is one transaction unless its file says otherwise, and a file that has run cannot change

*Amended by D-219: Dependabot opens no pull requests; updates are the owner's.*

Kysely's migrator ran every pending migration in one transaction and recorded nothing about the file. Two
consequences were measured on 1,000,000 messages (#240). `0007` claimed that adding a constraint `NOT VALID`
and then validating it "lets writes continue"; inside one transaction the `ACCESS EXCLUSIVE` lock of the
`ADD CONSTRAINT` is held to the commit, and a concurrent `SELECT` hit its 2 s statement timeout while the
validation scanned the table (the same migration, opted out, delayed no `SELECT` by more than 150 ms). And
`CREATE INDEX CONCURRENTLY` is refused inside a transaction, so no index could be added to a large table
without locking its writes.

**Decided: the migrator is ours, and the opt-out is declared in the file.** A comment in the file's leading
block, `-- purlay: no-transaction`, runs that migration statement by statement with no transaction around
it. The default stays one transaction per file, with its record written in the same transaction, so a
failed migration leaves nothing behind. A file that opts out gives that up and must be written to run again:
`IF NOT EXISTS`, and `DROP INDEX CONCURRENTLY IF EXISTS` before a `CREATE INDEX CONCURRENTLY`, because a
build that fails leaves an invalid index. Each statement is sent on its own, because PostgreSQL treats a
string of several statements as one implicit transaction. Concurrent starters take a session advisory lock
and run in turn; the third waits for the first and finds nothing to do.

**Decided: each applied migration records the SHA-256 of its file**, and a mismatch, a missing file or an
out-of-order name is a failure before any migration runs. A database migrated before checksums existed has
none recorded for its rows; they are **adopted once**, from the files as they stand. That is trust on first
use, and the cost is stated: an edit made before the first run of this migrator is not caught. The one edit
this change itself makes to an applied file, the corrected `0007` comment, is of that kind.

**The CLI reads `DATABASE_SSL`** like the application, through the same client, and refuses a value it
cannot read rather than connecting in the clear.

**Rejected — Kysely's `disableTransactions` for the whole run.** It is all or nothing: every migration
loses its atomicity because one needs to leave the transaction. **Rejected — a separate directory or
extension for non-transactional migrations:** the order of the migrations is one sequence, and a second
place to look is a second place to forget. **Rejected — a checksum that ignores comments:** needs a SQL
lexer to be right and decides what counts as a change; the file is the unit. **Rejected — refusing to
adopt unchecksummed rows:** it would fail every existing database for a risk that cannot be measured.

**Reversibility:** costly once migrations carry checksums, since the recorded values are the contract; the
opt-out line is one comment and costs nothing to remove from a file that has not run.

*Amended 2026-10-09:* readiness asks the same question the migrator asks before it runs
(`migrationHistoryProblem`), read-only, and reports an edited, missing or out-of-order migration as not
ready. A database that predates the checksum column has nothing to compare and is not accused. Without it,
a process whose files had parted from its schema would pass readiness and fail on the first query that
depended on the difference.

*Amended 2026-10-09 — the lock is polled, not waited for:* with two processes starting on an empty database,
one died with `deadlock detected` on every run (ten of ten in the test written for it). A blocking
`pg_advisory_lock` is a statement, and a statement is a transaction to PostgreSQL while it waits;
`CREATE INDEX CONCURRENTLY` (migration 0009) waits for every transaction that could see its table to end.
The runner waited for the starter, the starter for the runner's lock, and PostgreSQL ended one. The
earlier test of three starters had no concurrent index build and could not see it. The migrator now tries
`pg_try_advisory_lock` and sleeps between attempts (25 ms, doubling to 500 ms, for at most 120 s, then an
error that says another process held the lock). Between attempts the session is idle, which an index build
has nothing to wait for. The lock is taken on the one session the run holds, is released on every path past
acquiring it (a test fails a migration and then expects another starter to get the lock at once), and
ends with the session if the process dies. Two `db:migrate` processes started together on a fresh database
exit 0 five times in five, with all ten migrations applied once between them.
**Rejected — a lock per migration:** the wait would still be a statement in a transaction, now repeated
for every file. **Rejected — only a `lock_timeout`:** it turns the deadlock into a timeout error that
exits one of two healthy starters, instead of making it wait its turn. **Rejected — running the build and
the wait on separate connections without polling:** the waiting connection is the transaction the build
waits for; only not being in a statement avoids it.

*Amended 2026-10-09 — a deadlock against live traffic is retried, and "for an instant" was wrong:* a
second-round audit ran migration 0010 against live sends. At about 150 writes a second ten runs in ten
were untouched; at about 5,000 the migrator was ended with `deadlock detected`. An `ALTER TABLE` is granted its
exclusive lock only after every transaction already using the table, and a send takes `messages` and then
`channels` where the migration asks for them the other way round, so under load the two wait for each
other and PostgreSQL ends one. The migration's header said the lock was held "for an instant"; it is held
for as long as it takes to be granted.
**Decided: a migration is run again when PostgreSQL ends it with SQLSTATE `40P01`**, at most five attempts
in all, waiting 250, 500, 1000 and 2000 ms, each retry reported (`onRetry`: the CLI prints it, the API logs
it at `warn`), and the last deadlock thrown as it was when the attempts run out. Nothing else is retried: a
violation, a syntax error and a timeout belong to the migration or the data. **Why this is safe, for each
kind of file.** A transactional migration is rolled back whole by the deadlock, so running it again starts
from the state it started from the first time. A non-transactional migration may have committed earlier
statements, and the unit of retry is the *file, from its top*, not the statement that was waiting: D-86
already requires such a file to be safe to run again from the top, because a crash and a restart do exactly
that. A single statement is not retried on its own, because the one that was ended might be a `CREATE INDEX
CONCURRENTLY` that left an invalid index, which only its file's own `DROP INDEX IF EXISTS` clears.
**Rejected — retrying a statement:** that. **Rejected — retrying every error:** it hides a bad migration
behind a delay. **Rejected — taking the application's locks first, or locking the table up front:** it blocks
every writer for the duration, which is the cost the non-transactional form exists to avoid.
**Operators:** run migrations at low traffic. A retry makes a deadlock survivable, not cheap; a node migrating
on start under heavy load may need several attempts, and the log says so.
**A corrected comment in an applied migration is allowed, by a table in `migrator.ts`, not by editing
silently.** The files are checksummed whole, so a corrected comment looks like an edited statement and
would make every database that applied the migration refuse to start. `COMMENT_ONLY_EDITS` names the
checksum those databases recorded and the checksum of what the file *does* (comments removed, whitespace
collapsed, `executableText`); the edit is accepted only when both match, so a change to any statement is
refused as before, and the new checksum is recorded on the next run. A test fails if an entry stops
describing its file. The header of 0010 is the first use; 0007's earlier correction predates checksums and
was adopted instead. **Rejected — ignoring comments in every checksum:** it would change what every
recorded checksum means and makes any comment edit invisible, including a misleading one.

---

*Amended 2026-11-02 — a module has a set of its own (D-250):* the migrator takes the core's directory and the
sets of the enabled modules, each a directory of its own, and applies the core's first. A module's rows are
recorded as `<module>/<file>`; **the rows that exist are left as they are and are the core's**, so no database is
rewritten and the restore rehearsal's dump does not move. Order, checksum, a missing file and an out-of-order file
are checked within a set, never across sets, so two sets may both have a `0001` and a module that was off for
releases opens where it stopped. Rows of a module this run does not carry are not an error: the migrator hands
their names to the caller to log. The lock stays one, taken once for the whole run. The schema stamp of an export
reads the core's rows only, so a module that is off does not change it. **Rejected — renaming the existing rows to
`chat/…`:** `0055` selects one by name and would silently update nothing on a fresh database, and the rename
gains nothing a new file under a module's directory does not.

*Amended 2026-11-04 — a transactional migration waits ten seconds for a lock, not for ever:* an `ALTER TABLE` is
granted its lock after every transaction already using the table, and while it waits it is first in line, so a
plain `SELECT` behind it waits too. Reproduced on a private database: one open transaction holding `ACCESS SHARE`
on a table, one `ALTER TABLE`, one `SELECT` — the `SELECT` was answered after 8.01 s, when the transaction ended;
with `lock_timeout = 5s` on the migrating session the `ALTER` failed at 5.05 s and the `SELECT` was answered at the
same moment. With several nodes migrating as they start, that is an outage as long as the longest transaction.
Every transactional migration now runs with `lock_timeout` set for its transaction alone (`set_config(…, true)`),
ten seconds, the value the files that leave their transaction (0010, 0058, 0072) already set for themselves; a
file that needs another says so with `SET LOCAL lock_timeout`, which comes after. A migration that ends on it fails
with a message that names the file and what to do (find the long transaction, let it finish or end it, migrate
again); it is not recorded and runs again from its top, so a restarting node tries again by itself. **The counter-
risk was measured and is smaller than it looks:** `lock_timeout` counts the wait to *get* a lock and never how long
a granted one is held, so a backfill is not cut short (an `ALTER` and then 3 s of work under a 1 s limit
completed), and `chat/0001` on 200,000 messages and 40,000 attachments applied with the default. **Rejected — the
same limit on files that leave their transaction:** `CREATE INDEX CONCURRENTLY` waits for old snapshots without
blocking anyone, and `lock_timeout` ends that wait too, leaving an invalid index (measured: failed at 1.0 s with
an open repeatable-read transaction, `indisvalid = false`); those files bound the statements that queue (`SET
lock_timeout` before an `ALTER`) and leave the index build alone, as 0058 does. **Rejected — an environment
variable:** nothing the operator can usefully choose differently; a migration that must wait longer is a
migration, and says so. **Rejected — retrying the migration inside the process:** the wait is for a transaction
only a person can judge (end it or wait for it), and a restart already is the retry. Reversibility: free, one
constant.
