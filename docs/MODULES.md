# Purlay — Modules (`MODULES.md`)

> Authority: `DECISIONS.md` D-250 is binding on *why*, D-255 on what was decided in practice; this file on *how a module is built,
> loaded, kept apart and removed*. It is the rulebook: for each rule, what it is and what holds it (§8), with the checklist a reviewer
> holds a module to (§9) and the words it uses (§12). To add a module, run the steps of `MODULE-GUIDE.md`. How it was built, and what was
> measured on the way, is in `MODULES-HISTORY.md`.
>
> **Status.** Built and held by tests, for chat and issues: the manifest and registry, `MODULES`, isolation by budget (§7), the data
> hooks, the matrix of cells (§8), the web registry, facts, the outbox, the inbox and the find, per-workspace grants (D-289, D-292) and
> `module:new` (D-294). **Not built, each with what would start it: the table at the end of §10** (D-295). A line marked **built** in
> §8 or §10 is; one not marked is intent.

---

## 1. What a module is

A unit of product — chat, issues, notes, mail — that registers with the core and can be turned off. The
**core** (identity, workspaces and tenancy, permissions, audit, the domain event bus, attachments, the erasure and
export catalogues, the registry) knows no module by name. Chat's own notifications and its search of messages are
chat's: the `notifications` table is bound to a message and a channel, and stays chat's. What the core holds is the kinds
and sources a manifest declares (§2, `notifications` and `searchSources`), a search that asks every running module's source,
which is the core's mechanism and not chat's (**built**, D-285, §10 step 14k), and a store for the notices of any module, the table
`inbox_entries` and the sink that writes it (D-283 §4, D-286, **built** in §10 step 14f).
One process and one PostgreSQL stay (D-7): a module is a folder, a set of migrations and a web feature, not
a service. Modules are first-party code in this repository; the manifest is not a trust boundary, and
loading a module from elsewhere is not supported (D-250 rule 2).

**Where they live.** A module is `apps/api/src/features/<id>` and `apps/web/src/features/<id>`. The existing
`apps/api/src/modules/` keeps its layered meaning (`ARCHITECTURE.md` §4) and shrinks as each module's files
move under `features/`. An id may not be a name the core owns: a path segment (`auth`, `workspaces`), the words the build uses for
no module and every module (`core`, `none`, `all`), a core service (`search`, `inbox`, `find`) or a core table
(`users`, `outbox`, `audit-log`). `RESERVED_MODULE_IDS` is the one list; the registry, `module:new` and the contract's `ModuleId`
refuse it, and `registry.test.ts` holds it to `API.md`, the folders of `modules/` and the schema's owners.

## 2. The manifest

`apps/api/src/platform/module-kit/` holds the manifest type and the registry — pure, with no I/O and no
environment, so a module can import it without pulling the platform in. It is a folder of `platform/`, not a
package: a package would add itself to the production image, the lockfile, the licence check and the pull
request rules for one consumer, and the lint keeps the folder as clean as a package would be. A module
declares:

- `id`, and `requires` (it will not start without them) and `optional` (used when present);
- `provides`: the capabilities it offers;
- `routes`: its HTTP routes as templates, **at the paths the contract already gives them** — no `/api/<id>` prefix is
  added, and the routes themselves are a plugin in the module's own folder, `features/<id>/http/` (a slot of the module, §3,
  D-280), so the manifest holds no HTTP type (`ARCHITECTURE.md` §4);
- `frames`: the client operations on the socket it owns; `events`: the server events its services send; `jobs`: the
  scheduled jobs that act for its users. A process that does not run the module closes all four (§3);
- `entitlement` (optional, D-289): `always` when no workspace's grant may take the module from it (chat, for now), `grant` (what a
  module that says nothing says) when the operator grants it to each workspace; `platform/module-kit/entitlement.ts` decides, from the
  process's modules, the workspace's `workspace_modules` rows and `WORKSPACE_MODULES`, which of them a workspace may use;
- `degrades` (**required**, D-291): for each `optional` partner, one sentence saying what the module does when that partner is
  not run, and for no other module; `{}` when it has no optional partner. The registry refuses a partner with no sentence, an
  empty one, a sentence for a module not listed `optional`, and a manifest that leaves the field out. The sentence has a case
  behind it: `testing/degradation.ts` runs the module's scenario (`features/<id>/degradation.testing.ts`, a `Degradation<typeof manifest>`
  with a key for each optional partner) on the build composed without the partner and without what requires it (§4);
- `budget` (**required**, D-260, D-266): its share of the connection pool, `{ poolShare: (poolMax) => limits }`, or
  `{ none: reason }`. A manifest without it does not compile, and the registry refuses one that has none at run time, a
  `none` with no reason and a share that leaves the module no connection or the others none (§7). Every bundled module
  has a share today; one that declares `none` must also be named, with its reason, in `module-budgets.test.ts`, so an
  exemption is a line a reviewer sees;
- `deadline` (optional, D-270): how long a request or frame of the module may take before it is answered `504` and its database
  work cancelled: `{ ms }` (a whole number from 1000 to 120000) or `{ none: reason }`, which `module-deadlines.test.ts` lists too;
  left out, 20 s (§7);
- `jobDeadline` (optional, D-274): how long one run of one of its `jobs` or `retention` may take before the run is cancelled and
  recorded as a failure: `{ ms }` (1000 to 3 600 000) or `{ none: reason }`; left out, ten minutes. `workerDeadline` (optional, D-281):
  the same for one iteration of one of its workers: `{ ms }` (1000 to 3 600 000) or `{ none: reason }`; left out, 60 s. Both lists of
  `none` are in `module-deadlines.test.ts` (§7);
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
  that does not run the module lists none of them (`composition.searchSources`), and the slot supplies each one under the same id
  (`searchSources` of `BundledModule`, a `SearchSource` of `platform/ports/search-source.ts`; `compose` stops a build where the ids
  differ). **Built** (D-285, steps 14k and 14l): the core's route `GET /api/workspaces/:workspaceId/find` asks the source of every
  module that runs, at once, each as its own module (its share of the pool, an abort signal) under a deadline of 1.5 s or the
  module's own if shorter, and answers a group for each source and a `skipped` list (`off`, `slow`, `error`); chat's own search
  stays as it is.

