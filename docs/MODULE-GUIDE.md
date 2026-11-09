# Purlay — Writing a module (`MODULE-GUIDE.md`)

> Authority: `DECISIONS.md` D-294 (and D-250, D-283, D-291 for the rules it points at). This guide is by task: *what do I run, what
> do I write, what will fail*. It repeats no rule: `MODULES.md` §9 is the checklist a reviewer holds a module to, and each task
> below names the part of it that applies. Every `bun run` command it names is a script of the root `package.json` and every path at the
> repository's root exists; `module-guide.test.ts` fails when one stops. The example module is `acme`: an id no test of this repository uses as a fixture.
> The words *module*, *fact*, *notice*, *grant*, *edition* and *capability* mean one thing each: `MODULES.md` §12.

---

## 1. Add a module

```
bun run module:new acme --dry-run     # what would be made and changed, nothing written
bun run module:new acme               # a module that compiles and passes the guards
```

Then `git add -A`: `scripts/check-docs.test.ts` works from the tracked files and fails with `SCHEMA.md names a migration that is not a file`
until the new files are added. `bun test apps/api/src/testing/scaffold-leftovers.test.ts` lists each placeholder you still owe and fails
until none is left, and `bun run check:docs` and `bun run verify` finish the check. `module:new --help` prints the usage.

Flags: `--requires a,b` for modules it cannot start without, `--optional c,d` for modules it uses when they run. An id is
lowercase letters, digits and hyphens, at most 32, and not a name the core owns (a route segment, `core`, `none`, `all`, a core service or a core table: `RESERVED_MODULE_IDS`). With `DATABASE_URL` set (the database named in
`.env.test` will do) it also regenerates `packages/db/src/schema.ts` from a throwaway clone; without it, run `bun run db:check`
against a database (it migrates a throwaway clone, rewrites the file and exits 1 because the file changed: commit it). A second `module:new`
is the same as the first, however many modules there are; a second run of the same id says the module exists and changes nothing; a file it
needs to edit that has moved stops the run before anything is written.

**What it makes** (`apps/api/src/testing/module-new/templates/` is the text; the module is `acme` below):

| Where | What |
|---|---|
| `apps/api/src/features/acme/` | `module.ts` (the manifest: `budget`, `routes`, `degrades`), `budget.ts`, `schema.ts` (the tables it may name), `items.ts` (a list and a create), `export.ts` and `personal-export.ts` (the data hooks), `workers.ts` (none yet), `testing.ts` (the lifecycle seed), `degradation.testing.ts` with `--optional` |
| `apps/api/src/features/acme/http/` | `routes.ts` (the plugin), `handlers.ts`, the pool-share test `budget.integration.test.ts` and the route test |
| `packages/db/migrations/acme/0001_acme.sql` | the table: `workspace_id` with a cascade, bounds in `CHECK`s, the list's index |
| `packages/types/src/acme.ts` | the wire types and `ACME_FACTS`, an empty list already joined to `FACTS` in `facts.ts`; the two endpoints are in `endpoints.ts`, the id in `modules.ts` |
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

You read them from `ports` of what you are handed: `ModuleRouteDependencies` in a route, the context of a worker, the third argument of a
fact consumer. `ports.of(context)` is asked for each workspace, because a port is there only when its provider runs, was not stopped
by the administrator and is granted to *that* workspace; what you are given are the capabilities your manifest `uses`, no others.
The type of a port is `CapabilityPorts` in `platform/ports/module-ports.ts`: `<id>.records` is a `RecordResolver` for any module, and a new kind of port is a member there.

```ts
const resolver = ports.of(context)['issues.records'];
if (resolver === undefined) return hideTheIssueColumn(); // issues is not run here, or this workspace is not granted it
```

**Link another module's record.** Say it in four steps (D-291):

1. Your manifest lists the partner in `optional` (with its `degrades` sentence) and `uses: ['issues.records']`.
2. Your table stores `(module, type, id)` and the label the record had, with no key to the partner's table: `('issues', 'issue', id)`.
3. To show the link, ask `await ports.resolveRef({ module: 'issues', type: 'issue', id }, context)`. `available` has the live `label`;
   `unavailable` means draw the label you saved, as text, with "not available here" and no link. It is the same answer whether the
   partner is off, stopped or not granted, the record is gone or is another workspace's: never turn it into a `404` or `500`, and never
   tell the person which one it is. Only a failure of the database throws.
4. Prove it in `degradation.testing.ts` (§4): compose without the partner and assert your view draws the saved label.

To be the target of links, list `<your id>.records` under `provides` and implement `RecordResolver` for it in your slot's `ports`
(`features/issues/records.ts` is the model: one query that names the workspace, an id that is no UUID answers none).

## 4. Say, and prove, what you do without a partner

For every `optional` partner write the sentence in `degrades` and the scenario in `features/<id>/degradation.testing.ts` (`--optional` makes
both as stubs). `degradation.test.ts` composes the build without the partner and runs the scenario; it fails for an edge with no scenario. A
reference to the partner's records follows D-291 (§3): your own table holds `(module, type, id)` and the label, with no key to the other
module, and a missing target is a view. The stub `module:new --optional` writes asserts only that the partner is out of the world;
for a partner whose records you link, replace it with the scenario below, which `runs` and `composition` make possible:

```ts
issues: async ({ composition }) => {
  const ports = composition.portsFor('acme', database);
  expect(await ports.resolveRef(savedLink, { workspaceId, modules: null })).toEqual({ status: 'unavailable' });
},
```

## 5. Publish a fact

