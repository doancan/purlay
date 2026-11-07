/**
 * Issues, as a module (D-254, `MODULES.md` §11): the second one, with a migration set of its own, so its table exists
 * only where the set was applied. It contributes to the places the core leaves open what it has: what an erased
 * account leaves of it, what a deleted workspace's purge takes, and the tables of the two exports.
 *
 * **Held whether or not it runs**, as every bundled module's data is (`composition.ts`): where the set was applied and the
 * module was then turned off, a deleted workspace's titles and bodies are still purged, an export still holds them, and
 * an erased account is still taken off its assignments. Where the set was never applied there is no table, and each hook
 * asks `tableExists` at the moment it needs it (the purge does so for every table it names, the exports through
 * `ownSet`, which asks `tableExists` for them). `module-lifecycle.integration.test.ts` runs every step in every database state and process.
 */
import { tableExists } from '@purlay/db';
import { ISSUES_AUDIT_ACTIONS, ISSUES_NOTIFICATION_KINDS } from '@purlay/types';
import type { WorkspacePurge } from '../../modules/workspaces/deletion-purge';
import { issuesBudget } from './budget';
import type { PermissionDeclaration } from '../../platform/module-kit/manifest';
import { ISSUES_DELETE_ANY } from './issues';
import { issuesExport } from './export';
import { issuesRoutes } from './http/routes';
import { issuesPersonalExport } from './personal-export';
import { issuesSearchSource } from './search';
import type { IssuesTx } from './schema';

/**
 * An erased account's issues stay, under the anonymised person, as a message does (D-139 §5): the workspace's. What
 * goes is the assignment, which means nothing to a person who is no longer there to do it.
 */
const unassignErasedPerson = async (transaction: IssuesTx, userId: string): Promise<void> => {
  if (!(await tableExists(transaction, 'issues'))) return;
  await transaction
    .updateTable('issues')
    .set({ assignee_id: null })
    .where('assignee_id', '=', userId)
    .execute();
};

/** The purge takes the workspace's issues with the tables that still name it, once its content is gone. */
const issuesWorkspacePurge: WorkspacePurge = { before: [], after: [], tables: ['issues'] };

export const issuesModule = {
  manifest: {
    id: 'issues',
    requires: [],
    optional: [],
    provides: [],
    // A third of the pool, so that a module whose queries are slow cannot make chat's sends queue (`budget.ts`).
    budget: { poolShare: issuesBudget },
    // Past its own queue (1 s) and statement limit (5 s), well under the default: a list of issues is not a long request.
    deadline: { ms: 8_000 },
    routes: ['/api/workspaces/:workspaceId/issues', '/api/workspaces/:workspaceId/issues/**'],
    jobs: [],
    permissions: [
      { name: ISSUES_DELETE_ANY, minimumRole: 'admin' },
    ] satisfies readonly PermissionDeclaration[],
    auditActions: [{ read: 'audit.read', actions: ISSUES_AUDIT_ACTIONS }],
    // What the workspace-wide find reads of issues: a title or a body that holds the words.
    searchSources: ['issues'],
    // An assignment tells the assignee, in the core's inbox and in the assignment's transaction (D-286).
    notifications: ISSUES_NOTIFICATION_KINDS,
  },
  userErased: unassignErasedPerson,
  workspacePurge: issuesWorkspacePurge,
  export: issuesExport,
  personalExport: issuesPersonalExport,
  searchSources: [issuesSearchSource],
  routes: issuesRoutes,
};
