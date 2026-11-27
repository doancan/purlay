# D-289. A workspace is granted the modules it may use, in one table and one pure function, and the framework's guard asks it — builds on D-21, D-54, D-250, D-255, D-278, D-283; completes D-250 rule 9's precondition

**Context.** D-250 rule 9 lets the cloud price what it operates by the modules a customer runs, and forbids selling a package before a
workspace can be enabled on its own: a package per instance would make the cloud one deployment per customer and end D-1's small
operation. `MODULES` is a process's setting (D-255), read once at boot, so today every workspace of an instance has every module the
instance runs and `DEPLOY.md` says that mixed packages on one instance are not supported. This decision makes them supported. It is
a commercial gate and not a permission: being a member decides what a person may read (D-21), and a grant decides only whether the
workspace may use a feature at all. It is not a licence check either; all code stays AGPL and a server you run yourself is, by
default, every module (D-24, D-250 rule 9).

**Decision.**

1. **One table, `workspace_modules`**, owned by the core (`TABLE_OWNERS`), key `(workspace_id, module)`: `state` `on` or `off`, an
   optional `valid_until`, a `source` label (`operator`, `file:<name>`, or a billing system's), `changed_by` and `changed_at`.
   `module` has no foreign key and no list of values, because a build may not carry the module a row names and a core table never
   names a module's table (D-250 rule 5). Rows are sparse: a module added later is a migration of nothing.
2. **Two modes, `WORKSPACE_MODULES=open|managed`**, default `open`. With no row for a module, `open` grants it and `managed` does
   not; a row overrides the mode in both directions. A row past `valid_until` is read as no row, at the moment of the read, by the
   process's clock, with no job and no event, so a trial that ends needs nobody to end it. `open` with an empty table behaves exactly
   as the instance did before this decision: that is how the change ships dark. `managed` is what the cloud sets, so a module that
   appears in a later release is given to no customer unseen.
3. **One pure function decides.** `effectiveModules` (`platform/module-kit/entitlement.ts`) takes the modules the process runs, the
   workspace's rows, the mode and the time, and returns `closure_requires((running ∩ granted))`: a module whose requirement is not in
   the set leaves it, and what requires that leaves in turn. A manifest may say `entitlement: 'always'`, and then no row can take it
   from a workspace; a manifest that says nothing says `grant`. **Chat is `always` in this release**: its topics, frames and events are
   closed per process (D-255 §2), and a downgrade that cannot close an open socket is not a downgrade. Making chat a grant is a
   decision of its own, with the socket's side.
4. **The framework asks, not the module.** The set is read in the same statement as the membership (`requireWorkspaceMembership`, the
   one producer of a `WorkspaceContext`, D-54) and rides on the context. The guard checks the membership first and the grant after, so
   a stranger learns nothing about a workspace's grants, and a refusal for a grant is the answer of a module that is not run, byte for
   byte (`ROUTE_NOT_FOUND`, the plain `404`). A module cannot forget to ask, because the question is not in its code. Each request turned away for a grant is counted in
   `purlay_entitlement_refusals_total{module}`. A path that
   resolves its workspace without a membership (a signed webhook) asks the same function, by the same name. `GET /api/me` lists the
   set per workspace; the web draws from it. Search, the inbox, the ports, the workers and the outbox consume the same function and do
   not recompute it.
5. **No cache.** The grant is one more read in the statement that already joins the workspace, in the same snapshot, so every node
   agrees at once and there is nothing to invalidate; the bus carries socket frames and not state (D-7). The cost is measured when it
   is built and the decision reopens if the membership read's p95 moves by more than half a millisecond with rows present, or if
   `budget:latency` fails.
6. **A downgrade hides, never deletes.** A workspace that loses a module loses its paths, rail entry, search results and inbox lines,
   and keeps every row. Erasure, workspace purge, both exports and retention cover the data of a module the workspace is not granted,
   as they cover a module the process does not run (D-250 rule 5, D-255 §3). A grant back brings everything back. Deleting a
   disabled module's data after a stated period stays an explicit, confirmed, audited act and is not built here.
7. **Only the server's administrator writes**, through one service, `applyEntitlements`, which the administration console and the
   `entitlements:apply` command (an edition file) both call; a workspace's owner cannot grant themselves a module. Every change is
   audited by id and value, never by words (D-222). No billing is built; a billing system would call the same service as an actor of
   its own. Their rules are D-292's.
8. **A restrictive write waits for the cluster.** A node that does not know the table treats every workspace as granted. Making a
   grant `off`, or switching a server to `managed`, is refused with `409 PEERS_BEHIND` unless every live peer advertises that it
   reads grants; the roll is finished first (`DEPLOY.md`). Rolling the release back lifts every restriction, which is safe and not
   what was sold.
9. **The hooks that bypass the routes ask the grant too** (an audit of 2026-11-08, red-team F10). A route is guarded where the
   membership is read; a module's reader of files (`readAttachment`), its start for a new workspace (`workspaceCreated`) and the
   pushes of what its writes told (`pushNotices`) never pass one. `compose` wraps each of a module that is a grant
   (`entitlement` is not `always`) in the same function of the same rows (`modules/entitlements/hooks.ts`): a file of a workspace not
   granted the module is `ATTACHMENT_NOT_FOUND`, as a file nobody answers for is, asked after the module's own reader so a file
   nobody may read costs what it did; a new workspace is not started by a module its guard-minted context lacks; and a push for a
   workspace that lost the module is not sent. A module that is `always` costs no query. **Not gated, on purpose:** retention,
   erasure, the purge and both exports, which are the data's lifecycle and apply to a module's rows whoever is granted it (§6);
   `retention` work is the process's own and `entitlement-hooks.integration.test.ts` holds it identical to the module's. *Not built:* a push
   held in Deep Work for an inbox notice of a module the workspace has since lost is still sent when Deep Work ends.
10. **The jobs and workers of a module that is a grant are written per workspace, over the SQL form of the same function.** The build
   used to refuse them (`unguardedWorkProblem`) because their work carries no request. `platform/entitled-workspaces.ts` is the
   function as a statement (`closure(requires)` of the module, each member running, not stopped (D-296) and granted: no row
   `off` that counts, then a row `on` that counts or the mode `open`; a row counts until its `valid_until`, judged by the database's
   clock), written once and held to the TS function by `entitled-workspaces.integration.test.ts` over every shape of grant, both
   modes and a stop. A worker or a job is `perWorkspaceWorker(visit)` / `perWorkspaceJob(visit)`: the framework pages through the
   workspaces where the module is effective (a hundred at a time, in id order, reading each page's grants once) and calls `visit` with
   a `WorkspaceScope` that carries the modules the workspace may use (so `ports.of(turn)` is right for it). The module's code never
   sees a workspace it was not given, so it cannot forget: `compose` accepts a work on a grant only if it was made by those
   constructors (a registry of functions they fill, not a flag the author sets), and refuses any other, naming it. A workspace that
   loses the grant, or a module that is stopped, is left out of the next page and so of the next run. `context.entitled.has(column)` is
   the same condition for a sweep's own statement. Chat is `always` and unchanged; `retention` and the other lifecycle jobs stay
   plain and cover un-entitled data. A scheduled job now reads `WORKSPACE_MODULES` (the CLI had composed the build in `open` mode
   whatever the server's setting). *Not done:* the outbox claim still reads the grants in TypeScript (D-288 §11, changed
   elsewhere); it can take the statement when it is next touched.
11. **The records of the cluster are read as what anyone with the Redis can write** (an audit of 2026-11-08, red-team F6). One field
    with no `lapse|` in front of it stopped every node's announcement and turned every withdrawal into `PEERS_BEHIND` until somebody
    deleted it by hand, and a "ghost" field that lapsed in ten years was a peer that never reads grants for as long as it said. The
    scripts now treat a field that is not what a node writes as no node: no lapse, a lapse that is not a number or lies past `now + ttl`
    (no node writes one further ahead, and all use Redis's clock), or a field of more than 4096 characters. The announcing script
    removes such fields and answers how many, which the node says once as a warning (`the shared record of the cluster held fields no
    node writes`); `peersBehind` skips them and counts a capability that is forged the same way as no capability, which is the safe
    side. The bus is read as strictly: a frame is a `ServerFrame`, a topic the contract's grammar with a UUID, an origin the id a
    backplane makes for itself and a count a whole number from one, and what fails is dropped and logged without its content. A
    count that claims a hole sends every socket back to replay; claims within `GAP_REPLAY_MIN_MS` (10 s) of the last are told once
    when it has passed, so a real hole is still replayed and a stream of forged ones costs one replay in ten seconds. *Not
    built:* a limit on how many fields a hash may hold or on who may write at all, which is Redis's own (ACL, TLS, one
    `REDIS_KEY_PREFIX` for each environment; `DEPLOY.md`): a peer with the Redis credentials can still withhold a restriction by
    keeping a node's field alive, as it could by running a node.
12. **The trail of a grant says what it replaced, and the edition file is read as written** (red-team F11, builds on D-292). Each
    `server.module_*` entry records, as columns and never words, the state the row had before (`module_state_before`, none when
    there was no row), the end it set and the end it had (`module_valid_until`, `module_valid_until_before`), and
    `cluster_ready_asserted` when the command ran with `--cluster-ready`, which is the operator's word that every node reads grants
    and which nothing verified: it is warned of at `warn` and recorded with each grant it let through. A file that names one address
    twice in one object is refused with nothing applied (`JSON.parse` keeps the last and says nothing), as is an unknown address
    (already so); the address a tenant registered first is the workspace it finds, so a dry run now prints what each address
    resolved to for the operator to read against their customers. *Not built:* keying the file by workspace id, which would let a
    typo write to the wrong workspace as an address cannot; and showing the new columns in the console's list of the trail.

**Rejected.** *A `modules` column on `workspaces`:* a hot table for one module's concern (D-275), and a column cannot carry an end date,
a source or a writer. *A JSON setting on the server:* not per workspace. *Environment or file with a restart:* an edition sale is
hundreds of workspaces changing in minutes. *A per-request cache with an invalidation message:* a second node would serve a stale grant,
which is a wrong bill or a wrong `404`, and the invalidation is a new class of bug for a read that is one indexed lookup in a statement
that already runs. *A service of its own:* D-7. *Pre-filling every workspace and module:* adding a module would be a data migration.
*Letting each module check its grant:* a check a module can forget is a check that will be forgotten.

**Cost of reversing.** Before a restrictive row exists, none: drop the table's reader and the guard. After, remove the rows (or set
`open`) and every workspace has every module again; nothing was deleted, so nothing is restored.
