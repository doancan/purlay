# D-250. Purlay is a set of modules over a small core, and chat is one of them — builds on D-1, D-2, D-7, D-24, D-43, D-86; amends D-1, D-2 and `PRD.md` §6

*Amended by D-352: the in-process domain bus is removed unused; a hint goes over the socket `EventBus`, a fact through the outbox or a port.*

**Context.** Purlay was team chat. The owner now means it to be an all-in-one workspace — chat, issues and projects,
notes, mail — with more large features to follow, and four things have to stay true while it grows. An instance
installed for chat alone is chat alone: no other feature's tables, routes, bundle or menu. Features work without one
another and degrade, not break, when a partner is absent. The code stays one open repository, so a self-hoster can have
any subset. And the cloud can sell the same subsets as packages. None of this holds today: `messages` is a hub that
`integrations`, `workspaces`, `attachments` and `channels` import and are imported by; channel visibility, message
erasure and the export catalogue live in the core; the wire unions (`Topic`, `ServerFrame`, `NotificationType`) are
closed; the web app imports every screen statically; and the migrations are one line every instance runs whole.

No standing decision forbids an issue tracker, notes or mail: none is in `PRD.md` §6's list, and D-204's "no task
tracker" bounded that decision's own scope. What this decision changes is the *shape* the product grows in, and two
sentences that would otherwise contradict it (below).

**Decision.** A **core** and **modules**, in one process over one database (D-7 stands: a module is not a service, and
there is no broker).

