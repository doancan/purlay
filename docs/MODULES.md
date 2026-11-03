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

1. Parse `MODULES` (`module-kit`'s `resolve`). Unset or blank means every bundled module (a blank variable is read as unset everywhere in the configuration); `none` means the core alone. An
   unknown or repeated id, an empty item, or a missing requirement stops the process before it listens; a
   cycle, a reserved id or a repeated capability are caught earlier, when the build's registry is made.
2. Order by `requires`, then by `optional` edges, so a module's partners have registered first.
3. Record this node's module set in the database. A node whose set differs from a live peer's refuses to serve
   (D-250 rule 8); the release may differ, so a rolling deploy passes, and nodes of different sets share no bus channel.
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
  names fails it — keeps working. **Built** as `dataInCore`: a module whose tables the core's own migrations made
  (chat) contributes its erasure, purge, export, retention and channel answers whether or not it runs, and only
  what *acts* (its routes, its mail, what a new workspace starts with) waits for it to run. A module with a set of
  its own is held only while it runs; what its hooks do when its tables were never made is decided with the first
  such module.
- **Existing installs are not touched** (D-250, decided a): the legacy rows stay as the core's, and only files
  added from now on live under `packages/db/migrations/<module>/` and record as `<module>/<file>`. The core's
  first 77 files always create chat's tables, inert where chat is off. The release before the first prefixed row
  skips rows it has no file for and says so, so one release of rollback stays possible while module migrations are
  additive. Anything that reads the migration table for the core's schema stamp (the export's) filters to the
  core's rows.
- **Every table has one owner**, core or a module, in a list a test holds to the database; a foreign key across
  owners fails it, and the list of those that exist today (reactions, mentions, attachments and read state
  point at `messages` and `channels`) may only shrink. A core migration never names a module's table.
- `schema.ts` is generated per module and combined only for the core's own use; `db:check` migrates the core
  with each module alone as well as with all of them. **Built so far:** every cell migrates and adds only its own
  tables (`migration-cells.integration.test.ts`); the per-module generation of `schema.ts` is not, and waits for a
  module whose tables a combined schema would hide.

## 6. Web

`apps/web/src/features/<id>/manifest.ts` declares routes, sidebar entry, palette commands, shortcuts and
settings; the entry is a lazy import. The server answers which modules are enabled; the router, sidebar and
palette are built from those manifests, so a disabled module has no route and no chunk. The shell chunk holds
no module code; `budget:web` states a bound for it and one per module.

## 7. Isolation

Modules share a process, an event loop and a connection pool, so they are kept apart by **budget**:

- a share of the pool — a cap on a module's concurrent connections with a queue timeout — a
  `statement_timeout` set inside its transactions, a deadline per request and an error boundary around each
  handler and job: an unhandled rejection in one module is that module's, not the process's. **These land in step
  5, before a second module exists**, because a gate in step 12 would measure a mechanism nobody built;