Name it `<id>.<what>` and declare it with `defineFact` in the `<ID>_FACTS` of `packages/types/src/<id>.ts`, which the generator made and
already joined to `FACTS` in `packages/types/src/facts.ts`. Import `defineFact` from `./fact-declaration`, never from `./facts`: that file
imports your list, so a value taken from it is a cycle that fails at load. List the type in the manifest's `publishes`; a consumer lists it
in `consumes` and supplies a handler in `factConsumers` of its slot (`MODULES.md` §4, `fact-owners.test.ts`,
`module-communication.test.ts`). A route publishes with `publishFact` of the dependencies it is handed (`ModuleRouteDependencies`), inside
`atomicallyOn(database)`: `publishFact(transaction, workspaceContext, FACT, payload)` writes the rows in that transaction, as the module whose
route it is and for no other (`platform/ports/fact-publisher.ts`). The contract is built; the delivery by the outbox is the part of D-283 §1
that `MODULES.md` §10 says whether it has landed.

**Evolving a fact.** During a rolling deploy nodes of two releases share the outbox, so a row may be read by a release that did not
write it. Adding an optional field changes nothing for the nodes. Anything an older node would refuse (a new required field, a value more in an
enum, a narrower bound) is a new shape: set `shape: 2` and keep the old schema as a reader, which makes the old payload the new one
before your handler sees it:

```ts
const ACME_CREATED_V1 = Type.Object({ recordId: Type.String(), title: Type.String() });

export const ACME_CREATED = defineFact({
  type: 'acme.created',
  owner: 'acme',
  absent: 'drop',
  shape: 2,
  schema: Type.Object({ recordId: Type.String(), title: Type.String(), folder: Type.String() }),
  reads: { 1: readsEarlierShape(ACME_CREATED_V1, (record) => ({ ...record, folder: 'unfiled' })) },
});
```

A row is checked against the schema of the shape it was written in; one that fits no reader, or whose upgrade the current schema
refuses, is dead. Your handler only ever sees the current shape. Keep a reader for every shape the last release wrote:
`module-compat.test.ts` fails for a new shape without the reader of the one before it, and a reader is dropped only by a dated exception
in `released-manifests.json` (D-288 §5).

The release keeps a fingerprint of the schema of every shape a fact writes or reads, and the same test fails when a schema changed
under the same `shape` (the new required field, the narrower bound, the value more in an enum with `shape` left alone) or when a reader's
schema changed: `the fact 'acme.created' changed the schema of shape 1 without a new shape`. Raise `shape` and keep the old schema as the
reader. An added optional field changes the fingerprint as well, though it changes nothing for a node: say so with a dated exception
(`{ change, on, reason }` in `released-manifests.json`, `change` being the sentence the test prints), which the next release clears.

## 6. Add a worker

A background loop inside the API process is an entry of `workers` in `features/<id>/workers.ts` (the generated file has none): a
`name`, an `intervalMs` from a second to an hour and the `work`, which is given the module's leased database, the clock, the bus and push
and opens no connection of its own (D-281). It runs only where the module runs, in the module's share, cut off at `workerDeadline`.
A scheduled job is not a worker: it is `jobs` or `retention` in the manifest, `jobWork` in the slot and a place in `PLAN`
(`apps/api/src/modules/jobs/schedule.ts`).

**The module `module:new` makes is a grant, and a grant cannot declare `jobs` or `workers`.** Add one and the build stops:
`"acme" is a grant of the workspace and declares jobs or workers ... it must say entitlement: 'always'` (`unguardedWorkProblem` in
`composition.ts`, held by `composition.test.ts`). The reason: a loop or a job acts for workspaces with no request to carry the
workspace's grant, so it would go on serving a workspace that lost it. So, before you write the loop, choose (the table is in §7):

- Say `entitlement: 'always'` in the manifest. The module is then part of every workspace that runs it and is not sold per workspace.
  This is what chat does.
- Or keep the module a grant and do the work without a loop: a purge or a sweep that only keeps rows tidy is `retention`, which is
  allowed on a grant (it runs in every process, whether the module runs or not). A loop that must act for a workspace waits for the SQL
  form of `effectiveModules` (`MODULES.md` §10, the table of what is not built); the first module that needs it brings it.

## 7. Make it sellable

A module is on or off for a whole process by `MODULES` (D-250). It is on or off for each workspace of a process that runs it by the
operator's grant: the table `workspace_modules`, written by `bun run entitlements:apply` from an edition file and by the console
(D-289, D-292; the mode is `WORKSPACE_MODULES`, `DEPLOY.md` "Workspaces and modules"). The framework asks the grant for every route,
list, search, notice and fact; your code does not. What it costs you:

| Your module has | Say | Because |
|---|---|---|
| none of `frames`, `events`, `jobs`, `workers` | nothing: `entitlement` defaults to `grant` | the framework closes it per workspace |
| any of `frames`, `events` | `entitlement: 'always'` | a frame or an event is closed per process, never per workspace (`registry` refuses a grant with them) |
| any of `jobs`, `workers` | `entitlement: 'always'`, or no loop (§6) | their work is not given the workspace's grant (`compose` refuses it) |

Owed either way: a name and a removal threshold (`MODULES.md` §11), a `degrades` for every partner, and data decisions for erasure and
export that hold whether or not the module is granted, because taking a grant away hides the module's rows and keeps them (D-289 §6).

## 8. What stays by hand

The list a reviewer reads, and the only edits a new module makes outside its folder that the generator does not: a hot path of its own
in `HOT_PATHS` and the web feature (`apps/web/src/features/<id>/`, its line in `modules/registry.ts`, the catalogue words), and, for a
search source, the member of `FindTarget` (`packages/types/src/find.ts`) that says where a hit leads: it is the wire's, and a client that
does not know it ignores it. Everything else is derived from the bundle, or made by `module:new`: the tests that list modules, facts,
kinds and sources read them from the manifests.
