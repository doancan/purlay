# Purlay — Modules (`MODULES.md`)

> Authority: `DECISIONS.md` D-250 is binding on *why*, and D-255 on what was decided in practice. This file is
> binding on *how a module is built, loaded, kept apart and removed*. **Status: built for two modules, not
> complete.** Chat (`features/chat`) and issues (`features/issues`, D-254) are the modules, and the core runs
> without either: `MODULES` is read at boot, a module's routes, frames, events and jobs are closed when it is not
> run, the web draws only the modules `GET /api/me` lists (the public `GET /api/client` does not name them, §3),
> and the migration sets, the composition, the cluster record and the table-ownership list exist. What is not
> built: the typed query handle and the per-module generated `schema.ts`, the `contract` step of the attachment link
> (it lives in chat's own set, `chat/0005`, draft PR #961), workspace-level enablement, a module budget that any
> process takes (§7), and a CI matrix that runs the whole suite per cell (§8 says what runs). §8 says what each rule
> is held by, and §10 the order; a line marked **built** there is, and one not marked is intent. §9 is the
> checklist for adding a module and §12 the glossary.

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
- `routes`: its HTTP routes as templates, **at the paths the contract already gives them** — no `/api/<id>` prefix is
  added, and the route table itself is code in `ingress/`, so the manifest holds no HTTP type (`ARCHITECTURE.md` §4);
- `frames`: the client operations on the socket it owns; `events`: the server events its services send; `jobs`: the
  scheduled jobs that act for its users. A process that does not run the module closes all four (§3).

That is the whole manifest today (`module-kit/manifest.ts`): a field is added in the step that reads it. What a module
contributes besides is a slot of `BundledModule` in `composition.ts`, which the composition reads: `dataInCore`,
`userErased`, `workspacePurge`, `export`, `personalExport` (the **data** hooks: the erasure of a person, D-139, the tables
of an export, D-140, and what a purge takes), `workspaceCreated`, `workspaceChannels`, `readAttachment`, `pushNotices`
and `collatedColumns`. Its migrations are its set in `PRODUCT_MIGRATION_SETS` (`@purlay/db`). **Not yet fields of
anything:** `notifications`, `searchSources`, retention as a declared hook, and the audit actions and permissions a module
registers — the audit actions are in `modules/audit`, and the role rules are in each service.

## 3. Boot

**What `MODULES` does not do: it does not shrink the process.** The build loads the code of every module it carries, whatever is run, so `MODULES=none` measured the same resident memory as every module (63.7 MiB unset, 65.5 MiB `none`, one development start each; 111.5 and 112.6 MiB in an independent review). The benefit is reachability and data scope: a module that is off has no route, job, frame or table in this process, and its data is held whole all the same (§5). It is not a way to run a smaller server.

1. Parse `MODULES` (`module-kit`'s `resolve`). Unset or blank means every bundled module (a blank variable is read as unset everywhere in the configuration); `none` means the core alone. An
   unknown or repeated id, an id outside the grammar (lowercase letters, digits and hyphens: `CHAT`, `None` and
   `chat;issues` are refused, never corrected), an empty item, `none` listed with another id (it must stand alone),
   or a missing requirement stops the process before it listens; a cycle, a reserved id or a repeated capability
   are caught earlier, when the build's registry is made. **One reading serves both commands:**
   `parseModulesSetting` (`packages/db`) is the tokenizer and validator of the setting's shape, and `resolve`
   and `bun run db:migrate` both call it, so a setting one refuses the other refuses, with the same sentences;
   `db:migrate` exits 1 naming `MODULES` and each problem before it applies anything. Only what a module
   `requires` of another is the API's to check, since only the manifests say so. `module-setting-pair.test.ts`
   holds the two as a pair over a table of inputs.
2. Order by `requires`, then by `optional` edges, so a module's partners have registered first.
   The boot then logs one `info` line, `the modules this process runs`, with `running` and `notRun` (the modules the build carries and this process leaves out), and `/metrics` carries `purlay_modules_info{module="…"} 1` for each running module.
3. Where nodes share Redis, record this node's module set in the shared record (`realtime/module-set.ts`) and
   compare it with the live peers'. A difference is **said, never acted on** (D-250 rule 8 as amended by D-255): the
   node logs it once, keeps serving, and readiness does not change, so a rolling deploy of a new set passes. Nodes of
   different sets share the one bus channel, because a sign-out must reach every socket; what keeps a node's sockets
   from hearing a module it does not run is the manifest's `events`, dropped at delivery (`closedEvent`).
4. Run each enabled module's migrations (§5).
5. Call each module's `register`, which writes into the core's registries. **Capabilities are fixed after this
   step**: a question about one has the same answer for the life of the process.
6. Register the routes, then report ready. Readiness is the node's, not a module's: a process that runs a module on a
   database without its migration set has pending migrations and is not ready (`readiness.ts`).

A failure in 4 or 5 is fatal at boot. A failure at runtime stays inside the module's error boundary and does
not take the core down (§7). **A disabled module's routes are registered all the same and gated by path.** The
application is one typed Elysia chain, and a route table added to or left out per process would break the type the
web client reads; so every route of the build is registered, and `closed()` (`composition.ts`, built from the
`routes` of the manifests of the modules not run) is asked before the rate limit and the session. The route-ownership
test (`ingress/http/route-ownership.test.ts`) holds the manifests' lists and the routes the application registers together, so a
route nobody owns, or one claimed by two, fails it. The effect is that a request for a closed path gets the plain
`404` of any unknown route, with the generic body and no code that says *disabled* — which would tell a caller who has
not signed in which modules an instance runs. A closed job exits `0` (`closedJob`), a closed frame is answered as an
operation nobody has (`closedFrame`), and a closed event is not delivered (`closedEvent`).

**What an anonymous caller can still infer.** `GET /api/client` does not list modules (PR #963), but it carries
`capabilities` flags derived from chat being run (`scheduledMessages`, `messageReminders`,
`personalMessageDeletion`, D-58). They are the one thing a caller who has not signed in can read about the module set,
and they stay because a native client needs them before it signs in. So "no oracle" is exact for paths, bodies and
codes, and not for those three flags. A signed-in caller learns the list from `GET /api/me` (`modules`); the macOS
client reading it is issue #958.

That holds before any other judgement of the request: the edge's refusals of a body (a missing or an oversized
`Content-Length` on a webhook) are asked only of a path that is a route, so a closed webhook answers as `/api/no-such-thing`
does, whatever its headers say. A file is judged by what it is attached to: one attached to a message is chat's, so with chat not run
`GET /api/attachments/:id` and its `/thumbnail` answer `ATTACHMENT_NOT_FOUND` for it, as for an id that never existed, while an upload
nobody attached (the core's) stays its uploader's to read and discard. The manifest's `readAttachment` is how a module widens the core's reader;
the core names no module. Every running module's reader is asked in turn, the core's own last, and a file is readable if any says so (a reader says no with
`attachmentNotFound`; any other failure stays a failure). Composed, not exclusive, because a reader only answers for what its module holds and so two modules never contradict.

**A workspace made while chat is not run has no first channel**, because the hook that makes it is chat's. Turning
chat on later does not backfill one: no job or migration looks for workspaces without a channel. The chat front door
(`workspace-home.tsx`) shows, for a member with no channel, "Choose one from the list, or create the first", and the sidebar's
new-channel dialog is how; it is text and the sidebar's button, not a button on that screen.

**Every command-line entry point loads the same parse.** A job or command whose module is disabled logs that
and exits `0`; it never reaches for a table that is not there.

## 4. How modules meet

In this order:

1. **Events.** A module publishes on the **domain bus**; nobody listening is not an error. This is a new
   in-process bus, distinct from the socket `EventBus` that fans frames out to connections. Delivery is
   *at most once, after commit* (D-35), and there is no outbox framework (D-7). The manifest says of each event
   whether it is a **hint** (a UI nudge, fine to lose) or a **fact** (a notification, an index update, a system
   message). A fact is also a row written in the same transaction and drained by a sweeper job — a table and a
   loop, not a framework — so a crash between commit and publish loses nothing. A consumer never treats an event
   as the only copy of a fact.
2. **A port the core defines**, only where two modules use it or a test needs the boundary
   (`NotificationSink`, `SearchSource`, `SystemMessagePort`, `AttachmentOwner`).
3. **Asking whether a capability exists** (`capabilities.has(…)`). The caller that finds it absent hides the
   feature or does nothing.

A module imports `module-kit`, `platform` and `@purlay/types` and nothing from another module's folder.

**Reads are bounded the same way.** A module is handed a query handle typed with *its own tables and the
core's* — never the combined schema — and a lint rule rejects a table name outside that set in a query. A
read across modules goes through a port. Raw `sql` is the way round a typed handle, so a lint rule bans it in
`features/` too; a table is named only in the manifest's `data` hooks, which receive an executor of the module's
own. This is what makes "no foreign key between modules" mean more than
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
  names fails it — keeps working. **Built** without a flag: every bundled module's data
  hooks are held always, whether or not it runs, in the resolved order of the build (`composeFor`) — its erasure, purge,
  export, retention and channel answers — and only what *acts* (its routes, its mail, what a new workspace starts with,
  the attachment reader) waits for it to run. There was a `dataInCore` flag for this, and it was dropped: every bundled
  module set it, and a `false` would have made a person's erasure wait for a setting (rule 5), so it had no safe value.
  **A module's own set makes some of those tables** (chat's `message_attachments`, `scheduled_messages`,
  `message_reminders`, `hidden_messages` and `scheduled_message_attachments`; all of issues'), and a database migrated
  without the set — a fresh install that runs `MODULES=none` — has none of them. Where they exist the hooks reach them
  whether or not the module runs, so the right to be erased does not wait for a setting; where they do not there is
  nothing to reach. **`tableExists` (`@purlay/db`) is the one primitive for that**, asked at the moment the table is
  needed and never remembered, since another node may apply the set while this one runs; `absentTables` is its
  list form, for the purge's tables and the exports' `ownSet`. `ownSet` stays because the catalogues need it for what
  `tableExists` cannot say alone: which contribution's rows and people to leave out when its table is absent. The alternative,
  a contribution split into a part held always and a part held only where the set is applied, would need the process to
  know the database's sets when it is composed, and a node that was composed before the set arrived would then miss
  rows that are there. A process that *runs* a module on a database without its set is not a cell: readiness refuses
  it. `module-lifecycle.integration.test.ts` runs erasure, purge, exports, jobs and the attachment reader in each cell,
  on a database of its own.
- **Existing installs are not touched** (D-250, decided a): the legacy rows stay as the core's, and only files
  added from now on live under `packages/db/migrations/<module>/` and record as `<module>/<file>`. The core's
  77 files that existed when this was decided always create chat's tables, inert where chat is off. The release before the first prefixed row
  skips rows it has no file for and says so, so one release of rollback stays possible while module migrations are
  additive. Anything that reads the migration table for the core's schema stamp (the export's) filters to the
  core's rows.
- **Every table has one owner**, core or a module, in a list a test holds to the database; a foreign key across
  owners fails it, and the list of those that exist today (reactions, mentions, attachments and read state
  point at `messages` and `channels`) may only shrink. A core migration never names a module's table.
  An owner is `core` or the id of a registered migration set (`TableOwner` is derived from `PRODUCT_MIGRATION_SETS`, and the list
  covers every table of the generated schema or does not compile); `module-sets.test.ts` holds the sets to the bundled modules and
  to `migrations/<id>/`, so a directory with no registered set, or a set with no module, fails a test.
- `schema.ts` is generated per module and combined only for the core's own use; `db:check` migrates the core
  with each module alone as well as with all of them. **Built so far:** every cell migrates and adds only its own
  tables (`migration-cells.integration.test.ts`); the per-module generation of `schema.ts` is not, and waits for a
  module whose tables a combined schema would hide.

## 6. Web

<!-- web-module-registry: this section and the three lines marked the same way below are the web registry's. -->

**Built (D-250, the web registry).** `apps/web/src/features/<id>/manifest.ts` is data and one loader, no component:
the module's `id`; `load`, an `import()` of its chunk, which exports one screen for each route; its routes (path
patterns, all inside `/w/:slug`); the places it puts on the rail and in the palette; its shortcut rows; its settings
pages; whether its chunk is asked for in the first commit (`preload`); and what stands in for a screen while the
chunk comes (`waiting`: the shell's bar with a skeleton, or the skeleton alone). The list of manifests is
`apps/web/src/modules/registry.ts`, and nothing else names a module to the shell:

- **Router.** The route table is the core's routes and every manifest's, merged, so `RouteName`, `href()` and the
  params of each route are still a compile-time union derived from the manifests; `moduleOf` is read from them too.
- **Outlet.** A route a manifest declares is one component, `ModuleRoute`: `Shell`, `ModuleGate`, and the module's
  screen behind `Suspense` (the stand-in the manifest names). The core's routes are the `switch`'s cases, and one
  without a case does not compile.
- **Rail, palette, shortcuts, settings.** Each draws, for the modules the session lists, what the manifests say. An entry
  that is more than a link (the inbox's dot and panel, the open-questions count) draws itself, by route, in `rail.tsx`.
  What chat's palette lists from its data (channels, people, mark all read) stays in `use-palette-items.ts`, gated on chat.
- **The shell holds no module code.** A manifest imports types only, so the registry the shell carries holds no screen,
  and a manifest that imported a component which imports the router would fail at start-up. The chunk is asked for in
  the first commit of a `preload` module's route (chat's), beside the request for the session; `budget:web` reads the
  module ids from the manifests and looks for each one's screen marker (`screen-of-the-<id>-module`) in the initial
  chunks.

`registry.test.tsx` holds every manifest to the router and to each other: a route the router does not know, a rail
entry for another module's route, a palette place that is not the module's own, a settings page or shortcut row placed
after something that is not there, and a manifest the registry does not list.

The session says which modules run: `GET /api/me`'s `modules`, not the public `GET /api/client`; so a module that is not run has no rail link, no palette entry, no shortcut, no section and no request, and its address is `NotFound`, as the server's is.

## 7. Isolation

Modules share a process, an event loop and a connection pool, so they are kept apart by **budget**:

- a share of the pool: a cap on the transactions a module has open at once, with a queue timeout and a
  `statement_timeout` set inside them (`budgeted`, `platform/module-budget.ts`). **Wired for issues, and only
  for issues** (`features/issues/budget.ts`, handed to its four routes by `createApp`): a third of
  `DATABASE_POOL_MAX`, never more than the pool less one and never fewer than one (a pool of one has nothing to
  leave), a queue timeout of one second and a statement limit of five. A request over the share waits its
  turn and, past the timeout, is answered `503 DATABASE_UNAVAILABLE` (`The issues module's share of the database
  is in use. Try again.`), which a client retries. **Chat is not budgeted**: it is what the others are kept from
  slowing, and its behaviour and latency are as they were. The share caps the connections a module holds; it
  does not cap what a module costs the event loop, which all modules share. Not built: a deadline per request, an
  error boundary around each handler beyond the domain bus's, and the share for a module that has none yet;
  a module added later is budgeted by wiring its routes the way issues' are;
- a deadline and an abort signal per `SearchSource`; one that overruns is cancelled, skipped, and the response
  says which (`skipped: [module]`, a wire shape fixed in step 4);
- the CI latency gate runs chat's send path with another module busy (`budget:latency`: three more trials, with
  people reading issues' list while the issues table is locked in turns, judged against the quiet trials of the
  same run by the gate's own rule — past one and a half times and past the noise floor, twice running — and an
  error if nobody was answered). **Built for chat with issues busy**; the hot path of a module other than chat is
  not measured, as no other module is budgeted;
- every log line and metric carries `module`. **Not built**: the boot line and `purlay_modules_info` name the
  modules a process runs, and nothing else carries the label yet.

## 8. What holds each rule

A rule with nothing watching it is a wish (`CONTRIBUTING.md` §6.2). Each line is *built* by the step shown;
until then it is a stated intent and not a guarantee.

| Rule | Held by | Built in |
|---|---|---|
| No import between modules | lint, found per folder under `features/` and shown by `verify:enforcement` | 1 |
| The core imports no module | the same lint, on `modules/` and `platform/` | 1 |
| The core's modules import none of chat's | the lint that keeps `modules/` and `platform/` from importing a feature, now that chat is `features/chat`; the core's tests may — **built** | 9 |
| The core names none of chat's tables | `core-tables.test.ts`, reading the tables from `TABLE_OWNERS`, with an empty allow-list that may only shrink, and the mutation `core-sweep-names-a-chat-table` — **built** | 10 |
| No raw `sql` in a module | the lint, found per folder under `features/` and shown by `verify:enforcement` — **built** | 5 |
| No read of another module's tables | the typed query handle, handed to a module with its own tables and the core's | 9 |
| Every table has one owner; no foreign key across owners | the ownership list and its test, a ratchet that only shrinks | 2 |
| Chat's pagination and message reader are not the core's helpers | moved to `platform/`; a count of cross-imports that only falls | 5 |
| Modules tell one another what happened without importing each other | `platform/domain-bus.ts`: typed events, at most once, a failing handler logged with its module and unable to fail the publisher — **built** | 5 |
| A fact is not lost between commit and publish | a same-transaction row and a sweeper; a crash test | 5 |
| A module cannot starve the others of connections | `budgeted` in `platform/module-budget.ts`: a cap on open transactions, a queue timeout and a `statement_timeout` per module — **built and wired for issues** (a third of the pool; chat is not budgeted); `issues-budget.integration.test.ts` fills the share on a pool of its own and finds a chat write answered, and the mutation `issues-routes-outside-their-budget` holds the wiring | 5 |
| A client survives a frame it does not know; a module catches up after reconnect | a client test; the manifest's replay hook or "refetch" | 4 |
| The core's own list names no module (channel visibility, erasure, export entries are chat's) | a test of `platform/` against the manifests | 9 |
| Module id is not a core path segment | the registry, when the build's modules are checked, and a test holding the list to `API.md` | 1 |
| A bundle has no cycle, repeat or double capability, and no two modules (nor a module and the core, `core-claims.ts`) own the same route template (a subtree or a named segment overlapping another's counts), job, socket operation or server event | the registry, and mutations in `scripts/mutations.ts` | 1 |
| `MODULES` is valid | `resolve`, at boot: a process that cannot parse it logs `MODULES cannot be run; exiting` with every problem and exits `1` (`registry.test.ts`, `migrate-on-start.integration.test.ts`) — **built** | 12 |
| The matrix exists as soon as two cells differ | CI cells for core-alone and everything, widened per step | 9 |
| Disabled ⇒ `404`, no distinct body | `modules-off*.integration.test.ts` (routes, socket, presence, per cell), the route-ownership test, and `test:modules-none`, a browser spec run in the browser job — **built**; not a whole-suite matrix | 12 |
| Disabled ⇒ no tables | a test migrates the core alone, each set on the core and every set, and finds that a set adds only tables it owns (`migration-cells.integration.test.ts`) — **built**; the whole suite is **not** run per cell: no CI job does | 12 |
| Disabling leaves erasure and export whole | the export catalogue test over manifests; an erasure test with a module off; every lifecycle step in each cell of database state × process, on real migrated databases (`module-lifecycle.integration.test.ts`) — **built** | 10 |
| A core migration keeps module schemas valid | `migration-cells.integration.test.ts` migrates each set on the core at head and `upgrade.integration.test.ts` migrates from the previous state; CI migrating each set from the *last release's* database is **not** built | 10 |
| One module set in a cluster; a rolling deploy still passes | each node's set in the shared Redis record (`realtime/module-set.ts`), a log line when nodes differ and nothing else, a two-process test with different sets; no bus channel per set, which would stop a sign-out reaching the other set's sockets — **built** | 12 |
| Optional never becomes required silently | `module-compat.test.ts` holds the manifests to the last release's, kept in `released-manifests.json` and rewritten by `bun run release` (`manifests:snapshot`): no new requirement, no capability, route or job gone, no id changed, unless a dated exception in that file says so — **built** | 12 |
| Chat is not slowed by a module | `budget:latency` runs the send path again with issues busy and fails if chat's p95 jumps against the same run's quiet trials — **built** for issues, the one budgeted module; a measured run: quiet 24 ms, with issues busy 29 ms, and 937–1006 ms with issues taking connections unbudgeted | 12 |
| Shell chunk holds no module code | `budget:web` reads the shell chunk's source map and fails if a chat screen is in it, or its chunk is gone, or either is over its bound; the mutation `web-chat-screen-imported-statically` and `chat-chunk.test.ts` hold the import side — **built** for chat, and for issues, whose screen is a chunk of its own and whose marker the check looks for in the initial chunks | 11 |
| This file lists the manifests | a test of §11 against `bundledModules` (`module-listing.test.ts`) — **built** | 9 |

**The matrix** — the core alone, each module alone with what it requires, everything — is the set of cells the
tests build: `module-lifecycle.integration.test.ts` (the database as the core alone, chat's set, issues' set or every
set, against a process that runs none, each alone or both), `migration-cells.integration.test.ts`,
`modules-off*.integration.test.ts`, a real process per `MODULES` in `migrate-on-start.integration.test.ts`, and
`test:modules-none` in a browser. It is the set of cells run, and the only combinations promised (D-250 rule 6). It is
not the whole suite once per cell.

## 9. Adding a module — the checklist

Written from what building issues (D-254) needed, in the order a change is made. Each item names the file or test
that fails if it is skipped; an item with no such thing is said to have none. `issues` is the worked example: read its
commit beside this list.

**1. Decide it.**

- Take the next D-number in `DECISIONS.md` (`### D-N.`; the document check refuses a gap, a repeat and a decision
  nothing else cites) and write the decision: what the module is, what it is **not** (D-254 §1 lists what issues left
  out, each a decision of its own), the table, who may do what, what happens to its data when it is off, and the cost
  of reversing it. A module is admitted only with this, a section under §11 and a removal rule (D-250 rule 6).
- Add its row and its section to §11 below. `module-listing.test.ts` fails for a bundled module without a row, or a row
  for one that is not bundled.

**2. The manifest** (`features/<id>/module.ts`, the object in `bundledModules` in `composition.ts`).

- `id`: lowercase letters, digits, hyphens, at most 32, and not a path the core owns (`RESERVED_MODULE_IDS`; the
  registry refuses it, and a test holds the list to `API.md`).
- `requires` (will not start without), `optional` (used when present; mutual optional partners are a cycle, one must be
  the one that knows the other), `provides` (capability names like `chat.post-system-message`). Say what a user sees for
  each absent partner. Promoting an `optional` to `requires` is a breaking change.
- `routes`: every path template the module owns, as the paths the contract gives (`:name` is a segment, a trailing `**`
  the rest). `route-ownership.test.ts` fails for a registered route no manifest claims or two claim.
- `frames`, `events`, `jobs`: the socket operations, the server events its services send, and the scheduled jobs that act
  for its users. Leave out a job that only keeps rows tidy: rows outlive the module's being off. Chat's `events` are a
  `satisfies readonly ServerEvent[]` list, so a typo does not compile. An event the module sends and does not list
  would reach a process that does not run it.

**3. The data.**

- A **migration set** in `packages/db/migrations/<id>/0001_<name>.sql`, recorded as `<id>/0001_<name>`; registered in
  `PRODUCT_MIGRATION_SETS` (`packages/db/src/migrator.ts`). Keys go module to core, never between modules; index every
  key. `SCHEMA.md` §12 lists the file (`check:docs` fails if it does not) and the table's entry goes in `SCHEMA.md`
  and `DATA.md`.
- **The table's owner**: `TABLE_OWNERS` in `packages/db/src/table-owners.ts`, and the owner type beside it.
  `table-ownership.integration.test.ts` holds the list to the database, and a key across owners fails it. A core
  migration never names the table (`core-tables.test.ts`). Regenerate `packages/db/src/schema.ts` (`bun run db:generate`).
- **Data hooks and the data-lifecycle rule.** Erasure, export and retention reach every module whose tables exist,
  enabled or not (D-250 rule 5, D-255 §3). So a module whose data an erased account, a deleted workspace or an export
  must reach sets `dataInCore: true` and gives `userErased`, `workspacePurge` (its table in `tables`, because a purged
  workspace keeps its row as a tombstone and the cascade never fires), `export` and `personalExport`. Each hook that names
  a table its own set makes asks `tableExists` first; the exports skip it through the contribution's `ownSet`. Add the
  table to the compile-time decision in `export-catalogue.ts`: while a table is undecided it does not compile and names
  the table. A module whose data is not personal or workspace data still decides it, as `excluded`.
- **Audit and permissions**: an audit action is a value of `AuditAction` and its target a `targetType` in
  `modules/audit/audit.ts`, written in the same transaction by id and never by words (D-222), with the sentence the
  settings page shows for it (`apps/web/src/features/settings/pages/audit.tsx`). A role rule is in the service and tested
  through the route.

**4. The routes, in `ingress/`.**

- Route handlers in `apps/api/src/ingress/http/<id>.ts` and their registration in `ingress/http/app.ts`; the
  module's services do not import HTTP types. The wire types go in `packages/types/src/<id>.ts`, exported from `index.ts`,
  with new error codes in `errors.ts` and the endpoint in `api.ts` and `API.md`.
- **Cross-tenant classification.** The endpoints are read from `API.md`, and each must appear in `apps/api/src/testing/cross-tenant.ts`
  with a case (what it answers for a workspace the caller is not in, `WORKSPACE_NOT_FOUND`, and how channel visibility
  applies: `none`, with the reason, for a route that names no channel) or among the unscoped with the reason it has no
  tenant to cross; `cross-tenant.test.ts` fails for one that is in neither, and `cross-tenant.integration.test.ts` runs
  the crossings. A new path parameter name needs its id there too.
- `bundledModules` gets the module (one line in `composition.ts`), and `compose` does the rest.

**5. The web** (the web registry, §6).

- `apps/web/src/features/<id>/manifest.ts`: data and one loader, no component: the `id`; `load`, one `import()` of the
  module's chunk through `chunkOf` (`app/chunk.ts`), which exports a screen for each route; the routes (inside
  `/w/:slug`), the rail and palette places, shortcut rows and settings pages, `preload`, and `waiting` (the stand-in
  while the chunk comes). One line in `apps/web/src/modules/registry.ts` lists it. The router, the outlet, the rail, the
  palette, the shortcuts and the settings read the manifest; nothing else names the module to the shell, and
  `registry.test.tsx` fails for a route the router does not know, a rail entry for another module's route, a palette
  place that is not the module's own, or a manifest the registry does not list.