- a deadline and an abort signal per `SearchSource`; one that overruns is cancelled, skipped, and the response
  says which (`skipped: [module]`, a wire shape fixed in step 4);
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
| The core's modules import none of chat's | the lint that keeps `modules/` and `platform/` from importing a feature, now that chat is `features/chat`; the core's tests may — **built** | 9 |
| No raw `sql` in a module | the lint, found per folder under `features/` and shown by `verify:enforcement` — **built** | 5 |
| No read of another module's tables | the typed query handle, handed to a module with its own tables and the core's | 9 |
| Every table has one owner; no foreign key across owners | the ownership list and its test, a ratchet that only shrinks | 2 |
| Chat's pagination and message reader are not the core's helpers | moved to `platform/`; a count of cross-imports that only falls | 5 |
| Modules tell one another what happened without importing each other | `platform/domain-bus.ts`: typed events, at most once, a failing handler logged with its module and unable to fail the publisher — **built** | 5 |
| A fact is not lost between commit and publish | a same-transaction row and a sweeper; a crash test | 5 |
| A module cannot starve the others of connections | `budgeted` in `platform/module-budget.ts`: a cap on open transactions, a queue timeout and a `statement_timeout` per module — **built**, a module is handed it when it is made | 5 |
| A client survives a frame it does not know; a module catches up after reconnect | a client test; the manifest's replay hook or "refetch" | 4 |
| The core's own list names no module (channel visibility, erasure, export entries are chat's) | a test of `platform/` against the manifests | 9 |
| Module id is not a core path segment | the registry, when the build's modules are checked, and a test holding the list to `API.md` | 1 |
| A bundle has no cycle, repeat or double capability | the registry, and mutations in `scripts/mutations.ts` | 1 |
| `MODULES` is valid | `resolve`, at boot | 12 |
| The matrix exists as soon as two cells differ | CI cells for core-alone and everything, widened per step | 9 |
| Disabled ⇒ `404`, no distinct body | the CI matrix | 12 |
| Disabled ⇒ no tables | a test migrates the core alone, each set on the core and every set, and finds that a set adds only tables it owns (`migration-cells.integration.test.ts`) — **built**; running the whole suite per cell is the CI matrix, which waits for step 12 | 12 |
| Disabling leaves erasure and export whole | the export catalogue test over manifests; an erasure test with a module off | 10 |
| A core migration keeps module schemas valid | CI migrating each set from the last release | 10 |
| One module set in a cluster; a rolling deploy still passes | each node's set in the shared Redis record (`realtime/module-set.ts`), a log line when nodes differ and nothing else, a two-process test with different sets; no bus channel per set, which would stop a sign-out reaching the other set's sockets — **built** | 12 |
| Optional never becomes required silently | a test of manifests against the last release | 12 |
| Chat is not slowed by a module | `budget:latency` per module | 12 |
| Shell chunk holds no module code | `budget:web` reads the shell chunk's source map and fails if a chat screen is in it, or its chunk is gone, or either is over its bound; the mutation `web-chat-screen-imported-statically` and `chat-chunk.test.ts` hold the import side — **built** for chat | 11 |
| This file lists the manifests | a test of §11 against `bundledModules` (`module-listing.test.ts`) — **built** | 9 |

**The matrix** — the core alone, each module alone with what it requires, everything — runs when
`modules/**`, `features/**`, `platform/**` or `packages/db/**` changes. It is the set of cells run, and the
only combinations promised (D-250 rule 6).

## 9. Adding a module — the checklist

A section in this file with its requires, optional partners and capabilities · its migration set, with the
`SCHEMA.md` and `DATA.md` entries · its `data` hooks (erasure, export, retention) · its audit actions and
permissions · its events and notifications · its web manifest and chunk bound · its smoke test and matrix cell
· its latency measure · what a user sees for each partner that is absent · the threshold at which it is removed if
nobody uses it (D-250 rule 6).

## 10. Order of work

Each step ships alone and can be reverted.

