# Purlay — Writing a module (`MODULE-GUIDE.md`)

> Authority: `DECISIONS.md` D-294 (and D-250, D-283, D-291 for the rules it points at). This guide is by task: *what do I run, what
> do I write, what will fail*. It repeats no rule: `MODULES.md` §9 is the checklist a reviewer holds a module to, and each task
> below names the part of it that applies. Every file and command it names exists, and `module-guide.test.ts` fails when one stops.

---

## 1. Add a module

```
bun run module:new notes --dry-run     # what would be made and changed, nothing written
bun run module:new notes               # a module that compiles and passes the guards
```

Flags: `--requires a,b` for modules it cannot start without, `--optional c,d` for modules it uses when they run. An id is
lowercase letters, digits and hyphens, at most 32, and not a path the core owns. With `DATABASE_URL` set (the database named in
`.env.test` will do) it also regenerates `packages/db/src/schema.ts` from a throwaway clone; without it, run `bun run db:check`
against a database (it migrates a throwaway clone, rewrites the file and exits 1 because the file changed: commit it). A second `module:new`
is the same as the first, however many modules there are; a second run of the same id says the module exists and changes nothing; a file it
needs to edit that has moved stops the run before anything is written.

**What it makes** (`apps/api/src/testing/module-new/templates/` is the text; the module is `notes` below):

| Where | What |
|---|---|
| `apps/api/src/features/notes/` | `module.ts` (the manifest: `budget`, `routes`, `degrades`), `budget.ts`, `schema.ts` (the tables it may name), `items.ts` (a list and a create), `export.ts` and `personal-export.ts` (the data hooks), `workers.ts` (none yet), `testing.ts` (the lifecycle seed), `degradation.testing.ts` with `--optional` |
| `apps/api/src/features/notes/http/` | `routes.ts` (the plugin), `handlers.ts`, the pool-share test `budget.integration.test.ts` and the route test |
| `packages/db/migrations/notes/0001_notes.sql` | the table: `workspace_id` with a cascade, bounds in `CHECK`s, the list's index |
| `packages/types/src/notes.ts` | the wire types and `NOTES_FACTS`, an empty list already joined to `FACTS` in `facts.ts`; the two endpoints are in `endpoints.ts`, the id in `modules.ts` |
| the registries | `apps/api/src/composition.ts` (`bundledModules`), `packages/db/src/migrator.ts` (the set and its requirements), `packages/db/src/table-owners.ts`, `packages/db/src/table-lifecycle.ts`, `HOT_PATHS` in `apps/api/src/cli/budget-latency.ts` |
| the documents | `MODULES.md` §11 (row and section), `SCHEMA.md` (the table and §12), `DATA.md`, `API.md`, `CONFIG.md`, `ARCHITECTURE.md`, a skeleton decision in `DECISIONS.md`, the decision count in `README.md` |