- **Gating by `useRuns`** (or `WhenRun`) stays for what a manifest does not describe: a sidebar section, a request that
  would otherwise be answered with `404`.
- Still per module: the icon (`components/icon.tsx`), the client (`data/api.ts`, `data/keys.ts`), the failure words for
  its error codes (`data/failure.ts`, and the exhaustive switch in `composer/uploads.tsx`), and the English and Turkish
  catalogues (`i18n/catalogue/en.ts`, `tr.ts`).
- **`budget:web` shape check**: it reads the module ids from `features/*/manifest.ts` and looks for each one's marker,
  `screen-of-the-<id>-module`, in the initial chunks; the screen's file holds the marker. A bound for the chunk is added
  where the budget lists chat's.

**6. The tests that make it a module and not a folder.**

- The **modules-off cell**: the module's routes are `404` in a process without it (`ingress/http/modules-off.integration.test.ts`)
  and its frames and events are closed (`realtime/modules-off*.integration.test.ts`, if it has any).
- The **migration cell**: `packages/db/src/migration-cells.integration.test.ts` finds the table beside its set and nowhere
  else; `migration-sets.test.ts` lists the set.
- The **lifecycle matrix cell**: `module-lifecycle.integration.test.ts` runs erasure, purge, exports, jobs and the attachment
  reader with the module's set as a database state and the module alone as a process.
