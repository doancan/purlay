# D-292. Only the server's administrator writes a workspace's grants, through one service every writer calls — builds on D-278, D-289

**Context.** D-289 made a table, a mode and a function. Nothing yet says who may change a row, how a change is made safe to repeat,
and what the cluster does while a node that has never heard of the table is still serving. A workspace's grant is what a customer
pays for, so the writer is a commercial authority and its rules are decided here, not left to each caller.

**Decision.**

1. **One service, `applyEntitlements`** (`modules/entitlements/apply.ts`), in the caller's transaction. Every writer is a caller of
   it: the administration console's route, the command that reads an edition file, and a billing system if one is ever built, which
   would call it as an actor of its own and need no table of its own. It refuses, before it writes, a module the build does not
   carry, one no workspace is granted (`entitlement: 'always'`, chat for now), an end that has passed or is given to a removal, and a
   workspace that is not there; and it refuses `409 MODULE_REQUIRES` a grant that would leave a module without one it requires,
   judged on what the table would hold after the whole batch, so the order of a batch does not matter. It plans first and writes
   after, so a refusal leaves nothing whoever owns the transaction.
2. **Only the server administrator.** `POST /api/server/workspaces/:workspaceId/modules` is behind the same guard as the rest of
   `/api/server`, guard before parsing, and a workspace's owner is refused as a stranger is: the answer for a person who is not the
   administrator is one answer. The administrator's lock (`lockServerAdministrator`) is taken first, so an administrator demoted a
   moment ago writes nothing.
3. **A repeat is not a change.** A write that says what the row already says (the same state, the same end) writes nothing,
   records nothing and tells nobody; removing a row that is not there is the same. A command run twice, or a retried request, is
   the same as once.
4. **Every change is on the server's trail, by id.** `server.module_granted`, `server.module_withdrawn` and `server.module_reset`,
   each with the workspace and the module (`server_audit_log.target_module`), in the transaction of the change, and no value beyond
   what the action says (D-222). The row also names the administrator and a label of who wrote it (`operator`, `file:<name>`).
5. **The members are told after the commit.** `WORKSPACE_UPDATED` to each member, so an open page reads its session again and the
   rail follows; a page that misses it is corrected by its first `404` as for a module a rolling deploy stopped (D-255).
6. **A restrictive write waits for the cluster.** Withdrawing a module, or running a server `managed`, is refused
   `409 PEERS_BEHIND` while a live peer does not advertise that it reads grants, because that peer would serve the module to every
   workspace. Granting is never refused for it. The roll finishes first and the restriction follows; `DEPLOY.md` says so. The edition command cannot see the cluster (only the serving process holds the link to Redis), so on a server with `REDIS_URL` it asks the operator to say `--cluster-ready` before it takes anything away. That word is the operator's and nothing verifies it: the command warns of it and the trail records it (D-289 §12).

**Rejected.** *A workspace owner who can switch their own modules:* the gate would be a button in the customer's hands. *A row per
edition:* the edition is a name in a file and nothing in the table (D-289); the table says modules. *Writing the trail after the
commit:* a change with no entry is the failure this exists to prevent. *Checking `MODULE_REQUIRES` on read only:* a grant would
be accepted that does nothing, and the operator would believe it had.

**Cost of reversing.** The route and the command are additive and can be removed; rows already written keep working, and the
trail's three actions stay readable.
