# Purlay — Modules (`MODULES.md`)

> Authority: `DECISIONS.md` D-250 is binding on *why*. This file is binding on *how a module is built,
> loaded, kept apart and removed*. **Status: design.** Nothing here is implemented yet; §8 says what each
> rule is held by, and which step builds that, and §10 the order.

---

## 1. What a module is

A unit of product — chat, issues, notes, mail — that registers with the core and can be turned off. The
**core** (identity, workspaces and tenancy, permissions, audit, the domain event bus, notifications,
attachments, the search fan-out, the erasure and export catalogues, the registry) knows no module by name.
One process and one PostgreSQL stay (D-7): a module is a folder, a set of migrations and a web feature, not
a service. Modules are first-party code in this repository; the manifest is not a trust boundary, and
loading a module from elsewhere is not supported (D-250 rule 2).

**Where they live.** A module is `apps/api/src/features/<id>` and `apps/web/src/features/<id>`. The existing
`apps/api/src/modules/` keeps its layered meaning (`ARCHITECTURE.md` §4) and shrinks as each module's files
move under `features/`. An id may not be a path segment the core owns (`auth`, `workspaces`, `search`,
`users`, …); the list is a constant the registry checks.

## 2. The manifest

`apps/api/src/platform/module-kit/` holds the manifest type and the registry — pure, with no I/O and no
environment, so a module can import it without pulling the platform in. It is a folder of `platform/`, not a
package: a package would add itself to the production image, the lockfile, the licence check and the pull
request rules for one consumer, and the lint keeps the folder as clean as a package would be. A module
declares:

- `id`, and `requires` (it will not start without them) and `optional` (used when present);
- `provides`: the capabilities it offers;
- `migrations`: its own ordered set;
- `routes`: its HTTP routes, **at the paths the contract already gives them** — no `/api/<id>` prefix is added,
  and a module's route table is code in `ingress/`, not a type in the manifest, so the manifest holds no HTTP
  type (`ARCHITECTURE.md` §4);
- `events`, `notifications`, `searchSources`: what it adds to the core's registries;
- `jobs`, and the CLI commands it owns;
- **`data`**: how its tables answer the core — the erasure of a person (D-139), the tables of an export
  (D-140), retention, and the owner of an attachment it holds;
- **`audit` and `permissions`**: the actions it writes to the audit log and the role-gated writes it registers
  in the permission table.

## 3. Boot