- A **real process** per `MODULES` value in `platform/migrate-on-start.integration.test.ts`.
- The **no-module browser spec**: `apps/web/e2e/modules-none.e2e.ts` (run as `bun run test:modules-none`) holds the module
  out of the frame when the server runs none.
- A **module-listing** row (§11, above) and `composition.test.ts` for what the module contributes.
- **Mutations**: for each rule above the tests are the only guard of, a mutation in `scripts/mutations.ts` that breaks the
  rule and names the test that must fail (issues added eleven; read `issues-*` there). Insert new entries after
  `core-sweep-names-a-chat-table`, never at the end of the file.

**7. The release.**

- `bun run release` rewrites `apps/api/src/released-manifests.json` (`manifests:snapshot`), and from then on
  `module-compat.test.ts` holds the module to it: no new requirement, no capability, route, job or frame gone, no id changed.
  A break is a dated entry under `exceptions` in that file, where a reviewer sees it; the release clears them. Until a
  release carries the module the snapshot does not name it.
- `docs/changelog/changes.md` gets an entry under **Added**; the decision count in `README.md` follows.

**8. The documents.** `MODULES.md` (§11 row and section, §8 if a rule is now held), `DECISIONS.md`, `SCHEMA.md` (the
migration and the table), `DATA.md` (what personal data it holds and how it is erased and exported), `API.md`
(routes, error codes), `CONFIG.md` (the `MODULES` row names it), `ARCHITECTURE.md` (the features tree) and
`DEPLOY.md` (nothing to change unless the module needs configuration). `check:docs` and `module-listing.test.ts` fail for
the ones they hold.

