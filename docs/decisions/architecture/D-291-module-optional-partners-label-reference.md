# D-291. A module says what it does without each optional partner, a generated case runs it, and a reference to another module is a label and never a key — builds on D-250, D-254, D-283; amends `MODULES.md` §2, §4 and §9

**Context.** `optional` has meant "used when present" since D-250, and the sentence of what a user then sees was a line of the
checklist that nothing read. The next module will list two partners, and a partner that is off, or one a deployment never ran,
is the ordinary case for a module that is sold apart. Two questions had no mechanism: what proves a module works without a
partner, and what a row that points at another module's record is when that record is gone.

**Decision.**

1. **`degrades` is a required field of the manifest.** One sentence for each `optional` partner and for no other module; `{}` for
   a module with none. The registry refuses a partner with no sentence, an empty sentence, a sentence for a module the manifest
   does not list as optional, and a manifest that leaves the field out (a snapshot or a script has no compiler to forbid it).
   `released-manifests.json` is not held to it: an `optional` does not become `requires` (D-250 rule 6) and that is the only
   thing about the edge a release must keep.
2. **A sentence is a claim with a case.** `testing/degradation.ts` reads every (module, optional partner) edge of the build and,
   for each, composes the build with the partner left out of `MODULES` (and every module that requires it, directly or through
   another), then runs the module's scenario on that composition. A module writes its scenarios in
   `features/<id>/degradation.testing.ts` as `Degradation<typeof manifest>`, a record with one key for each optional partner, so a
   partner added to the manifest stops the file compiling; `degradation.test.ts` finds the files by their folder, fails for an edge
   with no scenario and for a scenario with no edge, and runs the cases, named `<module> without <partner>`. The generator is proved
   on a pair of modules made for it (`notes`, which draws a link's live label from a `wiki` port or the one it saved). The real
   build has **no optional edge yet** (neither chat nor issues lists a partner), so no real scenario exists; the first module that
   lists one writes its file and the case appears. Scenarios run on the composition: those that need a database or a route
   build the application from it as the integration tests do. *Not built:* the second world, a partner that runs but is not
   entitled in a workspace. *(Amended D-289: the entitlements are built; the second world is still not, and `MODULES.md` §10 says what
   would start it.)*
3. **A reference to another module's record is opaque and carries its label.** The referring module stores, in its own table, a
   `(module, type, id)` and the short label (the title) the record had when it was linked. There is **no foreign key** to the
   other module's table (D-250 rule 5; `module-foreign-keys.integration.test.ts` holds that a key between modules is declared by
   `requires` at all, and `module-tables.test.ts` that a module's functions cannot name the other's table). **The absence of the
   target is a view, not an error:** a target that is off, not entitled, deleted or not visible to the viewer is shown as its
   saved label, as plain text, with "not available here" and no link, and the module never answers `404` or `500` for it. Nobody can
   tell "gone" from "you cannot see it". **Deleting the target never cascades** to its referrers, and a referrer never reads the
   target's table: it asks a port the target provides, which is `undefined` where the target does not run (D-283 §3). The label is
   workspace content of the referrer and is covered by its export and purge; a label left behind by a target deleted while the
   referrer was not told is accepted, and a fact the target publishes on deletion lets the referrer clear it without making
   correctness depend on that. *(Built, item 5.)*
4. **The guards are the ones that exist** plus the registry's rule and the generated case. No new scan of migrations was written
   for item 3: a key across modules already fails the build, and a read of another module's table does not compile.
5. **The reference and its resolver are built, for the module that links first (`tasks`).** `ModuleRef { module, type, id }` and
   `ports.resolveRef(ref, scope)` answer `{ status: 'available', ref, label }` or the one value `{ status: 'unavailable' }`; the
   provider supplies `RecordResolver` under `<its id>.records` (issues: an issue by id inside the workspace, any member reading any
   issue, D-254). Every ground for not showing a record is that one answer, so absence leaks nothing across workspaces: the provider
   not run, stopped (D-296), not granted to the workspace (D-289), a record deleted, of another workspace, of another kind, an id
   that is no UUID, and a capability the asker does not `use`. A failure of the database is the one thing thrown: it is not a
   record's absence. `ports` is part of `ModuleRouteDependencies`, of a worker's context and of a fact consumer's arguments, one
   view for each module made by `Composition.portsFor` from the manifest's `uses` and bound to the database of the request or
   iteration (so the asker's share of the pool holds the question); `ports.of(scope)` is per workspace, `scope` being a request's
   `WorkspaceContext` or a delivered fact (which carries the modules its workspace may use, read at delivery).

**Rejected.** *A foreign key to the other module's record*: it makes the module need the other's tables and turns a deletion into a
cascade across a boundary (D-250 rule 5). *Only the id*: the viewer would see "something" where a title was. *A live label read
from the other module on every view with no saved one*: a partner that is off leaves nothing to show, and a stale label is not
worse than none. *A `degrades` that is a list of test names*: the sentence is for the reader, the case is derived, and a list is
a second place to forget. *Running only the process world until entitlements land and saying so nowhere*: the second world is
named above as not built.

**Cost of reversing.** `degrades` is additive to the manifest and read by the registry and one test; removing it loses the
refusal and the cases and changes no stored data. Item 3 is a rule for rows a later module writes; none exists yet.
