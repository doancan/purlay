/**
 * Issues, as a module (D-254, `MODULES.md` §11): the second one, with a migration set of its own, so its table
 * exists only where the module has run. It contributes to the places the core leaves open what it has: what an
 * erased account leaves of it, what a deleted workspace's purge takes, and the tables of the two exports.
 *
 * **Held only while it runs** (`dataInCore` is absent): a process that does not run issues does not run these either,
 * because the table may not be there to run them on — `MODULES=chat` is a database that never had it. The consequence,
 * stated where it is decided (D-254): while the module is off, a workspace's purge and the exports leave its issues
 * alone, and an operator who turns it off after using it, and deletes a workspace meanwhile, runs the purge with the
 * module on to have it erased.
 */
import type { Transaction } from '@purlay/db';
import type { WorkspacePurge } from '../../modules/workspaces/deletion-purge';
import { issuesExport } from './export';
import { issuesPersonalExport } from './personal-export';

/**
 * An erased account's issues stay, under the anonymised person, as a message does (D-139 §5): the workspace's. What
 * goes is the assignment, which means nothing to a person who is no longer there to do it.
 */
const unassignErasedPerson = async (transaction: Transaction, userId: string): Promise<void> => {
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
    routes: ['/api/workspaces/:workspaceId/issues', '/api/workspaces/:workspaceId/issues/**'],
    jobs: [],
  },
  userErased: unassignErasedPerson,
  workspacePurge: issuesWorkspacePurge,
  export: issuesExport,
  personalExport: issuesPersonalExport,
};