**What you owe.** Every place the generator could not write for you is marked with a placeholder (`scaffold-leftovers.test.ts` lists
them and fails until none is left): the decision (what the module is and is not, who may do what, what happens to its data when it
is off, what reversing costs), the removal threshold of its section, and the sentence of each optional partner. Then replace what is
scaffold: the table and the routes are a title and a list; give the module its own shape, and its own web feature when it has a screen.
The hot path is declared as having none, with a reason, until you give it a measured one (`HOT_PATHS`: copy issues').

**What proves it.** `module-new.integration.test.ts` runs exactly this on a copy of the repository: the generator twice (a module and a
second that consumes a fact of the first), the declarations an author writes (a fact, a kind of notice, a search source), the schema held
to the migrations, the compilers, the guards of the seams (`MODULES.md` §8), the tests that list facts, kinds and sources, and the
documents. A guard that starts to want a hand edit fails there first.

Then add the mutations for the rules only your tests guard (`CONTRIBUTING.md` §5), a changelog entry when a person can use the
module, and run `bun run verify`.

## 2. Choose how modules talk (D-283)

| You need | Use | Absent partner means |
|---|---|---|
| a read that shapes your request (is this person in that channel) | a port you `use`, provided by the other module (`apps/api/src/platform/ports/`) | `undefined`: you say in code what you do instead |
| to tell the core's inbox something in your transaction | the `NotificationSink` port | the sink refuses a kind no running module declares |
| an effect on a module that may be absent or slow | a fact you `publish` and the other `consume`s, delivered by the outbox | the fact's `absent` policy |
| a hint that may be lost (read again, presence) | the domain bus or the socket event bus | nobody listening is not an error |
| a reference to another module's record | an opaque `(module, type, id)` and the label it had when linked (D-291) | a "not available here" view, never an error |

`uses` never makes a requirement: a partner you `use` is listed `optional` (or `requires` if you truly cannot run without it).

## 3. Use a port

Declare the capability you ask for in `uses` with the provider in `optional` or `requires`; the registry refuses a capability nobody
provides. The composition hands you the implementation of the modules that run and `undefined` for one that does not (`Port<T>`,
`apps/api/src/platform/ports/ports.ts`), so the compiler makes you handle absence. The provider lists it under `provides` and supplies it in
`ports` of its slot in `apps/api/src/composition.ts`; `compose` stops a build where the two differ.

## 4. Say, and prove, what you do without a partner

For every `optional` partner write the sentence in `degrades` and the scenario in `features/<id>/degradation.testing.ts` (`--optional` makes
both as stubs). `degradation.test.ts` composes the build without the partner and runs the scenario; it fails for an edge with no scenario. A
reference to the partner's records follows D-291: your own table holds `(module, type, id)` and the label, with no key to the other
module, and a missing target is a view.

## 5. Publish a fact

Name it `<id>.<what>` and declare it with `defineFact` in the `<ID>_FACTS` of `packages/types/src/<id>.ts`, which the generator made and
already joined to `FACTS` in `packages/types/src/facts.ts`. Import `defineFact` from `./fact-declaration`, never from `./facts`: that file
imports your list, so a value taken from it is a cycle that fails at load. List the type in the manifest's `publishes`; a consumer lists it
in `consumes` and supplies a handler in `factConsumers` of its slot (`MODULES.md` §4, `fact-owners.test.ts`,
`module-communication.test.ts`). A route publishes with `publishFact` of the dependencies it is handed (`ModuleRouteDependencies`), inside
`atomicallyOn(database)`: `publishFact(transaction, workspaceContext, FACT, payload)` writes the rows in that transaction, as the module whose
route it is and for no other (`platform/ports/fact-publisher.ts`). The contract is built; the delivery by the outbox is the part of D-283 §1
that `MODULES.md` §10 says whether it has landed.

## 6. Add a worker

A background loop inside the API process is an entry of `workers` in `features/<id>/workers.ts` (the generated file has none): a
`name`, an `intervalMs` from a second to an hour and the `work`, which is given the module's leased database, the clock, the bus and push
and opens no connection of its own (D-281). It runs only where the module runs, in the module's share, cut off at `workerDeadline`.
A scheduled job is not a worker: it is `jobs` or `retention` in the manifest, `jobWork` in the slot and a place in `PLAN`
(`apps/api/src/modules/jobs/schedule.ts`).

## 7. Make it sellable

A module is on or off for a whole process by `MODULES` (D-250). Whether a workspace is entitled to it is the workspace-level
enablement of D-250 rule 9, which `MODULES.md` §10 marks as built or not: until it is, "sellable" means what the process runs, and a
module written for it needs nothing more than the rules above, because everything it does is already closed when it is off (routes,
frames, events, jobs, workers, search, notifications). What it must get right now: a name and a removal threshold (`MODULES.md` §11),
data decisions for erasure and export that hold whether or not it runs, and a `degrades` for every partner.

## 8. What stays by hand

The list a reviewer reads, and the only edits a new module makes outside its folder that the generator does not: a hot path of its own
in `HOT_PATHS` and the web feature (`apps/web/src/features/<id>/`, its line in `modules/registry.ts`, the catalogue words), and, for a
search source, the member of `FindTarget` (`packages/types/src/find.ts`) that says where a hit leads: it is the wire's, and a client that
does not know it ignores it. Everything else is derived from the bundle, or made by `module:new`: the tests that list modules, facts,
kinds and sources read them from the manifests.
