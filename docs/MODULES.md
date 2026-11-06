# Purlay — Modules (`MODULES.md`)

> Authority: `DECISIONS.md` D-250 is binding on *why*, and D-255 on what was decided in practice. This file is
> binding on *how a module is built, loaded, kept apart and removed*. **Status: built for two modules, not
> complete.** Chat (`features/chat`) and issues (`features/issues`, D-254) are the modules, and the core runs
> without either: `MODULES` is read at boot, a module's routes, frames, events and jobs are closed when it is not
> run, the web draws only the modules `GET /api/me` lists (the public `GET /api/client` does not name them, §3),
> and the migration sets, the composition, the cluster record and the table-ownership list exist. What is not
> built: chat's functions behind the typed query handle (issues' are, D-271), workspace-level enablement, a module budget that any
> process takes (§7), and a CI matrix that runs every suite per cell (§8 says what runs: the suites that need no module, in every cell but the one with every module). §8 says what each rule
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
  scheduled jobs that act for its users. A process that does not run the module closes all four (§3);
- `budget` (**required**, D-260, D-266): its share of the connection pool, `{ poolShare: (poolMax) => limits }`, or
  `{ none: reason }`. A manifest without it does not compile, and the registry refuses one that has none at run time, a
  `none` with no reason and a share that leaves the module no connection or the others none (§7). Every bundled module
  has a share today; one that declares `none` must also be named, with its reason, in `module-budgets.test.ts`, so an
  exemption is a line a reviewer sees;
- `deadline` (optional, D-270): how long a request or frame of the module may take before it is answered `504` and its database
  work cancelled: `{ ms }` (a whole number from 1000 to 120000) or `{ none: reason }`, which `module-deadlines.test.ts` lists too;
  left out, 20 s (§7);
- `retention`: the scheduled jobs that keep its rows within their retention — a purge past the days kept, a sweep of a
  cache. Unlike `jobs` they run in every process, whichever modules it runs, because the rows are there (§3);
- `permissions` (D-265): what a role may do in the module that is more than being a member, each as `{ name, minimumRole }`
  with the name `<id>.<what>`, held by that role and those above it. The core declares its own (`CORE_PERMISSIONS`, today
  `audit.read`); a service asks `permissions.holds(role, name)` of the table the composition makes, which has the core's
  and the running modules' and nothing else, so a permission of a module that is off is held by nobody, the owner included;