| # | Step | Behaviour changes? |
|---|---|---|
| 1 | `module-kit`: the manifest type, the registry and `MODULES` resolution, as pure code; the import lint | no |
| 2 | Migrator learns sets (legacy rows stay the core's); the table-ownership list and its ratchet test; the export's schema stamp reads core rows only — **built**; the `MODULES`-driven call waits for step 12 | no |
| 3 | *Folded into 12.* Reading `MODULES` at boot before anything can be turned off would accept a setting that does nothing — `MODULES=none` with chat still running — which `CONFIG.md` forbids: a variable is read when the feature that needs it is built. The server's list of modules and the web registry wait for the first module that has a screen (11) | — |
| 4 | Wire unions opened, with aliases, **with the first module that has frames of its own** (5b); the web client already ignores unknown frames (D-82, tested) and a native client is checked first; the replay rule; `skipped` in the search response | no |
| 5 | The core ports, the domain bus with hint/fact and the sweeper, the typed query handle and the raw-`sql` ban, the per-module pool cap and `statement_timeout`; chat's pagination and reader move to `platform/` | no |
| 5b | Issues' thin slice for the dogfood team — open an issue from a message, link back — to prove the ports with a real user before the moves | new feature |
| 6–8 | The three cycles broken: `workspaces`, `integrations`, `channels` with `messages` | no |
| 9 | Chat moved under `features/chat` — **built**, 116 files and every import that named them; still to come in this step: channel visibility and the export entries leave `platform/` and `export`, and chat's queries go behind the typed handle so its exemption from the raw-SQL ban ends | no |
| 10 | Migrations split by module; `data` hooks; codegen and `db:check` per module; the ownership ratchet reaches zero | no |
| 11 | Chat's web screens a lazy chunk; budgets split — **built** (below) | no |
| 12 | `MODULES` turns modules off; the full matrix, the cluster check and the per-module budgets in CI | **yes** |
| 13 | Issues complete, the second module in full | new feature |

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
   with an allow-list of the one place that still writes them); *contract* (**left**: the columns, their keys and
   indexes go, the dual write and the allow-list with them, and the exports stop writing the two columns — which
   changes the frozen shape of an export, so it is its own change).

The three behaviours that could change without a test failing: the default channel at workspace creation (an
integration test through the route and through `createWorkspace`, and one with the hook failing that finds no
workspace); the erasure of a person's messages (the existing tests unchanged, and the rows compared before and
after on a seeded fixture, with two erasures racing); and the nightly retention (the counts on aged fixtures identical, held by the existing tests, which moved unmodified).

**What is left of step 9 and step 10, measured on `main` after the move.** Nothing in the core imports chat, but eleven
files of the core still name its tables. Each is an edge with its own inversion, in this order, each its own pull
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
   compile time, naming a table nobody decided, and the integration test holds it to the database. A frozen
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
8. the lint then forbids a chat table's name in `modules/` and `platform/`, from an allow-list that has shrunk to
   nothing.

**Step 12, in the order it is built.** (a) *The composition* (**built**): `composition.ts` takes the modules a process runs
and makes from them what the core leaves open — the workspace's first hook, the account's erasure hook, who answers
for the channels, the purge's steps and tables, the two catalogues, the columns readiness checks; a module is its manifest
and what it contributes (`features/chat/module.ts`), and a process with no module has the core alone, shown on a real
database. (b) *`MODULES` read at boot* (**built**): `compositionFor(setting)` hands the process only the modules it names, and a setting that
names none the build carries stops it before it listens; the migrations (`MIGRATE_ON_START`, `db:migrate`, readiness and
the wait for another node's) are the core's and the named modules' sets, and the rows of a set that is off stay inert.
(c) *Routes, jobs and commands* (**built**): a module's manifest lists its route templates and its jobs; a path of a module that
is not run is the plain `404` of any unknown path, before the rate limit and the session are asked, a job of one that acts for its
users (chat's missed-mail letter) exits `0` with a line saying so and is left out of the status report — its sweeps and the retention purge still run, the rows being there — and `GET /api/client` lists the modules the server runs.
A scan holds every route the application registers to the core's list or a module's. (d) The web building its routes
from the listed modules (step 11); (e) *the cluster check* (**built**): where nodes share Redis each keeps its set in one
shared record, renewed and lapsing by itself, and a node that finds another set logs it once and again when the nodes agree;
it never refuses traffic, so a new set rolls out node by node; (f) the matrix in CI.

**Step 11 in detail — chat's screens as a chunk (built; measured 2026-11-03).** The seven screens (channel, inbox,
questions, search, saved, drafts, unreads) and what only they reach — the composer, the feed, messages and threads —
are re-exported by `features/chat/chat.ts`, which only `features/chat/load.tsx` imports, with `import()`: one chunk,
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
The repo's own cold-load test stops at the frame, which chat's chunk does not gate, so the first-row timer was a
temporary spec, not kept.

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