1. Parse `MODULES` (`module-kit`'s `resolve`). Unset means every bundled module; empty means the core alone. An
   unknown or repeated id, an empty item, or a missing requirement stops the process before it listens; a
   cycle, a reserved id or a repeated capability are caught earlier, when the build's registry is made.
2. Order by `requires`, then by `optional` edges, so a module's partners have registered first.
3. Record this node's module set and release in the database. A node whose set differs from a live peer's
   refuses to serve (D-250 rule 8).
4. Run each enabled module's migrations (§5).
5. Call each module's `register`, which writes into the core's registries. **Capabilities are fixed after this
   step**: a question about one has the same answer for the life of the process.
6. Mount routes, then report ready — per module, so an operator sees which one is not.

A failure in 4 or 5 is fatal at boot. A failure at runtime stays inside the module's error boundary and does
not take the core down (§7). A disabled module is never mounted: a request for it is the plain `404` of any
unknown route, with the generic body and no code that says *disabled* — which would tell a caller who has not
signed in which modules an instance runs.

**Every command-line entry point loads the same parse.** A job or command whose module is disabled logs that
and exits `0`; it never reaches for a table that is not there.

## 4. How modules meet

In this order:

1. **Events.** A module publishes on the **domain bus**; nobody listening is not an error. This is a new
   in-process bus, distinct from the socket `EventBus` that fans frames out to connections. Delivery is
   *at most once, after commit* (D-35), and there is no outbox (D-7). A consumer whose state must not drift
   reads the source when it needs it, or relies on a row written in the same transaction; it never treats an
   event as the only copy of a fact.
2. **A port the core defines**, only where two modules use it or a test needs the boundary
   (`NotificationSink`, `SearchSource`, `SystemMessagePort`, `AttachmentOwner`).
3. **Asking whether a capability exists** (`capabilities.has(…)`). The caller that finds it absent hides the
   feature or does nothing.

A module imports `module-kit`, `platform` and `@purlay/types` and nothing from another module's folder.

**Reads are bounded the same way.** A module is handed a query handle typed with *its own tables and the
core's* — never the combined schema — and a lint rule rejects a table name outside that set in a query. A
read across modules goes through a port. This is what makes "no foreign key between modules" mean more than
the schema: without it a module could `select` another's table and every rule above would hold on paper.

**The wire unions** open up the same way. `Topic` keeps its core prefixes and takes module prefixes from a
registry; `ServerFrame` splits into a core part and one per module; `NotificationType` is the core's kinds plus
each module's. The bundled contract (`contract:bundle`) lists every known module — what a disabled module
removes is its routes and tables, not its types. Whether namespaced frame names break an installed client is
verified first (D-250, open question b); the old names stay as aliases for one release either way.

## 5. Data

A module's tables exist only while it is enabled, and **disabling drops nothing** — the tables stay, inert.
Foreign keys run module → core, never between modules, and a table the core would point at a module's table
moves into that module.

- The migrator keeps one lock and validates order and checksum (D-86) **per set**, recording `<module>/<file>`.
  The sets are read from the files, not counted in a document.
- **A core migration keeps every module's applied schema valid.** CI migrates a module's set from the previous
  release's state to head, so a module that was off for three releases opens on the fourth.
- A disabled module's applied rows are not "missing"; they are logged.
- Erasure, export and retention run for every module whose tables exist, enabled or not (D-250 rule 5), so
  the export catalogue is assembled from the manifests and its test — a table in the database that no manifest
  names fails it — keeps working.
- Existing installs keep working through a one-time, transactional rename of their legacy rows. **It is not
  decided** (D-250, open question a) whether they become `chat/…` or the core's, and the release before it
  refuses to start on renamed rows, with a message naming the fix.
- `schema.ts` is generated per module and combined only for the core's own use; `db:check` migrates the core
  with each module alone as well as with all of them.

## 6. Web

`apps/web/src/features/<id>/manifest.ts` declares routes, sidebar entry, palette commands, shortcuts and
settings; the entry is a lazy import. The server answers which modules are enabled; the router, sidebar and
palette are built from those manifests, so a disabled module has no route and no chunk. The shell chunk holds
no module code; `budget:web` states a bound for it and one per module.

## 7. Isolation

Modules share a process, an event loop and a connection pool, so they are kept apart by **budget**:

- a share of the pool, a deadline per request and an error boundary around each handler and job — an
  unhandled rejection in one module is that module's, not the process's;
- a deadline per `SearchSource`; one that overruns is skipped and the response says which;
- the CI latency gate runs for the hot path of **every** module with another one busy, not for chat's send
  path alone;
- every log line and metric carries `module`.

## 8. What holds each rule

A rule with nothing watching it is a wish (`CONTRIBUTING.md` §6.2). Each line is *built* by the step shown;
until then it is a stated intent and not a guarantee.

| Rule | Held by | Built in |
|---|---|---|
| No import between modules | lint, found per folder under `features/` and shown by `verify:enforcement` | 1 |
| The core imports no module | the same lint, on `modules/` and `platform/` | 1 |
| No read of another module's tables | typed query handle and a lint rule on table names | 5 |
| No foreign key between modules | a schema test on the per-module `db:check` | 10 |
| The core's own list names no module (channel visibility, erasure, export entries are chat's) | a test of `platform/` against the manifests | 9 |
| Module id is not a core path segment | the registry, when the build's modules are checked, and a test holding the list to `API.md` | 1 |
| A bundle has no cycle, repeat or double capability | the registry, and mutations in `scripts/mutations.ts` | 1 |
| `MODULES` is valid | `resolve`, at boot | 3 |
| Disabled ⇒ `404`, no distinct body | the CI matrix | 12 |
| Disabled ⇒ no tables | the CI matrix, per cell | 12 |
| Disabling leaves erasure and export whole | the export catalogue test over manifests; an erasure test with a module off | 10 |
| A core migration keeps module schemas valid | CI migrating each set from the last release | 10 |
| One module set in a cluster | the boot check and its test | 12 |
| Optional never becomes required silently | a test of manifests against the last release | 12 |
| Chat is not slowed by a module | `budget:latency` per module | 12 |
| Shell chunk holds no module code | `budget:web` shape check | 11 |
| This file lists the manifests | a test | 3 |

**The matrix** — the core alone, each module alone with what it requires, everything — runs when
`modules/**`, `features/**`, `platform/**` or `packages/db/**` changes. It is the set of cells run, and the
only combinations promised (D-250 rule 6).

## 9. Adding a module — the checklist

A section in this file with its requires, optional partners and capabilities · its migration set, with the
`SCHEMA.md` and `DATA.md` entries · its `data` hooks (erasure, export, retention) · its audit actions and
permissions · its events and notifications · its web manifest and chunk bound · its smoke test and matrix cell
· its latency measure · the condition on which it is removed if nobody uses it (D-250 rule 6).

## 10. Order of work

Each step ships alone and can be reverted.

| # | Step | Behaviour changes? |
|---|---|---|
| 1 | `module-kit`: the manifest type, the registry and `MODULES` resolution, as pure code; the import lint | no |
| 2 | Migrator learns sets and the legacy rename (after open question a); old and new schemas compared | no |
| 3 | `MODULES` read at boot into the registry; the server lists enabled modules; the web registry skeleton | no |
| 4 | Wire unions opened, with aliases | no |
| 5 | The core ports, the domain bus, the typed query handle | no |
| 6–8 | The three cycles broken: `workspaces`, `integrations`, `channels` with `messages` | no |
| 9 | Chat moved under `features/chat`; channel visibility, message erasure and the export entries move with it | no |
| 10 | Migrations split by module; `data` hooks; codegen and `db:check` per module | no |
| 11 | Chat's web screens a lazy chunk; budgets split | no |
| 12 | `MODULES` turns modules off; the matrix, the cluster check and the per-module budgets in CI | **yes** |
| 13 | Issues, the second module — the contract meets a real second user | new feature |

**The three risks.** The migration rename and reorder: a wrong one stops a database from opening, so it is
rehearsed on a copy with the dumps compared, and it needs the owner's approval, being hard to reverse. The
places the core and chat share data — attachments, read state, notifications, which reference messages by key
(I-3, I-4, I-7) — where "works without chat" is unproven until the real schema says so; moving the rows that
cannot stay in the core into chat is the cost, and the core's claim is only as large as what is left. And the
wire names, which installed clients read.
