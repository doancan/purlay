# D-294. A new module is made by a command whose result the guards accept, and a list that can be derived is not kept by hand — builds on D-250, D-254, D-260, D-271, D-280, D-291; amends `MODULES.md` §9

**Context.** `MODULES.md` §9 asks a new module for about twenty-five edits across the API, the database package, the contract, the
tests, the workflow and seven documents, each guarded by a test that fails only after the edit was forgotten. The next modules are
products, and the rule of this repository is that a rule without a mechanism is a wish (`CONTRIBUTING.md` §6.2): a third module
built by following a list of that length would be built differently from the second, and the checklist would drift from the
guards it describes.

**Decision.**

1. **Derive before generating.** The lists that named every module are now read from the bundle or from the module's folder:
   the `module-suites` matrix of CI (`bun run modules:cells`, read by the workflow with `fromJSON`), the smoke test's carried modules,
   the set and `MODULES` reading tests, the baseline of the migration-safety test (a set it does not name is held from its first
   file) and the lifecycle seed (`features/<id>/testing.ts`, `seedLifecycle`). What still names a module is what is a decision:
   the registry lines, the ownership and lifecycle of its tables, the endpoints, the id of the wire.
2. **`bun run module:new <id> [--requires a,b] [--optional c,d] [--dry-run]`** makes a module from the templates in
   `apps/api/src/testing/module-new/templates/`: a folder under `features/<id>/` (manifest with a budget and a deadline, schema,
   routes as a plugin, data hooks, a workers file with no worker, the lifecycle seed, the pool-share test and a route test, and a
   scenario for each optional partner, D-291), the migration set, the types and endpoints, the lines in the registries, the rows
   of seven documents, a decision skeleton, three starter mutations in their own area file, and the module's entry in `HOT_PATHS`
   as having none, with the reason. With `DATABASE_URL` it regenerates the database types from a throwaway clone. Its edits are at
   anchors that must be found exactly once in the files as they are; one that is not stops the run before anything is written,
   a module that exists is left alone, and the files it writes are formatted.
3. **The result is held by a test that runs it.** `module-new.integration.test.ts` copies the repository, runs the command on the
   copy, and requires the compilers, the linter on what was made, and the guards of the seams, the budgets, the ownership of routes
   and tables, the contract, the migrations and the mutation list to accept it with no further edit; the one thing that fails is
   `scaffold-leftovers.test.ts`, which names the sentences the author owes (the marked lines of the decision and of the module's
   section), so a module cannot merge with a placeholder. A guard that starts to need a hand edit fails that test first.
4. **`docs/MODULE-GUIDE.md`** is the author's guide by task, bound to the repository by `module-guide.test.ts` (each path and
   command it names exists); `MODULES.md` §9 stays the reviewer's list and the guide repeats none of its rules.
5. **Not built.** The module's web feature (manifest, screen, registry line, catalogue words) and its measured hot path are the
   author's and stay in §9 item 5 and `HOT_PATHS`: the client's API object, keys and catalogues have no declaration a module can be
   added to without an edit of them, and a scaffold of a screen that is not designed is code to delete.

**Rejected.** *A generator that edits any file it can find a similar line in*: a moved line would be edited wrongly and quietly;
an anchor found once or nothing is the §6.3 rule that a mechanical edit asserts that it matched. *Marker comments in the files the
generator edits*: they are one more thing to keep, where a line the file already has is an anchor that fails when it goes.
*A table of the modules in the generator*: the bundle is the list. *A test that only runs the generator's unit tests*: the guards
it must satisfy change under it, which only a run of both shows.

**Cost of reversing.** The generator and its templates are a folder and a test; deleting them loses the command and leaves every
module as built. The derived lists were hand lists that a test held to the bundle, so restoring one is an edit, and the
workflow's matrix is one line.