- `auditActions` (D-265): the actions the module writes to the trail, in groups of `{ read, actions }`, `read` being the
  permission that reads those rows (the core's `audit.read`, or one the module declares). The wire's `AUDIT_ACTIONS` is
  every action there is; `CORE_AUDIT_ACTIONS`, `CHAT_AUDIT_ACTIONS` and `ISSUES_AUDIT_ACTIONS` in `@purlay/types` say who
  owns each, and a test holds the three to the wire's list, each action once;
- `notifications` (D-265): the kinds of notification the module sends, each `{ type, needsYou, pushed, mailed }` (chat's are
  `CHAT_NOTIFICATION_KINDS` in `@purlay/types`): whether it counts for the badge, the title and a background alert, is
  pushed, and is mailed when it waits unread. `NotificationType`, `NEEDS_YOU` and the database's `notification_type` are held
  to the declarations by `notification-kinds.test.ts`, and the missed-mail letter takes its kinds from `mailed`;
- `searchSources` (D-265): the ids of the sources the module adds to a workspace search (chat's is `messages`). A process
  that does not run the module lists none of them (`composition.searchSources`). **There is no fan-out yet:** a search
  answers messages, one source, and a second source needs a result that names its source, which is a change of the wire
  that has its own decision.

That is the whole manifest today (`module-kit/manifest.ts`): a field is added in the step that reads it. What a module
contributes besides is a slot of `BundledModule` in `composition.ts`, which the composition reads: `jobWork`, the work of
each job its manifest names under `jobs` or `retention` and of no other (a build where the names and the work differ does
not start; `bun run job` takes the work from the composition and names no module, D-260),
`userErased`, `workspacePurge`, `export`, `personalExport` (the **data** hooks: the erasure of a person, D-139, the tables
of an export, D-140, and what a purge takes), `workspaceCreated`, `workspaceChannels`, `readAttachment`, `pushNotices`
and `collatedColumns`. Its migrations are its set in `PRODUCT_MIGRATION_SETS` (`@purlay/db`). **Not yet fields of
anything:** the role rules that are not yet a named permission, which are in each service (D-265 §3).

## 3. Boot

**What `MODULES` does not do: it does not shrink the process.** The build loads the code of every module it carries, whatever is run, so `MODULES=none` measured the same resident memory as every module (63.7 MiB unset, 65.5 MiB `none`, one development start each; 111.5 and 112.6 MiB in an independent review). The benefit is reachability and data scope: a module that is off has no route, job, frame or table in this process, and its data is held whole all the same (§5). It is not a way to run a smaller server.

1. Parse `MODULES` (`module-kit`'s `resolve`). Unset or blank means every bundled module (a blank variable is read as unset everywhere in the configuration); `none` means the core alone. An
   unknown or repeated id, an id outside the grammar (lowercase letters, digits and hyphens: `CHAT`, `None` and
   `chat;issues` are refused, never corrected), an empty item, `none` listed with another id (it must stand alone),
   or a missing requirement stops the process before it listens; a cycle, a reserved id or a repeated capability
   are caught earlier, when the build's registry is made. **One reading serves both commands:**
   `parseModulesSetting` (`packages/db`) is the tokenizer and validator of the setting's shape, and `resolve`
   and `bun run db:migrate` both call it, so a setting one refuses the other refuses, with the same sentences;
   `db:migrate` exits 1 naming `MODULES` and each problem before it applies anything. What a module `requires`
   of another is judged the same way: `unmetRequirements` (`packages/db`) writes the sentence for both, the API
   over its manifests and `db:migrate` over `PRODUCT_MODULE_REQUIRES`, the table `packages/db` keeps because it
   cannot import the manifests. `module-setting-pair.test.ts` holds that table to the manifests, and the two
   commands as a pair over a table of inputs.
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
`404` of any unknown route, with the generic body and no code that says *disabled*, so what a closed route says is the
same as what an unknown path says (its status, for a caller with no session, is not: see below). A closed job exits `0` (`closedJob`), a closed frame is answered as an
operation nobody has (`closedFrame`), and a closed event is not delivered (`closedEvent`).

**What an anonymous caller can still infer.** A closed route hides its body and its code: both are those of an
unknown path. It does not hide its status. For a caller with no session, a route of a module that runs answers `401`
and the same route of a module that does not answers `404 ROUTE_NOT_FOUND`, while an unknown path is always `404`
(`GET /api/channels/x/messages`, `GET /api/workspaces/x/issues` and `GET /api/notifications` each tell whether chat or
issues runs). `GET /api/client` does not list modules (PR #963), but it carries `capabilities` flags that are true only
when chat runs (`scheduledMessages`, `messageReminders`, `personalMessageDeletion`, D-58; `client-info.ts`), and they
stay because a native client needs them before it signs in. So the module set is observable without a session, from
that status and from those three flags. This is accepted. To remove the status signal, answer `401` before `404` for
every `/api/*` path without a session; the flags would need their own decision. A signed-in caller learns the list
from `GET /api/me` (`modules`); the macOS client reading it is issue #958.

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

**Reads are bounded the same way.** A module's functions take a handle typed with *its own tables and the
core's it names* — never the combined schema (`features/<id>/schema.ts`: `ModuleSchema`, derived from `TABLE_OWNERS`, so
there is no second list of who owns what) — and a query over any other table does not compile. The handle is a type over
the object every caller already passes, not a wrapper: nothing is checked at run time, and no caller changes (D-271). It
holds the builder API only: it does not tell a read of a core table from a write, and it does not see raw `sql`. A read
across modules goes through a port. Raw `sql` is the way round a typed handle, so a lint rule bans it in `features/`
(chat is exempt for now: its templates are almost all expression fragments, `count(*)::int`, `state_version + 1`, and a
scan of the text for a table another module owns is what polices them, D-271); a table is named only in the manifest's
`data` hooks, which receive an executor of the module's own. This is what makes "no foreign key between modules" mean more
than the schema: without it a module could `select` another's table and every rule above would hold on paper.

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
  owners fails it, and the list of those that exist is empty (**built**, `chat/0005`: the last, from `attachments`
  to `messages`, went with the link's columns). A core migration never names a module's table.
  An owner is `core` or the id of a registered migration set (`TableOwner` is derived from `PRODUCT_MIGRATION_SETS`, and the list
  covers every table of the generated schema or does not compile); `module-sets.test.ts` holds the sets to the bundled modules and
  to `migrations/<id>/`, so a directory with no registered set, or a set with no module, fails a test.
- `schema.ts` is generated once, for the whole database, and the schema a module sees is **derived** from it and
  `TABLE_OWNERS` (`ModuleSchema`, D-271); `db:check` migrates the core
  with each module alone as well as with all of them. **Built so far:** every cell migrates and adds only its own
  tables, and leaves every column of a core table, and every value of a core enum type, as it was except what
  `CORE_COLUMNS_A_SET_CHANGES` and `CORE_ENUMS_A_SET_CHANGES` declare, the latter as `set:type` so that only the named set may alter the named type (`migration-cells.integration.test.ts`); a generated `schema.ts` per module is not built, and D-271 declines it: what a module sees is derived.

## 6. Web

<!-- web-module-registry: this section and the three lines marked the same way below are the web registry's. -->

**Built (D-250, the web registry).** `apps/web/src/features/<id>/manifest.ts` is data and one loader, no component:
the module's `id`; `load`, an `import()` of its chunk, which exports one screen for each route; its routes (path
patterns, all inside `/w/:slug`); the places it puts on the rail and in the palette; its shortcut rows; its settings
pages; the audit actions it records (`auditActions`, the same list the API's manifest reads, D-265); whether its chunk is
asked for in the first commit (`preload`); and what stands in for a screen while the
chunk comes (`waiting`: the shell's bar with a skeleton, or the skeleton alone). The list of manifests is
`apps/web/src/modules/registry.ts`, and nothing else names a module to the shell:

- **Router.** The route table is the core's routes and every manifest's, merged, so `RouteName`, `href()` and the
  params of each route are still a compile-time union derived from the manifests; `moduleOf` is read from them too.
- **Outlet.** A route a manifest declares is one component, `ModuleRoute`: `ModuleGate` and the module's
  screen behind `Suspense` (the stand-in the manifest names). `Outlet` draws the one `Shell` round it and round the
  core's screens of a workspace, so a change from one to the other keeps the shell standing. The core's routes are the `switch`'s cases, and one
  without a case does not compile.
- **Rail, palette, shortcuts, settings, audit filter.** Each draws, for the modules the session lists, what the manifests say. An entry
  that is more than a link (the inbox's dot and panel, the open-questions count) draws itself, by route, in `rail.tsx`.
  What chat's palette lists from its data (channels, people, mark all read) stays in `use-palette-items.ts`, gated on chat.
- **The shell holds no module code.** A manifest imports types only, so the registry the shell carries holds no screen,
  and a manifest that imported a component which imports the router would fail at start-up. The chunk is asked for in
  the first commit of a `preload` module's route (chat's), beside the request for the session; `budget:web` reads the
  module ids from the manifests and looks for each one's screen marker (`screen-of-the-<id>-module`) in the initial
  chunks.

`registry.test.tsx` holds every manifest to the router and to each other (and the audit actions of the core and the manifests to the wire's list, each once): a route the router does not know, a rail
entry for another module's route, a palette place that is not the module's own, a settings page or shortcut row placed
after something that is not there, and a manifest the registry does not list.

The session says which modules run: `GET /api/me`'s `modules`, not the public `GET /api/client`; so a module that is not run has no rail link, no palette entry, no shortcut, no section and no request, and its address is `NotFound`, as the server's is.

## 7. Isolation

Modules share a process, an event loop and a connection pool, so they are kept apart by **budget**:

- a share of the pool: a cap on the requests a module has holding a connection at once, with a queue timeout and a
  `statement_timeout` (`moduleConnections`, `platform/module-budget.ts`, D-266). **Every module declares one** (`budget` in
  the manifest, D-260), and it is held **at the connection, not at the transaction**: `createApp` leases the one database
  it hands every handler (`leasingExecutor` of `@purlay/db`), the router notes whose request it is (`noteModule`, from the
  manifests' `routes`), and every connection that request takes — a read as much as a write, in a route or a socket frame — is asked of that
  module's share. **No handler asks for it, and none can take the pool without it**: the raw database is not reachable from a
  handler, because the application has no other (`module-seams.test.ts` holds `app.ts` to one use of the database it was
  given, and the doors and features to no pool of their own). A request holds one slot however many connections it takes,
  so that a transaction that reads again on the pool cannot wait for itself. **The core stays outside every share**: a
  route that is the core's, the sign-in library's own session reads, and the guards inside a module's request that decide
  whether it may be made (`requireWorkspaceMembership`, through `inTheCore`) take their connections as the pool gives
  them, so a person who is not in a workspace holds no slot of a module they have no part in. And the modules **together**
  may take the pool less what the core keeps (`coreReserve`: a fifth, at least one, none in a pool of one), so that
  signing in and reading a session are never queued behind a busy module (D-269). **Issues has a share**
  (`features/issues/budget.ts`): a third of `DATABASE_POOL_MAX`, never more than the pool less one and never fewer than
  one (a pool of one has nothing to leave), a queue timeout of one second and a statement limit of five. A request over
  the share waits its turn and, past the timeout, is answered `503 DATABASE_UNAVAILABLE` (`The issues module's share of
  the database is in use. Try again.`); a statement past the limit is cancelled by the database and answered the same,
  which a client retries. **Chat** (`features/chat/budget.ts`) has what the modules may take
  together less one, so that no module can take every connection the modules share: seven of a pool of ten, a queue
  timeout of three seconds (what the pool itself waits) and the pool's own statement limit, which a connection need not
  be told again. Chat's numbers are measured (D-269): with chat and issues both saturating their shares, the core's
  reads kept their p95 of 17–91 ms where with no cap they waited about 750 ms for a connection; chat's own sends under
  its own saturation are slower than with no cap (seconds against under one, a freed slot going to the oldest request
  first), which is the price of the core's reserve, and the table in D-269 says by how much. The share caps the
  connections a module holds; it does not cap what a module costs the event loop, which all modules share;
- a deadline per request and frame, and an error boundary (`platform/request-deadline.ts`, D-270). **A module's request or
  frame that runs past its deadline** (`deadline` in the manifest: 20 s by default, 8 s for issues) **is answered
  `504 REQUEST_TIMEOUT`** in the error envelope, with its request id, **whatever it is waiting for**: the framework's `wrap`
  hook runs the whole request against the deadline (`docs/spikes/elysia.md`), and `routeFrame` runs a frame, answering the
  frame that was sent. **The work stops with the answer**: the request's signal aborts, the lease cancels the statement each
  of its connections is running (`pg_cancel_backend` from a connection of its own, since at the deadline the pool is what
  is full) and refuses it the next, so a handler that waited on a lock or a slow query does not run on unseen. A request
  that waits on something that is not the database (GitHub, storage) is answered at its deadline too, and keeps running
  until its own bound ends it: the answer is not held for it. The core's routes have none: uploads, downloads and exports
  are bounded as they are, and **no module route streams or waits long** — a module that adds one declares
  `deadline: { none: reason }`, which `module-deadlines.test.ts` lists (empty today), or its own bound. The socket's
  connection and its upgrade are the core's; the frames of a module are held to its deadline. **An uncaught throw in a
  module's handler is that request's alone**: the framework's error hook answers the standard `INTERNAL`, writes the cause
  once with the module's label (`request failed`, `frame failed`), and the lease gives back its connection and its slot, so
  neither the process nor the pool is left as it was not (`deadline.integration.test.ts`). Not built: a counter of
  overruns (the warn line `request ran past its deadline` names the module, and a request that never answers is not in the
  request histogram, which counts the responses the handler gave), and a deadline on the core's own routes;
- a deadline and an abort signal per `SearchSource`; one that overruns is cancelled, skipped, and the response
  says which (`skipped: [module]`, a wire shape fixed in step 4);
- the CI latency gate refuses **starvation**, and only that (`budget:latency`): after the quiet trials it runs
  two more with twelve people reading issues' list, one request at a time with a pause between, while the issues
  table is locked in turns, so that the readers hold their share of connections and there are more of them than
  the pool has. The lower of the two is compared with the quiet p95 of the same run, and chat is starved when it
  is **more than eight times** that (`STARVATION_FACTOR`, with the noise floor of the gate's other rule under it);
  a starved run is measured again once, and nobody answered is an error. Eight is chosen between what was
  measured: with the budget a busy issues module cost chat **two to four times** its p95 on a two-core shared CI
  runner and about the same locally under six busy loops (1.1 to 1.5 times), and with the budget removed the
  same scenario cost 18 to 23 times on a laptop (727–774 ms against 33–39 ms). That a CI runner without the
  budget is at least as bad is expected, not measured. **So a busy issues module still costs chat up to about
  three times its p95 on a two-core shared host — database backends and CPU contention, which the share of the
  pool does not remove — and that is not starvation and is not refused.** **Built for chat with issues busy**; the
  hot path of a module other than chat is not measured, as no other module is budgeted. CPU and event-loop time
  are shared by every module in a process, so a module that serves a great many requests, or heavy ones, can
  still slow chat's sends on a shared process, budget or no budget (an unpaced reader of issues' list, three
  hundred requests a second, tripled chat's p95 on a laptop);
- metrics and logs name the module. **Built**: the HTTP request histogram and the scheduled-job series carry `module`
  (`core`, a module id, or `none` for a route no one owns), read from the core's claims and the manifests' `routes` and
  `jobs` (`platform/module-kit/ownership.ts`), the request line and `request failed` carry it for a module's route, a
  scheduled job's lines carry it, and the boot line and `purlay_modules_info` name the modules a process runs. So do the three
  counters that were not labelled: `purlay_rate_limited_total` by the owner of the route (HTTP door) or of the frame's
  operation (socket door, `ofFrame`: read from the frame's text without parsing it, because a frame over the rate is refused
  before it is read; a frame that names no operation is `none`), `purlay_push_failures_total` by the module whose notices the
  sender delivers (`pushOwner` of the composition: chat's, or `core` where none runs) and `purlay_mail_failures_total`, whose
  every letter is the core's (invitations and sign-in links; a module's job posts from the job command, which keeps no
  counters). The label is one of `core`, a module id the build carries or, for the rate counter, `none`, and each series is made at
  zero from the start (`serverMetrics` is given the ids). **Not built**: the label on a log line that is not a request's or a
  job's, and a counter of the share's own refusals (they are visible as `module="issues",status="5xx"` of the request histogram).

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
| No read of another module's tables | the typed handle (`ModuleSchema`, `features/<id>/schema.ts`): a module's functions take it, and a query over a table that is neither the module's nor named in the schema does not compile; `module-db.test.ts` asks the compiler about it, in both directions of assignability — **built for issues** (D-271), chat's functions still take the whole database's executor; the mutations `module-schema-ignores-ownership` and `module-schema-forgets-core-reads` | 9 |
| Every table has one owner; no foreign key across owners | the ownership list and its test, a ratchet that only shrinks | 2 |
| Chat's pagination and message reader are not the core's helpers | moved to `platform/`; a count of cross-imports that only falls | 5 |
| Modules tell one another what happened without importing each other | `platform/domain-bus.ts`: typed events, at most once, a failing handler logged with its module and unable to fail the publisher — **built** | 5 |
| A fact is not lost between commit and publish | a same-transaction row and a sweeper; a crash test | 5 |
| A module cannot starve the others of connections | the application's one database is leased (`leasingExecutor`, `@purlay/db`) by the share of the module a request belongs to (`moduleConnections`, `platform/module-budget.ts`): a cap on the requests holding a connection, a queue timeout and a `statement_timeout` per module, the modules together held to the pool less the core's reserve — **built, applied from each manifest's `budget`** (issues a third of the pool, chat seven of ten); `issues-budget.integration.test.ts` and `chat-budget.integration.test.ts` fill a share on a pool of their own and find the other module and the core answered, `module-budget.integration.test.ts` and `leasing.integration.test.ts` hold the lease, and the mutations `module-routes-not-noted-as-their-module`, `frames-not-noted-as-their-module`, `application-database-not-leased`, `module-share-ignores-core-reserve`, `membership-read-inside-a-module-share` and `module-budget-declaration-ignored` hold the wiring | 5 |
| A module's handler cannot take the pool without its module's share | there is no other handle: `app.ts` uses the database it was given once, to lease it, and no feature or door opens a pool (`module-seams.test.ts`); the mutation `application-hands-handlers-a-raw-database` — **built** (D-266) | 12 |
| A module's request or frame that runs past its deadline is answered and its database work cancelled; a throw in one handler is that request's | `deadline` in the manifest (`request-deadline.ts`): the framework's `wrap` around a module's request, `routeFrame` around its frames, the lease's signal cancelling the statement — **built** (D-270); `deadline.integration.test.ts` (a request waiting on a lock, over `handle` and a started server, the statement gone from `pg_stat_activity`; a handler that throws, the share of one connection still whole), `router.test.ts`, `leasing.integration.test.ts`, `module-deadlines.test.ts`, `registry.test.ts`; mutations `module-requests-have-no-deadline`, `deadline-signal-not-on-the-request`, `deadline-does-not-cancel-the-statement`, `lease-takes-a-connection-past-the-deadline`, `frame-deadline-ignored`, `registry-accepts-any-deadline` and `registry-accepts-a-deadline-none-without-a-reason` | 12 |
| Every module says what it may take of the pool, or says `none` and why | `budget` is a required field of `ModuleManifest`: a manifest without it does not compile (`@ts-expect-error` in `registry.test.ts` and `composition.test.ts`), and the registry refuses at run time a missing one, a `none` with no reason and a share that gives the module no connection or leaves the others none, in a pool of one to a hundred; a `none` is a line of `module-budgets.test.ts`, and `composition.test.ts` holds that no share takes every connection the modules may share — **built** (D-260, D-266, D-269); mutations `chat-declares-no-budget`, `issues-declares-no-budget-unlisted`, `registry-accepts-a-module-without-a-budget`, `registry-accepts-a-budget-none-without-a-reason` and `registry-accepts-a-share-of-the-whole-pool` | 12 |
| A module's purge and sweeps are run by the core's job command without the command naming it | `retention` and `jobs` in the manifest, `jobWork` in `BundledModule`: `compose` stops a build whose named jobs and supplied work differ either way, the registry counts a retention job among the jobs two modules may not both own, and `core-claims.test.ts` holds the command's own list to the core's — **built** (D-260); retention runs in every process and `jobs` only where the module runs (`composition.test.ts`, `cli/jobs.integration.test.ts`); mutations `composition-accepts-a-job-with-no-work`, `composition-accepts-work-no-manifest-names`, `composition-retention-work-only-of-running-modules`, `composition-retention-closed-with-its-module`, `registry-retention-jobs-not-claimed`, `job-command-drops-the-modules-work` | 12 |
| `cli/`, `ingress/` and `realtime/` name a module's files only in its route handlers and the composition root | `module-seams.test.ts`: `cli/` imports no feature but `erase-content.ts`'s one, `ingress/` only the files listed for the feature they serve and `ingress/http/app.ts`, `realtime/` only `router.ts`, which still runs chat's three socket operations itself (the manifest has no field for a module's frame handler); a list that only shrinks, as `core-tables.test.ts`'s is — **built** (D-260); mutations `job-command-names-a-chat-file`, `ingress-file-names-a-chat-file` and `realtime-file-names-a-chat-file`. The lint cannot say it: chat's handlers are in `ingress/` | 12 |
| A client survives a frame it does not know; a module catches up after reconnect | a client test; the manifest's replay hook or "refetch" | 4 |
| The core's own list names no module (channel visibility, erasure, export entries are chat's) | a test of `platform/` against the manifests | 9 |
| Module id is not a core path segment | the registry, when the build's modules are checked, and a test holding the list to `API.md` | 1 |
| A bundle has no cycle, repeat or double capability, and no two modules (nor a module and the core, `core-claims.ts`) own the same route template (a subtree or a named segment overlapping another's counts), job, socket operation or server event | the registry, and mutations in `scripts/mutations/` | 1 |
| `MODULES` is valid | `resolve`, at boot: a process that cannot parse it logs `MODULES cannot be run; exiting` with every problem and exits `1` (`registry.test.ts`, `migrate-on-start.integration.test.ts`) — **built** | 12 |
| The matrix exists as soon as two cells differ | the cells the tests build (below) and, on a started process, CI's `modules` job (`bun run modules:smoke`): one migrated database and one API per cell, the cells made from the bundle — **built**; and the suites that belong to no module, once per cell (`bun run modules:suites`, below) — **built** | 9 |
| Disabled ⇒ `404`, no distinct body | `modules-off*.integration.test.ts` (routes, socket, presence, per cell), the route-ownership test, `modules:smoke` (every path every manifest claims, every method, signed out, on a real process per cell: a module left out answers byte for byte what an unknown path does, a module that runs answers something else), and `test:modules-none`, a browser spec run in the browser job — **built**; and every suite that needs no module, run in each cell with the application that cell starts (`modules:suites`) | 12 |
| Disabled ⇒ no tables | a test migrates the core alone, each set on the core and every set, and finds that a set adds only tables it owns (`migration-cells.integration.test.ts`) — **built**; and `modules:suites` runs the suites that need no module on a database that has only the cell's sets, so a suite that reaches for a table of a module that is off fails there | 12 |
| Disabling leaves erasure and export whole | the export catalogue test over manifests; an erasure test with a module off; every lifecycle step in each cell of database state × process, on real migrated databases (`module-lifecycle.integration.test.ts`) — **built** | 10 |
| A table says what becomes of its rows on an account's erasure and how long they are kept | `TABLE_LIFECYCLE` over the schema (`packages/db/src/table-lifecycle.ts`): a table without the decision does not compile, and `table-lifecycle.test.ts` holds it to `TABLE_OWNERS` and spells out the tables erasure does not reach — **built** | 10 |
| A core migration keeps module schemas valid | `migration-cells.integration.test.ts` migrates each set on the core at head and `upgrade.integration.test.ts` migrates from the previous state by hand-written rows; and CI's `modules` job runs `bun run modules:upgrade` (`testing/module-upgrade.ts`): `packages/db` as the **last release tag** has it is extracted with `git archive`, its own migrator makes a database under each `MODULES` an operator could have kept (the cell's modules that release carried, and everything it carried), a copy of each is migrated to head under every cell of the matrix, and each must exit `0` and record the core's files and the cell's sets — an edited released migration fails it by checksum. `module-upgrade.integration.test.ts` runs the same on a release made from this tree less its newest migrations, and the mutations `upgrade-check-starts-from-an-empty-database` and `upgrade-check-migrates-the-core-alone` hold it — **built**. Not covered: a release that wrote rows (the check migrates the schema the release's migrator makes, empty, so a migration that fails only on data is `upgrade.integration.test.ts`'s and `migration-safety.test.ts`'s), and the tag's own dependencies (its migrator runs on the kysely and pg this tree installed) | 10 |
| One module set in a cluster; a rolling deploy still passes | each node's set in the shared Redis record (`realtime/module-set.ts`), a log line when nodes differ and nothing else, a two-process test with different sets; no bus channel per set, which would stop a sign-out reaching the other set's sockets — **built** | 12 |
| Optional never becomes required silently | `module-compat.test.ts` holds the manifests to the last release's, kept in `released-manifests.json` and rewritten by `bun run release` (`manifests:snapshot`): no new requirement, no capability, route or job gone, no id changed, unless a dated exception in that file says so — **built** | 12 |
| Chat is not starved by a module | `budget:latency` runs the send path again with issues' readers holding their share of connections (the table locked, paced readers) and fails if chat's p95 is more than eight times the same run's quiet p95 — **built** for issues, the one module with a share; it refuses starvation, not slowness: 2–4 times with the budget on a 2-core CI runner, 18–23 times without it on a laptop; a busy module's database and CPU use can still cost chat up to about three times its p95 on a shared host | 12 |
| Shell chunk holds no module code | `budget:web` reads the shell chunk's source map and fails if a chat screen is in it, or its chunk is gone, or either is over its bound; the mutation `web-chat-screen-imported-statically` and `chat-chunk.test.ts` hold the import side — **built** for chat, and for issues, whose screen is a chunk of its own and whose marker the check looks for in the initial chunks | 11 |
| A module's code names no event or socket operation its manifest does not list | `module-emissions.test.ts` reads each bundled module's own source (its folder under `features/` and `ingress/http/<id>.ts`) for every `ServerFrame` event and `ClientFrame` operation written as a string literal and holds it to the module's `events` and `frames` or the core's (`core-claims.ts`); with `core-claims.test.ts`, which holds the lists to the schema (a name in the schema is the core's or exactly one module's), and the mutation `chat-sends-an-event-its-manifest-does-not-list` — **built**, as far as a scan for a literal sees: a name built at run time is not seen, and the events chat's services publish through the core's builders in `platform/events.ts` are named in the core's file, so only the schema test holds those | 12 |
| A suite that is about no module passes whichever modules run; one that needs a module says so | `bun run modules:suites` (CI's `module-suites` job): for each cell but the one with every module, the integration suites that need no module the cell lacks run on a database of only the cell's sets with `MODULES` set, which the harness reads (`@purlay/db`'s `testing.ts` migrates `setsNamedBy(MODULES)`, `testDependencies` composes `compositionFor(MODULES)`). What a suite needs is what it imports of `features/<id>/` (its own helpers included) and what it declares, `// @needs-modules chat` in the file or a helper, or `testNeeding('chat')(…)` for one test (`testing/module-needs.ts`, `testing/needs.ts`); `module-suites.test.ts` holds every declared id to the build's modules and leaves at least the suites that import nothing in every cell — **built**; mutations `harness-ignores-modules-for-the-schema` and `harness-composes-every-module` | 12 |
| Every audit action a module's code records is in its manifest, and every one its manifest lists is recorded | `audit-emissions.test.ts` reads each module's source (and the core's) as `module-emissions.test.ts` reads events', `core-claims.test.ts` holds the manifests' actions and the core's to the wire's `AUDIT_ACTIONS`, each once, the registry refuses an action two owners list and a reading permission that is another module's, and the composition's `auditAccess` judges every module the build carries — **built** (D-265); mutations `audit-trail-read-by-a-member`, `trail-shows-what-the-role-cannot-read`, `registry-accepts-an-audit-action-read-by-a-foreign-permission` and `chat-stops-declaring-its-audit-actions` | 12 |
| Every permission a module's code asks is in its manifest, and every one its manifest lists is asked | `permission-emissions.test.ts` reads each module's source (and the core's) as `module-emissions.test.ts` reads events', the registry refuses a permission not named for its module and one declared twice, and the composition's `permissions` have a module's own only while it runs — **built** (D-265); mutations `issues-delete-ignores-its-permission`, `issues-permission-asked-is-not-the-one-declared`, `composition-holds-the-permissions-of-a-module-that-is-not-run` and `registry-accepts-a-permission-not-named-for-its-module` | 12 |
| Every kind of notification and search source a module sends is declared, and the wire's and the database's lists are the declarations | `notification-kinds.test.ts` holds `NotificationType`, `NEEDS_YOU` and the database's enum to the manifests' kinds, each once; the registry refuses a kind or a source two modules both list; `composition.notificationKinds` and `composition.searchSources` have a module's only while it runs — **built** (D-265); mutations `chat-stops-declaring-its-notification-kinds`, `missed-mail-takes-every-pushed-kind`, `composition-queries-the-search-sources-of-modules-that-are-off` and `registry-lets-two-modules-send-one-notification-kind` | 12 |
| This file lists the manifests | a test of §11 against `bundledModules` (`module-listing.test.ts`) — **built** | 9 |

**The matrix** — the core alone, each module alone with what it requires, everything — is the set of cells the
tests build: `module-lifecycle.integration.test.ts` (the database as each valid `MODULES` value leaves it, against a process
that runs each such value; the cells are made from the bundle by `testing/module-cells.ts`, every subset up to three
modules and a sample past that, so a third module adds its cells with no test edited), `migration-cells.integration.test.ts`,
`modules-off*.integration.test.ts`, a real process per cell in `migrate-on-start.integration.test.ts` (its cases are the cells, and the paths and tables each is held to are read from the manifests and the migration sets), the metrics page and the boot report per cell (`metrics.test.ts`, `ingress/http/metrics.test.ts`, `composition.test.ts`), and
`test:modules-none` in a browser, and `modules:smoke` (`testing/module-smoke.ts`), which CI runs as the `modules` job whenever the
API, a package, the dependencies or the workflow changed: for each cell, `db:migrate` under its `MODULES`, the API started with the same
value and no migration of its own, and the paths of the manifests asked for. It is the set of cells run, and the only combinations
promised (D-250 rule 6).

**The suites per cell.** The same matrix runs the product's tests: `bun run modules:suites` (CI's `module-suites` job, one leg per cell, a required part of `verify`) takes every cell but the one with every module — that cell is `bun run test:all`, the whole suite on the whole schema, and the
harness unset is what it always was — and for each makes a database, migrates only the sets that cell's `MODULES` names, and runs on it,
with `MODULES` set, the integration suites (`apps/api` and `packages/db`; unit tests read no `MODULES`, so a second run would repeat the
first) that need no module the cell lacks. The harness reads the setting twice, as a process does: the migrations (`setsNamedBy`) and the
composition (`compositionFor`), so an application a test builds with `testDependencies` is the one that `MODULES` starts, and a table of a
module that is off is not there. **The rule for the subset is the suite's own need, not a list.** A suite needs the modules whose files it
imports (the closure of its relative imports, helpers included, cut at the files that put the modules together:
`composition.ts`, `index.ts`, `ingress/http/app.ts`, `ingress/ws/socket.ts`) and the ones it declares: `@needs-modules chat, issues` in the
file's header or in a helper it imports (a fixture that writes chat's rows says so once, `testing/channels.ts`), or `testNeeding('chat')(…)` /
`describeNeeding(…)` (`testing/needs.ts`) for one test or group in a file that is otherwise about no module, which is skipped in a cell
without it under a name that says why (`… (needs chat)`). A cell leaves out the whole files whose needs it lacks and says how many of each kind
(`27 suites need chat, which this cell does not run`). A new module adds its cells to the command and the suites that import it are its; a
suite that reaches a module by its routes or tables, and says nothing, fails in the cells without the module, in CI. Not covered: the
cell with every module is not run twice; a suite that needs *both* modules (the endpoint table, the export and purge catalogues, the
cross-tenant matrix, the permission table, which each walk every module's rows) runs only in the cell with everything, so what those say
about one module with the other off is not proven; the Redis suites run in each cell as the others do. The cost is about **nine to thirteen minutes** of one runner for all three cells on a laptop (the core alone 2–3 min, chat 5–6 min, issues 2.5–5 min, two files at a time); in CI each cell is a leg of its own job beside `schema`, so a pull request waits for the longest (chat's, about as long as `schema`) and the added runner time is the sum, about ten minutes. `module-suites.test.ts` holds the workflow's legs to the cells the build has.

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
  for its users. Chat's `events` are a `satisfies readonly ServerEvent[]` list, so a typo does not compile. An event the
  module sends and does not list would reach a process that does not run it.
- `budget` (D-260, D-266, D-269): required. `{ poolShare: (poolMax) => limits }` (`features/issues/budget.ts`,
  `features/chat/budget.ts`) or `{ none: '<reason>' }`, which is also a line in `module-budgets.test.ts`: an exemption is a
  decision a reviewer sees (there is none today). A manifest without it does not compile; the registry refuses it at run
  time, and a `none` with no reason, and a share that gives the module no connection or leaves the others none;
  `composition.test.ts` holds that no share takes every connection the modules together may. Nothing else is edited to
  budget a module: `createApp` leases the database every handler gets, and a request or frame is held to the share of the
  module whose `routes` or `frames` it matches.
- `deadline` (D-270): optional. Left out, a request or frame of the module is answered `504 REQUEST_TIMEOUT` after 20 s and its
  database work cancelled; `{ ms }` says another, and `{ none: '<reason>' }` — for a route that streams or waits long, which no
  module has — is also a line of `module-deadlines.test.ts`. The registry refuses a deadline under a second, over two minutes, and a
  `none` with no reason. Nothing else is edited: the router wraps every route and frame the module's `routes` and `frames` name.
- `retention`: the scheduled jobs that keep the module's rows within their retention, a purge or a sweep, **in the
  manifest, not in `cli/jobs.ts`**. They run in every process (rows outlive the module's being off); a job that acts for
  the module's users goes under `jobs` and waits for the module to run. The work is `jobWork` of the module's slot in
  `bundledModules`, one `JobWork` per name in `jobs` and `retention` (chat's: `features/chat/jobs.ts`); a name with no
  work, or work with no name, stops the build (`composition.test.ts`), and a name the core or another module has is
  refused by the registry. The new job still needs its slot in `PLAN` (`modules/jobs/schedule.ts`): `core-claims.test.ts`
  fails for a job the plan has and nothing claims, and the other way.

**3. The data.**

- A **migration set** in `packages/db/migrations/<id>/0001_<name>.sql`, recorded as `<id>/0001_<name>`; registered in
  `PRODUCT_MIGRATION_SETS` (`packages/db/src/migrator.ts`, one line: the module ids a `MODULES` setting may name, `PRODUCT_MODULE_IDS`, are
  derived from it, so there is no second list; a module with no tables of its own is the exception and goes in
  `MODULES_WITHOUT_A_SET` beside it). `migration-sets.test.ts` fails by id for a directory under `migrations/` that is not
  registered, and for a set that owns no table. Keys go module to core, never between modules; index every
  key (`schema.integration.test.ts`), and every table a statement of the module reads needs an index that starts with
  a column it names (`query-columns.integration.test.ts`: the module's own migration set, or a reasoned line in
  its capped `UNINDEXED` list for a table that stays small). `SCHEMA.md` §12 lists the file (`check:docs` fails if it does not) and the table's entry goes in `SCHEMA.md`
  and `DATA.md`.
- **The migration is written for a table that has rows** (`DATA.md` §5, `migration-safety.test.ts`). A migration after
  the baseline fails the test for an `UPDATE` or `DELETE` with no `LIMIT`, a `CHECK` or `FOREIGN KEY` added without
  `NOT VALID`, an index built without `CONCURRENTLY` (or `CONCURRENTLY` inside the transaction), or a column type
  change, on a table `TABLE_LIFECYCLE` does not call `swept` or one row for life. The module's own tables are exempt in
  the migration that creates them; a later change to them is not. A table that is small on every instance says so in
  the file, `-- purlay: large-table-ok: <why>`, and the test reads the reason.
- **The table's owner**: `TABLE_OWNERS` in `packages/db/src/table-owners.ts`, and the owner type beside it. The set's
  `requires` go in `PRODUCT_MODULE_REQUIRES` next to `PRODUCT_MODULE_IDS` in `migrator.ts`; a test holds that mirror to
  the manifests.
  `table-ownership.integration.test.ts` holds the list to the database, and a key across owners fails it. A core
  migration never names the table (`core-tables.test.ts`). Regenerate `packages/db/src/schema.ts` (`bun run db:generate`).
- **The table's schema** (D-271): `features/<id>/schema.ts` makes `<Id>Db` and `<Id>Tx` of `ModuleSchema<'<id>', CoreReads>`, naming the core tables the module reads; the module's functions take them in place of `Executor` and `Transaction`, and a core table added to the list is a line a reviewer reads. `module-db.test.ts` holds what the type refuses.
- **The table's lifecycle**: every owned table needs its erasure and retention decision in `TABLE_LIFECYCLE`
  (`packages/db/src/table-lifecycle.ts`); a table with none does not compile, and `table-lifecycle.test.ts` holds the
  list to `TABLE_OWNERS`. The compiler does not check that a `deleted` or `window` decision is true (see the silent gaps).
- **Data hooks and the data-lifecycle rule.** Erasure, export and retention reach every module whose tables exist,
  enabled or not (D-250 rule 5, D-255 §3). So a module whose data an erased account, a deleted workspace or an export
  must reach gives `userErased`, `workspacePurge` (its table in `tables`, because a purged
  workspace keeps its row as a tombstone and the cascade never fires), `export` and `personalExport`. Each hook that names
  a table its own set makes asks `tableExists` first; the exports skip it through the contribution's `ownSet`. The
  compile-time decision in `export-catalogue.ts` is derived from the manifests (nothing to edit there): while a table is
  undecided it does not compile and names the table. A module whose data is not personal or workspace data still decides it, as `excluded`.
- **Audit and permissions** (D-265): an audit action is a value of `AUDIT_ACTIONS` in `@purlay/types` and the name of one
  of the module's list there (`<ID>_AUDIT_ACTIONS`), declared in the manifest's `auditActions` with the permission that
  reads it, and its target a `targetType` in `modules/audit/audit.ts`; it is written in the same transaction by id and
  never by words (D-222), with the sentence the settings page shows for it (`apps/web/src/features/settings/pages/audit.tsx`)
  and the same list as the web manifest's `auditActions`, which is what the page's filter offers while the module runs.
  A role rule that is the module's own is a permission in the manifest's `permissions`, asked of
  `permissions.holds(context.role, NAME)` with the table the composition makes and the route hands the service
  (`issues.delete-any`). `audit-emissions.test.ts` fails for an action the module's source records and its manifest does not
  list and for a declared one its source no longer records; `permission-emissions.test.ts` for a permission asked at `holds`
  that is not declared and for a declared name its source no longer writes; `core-claims.test.ts` for an action the wire
  names that nobody owns, and the registry for a permission not named `<id>.<what>`, one two modules both declare, and a
  reading permission that is another module's.
- **Notifications and search** (D-265): a kind of notification a module sends is `{ type, needsYou, pushed, mailed }` in
  its manifest's `notifications` and a value of the database's `notification_type`; a source it adds to a workspace search is
  an id in `searchSources`. `notification-kinds.test.ts` fails for a kind the wire, `NEEDS_YOU` or the database has and no
  manifest declares, and for one declared twice; the registry for a kind or a source two modules list.

**4. The routes, in `ingress/`.**

- Route handlers in `apps/api/src/ingress/http/<id>.ts` and their registration in `ingress/http/app.ts`; the
  module's services do not import HTTP types. A service that writes atomically takes `atomicallyOn(database)`
  (`platform/transactions.ts`): a raw `database.transaction()` compiles and runs, and answers 500 in the cross-tenant
  harness, which holds a transaction already. The wire types go in `packages/types/src/<id>.ts`, exported from `index.ts`,
  with new error codes in `errors.ts` and the endpoint in `api.ts` and `API.md`.
- **Cross-tenant classification.** The endpoints are read from `API.md`, and each must appear in `apps/api/src/testing/cross-tenant.ts`
  with a case (what it answers for a workspace the caller is not in, `WORKSPACE_NOT_FOUND`, and how channel visibility
  applies: `none`, with the reason, for a route that names no channel) or among the unscoped with the reason it has no
  tenant to cross; `cross-tenant.test.ts` fails for one that is in neither, and `cross-tenant.integration.test.ts` runs
  the crossings. A new path parameter name needs its id there too, and the module's own row needs a seeded id: add its field to `Ids`
  and seed it in `aTenant` (`ingress/http/cross-tenant.integration.test.ts`). Without the seed, the same-member
  two-workspace list check passes vacuously for the module's lists.
- `bundledModules` gets the module (one line in `composition.ts`), and `compose` does the rest.
- **The share of the pool**: nothing to write in a handler. The handler is given the application's one database, whose
  every connection is leased by the module the request belongs to (D-266), so there is no boundary to ask for and no raw
  handle to take instead; `module-seams.test.ts` holds `app.ts` to one use of the database it was given, and the doors and
  features to no pool of their own. What is yours is a read that decides whether a request may be made at all (a
  membership, a session): the core's guards in `platform/tenancy.ts` take their connections outside every share
  (`inTheCore`), so a person with no part in the module holds none of its slots. Copy `chat-budget.integration.test.ts` for
  a module with a `poolShare`: a lock on a table its routes read, the share filled, the next request refused as busy
  and another module's answered meanwhile.
- **No door names a module's files but its own routes**: `cli/` imports no file under `features/`, and a route file in
  `ingress/` that imports the module is added to `ALLOWED` in `module-seams.test.ts` (the list only shrinks; a core route
  file that needs the module is a port or a manifest field, not an entry); `ingress/http/app.ts` is the one file that may
  name any.

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
- A **real process** per cell in `platform/migrate-on-start.integration.test.ts`: nothing to edit, its cases are made from the bundle.
- **Its suites declare what they need** (§8, *The suites per cell*): a suite under `features/<id>/` needs the module by where it is, a suite or helper that imports its files by the import, and one that reaches the module by its routes or its tables says `// @needs-modules <id>` in its header (or `testNeeding('<id>')(…)` for one test) — or it fails in `modules:suites` in every cell without the module. A suite about the core that uses a module's fixture (`aRoom` makes a channel) needs the module; to keep a core suite in every cell, build its world from the core's tables.
- The **smoke cell**: nothing to edit — `modules:smoke` makes its cells from the bundle and its paths from the manifest's `routes`, so a
  module with routes is asked for in every cell. A module whose manifest claims no path fails it (nothing would show it runs).
- The **no-module browser spec**: `apps/web/e2e/modules-none.e2e.ts` (run as `bun run test:modules-none`) holds the module
  out of the frame when the server runs none.
- A **module-listing** row (§11, above) and `composition.test.ts` for what the module contributes.
- **Mutations**: for each rule above the tests are the only guard of, a mutation in `scripts/mutations/` that breaks the
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

**What a new module edits outside its own folder, measured by a throwaway third module (`notes`) built from this
list.** Source files, not tests and not documents; the first four rows are what a module without UI and without an
audit action edits.

| Where | Files | Why |
|---|---|---|
| `apps/api/src` | `composition.ts` (one `bundledModules` line), `ingress/http/app.ts` (its routes), `ingress/http/<id>.ts` (its own) | the module's row and its routes; `cli/jobs.ts` is **not** edited, the job command takes a module's jobs from the composition; `export-catalogue.ts` is **not** edited, it is derived from the manifests |
| `packages/db` | `src/migrator.ts` (set registration and `PRODUCT_MODULE_REQUIRES`), `src/table-owners.ts`, `src/table-lifecycle.ts`, `src/schema.ts` (`bun run db:generate`) | the set, its owner, its erasure and retention decision, the generated schema |
| `packages/types/src` | `index.ts` (re-export), `<id>.ts` (its own) | the wire |
| `apps/web/src` | nothing for a module without UI: **no web manifest is needed** | the registry lists a module only when its manifest exists |
| an audit action | `modules/audit/audit.ts` (target type), `packages/types/src/api.ts` (action), web `features/settings/pages/audit.tsx`, `i18n/catalogue/en.ts`, `i18n/catalogue/tr.ts` | the exhaustive switch and the catalogues refuse an action with no sentence, so an audit action forces three web files even for a module with no web part |

That is 12 shared files besides the module's own two (the `ingress/http` handler and the types file), and 7 of them
without an audit action. A module with UI adds its manifest, one
`registry.ts` line and the per-module web files listed in item 5. The old figure of 27 files was the issues commit
counted before the web registry and the derived catalogue, and is stale.

**The tests a new module edits.** Item 6's cells are not all automatic. These hard-code the module list or need a
fixture, and are edited (eight files): `module-seams.test.ts` (the entry for the handler `ingress/` keeps),
`testing/module-smoke.test.ts`, `migration-sets.test.ts`, `scripts/check-docs.test.ts` (it uses `notesModule` as its
unknown-module name, so a real module of that name breaks it), and the modules-off, export, personal and upgrade
integration tests (a seeded row, a file list or a snapshot for the new table), plus the fixtures: `testing/cross-tenant.ts`
(the `Ids` field, item 4), the seed in `cross-tenant.integration.test.ts`, and the `channel-visibility.integration` and
`upgrade.integration` fixtures that need a seeded row or field.
What grows by itself: the `modules:smoke` cells, the lifecycle matrix, the migration cells, the real process per cell of
`migrate-on-start.integration.test.ts`, the cells of `composition.test.ts` and of both metrics tests, the `MODULES` value
the command and the API must read alike (`module-setting-pair.test.ts`), the `/api/me` module list of `modules-off.integration.test.ts`,
and `modules:upgrade`; and what a module's code names on the socket (`module-emissions.test.ts`).

**What still goes unnoticed (silent gaps).** `db:migrate` validating `requires` (#985), the cross-owner key list (#986),
the typed lifecycle decision per table (#990), the core-enum guard (#994), the member-of-two-workspaces list check
(#988), its non-vacuous form (#1010), the purge coverage (#1009), the set-keyed enum allowance (#1007) and the row-level
lifecycle proof for `deleted` and `window` decisions (#1011) are merged, and every `anonymised` lifecycle decision is
probed (all 28; the allow-list of unprobed tables is empty and capped at 0). A statement that reads a table by columns
no index starts with is held too (`query-columns.integration.test.ts`, seven reasoned exceptions, capped at 7), but
only as far as a source scan sees: a `where` or `orderBy` with a literal column on a chain it can follow to its table.
It does not see a column named inside a `where((eb) => ...)` callback (55 places), in a `sql` template (199 templates,
not all of them queries) or in a variable (29), a chain that starts from a parameter or a helper's return value (27),
a CTE or select alias (21 references), or whether a partial index's predicate serves the statement. And the rule is per statement and table, not per column:
`where workspace_id = $1 and status = $2` passes because `workspace_id` leads an index, so a column that is filtered
only after that one is not asked for an index of its own.
A migration that rewrites or locks a growing table in one step is held too, for the files after the baseline
(`migration-safety.test.ts`, `DATA.md` §5; thirteen shipped files grandfathered with a reason, capped at 13): it reads
the statements of the file, not the table's size, and does not see a table named through a variable in a `DO` block,
`SET NOT NULL` or `ADD UNIQUE`.

**What a new module's check needs.** `scripts/check-docs.test.ts` works from a copy of the tracked files, so `git add`
the module's files first, or it fails with `SCHEMA.md names a migration that is not a file`. The database named in
`.env.test` must already exist. `bun run modules:upgrade` and `module-upgrade.integration.test.ts` read the last release
tag with `git archive`: a checkout without tags fails the first (it says to fetch them), and a new module needs nothing.

**Recovery when the test database is corrupted.** Editing a migration that has been applied, or adding a `0002` file
and removing it, makes the persistent test template and database fail with `... was edited after it was applied`: the
template is migrated on every run and the clones come from it. Drop your own two databases and run again: the database
named in `.env.test` and its template, `<name>_template` (`buildIntegrationTemplate`), for example
`psql "$URL_OF_YOUR_DATABASE_ON_postgres" -c 'drop database "<name>_template" with (force)'` and the same for
`<name>`. Never drop `purlay` or `purlay_template` when another worktree or session uses them: `bun run db:prune` lists
what is scratch and leaves a database in use alone, but names both.

## 10. Order of work

Each step ships alone and can be reverted.

| # | Step | Behaviour changes? |
|---|---|---|
| 1 | `module-kit`: the manifest type, the registry and `MODULES` resolution, as pure code; the import lint | no |
| 2 | Migrator learns sets (legacy rows stay the core's); the table-ownership list and its ratchet test; the export's schema stamp reads core rows only — **built**; the `MODULES`-driven call waits for step 12 | no |
| 3 | *Obsolete: folded into 12 and 11, both built.* Reading `MODULES` waited until something could be turned off, as `CONFIG.md` requires; the list of modules the web reads is `GET /api/me`'s `modules` | — |
| 4 | Wire unions opened, with aliases, **with the first module that has frames of its own** (5b); the web client already ignores unknown frames (D-82, tested) and a native client is checked first; the replay rule; `skipped` in the search response | no |
| 5 | The core ports, the domain bus with hint/fact and the sweeper, the typed query handle (**built for issues**, D-271) and the raw-`sql` ban, the per-module pool cap and `statement_timeout`; chat's pagination and reader move to `platform/` | no |
| 5b | *Superseded by 13.* It planned a thin slice that opened an issue from a message and linked back; D-254 §1 decided that issues has no link and no frame, so that slice was not built | — |
| 6–8 | The three cycles broken: `workspaces`, `integrations`, `channels` with `messages` | no |
| 9 | Chat moved under `features/chat` — **built**, 116 files and every import that named them; still to come in this step: channel visibility and the export entries leave `platform/` and `export`, and chat's queries go behind the typed handle (D-271: issues' are; chat's raw-SQL exemption is policed by a text scan, not ended) | no |
| 10 | Migrations split by module; `data` hooks — **built** (`tableExists`, §5); the ownership ratchet reaches zero — **built, ships in the release after the expand** (`chat/0005`); codegen and `db:check` per module are **not built** | no |
| 11 | Chat's web screens a lazy chunk; budgets split — **built** (below) | no |
| 12 | `MODULES` turns modules off — **built**, with the cluster record (said, never acted on) and the cells of §8; the product's module-independent suites in every cell in CI (`modules:suites`, §8); a share of the pool is built for each module and a starvation gate for chat with issues busy (§7) | **yes** |
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
   the dumps compared, and the ratchet kept the crossing in view until then. **In three releases, all built:**
   *expand* (**built**: `claimed_at`, `message_attachments` backfilled, and a send writing the old columns and the
   link together); *the readers move* (**built**: the core says unsent and sent with `claimed_at`, chat finds a file's
   message and channel through `message_attachments`, the workspace export's and the person's export's bounds read
   through the link, and `dropFiles` is the core's `dropFilesById` and chat's `dropMessageFiles`; a test,
   `attachment-readers.test.ts`, fails if production code reads `attachments.message_id` or `channel_id` again,
   with an allow-list of the one place that still writes them); *contract* (**built, ships in the release after the expand** — `v0.3.0` contains `0079`, so it is the next
   release's: `chat/0005` drops the columns, their keys and indexes, the dual write and the allow-list go,
   and the exports stop writing the two columns on `attachments` and write `message_attachments` instead, which
   changes the shape of an export. It is a file of **chat's set**, not the core's: the sets run core first, so a core
   file dropping the columns would run before `chat/0001`'s backfill reads them, on every new install and for a server
   that was off chat for a release; in chat's set it follows the backfill always, and a server without chat keeps the
   columns, inert. It refuses, with nothing changed, a database whose link table does not carry every sent file —
   one that skipped the expand release — and its rollback is the backup restore, D-86. The ownership list's
   exceptions are now none.)

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
7. the message link of an attachment becomes chat's (step 8 above), with step 10 (**built, ships in the release after
   the expand**);
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
   `features/chat/sweeps.ts`. They, and the retention purge, are chat's manifest `retention` (D-260), not its `jobs`, on
   purpose: the rows are in the core's migrations, so the sweeps must keep running with chat off
   (`module-lifecycle.integration.test.ts` runs them in each cell), which a closed job would stop; the job runner takes
   their work from the composition (`features/chat/jobs.ts`) and names none of it. What the
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
it never refuses traffic, so a new set rolls out node by node; (f) the matrix in CI (the cells of §8 are built, and so is the run of the suites that need no module in each of them; a suite that needs two modules runs only where both do).

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
- **Audit and permissions.** Its four actions (`issue.created`, `issue.status_changed`, `issue.assigned`, `issue.deleted`) are
  on the workspace's trail and in the manifest's `auditActions`; the role rule — any member makes and changes, only the
  creator or whoever holds `issues.delete-any` (an owner or an admin) deletes — is the manifest's `permissions`, tested
  through the route.
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
  `readAttachment`, `pushNotices`, `collatedColumns`).
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
- **Holding** — the modules whose contributions a composition keeps: every bundled module, in the registry's resolved
  order (`composeFor`), whichever it runs. Erasure, purge, exports, retention and the columns readiness checks read from
  it; the workspace's first hook, the routes, the jobs and the attachment reader of a module that is not run do not,
  since they *act*. (A `dataInCore` flag once said which modules were held; every bundled module set it and a `false`
  would have made a person's erasure wait for a setting, so it was removed.)
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

