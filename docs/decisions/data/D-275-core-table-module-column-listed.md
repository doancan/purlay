# D-275. A column of a core table that exists for one module is acceptable only if it is listed, and a new one is a table of the module's own — builds on D-250, D-271

**Context.** A table has one owner (D-250), and a column does not. The core's `users`, `workspace_members`, `workspaces` and
`server_settings` carry columns that only chat uses, made before there were modules: `users.quiet_days`, `quiet_from`,
`quiet_to`, `away_chosen` and `missed_mail_since`; `workspace_members.deep_work_until` and `is_deep_work_active`;
`workspaces.retention_days`; and the six `server_settings.github_app_*` credentials of chat's GitHub App, fourteen in all. They
were found by reading every column of the core's tables against who names it (each in `apps/api/src`, outside tests): the
core names them only in the routes that set them (`modules/users`, `modules/workspaces`, `modules/setup`), the erasure that
clears one and the two exports that list them; chat's files read and, once, write one. Not on the list, though they look like
it: `workspaces.storage_quota_bytes` and `storage_used_bytes` are the attachments' own, which are the core's (chat's write is
in `CORE_WRITES`, `module-tables.test.ts`, as a seam for `platform/quota`), and `attachments.claimed_at` is the core's claim on
an upload; `users.title`, `time_zone`, `status_text` and `locale` are the person's profile, read by the core's mail and every
module. Nothing stopped the next such column: a module's migration set adding one to `users` fails the cells test, but a core
migration that did it for a module was one a reviewer had to notice.

**Decision.**

1. **The columns are not moved now.** A move is a migration (expand, backfill, switch readers, drop) on tables every request
   reads, and nobody has felt the cost of leaving them: no lock, no erasure the core cannot make, no second module wanting
   one. Recorded as the decision, with the conditions below, so that it is revisited by a cause and not by taste.
2. **They are listed, capped and held** (`CORE_COLUMNS_FOR_A_MODULE`, `@purlay/db`; `core-columns.test.ts`). Each entry is a
   column of a core table, for a module of the build, with why, and with the core's files that may name it. The test fails
   when the list is longer or shorter than its cap (**it only shrinks**, and raising it is a decision a reviewer sees), when a
   file of the core outside an entry's files names a listed column, when a file of another module does, when an entry's file no
   longer names its column, and when a migration set of a module adds a column to a core table (a text scan; the cells test,
   `migration-cells.integration.test.ts`, holds the same on the database and stays).
3. **A new column of a core table for one module is never added.** The module makes a table of its own, keyed by the core's row,
   with its foreign key running to the core (D-250). A column a module has no table for is the sign that the module needs one.
4. **A listed column must move to a table of its module's own** when any of these is true: a second module wants it (it is then
   not one module's: it goes to the core behind a port, or to the module that owns its meaning); a core file outside its entry
   needs it; the module's set must change its type or constraint (a set may not change a core column, so the move is the only
   way); or the person who feels it says so, with the cost: a lock held on a hot table, a backfill, an erasure or an export
   the core cannot do without naming the module's words. It moves by expand and contract across releases, and
   its entry is deleted from the list in the change that drops the column.

**Rejected.** *Moving them now*: a migration with a risk, for no pain anyone reported. *A list in the test file*: the list belongs
beside `CORE_COLUMNS_A_SET_CHANGES` and `TABLE_OWNERS`, which say who owns what, and a mutation can change it there.
*A list of columns without the files*: it would let any core file start naming one, which is how a core column becomes a
module's dependency. *Typing the core's columns by module in the generated schema*: a second copy of what the list says, with a
generator to keep it true.

**Cost of reversing.** One list, one test and one section of `MODULES.md`. Nothing is stored.