1. **The core** is identity, workspaces and tenancy (`WorkspaceContext`), permissions, audit, the domain event bus,
   notifications, attachments, the search fan-out, erasure and export as catalogues modules contribute to, and the
   module registry. Nothing in it names a module. What names chat today — channel visibility, message erasure, the
   messages in the export catalogue — moves to chat, and `MODULES.md` §10 steps 6–9 do it. Until then the sentence is
   a goal, and a test of `platform/` holds it once they are done. *(Amended 2026-11-07, D-283 §4: notifications and the search
   fan-out are the core's as a mechanism for modules, in a store and a route of their own; chat's `notifications` stays chat's.)*
2. **A module is a unit that registers itself**, through a manifest (`MODULES.md` §2). Chat is a module, not the base:
   issues and notes run without it. Modules are **first-party code in this repository**. The manifest is not a trust
   boundary, and loading a module from elsewhere is not supported — `PRD.md` §6 keeps "plugin directory" a non-goal.
3. **One build; the modules an instance runs are a setting.** `MODULES` unset or blank means every bundled module, `none`
   means the core alone. An unknown or repeated id, a missing requirement, a cycle, or an id that is a core path segment
   stops the process at boot. A disabled module is not mounted and its web chunk is never requested; a request for it
   gets the plain `404` of any unknown route, never a distinct answer. *(Amended 2026-11-04, D-255 §2: the routes are
   registered and closed by path, not left unmounted. The answer is the same.)*
4. **Modules meet through the core, never through each other's code.** By events first; by a port the core defines
   where there are two users or a test boundary; by asking whether a capability exists. A caller that finds it absent
   hides the feature or does nothing. Importing another module is a lint error, and **reading another module's tables
   is a lint error too**: a module is given a query handle typed with its own tables and the core's, and reads across
   go through a port. Raw `sql` in a module is the way round a typed handle, so it is a lint error there too: a table is
   named only in the manifest's `data` hooks, which are handed an executor of the module's own. An event is either a
   *hint* (a UI nudge, may be lost) or a *fact* (a notification, an index update, a system message): a fact is also a
   row written in the same transaction and drained by a sweeper, because delivery after commit is at most once (D-35). *(Amended
   2026-11-07, D-283 §1 and §2: the row is an outbox delivery for each consumer, for facts of human scale only; a core's
   own row is written by a port inside the caller's transaction.)*
5. **A module's tables exist only while it is enabled, and disabling drops nothing.** Each module owns an ordered set of
   migrations; a foreign key goes from a module to the core, never between modules. Disabled, the tables stay and are
   inert. The manifest declares what the module's data needs — erasure of a person (D-139), the tables of an export
   (D-140), retention, the audit actions it writes and the permissions it gates — and the core runs them for every
   module whose tables exist, enabled or not, so closing a module never leaves a person's data out of an erasure.
   Every table is owned by the core or one module, written down and tested; a foreign key across owners fails a test,
   and a list of the ones that exist today may only shrink. A core migration never names a module's table.
6. **Every combination that is run is tested; the rest are not promised.** CI boots and smoke-tests the core alone,
   each module alone with what it requires, and everything, and a disabled module's route must be `404`. Promoting an
   `optional` partner to `requires` is a breaking change, said in the release notes. A module is admitted only with a
   section in `MODULES.md`, its own budget gate (initial bundle, lazy chunk, and the latency of every other module's
   hot path measured with it busy), and the condition on which it is removed if nobody uses it. This replaces the hard
   cap on the number of features in D-2's table with a cost every feature must pay.
7. **Isolation is by budget, not by process.** A module gets a share of the connection pool, a deadline per request and
   an error boundary around its handlers and jobs — **built before a second module ships, not after**: a cap on its
   concurrent connections with a queue timeout, and a `statement_timeout` set inside its transactions. A search source
   takes an abort signal and a deadline, and is skipped, and said to be, when it overruns. Every log line and metric carries the module. *(Amended D-266: the share is a lease on every connection and the statement limit is the
   connection's, not set inside a transaction. D-270: a deadline per request and frame answers it and cancels its database work. D-274:
   a scheduled job runs in its module's share against a deadline.)*
8. **A cluster runs one module set.** A node records its module set in the database at boot and refuses to serve beside a
   live peer whose set differs. The release may differ, so a rolling deploy is not blocked. Nodes of different sets also
   share no channel on the bus, so a typo in `MODULES` on one node cannot make it receive another set's frames.
   *(Amended 2026-11-04, D-255 §1: the node does not refuse and no channel is split per set. The text stays as decided.)*
9. **Commercial model.** All code stays AGPL and in this repository (D-24); there is still no open core. A self-hosted
   instance can run every module, free. The cloud may price what it operates by the modules a customer runs, never by
   seat (D-43's other rules stand). **This amends** D-1's "the only thing the cloud sells is that we operate it" and
   `PRD.md` §6's "never withheld capability": a package is priced by what we run for a customer, and nothing is
   withheld from anyone who runs it themselves. A package is not sold before per-workspace enablement
   exists, because a package per instance would make the cloud one deployment per customer and end D-1's small
   operation. Until then a multi-tenant instance with mixed packages is unsupported and nothing is priced by module.
   *(Amended D-289, D-292: per-workspace enablement is built, and mixed packages on one instance are supported; what a workspace has is
   the operator's grants.)* Disabling a module keeps its data for a stated period and then offers deletion, and the data stays exportable
   throughout. *(Amended D-289 §6: a downgrade hides and never deletes; the period and the offer of deletion are not built, and
   `MODULES.md` §10 says what would start them.)*
10. **A module cannot forge the core's words, and the guards are not read round.** *Amends rule 2's "first-party code":
    the manifest is still not a trust boundary, but a mistake or a hostile line in one module must not become another
    tenant's data.* (a) A `WorkspaceContext` is minted only by the membership guard, frozen, and remembered by identity;
    the notice sink, the fact publisher and the find call `assertMinted` and refuse a copy (`{ ...context, workspaceId }`
    type-checks, so the type alone cannot). (b) One set, `RESERVED_MODULE_IDS`, holds every name a module may not take:
    route segments, `core`, `none` and `all`, the core's services, and the name of each core table; the registry,
    `module:new` and the contract's `ModuleId` refuse it. (c) A feature has no `import()`, `require`, loader of its
    own or path into `packages/` or `apps/`, no `sql` that is renamed, aliased or passed on, and no assertion to `never` or
    through `unknown`; the lint refuses each, `verify:enforcement` shows it, and `module-seams.test.ts` and
    `module-tables.test.ts` read the same lines from the text. (d) What a route is handed is built field by field in
    `createApp`, never spread from the application's dependencies: `config` is `APP_URL`, `GITHUB_API_URL` and
    `TRUST_PROXY`, `auth` is a `SessionAuth` that only the session readers open (the Better Auth instance and its cookie
    secret stay behind it), and `database` is the module's own handle (`ModuleRouteDependencies<ChatDb>`), so the
    red-team's session forgery, its cross-tenant channel read and its read of `ENCRYPTION_KEY` do not compile
    (`module-routes.test.ts`). (e) A module's reach into the core is a list and not an absence of bans:
    `scripts/module-reach.mjs` refuses every file of `platform/`, `modules/`, `ingress/` and `realtime/` that it does not
    open (the same base for every module, the door's helpers for its `http/` folder, and chat's own extra lines, which
    only shrink under a cap), and opens `modules/auth/sessions` for `requireLiveSession` and `SessionAuth` alone, so
    `issueSession`, the Better Auth instance and its secret derivation, the notice sink and the outbox cannot be imported.

**Rejected.** *Chat as the base that the others require* — the cheaper road, but it makes "project management without
chat" impossible and ties every package to chat. *A package per module* — the boundary is free, but the module needs
the database executor and `WorkspaceContext` and so either imports the platform downward or copies it, with a manifest,
a workspace entry and a gate per package for one consumer. *Build-time selection* — a smaller artefact, a build and a
test matrix for every combination. *A feature flag over shared code* — a default-off flag is a dead path that knip does
not see, and it does nothing for the bundle. *Every migration always applied* — simple, but an instance "for chat
only" holds every other module's tables, and cross-module keys leak in unseen. *Closing some modules* — it would end
"no open core" (D-1). *Dropping a module's tables when it is closed* — an erasure and an export would then depend on
which modules happened to be on. *Third-party modules* — a process-wide manifest with the database role is not a
sandbox, and a directory is a non-goal.

**Cost of reversing.** Dear once the migrations are split and cheap before: until then the registry and manifest are
types and a loop. After modules ship, removing one is dropping its manifest, and its tables stay until an operator
drops them by hand (D-9).

**Decided.** (a) *Existing installs:* the legacy migration rows stay as they are and count as the core's. A rename
would change the rows `0055` selects by name and the dump the restore rehearsal compares, and gains nothing a new
file cannot: only files added from now on go under `<module>/`. The cost is that the 77 files that existed when this was decided always create
chat's tables, even where chat is off — inert, which rule 5 already accepts. The release before the first prefixed
row skips rows it has no file for and says so, so rolling back one release stays possible while module migrations are
additive. (c) *Workspace-level enablement* is a precondition of selling a package (rule 9).

**Open.** (b) *Wire names:* namespacing frame types (`chat.message.created`) breaks installed clients, so the old
names stay as aliases for one release. That a client ignores a type it does not know is **verified** for the web
client (D-82: `parseServerMessage` returns `unknown`, the connection drops it, `server-frame.test.ts` holds it); it
is not verified for a native client, which is checked before the unions open. The unions open with the first module
that has frames of its own, not before: a registry with no entries would be a shape nothing has tried.