That is the whole manifest today (`module-kit/manifest.ts`): a field is added in the step that reads it. **Built in step 14b
(D-283 §3), with nothing yet publishing, consuming or using:** `publishes` (the fact types the module owns, each named
`<id>.<what>` and declared in `@purlay/types`), `consumes` (the fact types it handles, a publisher in the build or the core
for each, and a handler in the slot's `factConsumers`) and `uses` (the capabilities it asks, each provided by a module in its
`requires` or `optional`; the slot's `ports` is what a module implements of its `provides`). What a module
contributes besides is a slot of `BundledModule` in `composition.ts`, which the composition reads: `jobWork`, the work of
each job its manifest names under `jobs` or `retention` and of no other (a build where the names and the work differ does
not start; `bun run job` takes the work from the composition and names no module, D-260),
`userErased`, `workspacePurge`, `export`, `personalExport` (the **data** hooks: the erasure of a person, D-139, the tables
of an export, D-140, and what a purge takes), `workspaceCreated`, `workspaceChannels`, `readAttachment`, `pushNotices`
`noticeWords` (what a push says of each kind of notice the manifest declares `pushed`, in the person's language, D-286 §9)
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
5. Compose: `compose` (`composition.ts`) takes the manifests and the slots of the modules the process runs and makes what
   the core leaves open (hook lists, the purge, the catalogues, the permissions, the closed questions), once, for the life
   of the process. There is no `register` call a module makes into the core, and no run-time question about a capability
   (decided against, §4): a module is handed the ports of the modules that run, and `undefined` for one that does not.
6. Register the routes, then report ready. Readiness is the node's, not a module's: a process that runs a module on a
   database without its migration set has pending migrations and is not ready (`readiness.ts`).

A failure in 4 or 5 is fatal at boot. A failure at runtime stays inside the module's error boundary and does
not take the core down (§7). **A disabled module's routes are registered all the same and gated by path.** The
application has one route table in every process, so a route table added to or left out per process would be a second thing
to test in every cell; so every route of the build is registered, and `closed()` (`composition.ts`, built from the
`routes` of the manifests of the modules not run) is asked before the rate limit and the session. The route-ownership
test (`ingress/http/route-ownership.test.ts`) holds the manifests' lists and the routes the application registers together, so a
route nobody owns, or one claimed by two, fails it.

**A module's HTTP is its folder** (D-280). `features/<id>/http/` holds the module's handlers and `routes.ts`, one function from
`ModuleRouteDependencies` (`ingress/http/module-routes.ts`) to an Elysia plugin at the paths of its manifest's `routes`, and the
slot of the module in `bundledModules` carries it as `routes`, beside `jobWork` and `frameHandlers`. `createApp` makes the plugin
of every **bundled** module and uses them in one `.use(moduleRoutes)`; it registers none of a module's paths and names no module,
so a module is added by its slot and not by an edit of the core's door, and the table is the same whether or not a module runs.
The application's hooks (the deadline's `wrap`, the edge, the closed-path check, the rate limit, the error handler) apply to a
plugin's routes as to the chain's. The aggregate type of the table is read by nobody: `createApp` returns `HttpApplication`, and
the web's types are the contract's (D-280 §4). **Both modules are built this way** (D-280, **built**): issues' four routes and chat's 97, in `features/issues/http/` and `features/chat/http/` (one file per resource, each exporting its plugin, joined in `routes.ts`), and `app.ts` registers none of a module's paths. What a plugin shares across its resources it makes once from the context (chat's `wiring.ts`: the limiters of GitHub's deliveries and calls, the workspaces GitHub told to wait, the count of deliveries in hand). **A route about a module's feature is the module's, wherever its path is:** `GET` and `PUT /api/me/missed-mail` are chat's (its manifest lists them, `features/chat/http/missed-mail.ts` registers them beside `POST /api/missed-mail/stop`), at the same public URL and with the same bytes on the wire; in a process without chat they answer the plain `404 ROUTE_NOT_FOUND` of any unknown path, and the web asks for them only where chat runs (D-280 §7). The effect is that a request for a closed path gets the plain
`404` of any unknown route, with the generic body and no code that says *disabled*, so what a closed route says is the
same as what an unknown path says (its status, for a caller with no session, is not: see below). A closed job exits `0` (`closedJob`), a closed frame is answered as an
operation nobody has (`closedFrame`), and a closed event is not delivered (`closedEvent`).

**A frame of a module that runs is served by the module** (D-276). The manifest's `frames` say which client operations
are the module's, and its slot of `BundledModule` supplies `frameHandlers`, one handler for each: `(context, frame)`,
where the frame is the contract's, already parsed, and the context is the connection's (`platform/frame-handlers.ts`:
who is speaking, the application's database whose connections are the module's share, the transaction boundary, the bus,
the clock, the user's write budget, and `reply` and `fail`, which stamp a frame as the router does). The router does what is
the same for every operation, in this order: counts the frame against the connection's budget, parses it, answers an
operation of a module this process does not run as one nobody has, and runs the handler inside its module's deadline and
share (D-270, D-266), answering what it throws with the frame's `refId`. A handler returns the frames for this connection
and publishes the rest to the bus; it never touches the socket. `PING` and `ACTIVE` are the router's own. A handler for an
operation the manifest does not name stops the build (`compose`). A module reaches what its handler needs beyond the
context by declaring a context of its own that extends it (chat's: `ChatFrameContext`), so it takes no more than it names.

**A workspace that is not granted a module is turned away as a path nobody has** (D-289). `requireWorkspaceMembership` is the one place
a `WorkspaceContext` is made, and it reads the workspace's `workspace_modules` rows in the statement that finds the membership. The
request carries how to judge them (`RequestScope.entitlements`: the composition's `effectiveModules` and a counter of refusals);
the module is the one the router noted for the route. A request of a module the workspace may not use is answered `ROUTE_NOT_FOUND`
with the body of `routeNotFound()`, the same value a closed route throws, so the two cannot differ; this is asked **after** the
membership, so a person who is not a member is told the workspace does not exist whatever its grants. The set rides on the context
(`context.modules`, `null` for a request made with no policy, such as a command, which is unrestricted) for what must not work it out
again. A module whose `entitlement` is `always` (chat) is in every workspace's set, and the registry refuses a module that is a grant
and declares `frames` or `events`, because the socket is closed per process and not per workspace: a downgrade could not close what
was open. A route that finds its workspace without a membership (a signed webhook) would have to ask the same function; no route of
a module that is a grant is one today, and `entitlement.integration.test.ts` fails the day one is. No cache: the read is one more
subselect of the statement that already runs, measured at 0.03 to 0.05 ms at the median and under 0.1 ms at the 95th percentile on
50 000 workspaces with three grants each (D-289 §5).

**What else asks the set.** The workspace-wide find asks the sources of the modules in `context.modules` only and answers the others `off`
(`modules/find/find.ts`); the inbox lists, counts and marks read the notices of the running modules the workspace may use, and keeps
the rest (`ingress/http/inbox.ts`); `GET /api/me`, `GET /api/workspaces` and the answer of an accepted invitation carry
`memberships[].modules`, which the web draws a workspace from (`useModules`, `WorkspaceScopeProvider`), falling back to the
server's list for a server that does not send it. A module that is a grant and declares `jobs` or `workers` stops the build
(`unguardedWorkProblem`, `composition.ts`): their work is not yet given the workspace's grant, so the first such module brings
the SQL form of the function with it, or says `always`. No module has ports or `ports.of` to ask it yet; the outbox asks it when it publishes and when it claims (D-288).

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

1. **Events.** A module publishes on the **domain bus** (`platform/domain-bus.ts`): typed, delivered *at most once, after
   commit* (D-35), nobody listening is not an error, a failing handler is logged with its module and cannot fail the
   publisher. It is a new in-process bus, distinct from the socket `EventBus` that fans frames out to connections. It is
   built and tested and **no module publishes or subscribes on it yet**. It carries hints, which may be lost; a fact that
   must not be is an outbox delivery, decided and **built** without a production publisher, below (D-283 §1, §2).
2. **A port the core defines**, only where two modules use it or a test needs the boundary. Built: `WorkspaceChannels` and
   `PushNotices`, each with a null object where the module is absent, and the slots of `BundledModule` (§2) that the core
   runs in its own transactions. Built: `SearchSource` (D-285) and `NotificationSink` (D-286, step 14f), interfaces in `platform/ports/` that the core
   implements or calls. `AttachmentOwner` is *not built and not decided*.
3. **Asking whether a capability exists** is a typed port that is `undefined` where the provider is not run, not a
   `capabilities.has` call (D-283 §3): `Composition.ports` holds the implementations of the modules that run and `Port<T>`
   (`platform/ports/ports.ts`) makes a caller say what absence means. **Built** (step 14b) as that skeleton, held by a fake module;
   no module provides or uses a capability yet, so `provides` of the two real ones is still a list of names nothing asks.

**Which interaction uses which (D-283 §1).** The rule is what the receiver must be told:

| The interaction | The mechanism | Built in step (§10) | State |
|---|---|---|---|
| A read whose answer shapes the caller's request (search sources, is this person in that channel) | a port call with a deadline and an abort signal; `undefined` where the provider is not run | 14b the contract, 14k the search | the contract skeleton and the search built (`SearchSource`, D-285); no port a module `uses` exists yet, so `Port<T>` is proven by a fake module only |
| A fact written to a row the core keeps, to a receiver that is always there (an assignment notice) | a port call inside the caller's transaction, announced after commit | 14f, 14h | the sink and its table built (14f), called by issues' assignment (14h, **built**) |
| An asynchronous effect on a receiver that may be absent or slow | a transactional outbox, one row for each (fact, consumer), for facts of human scale; never a fact for each message | 14c to 14e | the table and `publishFact` (14c), the claim, the delivery and the worker (14d), the sweep, the metrics and the overview line (14e) built (D-288) |
| A hint: a cache nudge, presence, "read again" | the domain bus or the socket's `EventBus`, which exist | — | built, with no module using it |

**What each step built (D-283, steps 14b to 14l).** The outbox is built ahead of a production consumer on the owner's decision: its first real
publisher is a product feature that is not decided (issues' link to a channel, D-254 §1), so it ships proven by a fake third module's
test and not by a consumer in the product. Each row below is a step of §10 step 14, and each is built (14b to 14l); what is not built is in the table at the end of §10, which is the one list of it.

- *The contract surface* — **built** (14b) as far as the names go: `FactDeclaration`, `defineFact` and the lists `CORE_FACTS` and
  `FACTS` in `@purlay/types` (a module's `<ID>_FACTS` joins `FACTS` when it has a fact), `platform/ports/` with `Port<T>`,
  `platform/fact-consumers.ts`, the manifest's `publishes`, `consumes` and `uses`, the slot's `factConsumers` and `ports`, and the
  refusals of §8. Nothing publishes, consumes or provides: the two real modules declare none of it. **Not built** of it: a scan
  holding a module to the ports its `uses` names, which comes with the first module that reads one. The shape of a
  delivery (a consumer is given the fact and the transaction it is delivered in, and says `done` or `skipped`) and the release
  snapshot's hold on `publishes` and `consumes`, with the three fields in the contract bundle's module structure, are **built** in
  14c (D-288); what runs a delivery is 14d.
- *The outbox* (14c to 14e): **built** (14c, D-288): the table `outbox`, `publishFact` in the publisher's transaction and the `absent`
  policy (`platform/outbox.ts`), and **built** (14d, D-288) the claim, the delivery (`platform/outbox-drain.ts`, which with the first
  are the only files that name the table) and the drain as a worker of the consuming module (`outbox:consume`, made by `compose` for a
  module with handlers, in its share and under its `workerDeadline`; a node claims only the (consumer, type, shape) it has a handler
  for, and checks a row against the schema of the shape it was written in and upgrades it with the declaration's reader of that shape, so a rolling deploy kills no fact; `module-compat.test.ts` holds that a new shape keeps the reader of the last release's). **Built** (14e): `sweep:outbox`, the gauges `purlay_outbox_pending`, `purlay_outbox_oldest_age_seconds` and `purlay_outbox_dead`, the counters
  `purlay_outbox_delivered_total`, `purlay_outbox_failures_total`, `purlay_outbox_dropped_total` and `purlay_outbox_refused_total`, and the line of the server's overview. At least once, no
  order, a delivery's database effects atomic with its mark. A workspace may have `OUTBOX_PENDING_MAX` facts waiting for one consumer: `publishFact` refuses the next with `FactBacklogFull` (D-288 §10), which a module either lets end its transaction or catches and answers for itself.
- *The inbox* (D-286). **Built:** 14f, `inbox_entries`, the `NotificationSink` port, the sink, `sweep:inbox` and the table's
  erasure, purge and export; 14g, the routes `inbox` and `inbox/read`, the sink's `announce` and the frame `INBOX_UPDATED`; 14h,
  issues' assignment notice; 14i, the push of a notice of a `pushed` kind, held while the person is in Deep Work or their quiet
  hours and sent when they end; 14j, the web's *Updates* section (a category of the inbox, loaded on its own) and the rail's dot
  for an unread update. **Not built:** an inbox for a server that runs no chat (the screen is chat's). Chat's
  `notifications` stays chat's and unmoved.
- *The search fan-out* (14k to 14m): **built** in 14k and 14l (D-285): the `SearchSource` port, the route `find`, a deadline and a
  `skipped` list (`off`, `slow`, `error`) and the sources of chat and issues. **Not built:** the web's groups (14m), and a metric
  of how long each source took and how many were skipped.

**Not built and not decided here, each with what would start it.** *`AttachmentOwner`*: the first module that is not chat to
attach a file. *Mail for a module's notice*: a kind declared `mailed: true`. *A system message from a module into a chat channel*
(the fact `core.system-message-requested` of the plan): the product feature that wants it. *The wire unions opened* (`Topic` taking
module prefixes, `ServerFrame` split per module, the old names kept as aliases for a release; D-250 open question b): a module
with an operation of its own or live data, and a native client checked first. What is built is that `NotificationType`,
`NEEDS_YOU` and the database's enum are held to the manifests' `notifications`, and each frame and event name to its owner
(`core-claims.test.ts`). *`register`*: not wanted; nothing registers at run time (D-283 §3).

A module imports `module-kit`, `platform` and `@purlay/types` and nothing from another module's folder.

**What a module does without an optional partner is a case, not a sentence (D-291).** `degrades` says it, and
`degradation.test.ts` makes a case, `<module> without <partner>`, for every optional edge of the build: the build composed
without the partner (and what requires it), the module's scenario run on it, a missing scenario or a scenario for no edge a
failure. The real build has no optional edge today, so the cases appear with the first one; the generator is proved on a fake
`notes` and `wiki` in `testing/degradation.test.ts`.

**A reference to another module's record is opaque and carries its label (D-291).** The referring module stores, in its own table,
`(module, type, id)` and the label the record had when it was linked; there is no foreign key to the other module (a key between
modules is already held by `module-foreign-keys.integration.test.ts`, and a read of the other's table does not compile, above). The
target being off, not entitled, deleted or hidden from the viewer is a view, "not available here", shown as the saved label in
plain text and never an error, and deleting the target never cascades. The resolver port and the wire type come with the first
module that links; the rule binds the table it writes.

**Reads are bounded the same way.** A module's functions take a handle typed with *its own tables and the
core's it names* — never the combined schema (`features/<id>/schema.ts`: `ModuleSchema`, derived from `TABLE_OWNERS`, so
there is no second list of who owns what) — and a query over any other table does not compile. The handle is a type over
the object every caller already passes, not a wrapper: nothing is checked at run time, and no caller changes (D-271). It
holds the builder API only: it does not tell a read of a core table from a write, and it does not see raw `sql`. A read
across modules goes through a port. The seams that are not ports yet are listed, each with why, and may only shrink: chat's
four writes of a core table (`CORE_WRITES` in `module-tables.test.ts`: a sent file is claimed by its message, a scheduled
message claims its upload, a message adds to the workspace's storage counter, missed mail moves the person's
`missed_mail_since`), and the files of `cli/` that seed or measure a demo and name chat's tables, the allow-list of `core-tables.test.ts` (§8:
`cli/demo-seed.ts` and `cli/budget-latency.ts`). Raw `sql` is the way round a typed handle, so a lint rule bans it in `features/`
(chat is exempt for now: its templates are almost all expression fragments, `count(*)::int`, `state_version + 1`, and a
scan of the text for a table another module owns is what polices them, D-271); a table is named only in the manifest's
`data` hooks, which receive an executor of the module's own. This is what makes "no foreign key between modules" mean more
than the schema: without it a module could `select` another's table and every rule above would hold on paper.

The bundled contract (`contract:bundle`) lists every known module: what a disabled module removes is its routes and
tables, not its types.

**The contract bundle's module structure (built, D-273).** `contract.json` carries `modules` (id, `requires`, `optional`, and
the routes, frames, events and notification types each owns), the owner of every endpoint (`module`) and of every server event
and client operation (`eventOwners`, `frameOwners`), `core` or a module id, all read from the manifests and `CORE_CLAIMS` by
`contract/module-structure.ts`; what neither claims fails the bundle's build. `MeResponse.modules` is `ModuleId[]`
(`@purlay/types`, `modules.ts`), and a manifest id the type lacks fails `contract/bundle.test.ts` and `assembleBundle`. So adding
a module is also adding its id to `ModuleId` (§9). The wire names are not namespaced: the owner maps give the grouping, `API.md`
§2 tells a client what to do with it, and nothing needs an alias.

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
  files that existed when this was decided always create chat's tables, inert where chat is off. The release before the first prefixed row
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
  `TABLE_OWNERS` (`ModuleSchema`, D-271). `bun run db:check` (`scripts/check-schema.sh`) migrates every set and regenerates
  `schema.ts`, failing on a difference with the committed copy; it does **not** migrate a module alone. That is
  `migration-cells.integration.test.ts`. **Built so far:** every cell migrates and adds only its own
  tables, and leaves every column of a core table, and every value of a core enum type, as it was except what
  `CORE_COLUMNS_A_SET_CHANGES` and `CORE_ENUMS_A_SET_CHANGES` declare, the latter as `set:type` so that only the named set may alter the named type (`migration-cells.integration.test.ts`); a generated `schema.ts` per module is not built, and D-271 declines it: what a module sees is derived.

### Columns of core tables that exist for a module

A table has one owner, and a column does not: chat's away, missed-mail marker and retention days, and
the credentials of its GitHub App, are columns of `users`, `workspace_members`, `workspaces` and `server_settings`, which are
the core's, because they were made before there were modules (D-275). They are **not moved**: a move is a migration on the
tables every request reads, and nobody has felt the cost of leaving them. They are **listed, capped and held**:

- `CORE_COLUMNS_FOR_A_MODULE` (`packages/db/src/table-owners.ts`) names each as `table.column` with the module and why, and
  the core's files that may name it (the route that sets it, the erasure that clears it, the export that lists it). Nine
  today. `core-columns.test.ts` fails when the list is not as long as its cap, when a file of the core names a listed column
  outside its entry, when another module names it, when an entry's file no longer names it, and when a module's migration
  adds a column to a core table (`migration-cells.integration.test.ts` holds the same against the database). **The list only
  shrinks**; raising the cap is a decision.
- **A new column of a core table for one module is not added.** The module makes a table of its own keyed by the core's row
  (`user_id`, `workspace_id`), its foreign key running module to core.
- **A listed column must move to such a table** when a second module wants it (it is then not one module's: it goes to the core
  with a port, or to a table of the module that owns the meaning), when a core file outside its entry needs it, when the
  module's set must change its type or constraint (a set may not change a core column), or when its owner feels the cost: a
  lock held on a hot table, a backfill, or a contribution the core cannot make without naming the module's words. It moves by
  expand and contract across releases, and the entry goes in the change that drops the column.
- `workspaces.storage_*` and `attachments.claimed_at` are not on the list: they are the attachments' own, the core's, which
  chat writes through its seams (`CORE_WRITES` in `module-tables.test.ts`).

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

**Where a module's code is, and what holds it (D-277).** A module's web UI is `apps/web/src/features/<id>/`, the folder that
holds its manifest: chat's screens, composer, feed, threads, sidebar, inbox, search and the rest are under `features/chat/`. What
the core, the setup wizard or another module also needs and is not the module's (who a message is by, `lib/author.ts`; the
chip input, the author picker and a group's face, `ui/`) lives in `ui/`, `lib/` or `data/`. Two rules, both about a
direction, held by a lint fence (`webFences`, `scripts/web-fences.mjs`, one block per folder that has a manifest) and by
`web-fences.test.ts`, which reads every import with the compiler's parser: **a module imports no other module**, and **the core
imports no module** except `modules/registry.ts` (the manifests, nothing else) and the files of
`CORE_IMPORTS_OF_MODULES`, each with its reason and capped by a number in the test, a list that only shrinks. Tests and
`testing/` may import a module. `budget:web` derives the files a module's chunk alone may carry from the folder, less what the
core is allowed to import and what that imports statically.

Chat's sidebar keeps its channel sections together in `channel-list.tsx` (`ChannelSections`) and loads personal headings and exposes its overlays through
`sidebar/deferred.ts`, still in the existing deferred chunk. Personal groups add no shell import: these entry points reduce the
core-import list from 24 to 20, without moving chat code into the core or introducing another lazy chunk (D-284).

`registry.test.tsx` holds every manifest to the router and to each other (and the audit actions of the core and the manifests to the wire's list, each once): a route the router does not know, a rail
entry for another module's route, a palette place that is not the module's own, a settings page or shortcut row placed
after something that is not there, and a manifest the registry does not list.

The session says which modules run: `GET /api/me`'s `modules`, not the public `GET /api/client`; so a module that is not run has no rail link, no palette entry, no shortcut, no section and no request, and its address is `NotFound`, as the server's is.

## 7. Isolation

Modules share a process, an event loop and a connection pool, so they are kept apart by **budget**:

What each module is held to, written from the manifests (`bun run docs:sync`; a hand edit fails `docs-sync.test.ts`):

<!-- generated:module-limits (bun run docs:sync) -->
| Module | Request or frame | Job run | Worker iteration | Pool share (pool of 10) |
| --- | --- | --- | --- | --- |
| `chat` | 20 s (default) | 10 min (default) | 1 min (default) | 7 of 10, queue 3 s, statement 30 s |
| `issues` | 8 s | 10 min (default) | 1 min (default) | 3 of 10, queue 1 s, statement 5 s |

A request deadline is declared from 1 s to 2 min, a job deadline from 1 s to 60 min; the pool's own statement limit is 30 s.
<!-- /generated:module-limits -->

In detail:

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
- **a share, a deadline and an error boundary for each scheduled job** (`modules/jobs/module-shares.ts`, D-274). The job
  command was the one door that took the raw database: nothing held a module's job to its share, nothing but the pool's
  thirty-second statement limit bounded its time, and the scheduler runs jobs one after another, so a job that hung held
  every job behind it. **A module's job now runs as a module's request does.** The command notes the run as its module's
  (`scheduledJobRunner`), so each connection its work takes is asked of the module's share and held to its statement limit,
  and the work is given the leased database as its only handle; `jobDeadline` in the manifest (`{ ms }` from 1000 to
  3 600 000, or `{ none: reason }`, which `module-deadlines.test.ts` lists, empty today; ten minutes when left out,
  `DEFAULT_JOB_DEADLINE_MS`) is how long one run may take, past which its signal aborts, the lease cancels the statement
  running (`pg_cancel_backend`, as for a request) and refuses the next, and the run is recorded as a failure, `job_runs`
  and `purlay_job_consecutive_failures` included, with the module's label on the log line. **A throw is the run's alone**:
  recorded, logged at `error` with the module, answered with the exit code the scheduler reads, and the connection and the
  slot are given back, so `jobs:first` goes on to the next job. The record of a run is written on the pool as it is, by the
  runner, so a job cut off at its deadline is still told as failed. **The core's own jobs stay on the core's connection**
  and have no deadline, as the core's routes have none: their bound is the statement limit, and a core job that hangs on
  the store still holds the scheduler. Each job is a process of its own with a pool of two (`cli/jobs.ts`), so the
  share holds what a job asks of its module's slots and limits and the deadline stops what it waits on; the pool's two
  connections were already all one job could take of the server's. The cost of the deadline on a job was measured (`MODULES-HISTORY.md`);
- **a share, a deadline and an error boundary for each background loop a module runs in the API process**
  (`modules/workers/module-workers.ts`, D-281). Chat's delivery of scheduled messages and of reminders ran on timers started
  by hand in `index.ts` over the raw database: no share, no deadline, no count of failures, and the entry was no door
  the seams test read. **A module now declares `workers` on its slot** (`BundledModule.workers`: a `name`, an
  `intervalMs` from 1 000 to 3 600 000 and the `work`, as `jobWork` is the work of a name in the manifest), and `compose`
  lists the workers of the modules this process runs, and of no other (`Composition.workers`), for `startWorkers` to start.
  A module that consumes facts is given one more it did not write, `outbox:consume` (`workersOf`, D-288 §8), so it has no loop of its own for them.
  **Each iteration runs as the module's own**: in a request scope that names the module and carries an abort signal, over the
  leased database as the work's only handle, and over **the same slots the application's requests take** (`index.ts` makes one
  `moduleConnections` and hands it to `createApp` as `moduleShares` and, leased, to the workers), so a module's loop and its
  requests together hold its share and no more. `workerDeadline` in the manifest (`{ ms }` from 1 000 to 3 600 000, or
  `{ none: reason }`, which `module-deadlines.test.ts` lists, empty today; a minute when left out,
  `DEFAULT_WORKER_DEADLINE_MS`) is how long one iteration may take, past which its signal aborts, the lease cancels the
  statement running and refuses the next. **A throw or a missed deadline is the iteration's alone**: logged at `error` with
  the module and the worker, counted in `purlay_worker_failures_total{module,worker}` (one series for each worker the build
  carries, made at zero, so the label set is closed by the manifests), and the next iteration comes an interval after the
  last one ended; one flight a worker, and the process goes on. On a crash or a shutdown the workers stop, and the pool is
  closed after the iterations in flight, which their deadlines bound. Idle, a worker costs a timer and the two statements it
  always did; the scheduler adds an abort controller, one timer cleared at the iteration's end and a slot taken and given back
  per iteration (D-281 has the numbers);
- *Built* (D-285, §10 step 14k): each search source of `find` runs as its own module, so in its share, under the abort signal of a
  deadline of 1.5 s or the module's own if shorter, and the response says which was skipped and why; there is no metric of it yet;
- the CI latency gate refuses **starvation**, and only that (`budget:latency`): after the quiet trials it runs
  two more with twelve people reading issues' list, one request at a time with a pause between, while the issues
  table is locked in turns, so that the readers hold their share of connections and there are more of them than
  the pool has. The lower of the two is compared with the quiet p95 of the same run, and chat is starved when it
  is **more than eight times** that (`STARVATION_FACTOR`, with the noise floor of the gate's other rule under it);
  a starved run is measured again once, and nobody answered is an error. Why eight, and what a busy issues module costs chat with and without the share, was measured and is in `MODULES-HISTORY.md`: it
  costs up to about three times chat's p95 on a two-core shared host (database backends and CPU contention, which the share of the
  pool does not remove), and that is not starvation and is not refused. **The other direction is built, in the same
  harness** (D-250 rule 6 asks for both): `HOT_PATHS` in `cli/budget-latency.ts` says, for each bundled module, how its
  hot path is timed and how the module is made busy, or why it has none. Chat's is the send above; **issues' is the list of a
  workspace's issues through its route** (`GET /api/workspaces/:id/issues`, fifty issues, sixty reads a trial), timed while twelve
  people send messages one at a time with a pause between, more than chat's share of connections, while `messages` is locked in
  turns, so that chat holds all of its share throughout. It is judged as the quiet trials are (D-267): the lowest of three
  independent processes' p95 against the number recorded for it in the baseline file (`loaded`, `issues/list`), failing past
  the factor of 1.5, 10 ms and 20 ms, measured again once (D-227); a baseline from before it existed is not compared and the
  run records one. A module added
  without a line in the table fails `budget-latency.test.ts`, and one with no hot path is a line there with its reason
  (empty today), as for `module-budgets.test.ts`; the gate takes about fifteen seconds more. **Not measured:** the CPU and the
  event loop. They are shared by every module in a process, so a module that serves a great many requests, or heavy ones, can
  still slow chat's sends and issues' list, budget or no budget (an unpaced reader of issues' list, three hundred requests a
  second, tripled chat's p95 on a laptop): the share is of the pool, and the gate catches what the pool's connections cost;
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

**What "mutation" means in the column below.** A mutation is *applied* — the guard removed, the tests run, a failure
required — at two times, and only then is a claim that it holds a rule more than a claim. Every pull request that adds or
changes an entry of `scripts/mutations/` runs exactly those entries (`ci.yml`'s `mutations-changed`, part of `verify`), so
an entry that no test fails on cannot merge. Every other entry is applied by the weekly run of the whole list
(`mutations.yml`, not a required check), which turns red and opens one tracking issue on a survivor or a stale entry. Between
the two, a test weakened by a pull request that touches no entry is seen at the next weekly run, not on the pull
request; `mutations.test.ts` on every `verify` only proves each entry still applies once and names tests that exist.
The full or weekly run retains an existing declared equivalent with its recorded reason; the changed-entry job
requires every selected entry to be caught, even if it declares equivalence.

| Rule | Held by | Built in |
|---|---|---|
| No import between modules | lint, found per folder under `features/` and shown by `verify:enforcement` | 1 |
| No web import between modules; the core imports a module only through the registry | the lint (`webFences`, a block for each folder under `apps/web/src/features/` with a manifest, the core and the registry) and `web-fences.test.ts`, which reads each import with the compiler's parser and holds the core's imports of a module to `CORE_IMPORTS_OF_MODULES`, a list with a reason for each entry that only shrinks, capped by a number in the test — **built** (D-277); mutations `web-fence-lets-a-module-import-another`, `web-fence-lets-the-core-import-an-unlisted-file`, `web-fence-keeps-a-stale-entry`, `web-fence-registry-may-import-past-a-manifest` and `web-closure-follows-lazy-imports` | 11 |
| The core imports no module | the same lint, on `modules/` and `platform/` | 1 |
| The core's modules import none of chat's | the lint that keeps `modules/` and `platform/` from importing a feature, now that chat is `features/chat`; the core's tests may — **built** | 9 |
| The core names none of chat's tables | `core-tables.test.ts`, reading the tables from `TABLE_OWNERS` and scanning `modules/`, `platform/` and the doors (`cli/`, `ingress/`, `realtime/`), with an allow-list that may only shrink — today `cli/demo-seed.ts` and `cli/budget-latency.ts`, held to `MAX_ALLOWED` so that a file joins only with the cap raised in the same diff — and the mutations `core-sweep-names-a-chat-table` and `door-names-a-chat-table` — **built** | 10 |
| No raw `sql` in a module | the lint, found per folder under `features/` and shown by `verify:enforcement` — **built**; chat is the exemption, and is policed by the text scan below, not ended (D-271) | 5 |
| A module's raw `sql` and string-named tables name only its own tables and the core tables it reads | `module-tables.test.ts`, for every folder under `features/` (found, not listed): the tables from `TABLE_OWNERS` and `features/<id>/schema.ts`'s `CORE_READS`, a template's `from`, `join`, `into`, `update`, a column written `table.column`, `tableExists`, `Database['table']`, with comments stripped; a module with no `schema.ts` fails; a write of a core table is held to `CORE_WRITES`, which only shrinks and is capped (`MAX_CORE_WRITES`, raised only in the change that adds a write); and the lint, which bans `sql.raw`, `sql.table`, `sql.id` and `sql.lit` in every feature (they build a name at run time) — **built** (D-271), as far as a scan for a literal sees; mutations `module-tables-scan-ignores-sql-templates`, `module-tables-scan-allows-every-owner` and `module-tables-core-writes-not-held-to-list` | 9 |
| A module takes its typed handle and not the whole database's executor | the lint: `Executor`, `Transaction`, `Database` and `DB` from `@purlay/db` are refused in every feature, found per folder under `features/`, not in tests; shown by `verify:enforcement`, with chat's file as one of its cases — **built** (D-271) | 9 |
| No read of another module's tables | the typed handle (`ModuleSchema`, `features/<id>/schema.ts`): a module's functions take it, and a query over a table that is neither the module's nor named in the schema does not compile; `module-db.test.ts` asks the compiler about it, in both directions of assignability — **built** (D-271) for both modules: issues and every file of chat take `IssuesDb`/`IssuesTx` and `ChatDb`/`ChatTx`, and the lint above keeps it so; the mutations `module-schema-ignores-ownership` and `module-schema-forgets-core-reads` | 9 |
| Every table has one owner; no foreign key across owners | the ownership list and its test, a ratchet that only shrinks | 2 |
| Chat's pagination and message reader are not the core's helpers | moved to `platform/`; a count of cross-imports that only falls | 5 |
| Modules tell one another what happened without importing each other | `platform/domain-bus.ts`: typed events, at most once, a failing handler logged with its module and unable to fail the publisher, `domain-bus.test.ts` — **built**, with no module publishing on it yet | 5 |
| A fact is not lost between commit and publish | **decided** (D-283 §2, D-288), **built** (14c, 14d): an outbox row written in the publisher's transaction, rolled back with it, refused when its payload does not fit, its publisher is not the fact's owner or it is not given a transaction (`outbox.integration.test.ts`); claimed with `FOR UPDATE SKIP LOCKED` and delivered in the consumer's own transaction with its mark (`outbox-drain.integration.test.ts`: two drainers on two pools run each fact once, a node that fails between the handler and the mark leaves no effect, attempts counted at the claim reach the ceiling, an older node leaves the type and the shape it does not know, a newer node delivers an older node's shape upgraded); mutations `outbox-claim-without-skip-locked`, `outbox-attempts-not-counted-at-claim`, `outbox-claim-ignores-the-type`, `outbox-claim-ignores-the-shape`, `outbox-delivery-checks-the-current-shape`, `module-compat-ignores-a-shape-no-longer-read`, `outbox-failure-effect-survives` and the rest of `outbox-*` and `publish-*` | 14c, 14d |
| A module publishes only a fact type named for it that no other owner has, consumes only a type the build publishes and has its handler, and uses only a capability a partner it requires or lists as optional provides | **built** (D-283 §3, step 14b), with nothing yet publishing: the registry refuses a type two modules publish or the core owns, a name without its owner's prefix, a consumed type nothing publishes and a `uses` that nothing provides or that a module neither required nor optional provides (`communication.test.ts`); `compose` refuses a consumed type with no handler, a handler for an unnamed type, a `provides` with no implementation and an implementation with no `provides` (`module-communication.test.ts`), and offers a module's ports only while it runs; `fact-owners.test.ts` and `facts.test.ts` hold the declarations to their owners and to the manifests; mutations `registry-accepts-a-fact-two-modules-publish`, `registry-accepts-a-fact-without-its-owners-prefix`, `registry-accepts-a-consumer-of-an-unpublished-fact`, `registry-accepts-a-use-of-a-capability-nothing-provides`, `registry-accepts-a-use-of-a-capability-no-partner-provides`, `composition-accepts-a-consumed-fact-with-no-handler`, `composition-accepts-a-handler-for-an-unnamed-fact`, `composition-accepts-a-provided-capability-with-no-port`, `composition-accepts-a-port-nothing-provides`, `composition-offers-the-ports-of-modules-that-are-off`, `fact-owners-accepts-a-fact-declared-twice`, `fact-owners-accepts-a-fact-without-its-owners-prefix` and `fact-owners-accepts-an-owner-nobody-is`. **Not built:** a module's reading only the ports its `uses` names (the release snapshot holds `publishes` and `consumes`, `compatibility.ts`, but not `uses`; see §4) | 14b |
| A module reads no port it does not use | **decided** (D-283 §3), **not built**: a scan of a module's source, as `module-emissions.test.ts` reads events, when the first module reads a port | — |
| A module writes no `outbox` row but through the core's files | **built** (D-288, step 14c): `core-tables.test.ts` reads every file of the core but the table's own for the name, a module's typed handle does not hold the table, and publishing takes a transaction and not the pool, which `publishFact` checks at run time; mutation `module-writes-the-outbox-directly` | 14c |
| A module writes no `inbox_entries` row but through the sink | **built** (D-286 §4, step 14f): `core-tables.test.ts` fails for a file of a module that names the table, and a module's typed handle does not hold it; mutation `module-names-the-inbox-table` | 14f |
| A notice is for a current member who is not the actor, of a kind the calling module declares (the sink is bound to its module, D-286 §11), in the caller's transaction; the inbox keeps what the rules say | **built** (D-286 §3, §5, step 14f): `sink.integration.test.ts` (a kind no running module declares, a member of another workspace, one who left, an erased account, the actor, telling again, a rollback, a notice that is not short and plain, Unicode and markup as plain data) and `sweep.integration.test.ts` (30 days read, 180 days all, a backlog over a batch); `table-lifecycle.integration.test.ts` holds the erasure and the sweep to `TABLE_LIFECYCLE`; mutations `sink-accepts-an-undeclared-kind`, `sink-writes-a-kind-another-module-declares`, `sink-notifies-a-non-member`, `sink-notifies-the-actor`, `sink-takes-the-module-from-the-caller`, `sink-skips-the-params-check`, `sink-adds-a-second-unread-notice`, `sweep-inbox-keeps-what-was-read-long-ago`, `sweep-inbox-keeps-the-oldest` | 14f |
| The inbox lists, counts and reads only the notices of modules that run, of the caller's own, in the workspace asked for | **built** (D-286 §6, step 14g): `inbox.integration.test.ts` and `ingress/http/inbox.integration.test.ts` (a module that is off, another person, another workspace, a stranger and a signed-out caller, refused queries and bodies, pages of zero, one, a page and a page and one, the other tabs told once); the cross-tenant and endpoint harnesses hold both routes; mutations `inbox-count-includes-modules-that-are-off`, `inbox-list-crosses-people`, `inbox-list-crosses-workspaces`, `inbox-list-includes-modules-that-are-off`, `inbox-read-crosses-people`, `inbox-read-crosses-workspaces`, `inbox-read-reads-modules-that-are-off`, `inbox-list-skips-the-membership`, `inbox-routes-count-modules-that-are-not-run` | 14g |
| A search asks only the sources of modules that run, each as its own module and under a deadline, and shows only what the caller may read of the workspace | **built** (D-285, steps 14k and 14l): `compose` stops a build whose manifests and slots disagree on a source (`module-communication.test.ts`); `find.integration.test.ts` of the route, of the fan-out with a fake third module's source (off and never asked, slow and cancelled while the others answer, a throw, a limit) and of issues' source; the cross-tenant and channel-visibility matrices drive the route as a read that spans channels; mutations `composition-accepts-a-listed-search-source-with-nothing-behind-it`, `composition-accepts-a-search-source-its-manifest-does-not-list`, `composition-asks-the-find-of-sources-that-are-off`, `composition-reports-the-sources-that-run-as-off`, `find-answers-more-than-the-limit`, `find-error-aborts-the-find`, `find-module-deadline-ignored`, `find-source-deadline-ignored`, `find-source-not-noted-as-its-module`, `find-source-signal-not-passed`, `chat-find-reads-the-channels-the-caller-cannot-see`, `issues-find-forgets-its-workspace-filter`, `issues-find-keeps-a-duplicate`, `issues-find-matches-a-pattern`, `issues-find-skips-the-body` and `issues-find-skips-the-fold` | 14k, 14l |
| A module cannot starve the others of connections | the application's one database is leased (`leasingExecutor`, `@purlay/db`) by the share of the module a request belongs to (`moduleConnections`, `platform/module-budget.ts`): a cap on the requests holding a connection, a queue timeout and a `statement_timeout` per module, the modules together held to the pool less the core's reserve — **built, applied from each manifest's `budget`** (issues a third of the pool, chat seven of ten); `features/issues/http/budget.integration.test.ts` and `ingress/http/chat-budget.integration.test.ts` (§9 item 4) fill a share on a pool of their own and find the other module and the core answered, `module-budget.integration.test.ts` and `leasing.integration.test.ts` hold the lease, and the mutations `module-routes-not-noted-as-their-module`, `frames-not-noted-as-their-module`, `application-database-not-leased`, `module-share-ignores-core-reserve`, `membership-read-inside-a-module-share` and `module-budget-declaration-ignored` hold the wiring | 5 |
| A module's handler cannot take the pool without its module's share | there is no other handle: `app.ts` uses the database it was given once, to lease it, and no feature or door opens a pool (`module-seams.test.ts`); the mutation `application-hands-handlers-a-raw-database` — **built** (D-266) | 12 |
| A module's request or frame that runs past its deadline is answered and its database work cancelled; a throw in one handler is that request's | `deadline` in the manifest (`request-deadline.ts`): the framework's `wrap` around a module's request, `routeFrame` around its frames, the lease's signal cancelling the statement — **built** (D-270); `deadline.integration.test.ts` (a request waiting on a lock, over `handle` and a started server, the statement gone from `pg_stat_activity`; a handler that throws, the share of one connection still whole), `router.test.ts`, `leasing.integration.test.ts`, `module-deadlines.test.ts`, `registry.test.ts`; mutations `module-requests-have-no-deadline`, `deadline-signal-not-on-the-request`, `deadline-does-not-cancel-the-statement`, `lease-takes-a-connection-past-the-deadline`, `frame-deadline-ignored`, `registry-accepts-any-deadline` and `registry-accepts-a-deadline-none-without-a-reason` | 12 |
| Every module says what it may take of the pool, or says `none` and why | `budget` is a required field of `ModuleManifest`: a manifest without it does not compile (`@ts-expect-error` in `registry.test.ts` and `composition.test.ts`), and the registry refuses at run time a missing one, a `none` with no reason and a share that gives the module no connection or leaves the others none, in a pool of one to a hundred; a `none` is a line of `module-budgets.test.ts`, and `composition.test.ts` holds that no share takes every connection the modules may share — **built** (D-260, D-266, D-269); mutations `chat-declares-no-budget`, `issues-declares-no-budget-unlisted`, `registry-accepts-a-module-without-a-budget`, `registry-accepts-a-budget-none-without-a-reason` and `registry-accepts-a-share-of-the-whole-pool` | 12 |
| A module's purge and sweeps are run by the core's job command without the command naming it | `retention` and `jobs` in the manifest, `jobWork` in `BundledModule`: `compose` stops a build whose named jobs and supplied work differ either way, the registry counts a retention job among the jobs two modules may not both own, and `core-claims.test.ts` holds the command's own list to the core's — **built** (D-260); retention runs in every process and `jobs` only where the module runs (`composition.test.ts`, `cli/jobs.integration.test.ts`); mutations `composition-accepts-a-job-with-no-work`, `composition-accepts-work-no-manifest-names`, `composition-retention-work-only-of-running-modules`, `composition-retention-closed-with-its-module`, `registry-retention-jobs-not-claimed`, `job-command-drops-the-modules-work` | 12 |
| A module cannot forge a `WorkspaceContext`, take a name the core owns, or load code round the import fences | **built** (D-250 rule 10): `assertMinted` in the notice sink, the fact publisher and the find (`tenancy.integration.test.ts`, `sink.integration.test.ts`, `module-publish.integration.test.ts`, `find.integration.test.ts`); `RESERVED_MODULE_IDS` in the registry, `module:new` and the contract bundle (`registry.test.ts`, `module-new.test.ts`, `bundle.test.ts`); the lint on `import()`, `require`, paths into `packages/`, aliases of `sql` and `as never` (`verify:enforcement`), read again from the text by `module-seams.test.ts` and `module-tables.test.ts`; mutations `workspace-context-copy-accepted`, `notification-sink-trusts-any-context`, `fact-publisher-trusts-any-context`, `find-trusts-any-context`, `module-reserved-core-areas`, `module-reserved-core-tables`, `module-reserved-core-words`, `contract-accepts-a-reserved-module-id`, `module-new-help-not-recognised`, `module-seams-scan-misses-dynamic-import`, `module-tables-scan-misses-built-names` and `feature-fences-skip-bypass-patterns` | — |
| `cli/`, `ingress/` and `realtime/` name a module's files only in its route handlers and the composition root | `module-seams.test.ts`: the process entry `index.ts` is read as a door and imports no feature, `cli/` imports no feature but `erase-content.ts`'s one, `ingress/` only the files listed for the feature they serve and `ingress/http/app.ts`, `realtime/` none (chat's socket operations are `frameHandlers` of its slot, D-276); a list that only shrinks, as `core-tables.test.ts`'s is — **built** (D-260); mutations `job-command-names-a-chat-file`, `ingress-file-names-a-chat-file` and `realtime-file-names-a-chat-file` and `boot-entry-names-a-feature`. What is left in the list is the real remainder of the core's doors: `releases.ts`, the socket's presence and `erase-content` (three entries, and the cap is three). A module whose HTTP is in its folder (both today, D-280) is in no list, and `route-ownership.test.ts` fails for a module that has routes and supplies no plugin, for a path of a module registered in `app.ts`, and for a path its plugin registers that its manifest does not own (mutations `issues-routes-slot-dropped`, `chat-routes-slot-dropped`, `chat-routes-leave-out-a-resource`, `issues-route-outside-its-manifest`, `application-leaves-out-the-modules-routes`); the lint holds the folder: `features/<id>/http/` may import the framework and the door's helpers and not the socket door, `ingress/http/app` or the composition (`feature-fences.mjs`, mutation `module-http-folder-keeps-the-transport-fence`); the rest of a feature's code may import none of them or the composition either, and its tests may import the composition (D-286 §11, mutation `module-code-may-import-the-composition`) | 12 |
| A module's background loop runs in its module's share, against its deadline, and a failure of one iteration is that iteration's | `workers` in `BundledModule` and `workerDeadline` in the manifest: `compose` lists the workers of the modules that run and stops a build with a repeated name or an interval outside a second to an hour, `startWorkers` runs each iteration in the module's scope over the leased database and the application's own slots, and cancels, logs and counts what throws or overruns (`module-workers.test.ts`, `module-workers.integration.test.ts`, `composition.test.ts`, `module-seams.test.ts` for what `index.ts` hands them) — **built** (D-281); mutations `worker-deadline-ignored`, `worker-deadline-signal-not-passed`, `worker-failure-not-counted`, `worker-failure-stops-the-loop`, `worker-not-noted-as-its-module`, `composition-workers-of-modules-not-run-started`, `application-ignores-the-shares-it-is-given`, `boot-workers-on-the-raw-database` | 12 |
| A client survives a frame it does not know; a module catches up after reconnect | a client test (D-82) — **built** for the first half; the manifest's replay hook is **not built** (design intent, D-272) | 4 |
| The core's own list names no module (channel visibility, erasure, export entries are chat's) | a test of `platform/` against the manifests | 9 |
| Module id is not a core path segment | the registry, when the build's modules are checked, and a test holding the list to `API.md` | 1 |
| A bundle has no cycle, repeat or double capability, and no two modules (nor a module and the core, `core-claims.ts`) own the same route template (a subtree or a named segment overlapping another's counts), job, socket operation or server event | the registry, and mutations in `scripts/mutations/` | 1 |
| `MODULES` is valid | `resolve`, at boot: a process that cannot parse it logs `MODULES cannot be run; exiting` with every problem and exits `1` (`registry.test.ts`, `migrate-on-start.integration.test.ts`) — **built** | 12 |
| The matrix exists as soon as two cells differ | the cells the tests build (below) and, on a started process, CI's `modules` job (`bun run modules:smoke`): one migrated database and one API per cell, the cells made from the bundle — **built**; and the suites that belong to no module, once per cell (`bun run modules:suites`, below) — **built** | 9 |
| Disabled ⇒ `404`, no distinct body | `modules-off*.integration.test.ts` (routes, socket, presence, per cell), the route-ownership test, `modules:smoke` (every path every manifest claims, every method, signed out, on a real process per cell: a module left out answers byte for byte what an unknown path does, a module that runs answers something else), and `test:modules-none`, a browser spec run in the browser job, which takes the paths it holds closed from the manifests' `routes` — **built**; and every suite that needs no module, run in each cell with the application that cell starts (`modules:suites`) | 12 |
| Disabled ⇒ no tables | a test migrates the core alone, each set on the core and every set, and finds that a set adds only tables it owns (`migration-cells.integration.test.ts`) — **built**; and `modules:suites` runs the suites that need no module on a database that has only the cell's sets, so a suite that reaches for a table of a module that is off fails there | 12 |
| Disabling leaves erasure and export whole | the export catalogue test over manifests; an erasure test with a module off; every lifecycle step in each cell of database state × process, on real migrated databases (`module-lifecycle.integration.test.ts`), which also fails for a table a module owns that the seed leaves empty where its set is applied, unless the table is in `UNSEEDED`, a list that only shrinks and is capped (`MAX_UNSEEDED`; chat's tables with no probe yet are in it) — **built** | 10 |
| A table says what becomes of its rows on an account's erasure and how long they are kept | `TABLE_LIFECYCLE` over the schema (`packages/db/src/table-lifecycle.ts`): a table without the decision does not compile, and `table-lifecycle.test.ts` holds it to `TABLE_OWNERS` and spells out the tables erasure does not reach — **built** | 10 |
| A core migration keeps module schemas valid | `migration-cells.integration.test.ts` migrates each set on the core at head and `upgrade.integration.test.ts` migrates from the previous state by hand-written rows; and CI's `modules` job runs `bun run modules:upgrade` (`testing/module-upgrade.ts`): `packages/db` as the **last release tag** has it is extracted with `git archive`, its own migrator makes a database under each `MODULES` an operator could have kept (the cell's modules that release carried, and everything it carried), a copy of each is migrated to head under every cell of the matrix, and each must exit `0` and record the core's files and the cell's sets — an edited released migration fails it by checksum. `module-upgrade.integration.test.ts` runs the same on a release made from this tree less its newest migrations, and the mutations `upgrade-check-starts-from-an-empty-database` and `upgrade-check-migrates-the-core-alone` hold it — **built**. Not covered: a release that wrote rows (the check migrates the schema the release's migrator makes, empty, so a migration that fails only on data is `upgrade.integration.test.ts`'s and `migration-safety.test.ts`'s), and the tag's own dependencies (its migrator runs on the kysely and pg this tree installed) | 10 |
| One module set in a cluster; a rolling deploy still passes | each node's set in the shared Redis record (`realtime/module-set.ts`), a log line when nodes differ and nothing else, a two-process test with different sets; no bus channel per set, which would stop a sign-out reaching the other set's sockets — **built** | 12 |
| Optional never becomes required silently | `module-compat.test.ts` holds the manifests to the last release's, kept in `released-manifests.json` and rewritten by `bun run release` (`manifests:snapshot`): no new requirement, no capability, route, job, socket operation, retention job or published or consumed fact gone, no id changed, no change of `entitlement` (a module served to every workspace that becomes a grant, or the other way), and for a fact a fingerprint of the schema of each shape it writes or reads: a schema changed under the same `shape` (a new required field, a narrower bound, a value more in an enum) or a reader whose schema changed is a break, until the shape is raised and the old schema kept as its reader — unless a dated exception in that file says so. An added optional field changes the fingerprint too: it is excused by an exception, which the release clears. The release rewrites the fingerprints with the rest of the snapshot — **built** (mutations `module-compat-digest-depends-on-the-order-of-required`, `module-compat-ignores-a-changed-fact-schema`, `module-compat-ignores-a-changed-reader-schema`, `module-compat-ignores-a-dropped-retention-job`, `module-compat-ignores-an-entitlement-change`, `module-compat-ignores-a-shape-no-longer-read`) | 12 |
| Chat is not starved by a module | `budget:latency` runs the send path again with issues' readers holding their share of connections (the table locked, paced readers) and fails if chat's p95 is more than eight times the same run's quiet p95 — **built** in both directions (chat's sends while issues is busy, and issues' list while chat is saturated, which is judged on its own recorded number, D-267; CPU and event-loop share are not measured); it refuses starvation, not slowness: 2–4 times with the budget on a 2-core CI runner, 18–23 times without it on a laptop; a busy module's database and CPU use can still cost chat up to about three times its p95 on a shared host | 12 |
| Shell chunk holds no module code | `budget:web` reads the shell chunk's source map and fails if any file of a module's folder is in it (derived from the folder: less what the core may import and what that imports statically, `screenSources`; D-277), or its chunk is gone, or either is over its bound; the mutation `web-chat-screen-imported-statically` and `chat-chunk.test.ts` hold the import side — **built** for chat, and for issues, whose screen is a chunk of its own and whose marker the check looks for in the initial chunks | 11 |
| A module's code names no event or socket operation its manifest does not list | `module-emissions.test.ts` reads each bundled module's own source (its folder under `features/`, its `http/` included, and the files of `ingress/` that import it) for every `ServerFrame` event and `ClientFrame` operation written as a string literal and holds it to the module's `events` and `frames` or the core's (`core-claims.ts`); with `core-claims.test.ts`, which holds the lists to the schema (a name in the schema is the core's or exactly one module's), and the mutation `chat-sends-an-event-its-manifest-does-not-list` — **built**, as far as a scan for a literal sees: a name built at run time is not seen, and the events chat's services publish through the core's builders in `platform/events.ts` are named in the core's file, so only the schema test holds those | 12 |
| A suite that is about no module passes whichever modules run; one that needs a module says so | `bun run modules:suites` (CI's `module-suites` job): for each cell but the one with every module, the integration suites that need no module the cell lacks run on a database of only the cell's sets with `MODULES` set, which the harness reads (`@purlay/db`'s `testing.ts` migrates `setsNamedBy(MODULES)`, `testDependencies` composes `compositionFor(MODULES)`). What a suite needs is what it imports of `features/<id>/` (its own helpers included) and what it declares, `// @needs-modules chat` in the file or a helper, or `testNeeding('chat')(…)` for one test (`testing/module-needs.ts`, `testing/needs.ts`); `module-suites.test.ts` holds every declared id to the build's modules and leaves at least the suites that import nothing in every cell — **built**; mutations `harness-ignores-modules-for-the-schema` and `harness-composes-every-module` | 12 |
| Every audit action a module's code records is in its manifest, and every one its manifest lists is recorded | `audit-emissions.test.ts` reads each module's source (the same files, and the core's) as `module-emissions.test.ts` reads events', `core-claims.test.ts` holds the manifests' actions and the core's to the wire's `AUDIT_ACTIONS`, each once, the registry refuses an action two owners list and a reading permission that is another module's, and the composition's `auditAccess` judges every module the build carries — **built** (D-265); mutations `audit-trail-read-by-a-member`, `trail-shows-what-the-role-cannot-read`, `registry-accepts-an-audit-action-read-by-a-foreign-permission` and `chat-stops-declaring-its-audit-actions` | 12 |
| Every permission a module's code asks is in its manifest, and every one its manifest lists is asked | `permission-emissions.test.ts` reads each module's source (the same files, and the core's) as `module-emissions.test.ts` reads events', the registry refuses a permission not named for its module and one declared twice, and the composition's `permissions` have a module's own only while it runs — **built** (D-265); mutations `issues-delete-ignores-its-permission`, `issues-permission-asked-is-not-the-one-declared`, `composition-holds-the-permissions-of-a-module-that-is-not-run` and `registry-accepts-a-permission-not-named-for-its-module` | 12 |
| Every kind of notification and search source a module sends is declared, and the wire's and the database's lists are the declarations | `notification-kinds.test.ts` holds `NotificationType`, `NEEDS_YOU` and the database's enum to the manifests' kinds, each once; the registry refuses a kind or a source two modules both list; `composition.notificationKinds` and `composition.searchSources` have a module's only while it runs — **built** (D-265); mutations `chat-stops-declaring-its-notification-kinds`, `missed-mail-takes-every-pushed-kind`, `composition-queries-the-search-sources-of-modules-that-are-off` and `registry-lets-two-modules-send-one-notification-kind` | 12 |
| A workspace is served only the modules it is granted | `requireWorkspaceMembership` reads `workspace_modules` with the membership and turns a request of a module the workspace may not use away as `routeNotFound()`, after the membership; `effectiveModules` is the one function that decides; `entitlement.integration.test.ts` crosses every endpoint of a module that is a grant (read from `CROSS_TENANT`) against a process without the module, byte for byte with nothing written, and a stranger against every combination of grant and mode — **built** (D-289, the guard); mutations `entitlement-closure-ignores-requires`, `entitlement-expired-grant-still-counts`, `entitlement-managed-mode-treats-no-row-as-on`, `entitlement-off-row-is-ignored`, `membership-guard-ignores-entitlement`, `membership-guard-tells-a-stranger-the-module-is-off`, `membership-guard-reads-another-workspaces-grants`, `membership-guard-answers-a-missing-grant-differently`, `membership-guard-does-not-count-a-refusal` and `registry-accepts-a-grant-with-frames` | 12 |
| What asks several modules at once asks only those the workspace may use | `find` skips a source whose module is not in `context.modules` and says `off`; the inbox filters its modules by `entitledTo`; `GET /api/me`, `GET /api/workspaces` and an accepted invitation carry `memberships[].modules` and the web draws from it; the build refuses a grant with jobs or workers — **built** (D-289); `entitlement.integration.test.ts`, `rail.test.tsx`, `composition.test.ts`; mutations `find-asks-sources-of-modules-the-workspace-lacks`, `inbox-lists-entries-of-modules-the-workspace-lacks`, `inbox-reads-entries-of-modules-the-workspace-lacks`, `membership-list-omits-the-workspaces-modules`, `invitation-accept-forgets-the-workspaces-modules`, `workspace-list-forgets-the-grants`, `me-forgets-the-grants`, `web-draws-the-modules-the-server-runs-in-every-workspace` and `composition-lets-a-grant-run-unguarded-work` | 12 |
| Only the server administrator changes a workspace's grants, safely and on the trail | `applyEntitlements` (`modules/entitlements/apply.ts`) is the one writer: it refuses a module the build lacks, one that is `always`, an end that has passed, a workspace that is not there, and a grant whose requirement is missing, plans before it writes, makes a repeat a no-op and records `server.module_granted`, `server.module_withdrawn` or `server.module_reset` with `target_module` in the same transaction; the route is behind the administrator's guard before it parses — **built** (D-292); `modules/entitlements/apply.integration.test.ts` and `server.integration.test.ts`; mutations `entitlement-write-accepts-a-module-no-workspace-is-granted`, `entitlement-write-accepts-a-module-the-build-lacks`, `entitlement-write-accepts-an-end-that-has-passed`, `entitlement-write-accepts-module-without-its-requires`, `entitlement-write-records-a-repeat`, `workspace-modules-write-skips-audit` and `workspace-modules-writable-by-workspace-owner` | 12 |
| A module the administrator stopped is served as one that is not run, on every node, within two seconds, and nothing is deleted | `suspended_modules` is read by `suspensionCache` (`platform/suspended-modules.ts`): `SUSPENSION_TTL_MS`, one read at a time, the last set kept when a read fails, a local change not undone by an older read; a request reads it again when it is older (`onBeforeHandle`); the composition leaves a stopped module out of `closed`, `closedJob` (its `retention` jobs stay), `closedFrame`, `closedEvent`, `ports` and `effectiveModules`, which is what `find`, the inbox lists, `GET /api/me` and the guard consume; `composition.test.ts` crosses every route, job, operation and event of each module, and `suspension.integration.test.ts` every endpoint of each module against a process without it (signed in, a stranger, and nobody), with a change believed within the TTL — **built** (D-296; the administrator's route and command follow); the worker loop skips a stopped module's iterations, the sink writes nothing for it, the fact routing reads it as not run (so a fact follows its own `absent` word), `bun run job` reads the table once a run, and `GET /api/me`, `GET /api/client` and `purlay_module_suspended` tell what is stopped, each held by `suspension.integration.test.ts` or its own unit test; mutations `suspension-cache-*`, `suspension-client-capabilities-from-the-process-alone`, `suspension-composition-*`, `suspension-effective-set-ignores-the-stop`, `suspension-fact-routing-*`, `suspension-job-run-ignores-the-stop`, `suspension-me-lists-a-stopped-module`, `suspension-request-does-not-reread-the-stop`, `suspension-sink-*` and `suspension-worker-runs-while-stopped` | 12 |
| Only the server administrator stops a module, safely, with a reason and on the trail; a stop waits for the cluster | `applySuspension` (`modules/suspension/apply.ts`) is the one writer, behind the administrator's lock: it refuses a module the build lacks, a stop with no reason (1 to 200 characters), and a stop that takes a module that is always granted down (chat, or what it requires) unless `force` says it is meant; it answers the modules that stop with this one, writes nothing for a repeat and one entry of the trail for a change, with the reason as its `note`; `requireStopPeersReady` refuses `409 PEERS_BEHIND` while a live node of the module-set record has no live field in the record of the nodes that read the stops (`suspensionNodes`), or when that cannot be asked, and never for a resume; `apply.integration.test.ts` and `peers.test.ts` hold them — **built** (D-296; the route and the command that call them follow); mutations `suspension-resume-waits-for-the-cluster`, `suspension-stop-allowed-while-a-peer-is-behind` and `suspension-writer-*` | 12 |
| A restriction is not written while a node would not honour it | `requirePeersReady` (`modules/entitlements/peers.ts`) refuses `409 PEERS_BEHIND` a withdrawal, or the removal of a grant on a `managed` server, while a live node of the module-set record has no live field in the record of the nodes that read grants (`realtime/entitlement-peers.ts`, one Lua script on Redis's clock), and when Redis cannot say; renewal prunes expired capability fields left by crashed nodes, preserving live peers, so the record stays bounded across restarts; a server with no Redis is one node; the administrator's workspace list shows each workspace's grants and what they come to — **built** (D-292); `peers.test.ts`, `entitlement-peers.redis.integration.test.ts`, `server.integration.test.ts`; mutations `entitlement-restriction-ignores-the-cluster`, `entitlement-restriction-allowed-while-a-peer-is-behind`, `entitlement-restriction-guessed-when-the-cluster-cannot-be-asked`, `entitlement-peers-script-counts-nobody`, `entitlement-capability-keeps-expired-nodes` and `workspace-list-shows-a-row-that-has-run-out` | 12 |
| An edition file is applied whole or not at all, and again is the same | `readEditionFile` and `planEdition` (`modules/entitlements/edition.ts`) refuse a file, an edition, a module or a workspace they cannot use before anything is written; `applyEdition` runs the writes in one transaction through `applyEntitlements`, or makes and undoes it for `--dry-run`; the command (`cli/entitlements-apply.ts`) labels the rows `file:<name>` and, on a server with `REDIS_URL`, asks the operator to say `--cluster-ready` before it takes anything away — **built** (D-292); `edition.test.ts`, `edition.integration.test.ts`, `cli/entitlements-apply.integration.test.ts`; mutations `entitlements-apply-applies-a-file-with-a-problem`, `entitlements-apply-source-is-not-the-file`, `entitlement-dry-run-writes`, `entitlement-edition-grants-chat` and `entitlement-edition-leaves-a-module-out-unsaid`; the console's **Modules** dialog on each workspace of Settings → Server → Workspaces says `inherit`, `on` or `off` for each module and sends only what changed (`workspaces.test.tsx`; mutation `console-sends-modules-that-did-not-change`) | 12 |
| This file lists the manifests | a test of §11 against `bundledModules` (`module-listing.test.ts`) — **built** | 9 |
| Every optional partner has a sentence and a case | the registry refuses a partner with no `degrades` sentence, an empty one and a sentence for a module not `optional`; `degradation.test.ts` composes the build without the partner and runs the scenario of `features/<id>/degradation.testing.ts`, and fails for an edge with no scenario and a scenario with no edge — **built** (D-291). Not covered: a partner that runs but is not granted to the workspace is not exercised (§10); mutations `registry-accepts-an-optional-edge-without-degrades`, `degradation-gaps-ignore-an-edge-without-a-scenario` and `degradation-setting-keeps-what-requires-the-partner` | D-291 |
| A scheduled job and a worker are bounded | `jobDeadline` and `workerDeadline` are `{ ms }` within bounds or `{ none: reason }`, which `module-deadlines.test.ts` lists; the job command and the worker loop cancel at the deadline (`module-shares`, `module-workers`) — **built** (D-274, D-281); mutations `job-deadline-default-dropped`, `job-deadline-exemption-not-listed`, `job-deadline-ignored`, `job-deadline-longer-than-an-hour-accepted`, `job-deadline-statement-not-cancelled`, `worker-deadline-default-dropped`, `worker-deadline-ignored`, `worker-deadline-longer-than-an-hour-accepted`, `worker-deadline-signal-not-passed` and `composition-worker-deadline-of-manifest-ignored` | 12 |
| A module's hot path is measured against the others' load | `HOT_PATHS` in `cli/budget-latency.ts` has a line for every bundled module or `{ none: reason }` listed in `WITHOUT_A_HOT_PATH`; `budget-latency.test.ts` fails for a module with no line, for a `none` that is not listed and for one listed that has a path, and `budget:latency` times it — **built**; what the line measures is for a reviewer (§9); mutations `latency-hot-path-judged-against-nothing` and `latency-hot-path-table-skipped` | 12 |
| A migration is written for a table that has rows | `migration-safety.test.ts` reads the statements of each file after the baseline (`DATA.md` §5); the shipped files that break it are grandfathered with a reason and the list is capped. Not covered: the table's size, a table named through a variable in a `DO` block, `SET NOT NULL` and `ADD UNIQUE` — **built**; mutations `migration-guard-accepts-a-constraint-without-not-valid`, `migration-guard-baseline-moved-back`, `migration-guard-covers-a-swept-table`, `migration-guard-lets-an-index-build-in-the-transaction` and `migration-guard-sees-no-unbatched-update` | 5 |
| Every endpoint says what it answers for a workspace the caller is not in | the endpoints are read from `API.md` and each must have a case in `testing/cross-tenant.ts` or be among the unscoped with the reason; `cross-tenant.test.ts` fails for one in neither and `cross-tenant.integration.test.ts` runs the crossings, with every list proved to show a row of its own — **built**; mutation `cross-tenant-excuses-another-list` | 12 |
| The contract bundle lists the modules, what each owns and what it publishes, consumes and uses | `contract/bundle.test.ts` against the manifests: the module ids are `ModuleId`, routes overlap nowhere, a core claim is checked, and the digest is of the text a client reads — **built** (D-273); mutations `bundle-core-claims-not-checked`, `bundle-hides-what-a-module-consumes`, `bundle-hides-what-a-module-publishes`, `bundle-hides-what-a-module-uses`, `bundle-lists-no-modules`, `bundle-module-id-check-passes-a-stale-type`, `bundle-module-overlap-not-checked` and `bundle-route-overlap-only-when-equal` | D-273 |
| A module made by `module:new` passes every guard with no hand edit | `module-new.integration.test.ts` runs the generator twice on a copy of the repository (a module and one that consumes its fact) and then the compilers, the guards and the documents; `module-new.test.ts` holds every edit to its anchor; `scaffold-leftovers.test.ts` fails until each placeholder is filled; `module-guide.test.ts` holds the guide to the files, commands and example id — **built** (D-294); mutations `module-new-ignores-a-missing-anchor`, `module-new-skips-the-docs-row` and `module-new-skips-the-pool-share-test` | D-294 |
| A field of the manifest or a slot of a bundled module is described | `manifest-docs.test.ts` reads the names of `ModuleManifest` and `BundledModule` and fails for one that §2 and §12 do not name — **built**; mutation `module-manifest-section-forgets-a-field` | D-294 |
| The nodes of a cluster agree on `WORKSPACE_MODULES` | each node announces its mode with its set in the shared record, and a node that finds another mode says so once in the log (`the nodes of this cluster do not agree on WORKSPACE_MODULES`) and again when they agree; said, never acted on — **built** (D-289); `module-set.test.ts`; mutation `module-set-mode-mismatch-unsaid` | D-289 |

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
(`<n> suites need chat, which this cell does not run`). A new module adds its cells to the command and the suites that import it are its; a
suite that reaches a module by its routes or tables, and says nothing, fails in the cells without the module, in CI. Not covered: the
cell with every module is not run twice; a suite that needs *both* modules (the endpoint table, the export and purge catalogues, the
cross-tenant matrix, the permission table, which each walk every module's rows) runs only in the cell with everything, so what those say
about one module with the other off is not proven; the Redis suites run in each cell as the others do. The cost is the sum of the cells' runner time (measured at about ten minutes for three cells when it was built, a laptop and a CI leg alike); in CI each cell is a leg of its own job beside `schema`, so a pull request waits for the longest (chat's, about as long as `schema`). `module-suites.test.ts` holds the workflow's legs to the cells the build has.

Scratch databases, their templates and nested fixtures use `packages/db/src/scratch-databases.ts` for their final
identifier and connection URL. Short names stay unchanged; long names keep a UTF-8-safe prefix and a digest of the
whole logical name, so PostgreSQL cannot truncate away a run's unique suffix. Creation, connection and cleanup use
that same actual name. Clones of sources outside the throwaway CLI's existing ASCII alphabet use an opaque ASCII
identity; its cleanup guard is not widened. An allocation is recorded for cleanup only after `CREATE DATABASE` succeeds. The configured
source and any database already present are never claimed by a failed allocation (`scratch-databases.integration.test.ts`,
`scratch-ownership.integration.test.ts`).

## 9. Adding a module — the checklist

Written from what building issues (D-254) needed, in the order a change is made. Each item names the file or test
that fails if it is skipped; an item with no such thing is said to have none. `issues` is the worked example: read its
commit beside this list. **Start with `bun run module:new <id>`** (D-294, `MODULE-GUIDE.md`): it makes the folder, the migration set,
the types, the registry lines, the documents' rows, a decision skeleton and the starter mutations, and
`module-new.integration.test.ts` runs it on a copy of the repository and requires the compilers and the guards below to accept
the result with no hand edit. This list is what a reviewer holds the result to, and what is still the author's: the decision,
the removal threshold, the behaviour, the hot path of `HOT_PATHS`, and the web feature.

**1. Decide it.**

- Take the next D-number in `DECISIONS.md` (`### D-N.`; the document check refuses a gap, a repeat and a decision
  nothing else cites) and write the decision: what the module is, what it is **not** (D-254 §1 lists what issues left
  out, each a decision of its own), the table, who may do what, what happens to its data when it is off, and the cost
  of reversing it. A module is admitted only with this, a row and a section under §11 and a removal rule (D-250 rule 6), which the section states as a threshold or as `none, because …`.
- Add its row and its section to §11 below, the section with a `**Removal threshold.**` line. `module-listing.test.ts` fails
  for a bundled module without a row or a section, a row or section for one that is not bundled, and a section with no
  threshold line.

**2. The manifest** (`features/<id>/module.ts`, the object in `bundledModules` in `composition.ts`).

- `id`: lowercase letters, digits, hyphens, at most 32, and not a name the core owns (`RESERVED_MODULE_IDS`: a route
  segment, `core`, `none`, `all`, a core service or a core table; the registry, `module:new` and the contract refuse it,
  and tests hold the list to `API.md`, the folders of `modules/` and the schema's owners).
- `requires` (will not start without), `optional` (used when present; mutual optional partners are a cycle, one must be
  the one that knows the other), `provides` (capability names like `chat.post-system-message`). Say what a user sees for
  each absent partner in `degrades` (D-291), and write its scenario in `features/<id>/degradation.testing.ts`: `degradation.test.ts` fails for an edge without one. Promoting an `optional` to `requires` is a breaking change.
- `routes`: every path template the module owns, as the paths the contract gives (`:name` is a segment, a trailing `**`
  the rest). `route-ownership.test.ts` fails for a registered route no manifest claims or two claim.
- `frames`, `events`, `jobs`: the socket operations, the server events its services send, and the scheduled jobs that act
  for its users. **Each operation in `frames` is served by a handler in `frameHandlers` of the module's slot** (chat's:
  `features/chat/frames.ts`), typed by the contract's frame for that operation, and the router dispatches by ownership: a
  module's frame is added by its handler and never by an edit of `realtime/router.ts`; a name with no handler, or a handler
  for a name not listed, stops the build (`composition.test.ts`, `frame-handlers.test.ts`). An operation is a name of `ClientFrame` in
  `@purlay/types`, which does not yet open to a module's own (§4, wire unions); until it does, a new operation is added to
  the contract and claimed here by one module. The context a handler is given is a
  `FrameContext` (`platform/frame-handlers.ts`): declare the parts you use in an interface that extends it. A test in
  `realtime/` with the module's handler and a fake `bundledModules` slot, as `frame-handlers.test.ts`, shows dispatch, the
  closed answer, the budget and the deadline. Chat's `events` are a `satisfies readonly ServerEvent[]` list, so a typo does not compile. An event the
  module sends and does not list would reach a process that does not run it. `module-emissions.test.ts` fails for a name
  its source writes that its manifest does not list (its source is its folder and the files of the doors that import it).
- Its id in `ModuleId` (`packages/types/src/modules.ts`): the contract bundle lists the module from its manifest, and
  `contract/bundle.test.ts` and `bun run contract:bundle` fail until the type names it (D-273).
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
- **Facts and capabilities** (D-283, step 14b): a module that tells another something, or asks it, says so in the manifest and
  supplies the other half in its slot, and each missing half stops the build. `publishes`: a fact type named `<id>.<what>`,
  declared with `defineFact` in `packages/types/src/<id>.ts` as a list `<ID>_FACTS` that joins `FACTS` in `facts.ts`;
  `fact-owners.test.ts` fails for a declared type the manifest does not publish and the other way, and for a type not named for
  its owner, and the registry for a type another module or the core already owns. `consumes`: the type, which must be published
  by a module of the build or the core (the registry), and a handler under `factConsumers` in the slot for each (`compose`,
  `module-communication.test.ts`); a handler for a type not named stops the build too. `provides` and `ports`: a capability is
  named `<module>.<what>` and the slot's `ports` has an implementation of the interface in `platform/ports/` for each, and none
  for a name not listed (`compose`). `uses`: a capability provided by a module in the module's `requires` or `optional`, never one
  nobody provides (the registry): the module is handed `Port<T>`, the implementation where the provider runs and `undefined`
  where it does not, and says in code what the feature does without it. Asking never makes a requirement. No scan yet holds a
  module to reading only the ports it `uses`; the release snapshot holds `publishes` and `consumes` but not `uses` (§4, D-288).
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
- **The table's schema** (D-271): `features/<id>/schema.ts` makes `<Id>Db` and `<Id>Tx` of `ModuleSchema<'<id>', CoreReads>`, naming the core tables the module reads; the module's functions take them in place of `Executor` and `Transaction`, and a core table added to the list is a line a reviewer reads. `module-db.test.ts` holds what the type refuses, and `module-tables.test.ts` fails for a folder under `features/` with no `schema.ts`, saying so, and reads its `CORE_READS`; the lint refuses `Executor`, `Transaction`, `Database` and `DB` in the module's files. A module therefore needs, beside its manifest: `schema.ts`; a `budget` (`poolShare` or `none` with a reason, the registry refuses a manifest without it and `module-budgets.test.ts` lists a `none`); a `deadline` only to differ from the default (`{ ms }`, or `{ none: reason }`, listed in `module-deadlines.test.ts`), a `jobDeadline` likewise for its scheduled jobs (D-274), and a `workerDeadline` for its workers (D-281); and `retention` for the jobs that keep its rows (`composition.test.ts` stops a build whose named jobs and supplied work differ).
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

**4. The routes and the share of the pool.**

- **Route handlers and their registration in the module's folder** (D-280): `apps/api/src/features/<id>/http/handlers.ts` (or
  one file per resource) and `routes.ts`, whose function takes `ModuleRouteDependencies` and returns an Elysia plugin
  (`features/issues/http/routes.ts` is the model), supplied as `routes` in the module's slot in `bundledModules`. Nothing is
  edited in `ingress/http/app.ts`: it uses every bundled module's plugin. The folder may import Elysia and the door's helpers
  (`ingress/http/session`, `validate`), the lint says no more of it; a module's tests of its routes live there and drive
  `createApp`. `route-ownership.test.ts` fails if the module has `routes` in its manifest and no plugin in its slot, if a path
  the plugin registers is not the manifest's, and if `app.ts` registers one of the module's paths. The module's services do
  not import HTTP types. A service that writes atomically takes `atomicallyOn(database)`
  (`platform/transactions.ts`): a raw `database.transaction()` compiles and runs, and answers 500 in the cross-tenant
  harness, which holds a transaction already. The wire types go in `packages/types/src/<id>.ts`, exported from `index.ts`,
  with new error codes in `errors.ts` and the endpoint in `api.ts` and `API.md`.
- **Cross-tenant classification.** The endpoints are read from `API.md`, and each must appear in `apps/api/src/testing/cross-tenant.ts`
  with a case (what it answers for a workspace the caller is not in, `WORKSPACE_NOT_FOUND`, and how channel visibility
  applies: `none`, with the reason, for a route that names no channel) or among the unscoped with the reason it has no
  tenant to cross; `cross-tenant.test.ts` fails for one that is in neither, and `cross-tenant.integration.test.ts` runs
  the crossings. `module:new` writes the two rows of its routes. A new path parameter name needs its id in `Ids`
  (`testing/cross-tenant.ts`) by hand. The module's rows are seeded by its `seedLifecycle` (`features/<id>/testing.ts`), which `aTenant`
  (`ingress/http/cross-tenant.integration.test.ts`) runs for every module through `moduleSeeders()`, so there is nothing to add to `aTenant`.
  A list that answers no rows for the seed fails the same-member two-workspace check (`EMPTY_FOR_THE_SEED` is the only exception, capped
  by `MAX_EMPTY_FOR_THE_SEED`); the other workspace's answer is searched for the ids of `Ids` only, so an id of the module that should be
  proved absent from it is a field of `Ids` too.
- `bundledModules` gets the module (one line in `composition.ts`), and `compose` does the rest.
- **The share of the pool**: nothing to write in a handler. The handler is given the application's one database, whose
  every connection is leased by the module the request belongs to (D-266), so there is no boundary to ask for and no raw
  handle to take instead; `module-seams.test.ts` holds `app.ts` to one use of the database it was given, and the doors and
  features to no pool of their own. What is yours is a read that decides whether a request may be made at all (a
  membership, a session): the core's guards in `platform/tenancy.ts` take their connections outside every share
  (`inTheCore`), so a person with no part in the module holds none of its slots. A module with a `poolShare` has an
  integration test of it, `features/<id>/http/budget.integration.test.ts`, copied from issues' (the first such test,
  `features/issues/http/budget.integration.test.ts`): a lock on a table its routes read, the share filled, the next request
  refused as busy and another module's answered meanwhile, with `@needs-modules` naming the module. Chat's is the one
  exception, `ingress/http/chat-budget.integration.test.ts`, left where its handlers were. `module-budgets.test.ts` fails for
  a module with a `poolShare` and no test at that path (or the one path its table of exceptions gives, which only shrinks) and
  for a test whose header does not name the module; it does not run the test or read what it asserts, so that the share is
  filled and the others answered is held by review.
- **A background loop is a worker** (D-281): a module that needs something done on a timer inside the API process declares
  `workers` on its slot (`name`, `intervalMs`, `work`: `features/<id>/workers.ts`, as `jobs.ts` is the work of its jobs) and
  starts nothing itself; `index.ts` starts the workers of the modules that run, and names none. The work is given the module's
  leased database, the clock, the bus and push, and opens no connection of its own. Guards: `compose` stops a build with a
  repeated or malformed name or an interval outside a second to an hour (`composition.test.ts`); `module-seams.test.ts` reads
  `index.ts` as a door, holds it to no feature's file, and holds the workers it starts to the leased database and the
  application's shares; `module-workers.test.ts` and `.integration.test.ts` hold the iteration to its deadline (a statement past
  it is cancelled on the server, and the next iteration runs), its failure to the log and `purlay_worker_failures_total`, and a
  worker of a module that is off to not starting; `module-deadlines.test.ts` lists a `workerDeadline: { none }`.
- **Its hot path in `budget:latency`**: a line of `HOT_PATHS` in `cli/budget-latency.ts` (D-250 rule 6): how to time the
  module's hot path through its real route or frame, and how to make the module busy up to its share (copy `issues`: people
  asking, the table its statements use locked in turns), or `{ none: '<reason>' }`, which is also a line in
  `WITHOUT_A_HOT_PATH` of `budget-latency.test.ts`. **`budget-latency.test.ts` fails for a bundled module with no line**, for a
  `none` that is not listed, and for one listed that has a path. The gate then times the module's path while every other
  module with a line is busy, against the number recorded for it in the baseline file.
- **No door names a module's files**: `cli/` imports no file under `features/` but `erase-content.ts`'s one (the single allow-listed entry, which a module's own command would join only with a manifest field to go through), and no file of `ingress/` imports a module's
  folder but the ones listed in `ALLOWED` in `module-seams.test.ts` (the list only shrinks and its cap with it; a new module's
  handlers are in its own folder (`features/<id>/http/`, which the fence lets import the framework and what `ModuleRouteDependencies` names, widened in a line a reviewer reads) and are not an entry, and a core route file that needs the module is a port or a manifest
  field, not an entry); `ingress/http/app.ts` is the one file that may name any.

**5. The web** (the web registry, §6).

- **Its UI is under `apps/web/src/features/<id>/`, beside the manifest, and imports itself and what is shared** (`ui/`, `lib/`, `data/`, the core's `session`, `shell` and `router`), never another module's folder; if the core or another module needs a piece of it, the piece is not the module's and moves to `ui/` or `lib/`. `web-fences.test.ts` and the lint fail for an import between modules or one of the core's that is not the registry's manifest (D-277); `budget:web` holds every file of the folder out of the initial chunks without a line to add.
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
  its error codes (`data/failure.ts`, and the exhaustive switch in `features/chat/composer/uploads.tsx`), and the English and Turkish
  catalogues (`i18n/catalogue/en.ts`, `tr.ts`).
- **`budget:web` shape check**: it reads the module ids from `features/*/manifest.ts` and looks for each one's marker,
  `screen-of-the-<id>-module`, in the initial chunks; the screen's file holds the marker. A bound for the chunk is a line of
  `MODULE_BYTES` (a module without one fails), and the files of the module's folder are looked for by their sources
  (`screenSources`, D-277).

**6. The tests that make it a module and not a folder.**

- The **modules-off cell**: the module's routes are `404` in a process without it (`ingress/http/modules-off.integration.test.ts`)
  and its frames and events are closed (`realtime/modules-off*.integration.test.ts`, if it has any).
- The **migration cell**: `packages/db/src/migration-cells.integration.test.ts` finds the table beside its set and nowhere
  else; `migration-sets.test.ts` lists the set.
- The **lifecycle matrix cell**: `module-lifecycle.integration.test.ts` runs erasure, purge, exports, jobs and the attachment
  reader with the module's set as a database state and the module alone as a process.
- A **real process** per cell in `platform/migrate-on-start.integration.test.ts`: nothing to edit, its cases are made from the bundle.
- **Two real processes** for what a cluster does (D-288, D-292): `outbox-two-processes.redis.integration.test.ts` and `entitlement-two-processes.redis.integration.test.ts` start the API's own entry point twice on one database and one Redis, with a preload for what a test changes about a node (`testing/cluster-node.ts`). A module's fact consumer or a grants rule is proved in-process (`outbox-two-nodes.integration.test.ts`); these hold the signals and the boot.
- **Its suites declare what they need** (§8, *The suites per cell*): a suite under `features/<id>/` needs the module by where it is, a suite or helper that imports its files by the import, and one that reaches the module by its routes or its tables says `// @needs-modules <id>` in its header (or `testNeeding('<id>')(…)` for one test) — or it fails in `modules:suites` in every cell without the module. A suite about the core that uses a module's fixture (`aRoom` makes a channel) needs the module; to keep a core suite in every cell, build its world from the core's tables.
- **CI's `module-suites` leg**: nothing to edit. The matrix is `bun run modules:cells` (every subset of the modules but the one with
  all of them), which the `changes` job runs and the matrix reads with `fromJSON`; `module-suites.test.ts` holds the workflow to that.
- **The lifecycle seed**: `module-lifecycle.integration.test.ts` seeds a row for each module's data so that erasure, purge
  and export are proven on something; a module with a `features/<id>/testing.ts` exporting `seedLifecycle` is seeded by it, found by the folder
  (`module:new` writes it; `testing/module-seeders.ts`, which the cross-tenant crossing uses for its list check too); chat's and issues' are written out in
  `seed`, behind `hasSet(state, '<id>')`. Or the test fails for each table the module owns that the seed leaves empty, unless it is in `UNSEEDED` with a reason (capped,
  `MAX_UNSEEDED`, and only shrinking).
- The **smoke cell**: nothing to edit — `modules:smoke` makes its cells from the bundle and its paths from the manifest's `routes`, so a
  module with routes is asked for in every cell. A module whose manifest claims no path fails it (nothing would show it runs).
- The **no-module browser spec**: `apps/web/e2e/modules-none.e2e.ts` (run as `bun run test:modules-none`) holds the module
  out of the frame when the server runs none, and asks for none of the paths in the manifests' `routes`. The words it
  looks for in the rail and the sidebar (`Inbox`, `Issues`) are the module's labels and are edited with a module that has UI.
  **Nothing holds them, and they are not derived from the manifests on purpose:** a manifest holds i18n keys, which the page
  resolves from a catalogue the Playwright project does not load, and the spec's words are not the manifests' labels (the
  front door's `Channels` and the palette's `Unreads` are matched by patterns of their own), so a derived list would need a
  table of exceptions, a second list. A label left out leaves the spec passing, so a module with UI adds its words by hand.
- A **module-listing** row (§11, above) and `composition.test.ts` for what the module contributes.
- **Mutations**: for each rule above the tests are the only guard of, a mutation in `scripts/mutations/` that breaks the
  rule and names the test that must fail (read `issues-*` there). A mutation goes in the file
  of the area of the code it mutates (`scripts/mutations/areas.ts`, `areaOf`), at the place its id sorts, never at the end of
  the file (`CONTRIBUTING.md` §5); `scripts/mutations.test.ts` refuses an entry in the wrong file or out of order.

**7. The release.**

- `bun run release` rewrites `apps/api/src/released-manifests.json` (`manifests:snapshot`), and from then on
  `module-compat.test.ts` holds the module to it: no new requirement, no capability, route, job, frame or retention job gone, no id or `entitlement` changed, and
  no fact schema changed under the same `shape` (§8 says what the snapshot holds of a fact).
  A break is a dated entry under `exceptions` in that file, where a reviewer sees it; the release clears them. Until a
  release carries the module the snapshot does not name it.
- `docs/changelog/changes.md` gets an entry under **Added** when the module is something a person can use (a module with
  no user-visible effect has none; the shape of an entry is in that file's header, `CONTRIBUTING.md` §7 item 6). The decision count in
  `README.md` follows the new D-number: `module:new` writes it and `bun run check:docs` fails when it is wrong. **The changelog entry is
  not held by a guard**, and not worth one: what is user-visible is a judgement a test would have to make for the author. A reviewer reads it.

**8. The documents.** `MODULES.md` (§11 row and section, §8 if a rule is now held), `DECISIONS.md`, `SCHEMA.md` (the
migration and the table), `DATA.md` (what personal data it holds and how it is erased and exported), `API.md`
(routes, error codes), `CONFIG.md` (the `MODULES` row names it), `ARCHITECTURE.md` (the features tree) and
`DEPLOY.md` (nothing to change unless the module needs configuration). `check:docs` and `module-listing.test.ts` fail for
the ones they hold.

**What a new module edits outside its own folder, measured by a throwaway third module (`notes`) built from this
list.** Source files, not tests and not documents; the rows before the audit action's are what a module without UI and without an
audit action edits.

| Where | Files | Why |
|---|---|---|
| `apps/api/src` | `composition.ts` (one `bundledModules` line) | the module's row and its routes (`ingress/http/app.ts` is **not** edited: it uses each bundled module's `routes`, D-280); `cli/jobs.ts` is **not** edited, the job command takes a module's jobs from the composition; `export-catalogue.ts` is **not** edited, it is derived from the manifests |
| `apps/api/src` | `modules/jobs/schedule.ts` (a job of the module gets its slot in `PLAN`) | only for a module with `jobs` or `retention`: `core-claims.test.ts` fails for a job the plan has and nothing claims, and the other way |
| `apps/api/src` | nothing in `index.ts` | it starts the workers of the modules that run and names none (D-281) |
| `packages/types/src` | `modules.ts` (the id in `ModuleId`) | the contract bundle lists the module from its manifest, and `contract/bundle.test.ts` fails until the type names it (D-273) |
| `packages/db` | `src/migrator.ts` (set registration and `PRODUCT_MODULE_REQUIRES`), `src/table-owners.ts`, `src/table-lifecycle.ts`, `src/schema.ts` (`bun run db:generate`) | the set, its owner, its erasure and retention decision, the generated schema |
| `packages/types/src` | `index.ts` (re-export), `<id>.ts` (its own) | the wire |
| `apps/web/src` | nothing for a module without UI: **no web manifest is needed** | the registry lists a module only when its manifest exists |
| an audit action | `modules/audit/audit.ts` (target type), `packages/types/src/api.ts` (action), web `features/settings/pages/audit.tsx`, `i18n/catalogue/en.ts`, `i18n/catalogue/tr.ts` | the exhaustive switch and the catalogues refuse an action with no sentence, so an audit action forces three web files even for a module with no web part |

A module with UI adds its manifest, one `registry.ts` line and the per-module web files listed in item 5. No count of
these files is stated: the table is the list, and a number beside it was stale each time a row was added.

**The tests a new module edits.** Item 6's cells are automatic now: the smoke and migration-set tests, the CI matrix and the lifecycle
seed read the bundle or the module's folder. What is left hard-codes the module list or needs a fixture
(`module-seams.test.ts` is not one, the handlers being in the module's folder):
the modules-off, export, personal and upgrade
integration tests (a seeded row, a file list or a snapshot for the new table), plus the fixtures: `testing/cross-tenant.ts`
(the `Ids` field, item 4), the module's `seedLifecycle` (item 4), and the `channel-visibility.integration` and
`upgrade.integration` fixtures that need a seeded row or field; and the lifecycle seed (`module-lifecycle.integration.test.ts`, item 6).
What grows by itself: the `modules:smoke` cells, the lifecycle matrix, the migration cells, the real process per cell of
`migrate-on-start.integration.test.ts`, the cells of `composition.test.ts` and of both metrics tests, the `MODULES` value
the command and the API must read alike (`module-setting-pair.test.ts`), the `/api/me` module list of `modules-off.integration.test.ts`,
and `modules:upgrade`; what a module's code names on the socket (`module-emissions.test.ts`), the closed paths of the no-module browser spec, and the
modules, entries and screens `budget:web` looks for.

**Where the paved road still needs a hand (measured 2026-11-08 with two throwaway modules, `zz` publishing a fact and `yy` consuming it,
telling the inbox and appearing in the find; every item is a defect or a gap of the generator or the guards, reported and not hidden).**
`module:new` gives a module the guards accept with no hand edit, and that holds, for a second module and a third. What it does not cover:

- A member of `FindTarget` (`packages/types/src/find.ts`) for a search source whose hits lead somewhere a client does not know: the union is
  the wire's, not derivable from the manifests, and a client that does not know a member ignores it.
- A consumer's handler is given the transaction and not the inbox.
- Closed (D-286 §11): a feature's code imports `composition.ts` no more (the lint refuses it, `verify:enforcement` proves it, mutation
  `module-code-may-import-the-composition`), and the sink a module is handed is bound to that module, so a notice of another module's
  kind (`zz` writing `issue_assigned`) is refused and written as no one else's (`sink.test.ts`, `sink.integration.test.ts`, mutation
  `sink-writes-a-kind-another-module-declares`).
- Held, tried on `zz`: leaving out `requireWorkspaceMembership` in a handler fails the generated route test, the cross-tenant matrix
  and `entitlement.integration.test.ts`; importing another module, `Executor`, raw `sql`, `ingress` or a table of another owner
  (`issues`, `inbox_entries`, `outbox`) fails the lint or the compiler.

**What still goes unnoticed (silent gaps).** `db:migrate` validating `requires` (#985), the cross-owner key list (#986),
the typed lifecycle decision per table (#990), the core-enum guard (#994), the member-of-two-workspaces list check
(#988), its non-vacuous form (#1010), the purge coverage (#1009), the set-keyed enum allowance (#1007) and the row-level
lifecycle proof for `deleted` and `window` decisions (#1011) are merged, and every `anonymised` lifecycle decision is
probed (all 31; the allow-list of unprobed tables is empty and capped at 0). A statement that reads a table by columns
no index starts with is held too (`query-columns.integration.test.ts`, seven reasoned exceptions, capped at 7), but
only as far as a source scan sees: a `where` or `orderBy` with a literal column on a chain it can follow to its table.
For an upsert’s guard it also reads the unique target columns of that same `onConflict` callback: a
receipt’s cursor comparison probes its declared primary key, not the whole receipt table by cursor.
Each matrix cell checks queries against the tables its own migration sets installed: a query through a known
module-owned table absent from that schema cannot run there and is excluded using `TABLE_OWNERS`. Unknown tables,
missing core tables and misspelled columns still count against the same unresolved-reference limit; no allowance grows.
It does not see a column named inside a `where((eb) => ...)` callback, in a `sql` template, or in a variable, a chain
that starts from a parameter or a helper's return value, a CTE or select alias (each is common; they were counted once
and the counts went stale, so none is stated), or whether a partial index's predicate serves the statement. And the rule is per statement and table, not per column:
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
| 4 | *Not built (D-272):* wire unions opened, with aliases, **with the first module that has frames of its own** (5b); the web client already ignores unknown frames (D-82, tested) and a native client is checked first; the replay rule; `skipped` in the search response (built in D-285, step 14k) | no |
| 5 | The domain bus, the typed query handle (**built**, D-271: issues and chat) and the raw-`sql` ban, the per-module pool cap and `statement_timeout`; chat's pagination and reader move to `platform/`. **Not built (D-272):** `AttachmentOwner`; the hint and fact with its sweeper and the port `NotificationSink` are decided in D-283 and are step 14; `SearchSource` is built (D-285) | no |
| 5b | *Superseded by 13.* It planned a thin slice that opened an issue from a message and linked back; D-254 §1 decided that issues has no link and no frame, so that slice was not built | — |
| 6–8 | The three cycles broken: `workspaces`, `integrations`, `channels` with `messages` | no |
| 9 | Chat moved under `features/chat` — **built**, every file and every import that named them; still to come in this step: channel visibility and the export entries leave `platform/` and `export`, and chat's queries go behind the typed handle — **built** (D-271; chat's raw-SQL exemption is policed by a text scan, not ended) | no |
| 10 | Migrations split by module; `data` hooks — **built** (`tableExists`, §5); the ownership ratchet reaches zero — **built, ships in the release after the expand** (`chat/0005`); codegen and `db:check` per module are **not built** | no |
| 11 | Chat's web screens a lazy chunk; budgets split — **built** (below) | no |
| 12 | `MODULES` turns modules off — **built**, with the cluster record (said, never acted on) and the cells of §8; the product's module-independent suites in every cell in CI (`modules:suites`, §8); a share of the pool is built for each module and a starvation gate for chat with issues busy (§7) | **yes** |
| 13 | Issues complete, the second module in full — **built** as D-254, deliberately the smallest record that exercises every seam: its own set, its hooks held whether or not it runs (D-254 §4), its routes in the manifest, a chunk of its own, the matrix tested on a database each cell made | new feature |
| 14 | How modules tell one another things (D-283): **(a)** the decision and these documents — **built**; **(b)** the contract skeleton: fact declarations, ports folder, the manifest's `publishes`, `consumes` and `uses`, their refusals and a fake module's tests — **built**; **(c)** the outbox table, `publishFact` and the `absent` policy, with the release snapshot's hold on `publishes` and `consumes` and the bundle's module structure — **built** (D-288); **(d)** the claim, the delivery and the drain worker — **built** (D-288); **(e)** the outbox sweep, metrics and the overview line — **built** (D-288); **(f)** `inbox_entries`, the `NotificationSink` port, its sink and `sweep:inbox` (D-286) — **built**; **(g)** the inbox routes, `INBOX_UPDATED` and the sink's `announce` (D-286) — **built**; **(h)** issues' assignment notice (D-286) — **built**; **(i)** push held by Deep Work and quiet hours, and those columns leaving `CORE_COLUMNS_FOR_A_MODULE` (D-286 §9) — **built**; **(j)** the web's *Updates* section and badge (D-286 §10) — **built**; **(k)** `find` and chat's source — **built** (D-285); **(l)** issues' source and its index — **built** (D-285); **(m)** the web's search groups — not built; **(n)** the close: this file's rows turned to built and what is not, with its trigger (D-295) — **built**; a scan of publishers and the wire-union watcher — not built | **yes**, from (g) |

**Before a package is sold:** workspace-level enablement (D-250 rule 9) is built (D-289, D-292) but for the jobs and workers of a module that is a grant (the table above), the downgrade lifecycle, and for each
module a written removal threshold — active workspaces, retention, support load — rather than a sentence.
**Between modules** a table of module pair × experience (mention, link, notification, search, attachment,
permission, onboarding) says what a user sees when the partner is absent: shown, hidden, or plain text. It is part
of each module's section (§9).

**What is not built of how modules talk and are entitled, and what would start each (D-295).** Audited 2026-11-08 against the code
(`git grep` for each claim, a throwaway pair of modules made with `bun run module:new` on a copy, `docs/DECISIONS.md` D-295). Built,
and proved by the tests named in §8 and by fake modules, with **no production publisher, consumer or port in the product**: the
contract (`publishes`, `consumes`, `uses`, `degrades`), the outbox with its claim, worker, sweep and metrics, the core's inbox with
its sink, routes, push and Updates section, the workspace find, the per-workspace grant with its guard, administrator route, edition
file and cluster check, and the scaffold. Not built:

| Not built | What would start it | What watches for it today |
|---|---|---|
| A fact published by a module of the product | the first feature that must tell a module that may be absent (issues' link to a channel, D-254 §1) | nothing: a route has `publishFact` (`ModuleRouteDependencies`, `platform/ports/fact-publisher.ts`, `ingress/http/module-publish.integration.test.ts`), bound to its module, so the first publisher only declares its fact |
| `Composition.ports` asked per workspace (`ports.of`) | the first module that `uses` a port of a module that is a grant: today a port answers for a process, not for a workspace the module is withheld from | `uses` and `provides` of the real modules are empty, so nothing can ask yet |
| The SQL form of `effectiveModules` (`entitled()`) for jobs and workers | the first module that is a grant and declares `jobs` or `workers` | the build refuses it (`unguardedWorkProblem`, `composition.test.ts`) |
| The web's search groups and the skipped line (14m) | the product wants the find drawn; the route answers them today | none; a metric of how long each source took and how many were skipped is also not built |
| A runtime kill switch for a module | the administrator's route and command that call the writer, and the list of what is stopped (D-296: the state, everything that reads it, the writer and the wait for the cluster are built) | until then a row written by hand is believed by every node within two seconds |
| Tracing across modules (OpenTelemetry) | a latency question that the per-module histograms, `purlay_worker_failures_total` and the request id in the logs cannot answer | none |
| Per-tenant quotas of a module's work (requests, notices) | one workspace measured filling a share | the share of the pool and the rate limits are per module and per connection, not per tenant; facts have a ceiling per workspace and consumer (D-288 §10); D-283 §10 names `pg_stat_user_tables.n_dead_tup` of `outbox` and `purlay_outbox_pending` as the watchers of partitioning (`DEPLOY.md`) |
| The web feature of a new module (C2b) | the client's API object, keys and catalogues gain a declaration a module can be added to without editing them (D-294 §5) | `module:new` makes the server side only; item 5 of §9 is by hand |
| A scan holding a module to the ports its `uses` names; the watcher that asks for a decision when a manifest fills `frames` or `events` with no opened union (14n) | the first module that reads a port; the first module with an operation of its own | review |
| A downgraded module's data kept for a stated period and then offered for deletion (D-250 rule 9) | the first operator who must remove a module's rows for a workspace that left it | none: a downgrade hides every row and keeps it, exports and erasure still cover it (D-289 §6); review |
| The second world of degradation: a partner that runs but is not granted to the workspace (D-291 §2) | the first module whose `optional` partner is a grant | none: `degradation.test.ts` composes the build without the partner, not with the partner withheld; review |
| The idle memory bound | **an owner decision, not a change made here:** `budget:api` fails at 120 MiB (`PRD.md` §5, D-49) and the API's idle resident set was read at 112 to 129 MB by the owner, and by the audit at 120.6, 122.0 and 122.5 MiB in three runs of `budget:api` and 122.7 MiB in `test:all` on a machine of its own (each over the bound), so the bound sits inside the noise of the measure | `bun run budget:api`, in `verify` and CI's database job |

**How the extraction was done, step by step** (steps 6–8 from the imports, what was left of steps 9 and 10, step 12 in the order it was built,
followed conversations, step 11 and what is left of chat in the shell, with the measurements of each) is a record of what happened, not a rule:
it is in [`MODULES-HISTORY.md`](MODULES-HISTORY.md). This section keeps the order of work and what is not built.

**The three risks.** The migration rename and reorder: a wrong one stops a database from opening, so it is
rehearsed on a copy with the dumps compared, and it needs the owner's approval, being hard to reverse. The
places the core and chat share data — attachments, read state, notifications, which reference messages by key
(I-3, I-4, I-7) — where "works without chat" is unproven until the real schema says so; moving the rows that
cannot stay in the core into chat is the cost, and the core's claim is only as large as what is left. And the
wire names, which installed clients read.

## 11. The modules this build carries

One row and one section for each manifest in `bundledModules` (`composition.ts`): a module added there without its row,
or a row for one that is not there, fails `module-listing.test.ts`, and so does a module with no section or a section with
no `**Removal threshold.**` line (a threshold, or `none, because …`; D-250 rule 6). `—` is none. What the sections say
beyond the threshold is held by review.

| Module | Requires | Optional | Provides |
|---|---|---|---|
| `chat` | — | — | — |
| `issues` | — | — | — |

### `chat`

The first module (D-250): what the product was before it was a set of modules, carved out of the core in the steps of §10.
§1 to §10 and D-250 describe it, so this section says only what a section must. **Requires** nothing, **optional**
nothing, **provides** nothing, as its row says.

- **Removal threshold.** None, because chat is the product the other modules sit beside and an operator's choice to run a
  server without it is `MODULES`, not a removal from the build. A measurable rule is needed before a package is sold
  (§10, *Before a package is sold*); there is none yet. Its tables stay until an operator drops them (D-250 rule 5).

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
- **Events and notifications.** An issue has no frame of its own; a client reads again. An assignment to somebody else tells
  the assignee, once, through the core's `NotificationSink` **inside the assignment's own transaction** (D-286): the notice is
  committed with the assignment or not at all, and the route announces it to the person's tabs (`INBOX_UPDATED`) after the
  commit. One kind, `issue_assigned`, declared in the manifest's `notifications`; it is `pushed` (a device is told, held while the
  person is in Deep Work or their quiet hours; words in `notice-words.ts`, never the title) and `needsYou` (the inbox's dot counts
  it; §10, 14j). A retitle, a status change, an
  unassignment, an assignment to oneself and an issue with nobody tell nobody.
- **Search.** One source, `issues`, for the workspace-wide find (D-285): a title or a body that holds the words, in two queries on
  the two trigram indexes of `migrations/issues/0002_issues_search.sql`. Any member reads any issue, so the workspace is the only
  narrowing. A process without issues answers the source `off`.
- **Web.** The screen at `/w/:slug/issues`, one `import()` from `features/issues/manifest.ts` (<!-- web-module-registry -->) into a chunk of its own; the rail
  link and the palette entry only where the session lists the module. `budget:web` holds the shell chunk to carrying none of
  the screen.
- **Smoke test and matrix cell.** `module-lifecycle.integration.test.ts` for every lifecycle step in each state of the database (core alone, chat's set, issues' set, every set) against each process,
  `modules-off.integration.test.ts` for the routes per cell, and a real process per `MODULES` in
  `migrate-on-start.integration.test.ts`.
- **Latency.** Its hot path is the list of a workspace's issues, an indexed read, and `budget:latency` times it through its route while chat is saturated (§7), against its own recorded number.
- **What a user sees for each partner that is absent.** There are no partners.
- **Removal threshold.** Decided by the owner at each release, against the measured use. A measurable rule is needed
  before a package is sold (§10, *Before a package is sold*); there is none yet. Its table stays until an operator drops
  it (D-250 rule 5).

## 12. Glossary

The terms of this file and of the code that carries it, as they are **now**. A line says where the word lives. Not a
table, so that §11's listing test reads only the modules.

**Words that look alike, and the one each means.** The guide (`MODULE-GUIDE.md`) and the code use these and no others for these things.

- **module, feature, package.** A *module* is the unit of this file: a manifest, a migration set, data hooks, optionally a web chunk. Its
  folder is `apps/api/src/features/<id>/` and, when it has a screen, `apps/web/src/features/<id>/`: in a path, `features/` holds modules,
  and the core's own layered code is `modules/` and `platform/` (so a folder named `modules/` is the core, not a module). Prose says
  *module*, never *feature*, for this; a *feature* is what a person can do. A *package* is a workspace package of the repository
  (`packages/*`); the commercial word D-250 used for what is sold is *edition*.
- **fact, event, hint.** A *fact* is a type one module tells the build through the outbox (`FactDeclaration`, §4): it must not be lost. An
  *event* of the manifest is a server event sent over the socket, and a *hint* is a nudge that may be lost (the domain bus, the socket
  bus). A row the core keeps for a module's user, such as an inbox line, is a *notice*, not a fact.
- **notice, notification.** A *notice* is a row of `inbox_entries`, written through the `NotificationSink` (D-286). A *notification* is a row
  of chat's `notifications`, bound to a message. The manifest's `notifications` declares the kinds of both: a kind is one of chat's
  (held to the wire's `NotificationType` and the database enum) or a core inbox notice (text, which the sink checks against the
  running modules' declarations).
- **entitlement, grant, edition.** *Entitlement* is the manifest field (`always` or `grant`): whether a workspace's grant can take the
  module away. A *grant* is a row of `workspace_modules` saying one workspace may, or may not, use one module. An *edition* is a name in
  the operator's file that expands to grants; nothing stores it (`DEPLOY.md`, *Editions*).
- **capability.** Only a name in `provides` or `uses`. (`GET /api/client` also answers some flags it calls `capabilities`: they are client
  flags, true when chat runs.)
- **bundled, run, granted.** *Bundled*: carried by the build. *Run*: named by this process's `MODULES`. *Granted*: usable by this
  workspace (`effectiveModules`). *Off* means not run.

- **Core** — what knows no module by name: identity, workspaces and tenancy, permissions, audit, the domain bus,
  attachments, the registry, the erasure and export catalogues. `modules/` and `platform/`.
- **Module** — a unit of product with a manifest, a migration set of its own, data hooks and a web chunk (§1).
- **Manifest** (`manifest` of a `BundledModule`) — what a module says of itself to the registry: `id`, `requires`, `optional`, `degrades`, `provides`,
  `entitlement`, `routes`, `frames`, `events`, `jobs`, `budget`, `deadline`, `jobDeadline`, `workerDeadline`, `retention`, `permissions`,
  `auditActions`, `notifications`, `searchSources`, `publishes`, `consumes`, `uses` (`platform/module-kit/manifest.ts`, §2). It is not a trust boundary.
- **`BundledModule`** — a manifest plus what the module contributes to the places the core leaves open: the slots in
  `composition.ts` (`userErased`, `workspacePurge`, `export`, `personalExport`, `workspaceCreated`, `workspaceChannels`,
  `readAttachment`, `pushNotices`, `collatedColumns`, `jobWork`, `workers`, `frameHandlers`, `routes`, `factConsumers`, `ports`).
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
- **Cell** — one combination the tests build: a database state (a subset of the migration sets, from the core alone to
  every set) against a process (one valid `MODULES` value). They are made from the bundle by `testing/module-cells.ts`, so
  a module added later adds its own. §8.
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
- **Hint and fact** — an event that is a UI nudge, fine to lose (a hint, the domain bus), or one that must not be lost (a
  fact, an outbox delivery). The fact's table and publishing are **built**, with no publisher in the product (§4, D-288).
- **Fact** — a type of thing one module tells the build, named `<owner>.<name>`, declared in `@purlay/types` with a schema
  and what happens when its consumer is off (`absent`: `'drop'` or `{ holdDays }`). Carries ids and a short label, not state. The
  declaration and the manifest's `publishes` and `consumes` are **built** (D-283 §3, step 14b, D-288); nothing publishes one yet.
- **Outbox** — a core table of deliveries, one row for each (fact, consumer), written in the producer's transaction and run in
  the consumer's own by a worker of its module: at least once, unordered, for facts of human scale. The table, `publishFact`, the claim, the
  delivery, the worker, the sweep and the metrics are **built** (D-288), with no publisher in the product.
- **Port** — an interface the core defines and a module implements, handed to the module that `uses` it as `Port<T>`, the
  implementation or `undefined` where the provider is not run (`platform/ports/`, `Composition.ports`, built in step 14b with no
  port yet). Built before it: `WorkspaceChannels`, `PushNotices`, `SearchSource` (D-285), `NotificationSink` (D-286).
- **Capability** — a name a module lists under `provides`: held to no repeat by the registry and to the last release's by
  `module-compat.test.ts`. A module that `uses` one is handed its implementation or `undefined` (`Composition.ports`, built, with no
  module yet using one), and there is no `capabilities.has` (§4, D-283 §3).
- **Grant** — a row of `workspace_modules` (D-289): the operator's word that one workspace may, or may not, use one module. With no row a
  workspace has what `WORKSPACE_MODULES` says (`open` is the module, `managed` is none that is a grant). Not a permission: a member's
  rights are the role's.
- **Effective modules** — `closure_requires(running ∩ granted)`, the one answer to *which modules may this workspace use*, made by
  `effectiveModules` (`platform/module-kit/entitlement.ts`) and carried on the `WorkspaceContext` as `modules`.
- **Said, never acted on** — how a node reports a cluster whose members run different sets: one log line, nothing else
  (D-255 §1).

