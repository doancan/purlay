# D-271. A module's functions take a handle typed with its own tables, derived from the owners list, so another module's table does not compile — builds on D-250, D-254, D-266; amends `MODULES.md` §4 and §5

**Context.** `MODULES.md` §4 promised a query handle typed with a module's own tables and the core's, and §8 listed "no read
of another module's tables" as not built, so the rule held on paper: the one generated `DB` lets any function `selectFrom`
any table. Measured on the code: nothing in chat names an issues table and nothing in issues names a chat table, so
there is nothing to repair, and the compiler cannot yet say it stays so for a third module. What does cross is small: issues reads
`users`, `workspaces` and `workspace_members`; chat reads those and `attachments`, and **writes** a core table in five places
(a claimed upload twice, a workspace's storage counter, `users.missed_mail_since` twice); `cli/` has three demo and
benchmark files that name chat's channels. The raw `sql` of chat is 127 templates, almost all expression fragments
(`count(*)::int`, `state_version + 1`) that name no table. D-266 declined "a type that hides the raw handle" because chat's
services take `Executor` by the hundred and a brand all of them had to be changed for cost more than it guarded.

**Decision.**

1. **One schema a module sees, derived.** `TABLE_OWNERS` is `as const satisfies Readonly<Record<keyof DB, TableOwner>>`
   (a table with no owner still does not compile), `TablesOf<owner>` is the union of an owner's table names, and
   `ModuleSchema<module, coreReads>` is `Pick<DB, TablesOf<module> | coreReads>`: the module's tables from the list, and the
   core tables it names, which is a line in the module's own `features/<id>/schema.ts` and so a diff a reviewer reads, as an
   import is. `ModuleDb<schema>` is `Kysely<schema> | Transaction<schema>` and `ModuleTransaction<schema>` is the transaction;
   a module's `schema.ts` makes its `<Id>Db` and `<Id>Tx`. A table cannot be "own" to two modules, and a new one enters its
   module's schema by being added to `TABLE_OWNERS`, which it must be for the file to compile. There is no generated
   `schema.ts` per module (`MODULES.md` §5 said there would be): the generated file is already one, and who owns what is
   already a list a test holds to the database.
2. **Types only; the object is the one every caller already passes.** The handle is a type alias over the leased `Executor` of
   D-266. Nothing is wrapped, nothing is checked at run time, and callers (handlers, the composition, the data hooks, tests)
   keep passing what they pass: `Executor`, `Transaction`, a hook typed `(tx: IssuesTx) => …` fits the core's slot. **This is not
   the brand D-266 rejected**: no new runtime object, nothing that every call site must be changed to construct, and the one
   signature change is mechanical and local, `Executor` and `Transaction` in a module's own files read `<Id>Db` and `<Id>Tx`
   as the module is moved (issues in this change; chat in steps). The core's helpers (`recordAudit`, `tableExists`,
   `requireWorkspaceMembership`) keep taking `Executor`, and a module's handle is assignable to it.
3. **`Executor` is `Kysely<DB> | Transaction<DB>`, a change of the type the most code takes.** Kysely's generics make
   `Transaction<DB>` to `Kysely<Sub>` and `Transaction<Sub>` to `Kysely<DB>` not assignable, though `Kysely<DB>` to `Kysely<Sub>`
   is. With a plain `Kysely<Sub>` handle a trial over chat and issues failed 524 type checks, 404 of them tests handing a
   transaction to a service; with the two unions, none. The cost: a value **typed** `Executor` that is called `.destroy()` or
   `.transaction()` now meets kysely's `@deprecated` overrides on `Transaction` (the lint says so), so what a pool is made
   into is typed for what it is: `createDatabase` and `createMigrationDatabase` return `DatabasePool` (`Kysely<DB>`), and a
   service takes `Executor`. `migrateToLatest` takes an `Executor` and not a generic `Kysely<T>`, which TypeScript 6 would not
   accept the union for. `module-db.test.ts` holds both directions of assignability that kysely's variance leaves to luck, so
   an upgrade of kysely fails there by name.
4. **What the handle is not.** It does not tell a read of a core table from a write; it does not see raw `sql`, and
   `sql.ref('issues.id')` type-checks anywhere; and a function that is still typed `Executor` or `Database` is not held, so the
   wall is as strong as every public function of a module declaring the module's type. A wall for each: a text scan of the
   `sql` templates and string-named tables of every feature (a table that is not the module's or one it reads fails; a write
   of a core table is held to a list that only shrinks, chat's four), and a lint rule that bans `Executor`, `Transaction`,
   `Database` and `DB` from `@purlay/db` in a feature that is behind its handle, and `sql.raw`, `sql.table`, `sql.id` and
   `sql.lit` in every feature, which build a name at run time. A table named at run time by other means is not seen. Chat's
   raw-`sql` exemption is **policed by that scan, not ended**: wrapping 127 fragments in typed builders would be
   a large change for no isolation gain, since none names a table that is not chat's, `users` or `attachments`.
5. **Held how.** `module-db.test.ts` builds a program with the compiler's API, because `@ts-expect-error` is checked by `tsc`
   alone and `bun run mutate` runs tests alone: each case a module may not do is paired with the same statement over a table it
   holds, which must compile; mutations `module-schema-ignores-ownership`, `module-schema-forgets-core-reads`,
   `module-handle-is-not-a-union` and `executor-is-not-a-union`. **Built:** the types, issues behind them, the text scan
   (`module-tables.test.ts`, with `CORE_WRITES`: chat's four, each with why) and the lint (`NO_WHOLE_DATABASE` for every feature,
   and `NO_RUNTIME_TABLE_NAMES`, both shown by `verify:enforcement`); mutations `module-tables-scan-ignores-sql-templates`,
   `module-tables-scan-allows-every-owner` and `module-tables-core-writes-not-held-to-list`. Chat's functions moved behind its
   handle in four steps, held meanwhile by a per-file list that only shrank; its last step emptied the list, deleted it, and put
   chat under the lint with every other feature. A folder under `features/` with no `schema.ts` fails `module-tables.test.ts`.

**Rejected.** *A generated `schema.ts` per module*: a second generated copy of what `TABLE_OWNERS` already says, with a
generator to keep it true. *A runtime proxy that throws on a table that is not the module's*: a cost on every query, found
only when the path runs, where the compiler finds it at once. *A brand over `Executor`* (D-266): see 2. *A handle of `Kysely<Sub>`
alone*: 524 errors, see 3. *Ending chat's raw-`sql` exemption by wrapping its fragments*: see 4. *Typing the core with a
`CoreDb`*: `core-tables.test.ts` already holds the core to naming no module table, at zero. *A read and a write handle for
the core's tables*: the five writes are listed and held to a list instead, and each is a candidate for a port
(`AttachmentOwner`, `platform/quota`, a preference port), not a type.

**Cost.** Type-check time, `bun run typecheck` cold (`tsc --build --force`, this machine, three runs): TypeScript 7 2.8 s to
3.4 s (+21%), TypeScript 6 25.0 s to 25.9 s (+3%); `apps/api` alone 4.19 M to 4.80 M instantiations on TypeScript 7 and
2.18 M to 2.33 M on 6. All of it is the global `Executor` union; issues is five files. **Cost of reversing:** delete the
`schema.ts` files and `module-db.ts`, put `Executor` back to `Kysely<DB>` and `createDatabase` to return it. Nothing is stored.
