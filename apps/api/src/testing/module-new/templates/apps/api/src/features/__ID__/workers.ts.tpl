/**
 * The background loops __ID__ runs inside the API process (`MODULES.md` §9): none. A loop is added here as
 * `{ name, intervalMs, work }`; it runs in the module's share and is cut off at its `workerDeadline`.
 *
 * The module is a grant, so a loop that acts for workspaces is written per workspace: the framework walks the workspaces the
 * module may act for now and calls `visit` for each, never for one that lost the grant or while the administrator has the module
 * stopped (D-289). The build refuses a plain `work` on a grant.
 *
 *   {
 *     name: 'sweep:overdue',
 *     intervalMs: 60_000,
 *     work: perWorkspaceWorker(async (workspace, { database, clock }) => {
 *       // `workspace.workspaceId` is the one to work on; `ports.of(workspace)` is right for it.
 *     }),
 *   },
 *
 * and the loop tells the build something through `inWorkspace(workspace, async (transaction, seam) => { ... })`: `seam.notify`
 * (a kind this module declares under `notifications`; no actor) and `seam.publishFact` (a type it lists under `publishes`) are written in
 * that transaction as this module, and the notice is announced after the commit. A fact consumer is handed the same `seam` as its
 * fourth argument.
 */
import type { ModuleWorker } from '../../modules/workers/module-workers';

export const __CAMEL__Workers: readonly ModuleWorker[] = [];
