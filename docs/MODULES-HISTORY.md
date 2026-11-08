# Purlay — How the modules were built (`MODULES-HISTORY.md`)

> Authority: none. This is the record of how `MODULES.md` §10's steps were carried out: what was measured, in what order, and what was
> left alone and why. It is kept because the numbers and the reasons are evidence, and moved out of `MODULES.md` so that the rulebook
> says what the rule is, what holds it and one example, and nothing that happened once. A rule is never stated only here. Section
> numbers in the text below are those of `MODULES.md`; the figures are as measured on the date given and are not kept current.

---

## Steps 6–12, in detail

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
   inbox waited for a second writer, and issues is one: it is a store of its own beside chat's, decided in D-283 §4 and **built** in D-286 (step 14f);
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

**What is left of step 9 and step 10, measured on `main` after the move.** Nothing in the core imports chat, but some
files of the core still named its tables (eleven at the time). Each is an edge with its own inversion, in this order, each its own pull
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
   core's tests are left out, as the lint leaves them. Its allow-list may only shrink (§8 names the files on it today, and `stated-numbers.test.ts` holds the list and its cap to that sentence). It is a test
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

**Followed conversations (D-290).** Chat also owns `GET /api/workspaces/:workspaceId/followed-threads`, its private
follow-list cache family and `/w/:slug/followed`, reached from the channel sidebar and palette. The screen is a nested
lazy import under chat's existing module gate, preserving the measured chat entry budget. The SQL reader reuses
`thread_follows`, participation, the canonical visibility guard and D-282 receipt scopes; it adds no migration.

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
reverted; the helpers that merely live in chat folders (`palette/channels`, `composer/outbox`,
`channel/feed-ports`) save no bytes when moved and stay (`messages/author` moved to `lib/author`, which is not chat's). The shape check therefore names the screens and the
heavy modules, not every chat-named file; a module with a larger share of its code in the shell would earn the
second chunk.


## Measurements behind the rules of §7

**Why the starvation factor is eight (§7, `budget:latency`).** With the budget a busy issues module cost chat **two to four times** its
p95 on a two-core shared CI runner and about the same locally under six busy loops (1.1 to 1.5 times), and with the budget removed the same
scenario cost 18 to 23 times on a laptop (727–774 ms against 33–39 ms). That a CI runner without the budget is at least as bad was expected,
not measured. So a busy issues module still costs chat up to about three times its p95 on a two-core shared host: database backends and CPU
contention, which the share of the pool does not remove.

**Issues' hot path in the same gate.** Measured locally, with chat's budget as it is, the list answered in **4 to 12 ms** (p95, nobody
refused; 9 to 22 ms with the machine at twice its cores in load); with chat's share made all but the whole pool it took **753 to 781 ms**,
which the gate fails. The gate takes about fifteen seconds more: 68 s before, 77 to 80 s after, on a laptop.

**What the deadline and the share cost a scheduled job (§7, D-274).** Measured on `purge:retention` over 3 000 workspaces, eight alternating runs
each of the command before and after: medians 3 940 and 3 824 ms, fastest 3 084 and 3 165 ms, which is within the noise of a shared machine.

## Chat's data notes

**Channel groups (D-284).** Chat's personal channel headings and placements are in `channel_groups` and `channel_group_channels`, created by chat/0011 (D-284). Membership foreign keys clear private placement on leave, the user-erasure hook clears account state, and workspace purge removes headings. Workspace exports exclude both; personal exports include only the caller's rows, omitting the generated name key. The private tables are optional on older stopped-module schemas and do not change the module's original migration identity or export workspace context. No core column or table exception is added.