**What a new module edits outside its own folder, counted on the issues commit (#962).** Source files, not tests and
not documents; the list is here so that it can shrink, and each line says whether it has to.

| Where | Files | Why, and whether it can go |
|---|---|---|
| `apps/api/src` | `composition.ts`, `ingress/http/app.ts`, `ingress/http/<id>.ts`, `export-catalogue.ts`, `modules/audit/audit.ts` | the module's row, its routes, the compile-time decision of its tables, the target type; the first two are the cost of one typed chain and one list |
| `apps/api/src/modules/export` | `catalogue.ts`, `export.ts`, `personal-catalogue.ts`, `personal.ts` | paid once, by the first own-set module (`ownSet`, `absent`); the next one touches none |
| `packages/db` | `migrations/<id>/0001`, `src/migrator.ts`, `src/table-owners.ts`, `src/schema.ts` | the set, its registration, its owner, the generated schema; the last is generated |
| `packages/types/src` | `<id>.ts`, `api.ts`, `errors.ts`, `index.ts` | the wire; the module's own file is the module's |
| `apps/web/src` | `modules/registry.ts` (one line), `components/icon.tsx`, `data/api.ts`, `data/keys.ts`, `data/failure.ts`, `features/composer/uploads.tsx`, `features/settings/pages/audit.tsx`, `i18n/catalogue/en.ts`, `i18n/catalogue/tr.ts`, `testing/fake-api.ts` | the registry line lists the manifest; the router, outlet, rail, palette, shortcuts, settings and `budget:web` read it, so they are no longer edited; the rest are shared registries a module adds its entries to |
| `scripts` | `mutations.ts` | the mutations; the screen's marker is derived from the module's manifest |

That is 27 source files that recur, plus the four of the export that were paid once, and eight documents. The
architecture review's "about 12 source files and 3 documents" counted the places a module must be *wired*; counting every
file an issues-sized module touches gives the larger number, and the web's twelve are most of it.

Since the web registry the web's share is the manifest, one registry line, and the icon, client, failure words and
catalogues: a third module's web edits went from about ten places across twelve files to five things.

## 10. Order of work

Each step ships alone and can be reverted.

| # | Step | Behaviour changes? |
|---|---|---|
| 1 | `module-kit`: the manifest type, the registry and `MODULES` resolution, as pure code; the import lint | no |
| 2 | Migrator learns sets (legacy rows stay the core's); the table-ownership list and its ratchet test; the export's schema stamp reads core rows only — **built**; the `MODULES`-driven call waits for step 12 | no |
| 3 | *Obsolete: folded into 12 and 11, both built.* Reading `MODULES` waited until something could be turned off, as `CONFIG.md` requires; the list of modules the web reads is `GET /api/me`'s `modules` | — |
| 4 | Wire unions opened, with aliases, **with the first module that has frames of its own** (5b); the web client already ignores unknown frames (D-82, tested) and a native client is checked first; the replay rule; `skipped` in the search response | no |
| 5 | The core ports, the domain bus with hint/fact and the sweeper, the typed query handle and the raw-`sql` ban, the per-module pool cap and `statement_timeout`; chat's pagination and reader move to `platform/` | no |
| 5b | *Superseded by 13.* It planned a thin slice that opened an issue from a message and linked back; D-254 §1 decided that issues has no link and no frame, so that slice was not built | — |
| 6–8 | The three cycles broken: `workspaces`, `integrations`, `channels` with `messages` | no |
| 9 | Chat moved under `features/chat` — **built**, 116 files and every import that named them; still to come in this step: channel visibility and the export entries leave `platform/` and `export`, and chat's queries go behind the typed handle so its exemption from the raw-SQL ban ends | no |
| 10 | Migrations split by module; `data` hooks — **built** (`dataInCore`, `tableExists`, §5); the ownership ratchet is not at zero (it holds the crossings that are left, until the attachment link's contract step, `chat/0005`, draft PR #961, merges); codegen and `db:check` per module are **not built** | no |
| 11 | Chat's web screens a lazy chunk; budgets split — **built** (below) | no |
| 12 | `MODULES` turns modules off — **built**, with the cluster record (said, never acted on) and the cells of §8; **not built:** the whole-suite matrix and per-module budgets in CI (`budget:latency` has no module notion: pending) | **yes** |
| 13 | Issues complete, the second module in full — **built** as D-254, deliberately the smallest record that exercises every seam: its own set, its hooks held whether or not it runs (D-254 §4), its routes in the manifest, a chunk of its own, the matrix tested on a database each cell made | new feature |

**Before a package is sold:** workspace-level enablement (D-250 rule 9), the downgrade lifecycle, and for each
module a written removal threshold — active workspaces, retention, support load — rather than a sentence.
**Between modules** a table of module pair × experience (mention, link, notification, search, attachment,
permission, onboarding) says what a user sees when the partner is absent: shown, hidden, or plain text. It is part
of each module's section (§9).

**Steps 6–8 in detail** — measured from the imports, not guessed. Nine imports in seven files go from a core
module to a chat one; the other mutual pairs (`messages`↔`workspaces`, `integrations`↔`setup`) are chat reaching
the core, which is allowed, and end when the core's side is inverted. Four ways to remove an edge, in the order to
try them: move the symbol to the side that owns it; a port the core defines and a module implements; a list of
**in-transaction hooks** that modules register at the composition root and the core runs inside its own
transaction (the domain bus cannot do this: it is after commit and at most once, and a workspace must never exist
without its first channel); the domain bus for what may be lost. Each is its own pull request, with behaviour
unchanged and proved so:

1. leaf moves — the GitHub client and the `ILIKE` escape to `platform/` (**built**);
2. a `workspaceCreated` hook list; chat registers the creation of the default channel, and a hook that throws
   rolls the whole workspace back (**built**);
3. `dropFiles` to `attachments`, taking the ids of the messages it drops (**built**); split in step 8 below into the
   core's `dropFilesById` and chat's `dropMessageFiles`, which finds the files through the link;
4. erasure and retention: both turned out to be whole commands about messages that nothing in the core calls, so
   they moved to `messages/` and no hook was needed (**built**);
5. notifications: they are written only by messages and point at channels and messages, and their module is read
   by the doors and one command only, so they are chat's — **built** as an ownership, the table keeps its name and
   the two foreign keys leave the list of crossings; the code moves with the rest of chat in step 9. A generic core
   inbox waits for a second writer;
6. the channel file list leaves `attachments` (**built**);
7. the workspace purge takes a `WorkspacePurge` — steps before the core's uploads and exports, steps after, and the
   tables a module owns — and chat supplies its messages, channels and tables; the core's list holds its own
   (**built**);
8. the one crossing left, `attachments -> messages`, is **not** dropped for a sweep to stand in for: the two keys
   are `ON DELETE CASCADE` and they are what makes an attachment's workspace and channel those of its message
   (I-1), so a sweep would trade a guarantee of the schema for one of a job. The link is chat's instead: a
   `message_attachments` table in chat's set (attachment, message, channel, with the same composite keys to
   `messages`, and a key to the core's `attachments`), the columns `message_id` and `channel_id` leave
   `attachments`, and the core's table holds a stored object, its uploader and its workspace and nothing of a
   message. An upload nobody links is what the orphan sweep already removes after a day. It is a migration that
   moves data and every reader of those two columns changes with it, so it is done with step 10, on a copy with
   the dumps compared, and the ratchet keeps the crossing in view until then. **In three releases, two built:**
   *expand* (**built**: `claimed_at`, `message_attachments` backfilled, and a send writing the old columns and the
   link together); *the readers move* (**built**: the core says unsent and sent with `claimed_at`, chat finds a file's
   message and channel through `message_attachments`, the workspace export's and the person's export's bounds read
   through the link, and `dropFiles` is the core's `dropFilesById` and chat's `dropMessageFiles`; a test,
   `attachment-readers.test.ts`, fails if production code reads `attachments.message_id` or `channel_id` again,
   with an allow-list of the one place that still writes them); *contract* (**pending**: it lives in chat's own set, `chat/0005`, draft PR #961, not in the core's migrations; the columns, their keys and
   indexes go, the dual write and the allow-list with them, and the exports stop writing the two columns — which
   changes the frozen shape of an export, so it is its own change).

The three behaviours that could change without a test failing: the default channel at workspace creation (an
integration test through the route and through `createWorkspace`, and one with the hook failing that finds no
workspace); the erasure of a person's messages (the existing tests unchanged, and the rows compared before and
after on a seeded fixture, with two erasures racing); and the nightly retention (the counts on aged fixtures identical, held by the existing tests, which moved unmodified).

**What is left of step 9 and step 10, measured on `main` after the move.** Nothing in the core imports chat, but eleven
files of the core still named its tables. Each is an edge with its own inversion, in this order, each its own pull
request with behaviour unchanged:

1. **`WorkspaceChannels`** (**built**), a port `modules/workspaces` defines with four methods — the channels a member could see
   and taking them out of every channel (`members.ts`, in the workspace's transaction), how many keep longer than a
   window (`retention.ts`), and the channels of a workspace (`deletion.ts`) — and chat implements. A null object
   answers `[]` and 0 when chat is absent, which is its second implementation; the proof is that the existing
   tests pass unmodified with chat's, that the same channel ids still reach the fan-out after the commit, and
   that nothing breaks with the null one;
2. **`userErased`** (**built**), a hook list run in the account's erasure transaction, where chat registers the five deletes
   it does today (`saved_searches`, `saved_messages`, `thread_follows`, `notifications`, `missed_mail_letters`)
   in the same order; proved by the existing erasure tests, the rows of every table compared before and after on a
   seeded fixture, the SQL sequence captured before and after, and an erasure raced against sends;
3. **The workspace export as contributions** (**built**): `modules/export/catalogue.ts` defines what a contribution is —
   tables with their columns typed per table, how each is bounded, the people its rows name, what it covers,
   its files, and its words on the trail — and assembles the core's (`core-export.ts`) and each module's
   (`features/chat/export.ts`) in the order the files have always been written: the core's first three tables,
   the modules', the core's last two. The composition root (`export-catalogue.ts`) holds the sum to the schema at
   compile time, naming a table nobody decided, and the integration test holds it to the database. The modules' side is read
   off `bundledModules` itself — the names of each contribution's `tables` and the keys of its `excluded` — so a third module is held to
   the schema, for both exports, without `export-catalogue.ts` being edited. A frozen
   shape of the files, rows and columns — the safety net, written first — passed unchanged through the move.
   `attachments` is still described by chat, which bounds it by messages, until the link is chat's (step 8)
4. **The personal export** (**built**) the same way: `modules/export/personal-catalogue.ts` defines its contribution and
   assembles the core's (`core-personal-export.ts`: the account, the workspaces its rows name, the memberships)
   and chat's (`features/chat/personal-export.ts`: channels, messages, reactions, saved items and the rest) in
   the order the files have always been written; the composition root holds the sum to the schema at compile
   time, and a frozen shape of the files, rows and columns, written first, passed unchanged through the move;
5. **`COLLATED_COLUMNS`** in the readiness check (**built**): the core keeps `CORE_COLLATED_COLUMNS` (`users.email`,
   `users.username`, `workspaces.slug`); chat's list (`features/chat/collated-columns.ts`: `channels.name` and the
   `github_*` digests) is handed in where the application is put together, `createApp`'s `collatedColumns`, defaulting
   to chat's. The check and its message are unchanged; the test that scans the migrations for the collation compares
   with the core plus chat's, and one more integration test breaks `channels.name` and expects it named;
6. **`platform/channels.ts`** (**built**) — the channel guard, 26 mentions of chat's tables — moved whole, with its
   two tests, to `features/chat/channels/guard.ts`, the `ChannelContext` brand still in that one file;
   `attachmentNotFound`, a plain error, moved to `platform/errors.ts`, where the attachment code reaches it. Nothing
   in the core imports the guard now (one workspace test still does, which the lint allows);
7. the message link of an attachment becomes chat's (step 8 above), with step 10;
8. a test then forbids a chat table's name in `modules/` and `platform/` (**built**): `core-tables.test.ts` reads
   the tables from `TABLE_OWNERS` (every table whose owner is not the core, so a module added later is covered) and
   fails for a file of the core that names one where a query puts it — a builder method's table, SQL's `from`,
   `join`, `into` or `update`, `table.column`, `Database['table']`, `tableExists` — with comments stripped; the
   core's tests are left out, as the lint leaves them. Its allow-list is empty and may only shrink. It is a test
   and not a lint rule because the lint configuration is plain JavaScript and the list of owners is TypeScript; a
   test reads both, and the mutation `core-sweep-names-a-chat-table` shows it catches a chat table written back
   into the core. Two places still named chat's tables when it was written, and were inverted with it. **The push
   sender** joined `notifications`, `messages` and `channels` to find who to tell; it asks a `PushNotices` port
   (`modules/push/notices.ts`), which chat implements (`features/chat/notifications/push-notices.ts`) and the
   composition hands to it (`pushNotices`, with `noPushNotices` where chat is not run), and the sender keeps the
   core's own joins (subscriptions, sessions, users, workspaces) — the same rows in the same order, with the chat
   part in its own query. **The link-preview and delivery sweeps** (`sweep:link-previews`,
   `sweep:github-deliveries`) deleted from five of chat's tables in `modules/jobs`; they are now
   `features/chat/sweeps.ts`, which the job runner calls as it calls the retention purge. They are not in chat's
   manifest `jobs` on purpose: the rows are in the core's migrations, so the sweeps must keep running with chat
   off (`module-lifecycle.integration.test.ts` runs them in each cell), which a closed job would stop. What the
   core still names are its own tables; the one seam in it that asks `tableExists`, the workspace purge, asks it
   of the names a module contributes and writes none of its own.

**Step 12, in the order it is built.** (a) *The composition* (**built**): `composition.ts` takes the modules a process runs
and makes from them what the core leaves open — the workspace's first hook, the account's erasure hook, who answers
for the channels, the purge's steps and tables, the two catalogues, the columns readiness checks; a module is its manifest
and what it contributes (`features/chat/module.ts`), and a process with no module has the core alone, shown on a real
database. (b) *`MODULES` read at boot* (**built**): `compositionFor(setting)` hands the process only the modules it names, and a setting that
names none the build carries stops it before it listens; the migrations (`MIGRATE_ON_START`, `db:migrate`, readiness and
the wait for another node's) are the core's and the named modules' sets, and the rows of a set that is off stay inert. **Order** is the registry's resolved one (partners first): the modules that run act in it, and what every carried module holds (erasure hooks, the purge's steps and tables, the export tables) follows the resolved order of the whole build, so it does not change with the `MODULES` value (`composeFor`).
(c) *Routes, jobs and commands* (**built**): a module's manifest lists its route templates and its jobs; a path of a module that
is not run is the plain `404` of any unknown path, before the rate limit and the session are asked, a job of one that acts for its
users (chat's missed-mail letter) exits `0` with a line saying so and is left out of the status report — its sweeps and the retention purge still run, the rows being there — and `GET /api/me` lists the modules the server runs (the public `GET /api/client` does not, PR #963).
A scan holds every route the application registers to the core's list or a module's. (d) The web building its routes
from the modules `GET /api/me` lists (step 11, **built**); (e) *the cluster check* (**built**): where nodes share Redis each keeps its set in one
shared record, renewed and lapsing by itself, and a node that finds another set logs it once and again when the nodes agree;
it never refuses traffic, so a new set rolls out node by node; (f) the matrix in CI (the cells of §8 are built; the whole suite per cell is not).

**Step 11 in detail — chat's screens as a chunk (built; measured 2026-11-03).** The seven screens (channel, inbox,
questions, search, saved, drafts, unreads) and what only they reach — the composer, the feed, messages and threads —
are exported by `features/chat/chat.ts`, which only chat's manifest imports, with `import()` (<!-- web-module-registry -->): one chunk,
`assets/chat-*.js`, not seven, because they share the composer and the feed and would otherwise pull them into a
third chunk. Each screen is drawn inside `ModuleGate` and, while the chunk comes, the skeleton the channel draws for
its own data (`ui/skeleton`), so the first paint keeps its shape. **No waterfall:** `Outlet` asks for the chunk in the
first commit of a chat address, beside the request for the session, not when the screen is first drawn; without that
the chunk starts after `/api/me` and the channel's messages wait for it. What stays in the shell is what the frame,
the sidebar and the realtime reader use of chat (links, read caches, the panels the frame hosts); `budget:web` lists
the screens and heavy modules that may not be there. Measured on the same build: initial JavaScript 293.24 → 242.04 KB
gzipped (entry 292.63 → 241.43), chat's chunk 45.65 KB; the bounds are 250 KB for the shell (3% over) and 50 KB for
chat (10% over), and the 400 KB backstop stays. Time to the first message row, cold cache at 10 Mbit/s and 40 ms,
median of nine, in-page timer: 1444–1474 ms before, 1471–1476 ms after (run twice; the runs differ by as much as
the two builds do) and 1509 ms with the chunk not asked for early; with a warm cache 124 ms before, 124–130 ms after.
The repo's own cold-load test (`budget:browser`) stops at the frame, which on a narrow window *is* gated by the
chunk: the navigation toggle is in the screen's bar. The first version's fallback had no bar and the narrow cold
load regressed from 122.8 to 201.9–238.3 ms in CI (and the toggle was missing after the front door moved the
person); the fallback now draws the shell's `ScreenBar` first. The first-row timer was a temporary spec, not kept.

**What is left of chat in the shell, measured and left alone (2026-11-03).** About 1.17 MB of source is in the
initial chunk's source map; the chat-only UI the frame draws only inside `WhenRun module="chat"` (inbox panel,
rail links, the sidebar's channel, starred, unread and conversation lists, the jump field) is about 55 KB of source,
and the rest of what is chat-named is imported by the shell's panel host, the composer providers and the tab title,
so a lazy boundary cannot take it out without restructuring them. A second lazy chunk of the frame's chat pieces
was built and measured: the shell went from 242.62 to 237.80 KB gzipped (2%), narrow cold load unchanged
(63.4 vs 62.4 ms mean of three medians of five, local), wide about 4 ms slower on average, inside the 60–78 ms
spread but pointing the wrong way in five of six runs. Not worth a second layout-fallback surface, so it was
reverted; the helpers that merely live in chat folders (`messages/author`, `palette/channels`, `composer/outbox`,
`channel/feed-ports`) save no bytes when moved and stay. The shape check therefore names the screens and the
heavy modules, not every chat-named file; a module with a larger share of its code in the shell would earn the
second chunk.

**The three risks.** The migration rename and reorder: a wrong one stops a database from opening, so it is
rehearsed on a copy with the dumps compared, and it needs the owner's approval, being hard to reverse. The
places the core and chat share data — attachments, read state, notifications, which reference messages by key
(I-3, I-4, I-7) — where "works without chat" is unproven until the real schema says so; moving the rows that
cannot stay in the core into chat is the cost, and the core's claim is only as large as what is left. And the
wire names, which installed clients read.

## 11. The modules this build carries

One row for each manifest in `bundledModules` (`composition.ts`): a module added there without its row, or a row for
one that is not there, fails `module-listing.test.ts`. `—` is none. The rest of a module's section (§9) goes under
its row's id as it is written.

| Module | Requires | Optional | Provides |
|---|---|---|---|
| `chat` | — | — | — |
| `issues` | — | — | — |

### `issues`

The second module (D-254), the smallest that exercises every seam, and written so that the next one can be compared with
it. **Requires** nothing, **optional** nothing, **provides** nothing: it uses no other module and no other module uses it.

- **Migration set.** `migrations/issues/0001_issues.sql`, one table, `issues`, owned by `issues` in the ownership list, with
  `SCHEMA.md` §7.12 and `DATA.md`. Its keys go to `workspaces` and `users` only; a core migration never names it.
- **`data` hooks.** `userErased` takes an erased account off the issues assigned to it (what it made stays, under the
  anonymised row); `workspacePurge` empties the table by name, because a purged workspace keeps its row as a tombstone and
  the cascade never fires; `export` and `personalExport` write the table whole and the person's own. **All four are held
  whether or not the module runs** (every bundled module is, `composition.ts`), and each asks `tableExists` first, so a database that never had the
  set is no failure and one that ran issues and was then turned off is erased, purged and exported whole: its rows stay
  while the module is off, and the right to be erased and a deleted workspace's purge do not wait for a setting
  (D-254 §4). The exports skip the table through the contribution's `ownSet`.
- **Audit and permissions.** None: nothing it does is on the workspace's trail, and the role rule — any member makes and
  changes, only the creator or an owner or an admin deletes — is in the service, tested through the route.
- **Events and notifications.** None. An issue has no frame and tells nobody; a client reads again.
- **Web.** The screen at `/w/:slug/issues`, one `import()` from `features/issues/manifest.ts` (<!-- web-module-registry -->) into a chunk of its own; the rail
  link and the palette entry only where the session lists the module. `budget:web` holds the shell chunk to carrying none of
  the screen.
- **Smoke test and matrix cell.** `module-lifecycle.integration.test.ts` for every lifecycle step in each state of the database (core alone, chat's set, issues' set, every set) against each process,
  `modules-off.integration.test.ts` for the routes per cell, and a real process per `MODULES` in
  `migrate-on-start.integration.test.ts`.
- **Latency.** No hot path: it is not on the chat's send path, and a list of the workspace's issues is one indexed read.
- **What a user sees for each partner that is absent.** There are no partners.
- **Removal threshold.** Decided by the owner at each release, against the measured use. A measurable rule is needed
  before a package is sold (§10, *Before a package is sold*); there is none yet. Its table stays until an operator drops
  it (D-250 rule 5).

## 12. Glossary

The terms of this file and of the code that carries it, as they are **now**. A line says where the word lives. Not a
table, so that §11's listing test reads only the modules.

- **Core** — what knows no module by name: identity, workspaces and tenancy, permissions, audit, the domain bus,
  attachments, the registry, the erasure and export catalogues. `modules/` and `platform/`.
- **Module** — a unit of product with a manifest, a migration set of its own, data hooks and a web chunk (§1).
- **Manifest** — what a module says of itself to the registry: `id`, `requires`, `optional`, `provides`, `routes`,
  `frames`, `events`, `jobs` (`platform/module-kit/manifest.ts`, §2). It is not a trust boundary.
- **`BundledModule`** — a manifest plus what the module contributes to the places the core leaves open: the slots in
  `composition.ts` (`userErased`, `workspacePurge`, `export`, `personalExport`, `workspaceCreated`, `workspaceChannels`,
  `readAttachment`, `pushNotices`, `collatedColumns`, `dataInCore`).
- **Bundled** — carried by this build: in `bundledModules`. A bundled module has a row in §11, a set in
  `PRODUCT_MIGRATION_SETS` and routes the application registers, whether or not a process runs it.
- **Run** — named by this process's `MODULES`. What a process *acts* with is the modules it runs; what it keeps whole is
  more (see *holding*).
- **Composition** — what the core's open places become for the modules a process runs (`compose` in `composition.ts`):
  the hook lists, the purge, the catalogues, the migration sets and the four `closed` questions. `compositionFor(setting)`
  is the one `MODULES` makes; with no module it is the core alone.
- **Closed** — a path nobody has. For a module bundled and not run: a **closed route** is a path of its manifest's
  `routes`, answered as an unknown path (`closed()`); a **closed job** is one of its `jobs`, which exits `0` with a line
  (`closedJob`); a **closed frame** is a client operation of its `frames`, answered as one nobody has (`closedFrame`); a
  **closed event** is a server event of its `events`, which a socket of this process is not sent, from its own services
  or another node's (`closedEvent`). A path no module claims is not closed, it is the core's.
- **Cell** — one combination the tests build: a database state (core alone, chat's set, issues' set, every set) against a
  process (no module, each alone, both). §8.
- **Migration set** — a module's ordered migrations in `packages/db/migrations/<id>/`, recorded as `<id>/<file>`; the
  core's own are the legacy rows (D-250 decided a). Validated per set by the migrator (D-86).
- **Table owner** — the core or one module, for every table, in `TABLE_OWNERS`; a foreign key across owners fails a test.
- **`dataInCore`** — a flag of `BundledModule` meaning that what the module contributes to the lifecycle of its data is
  held by every process's composition, whether or not it runs. Named for chat, whose tables the core's migrations made;
  issues has the same flag with a table of its own set. **The compose-simplification work may remove this flag**
  (holding every module whose rows may exist); until it merges, this is what the code does.
- **Holding** — the modules whose contributions a composition keeps: those it runs plus every bundled module with
  `dataInCore` (the local `holding` of `compose`). Erasure, purge, exports, retention and the columns readiness checks
  read from it; the workspace's first hook and the routes do not, since they *act*.
- **`ownSet`** — on an export contribution: the tables its module's own set makes. An export asks `tableExists` for each
  and skips a contribution whose table is absent, so a database that never applied the set is no failure and its export
  says nothing of it.
- **`tableExists`** — `@purlay/db`: whether the database has a table, asked at the moment it is needed and never
  remembered, because another node may apply the set while this one runs. The one primitive a hook uses to be held where
  the set is applied and silent where it is not (D-255 §3).
- **Tombstone** — a purged workspace's row, kept so that the cascade of its keys never fires; why a module's purge names
  its tables itself.
- **Hint and fact** — an event is a hint (a UI nudge, fine to lose) or a fact (written as a row in the same transaction
  and drained by a sweeper), §4.
- **Capability** — a name a module provides and another asks for (`capabilities.has`), fixed after `register`.
- **Said, never acted on** — how a node reports a cluster whose members run different sets: one log line, nothing else
  (D-255 §1).

