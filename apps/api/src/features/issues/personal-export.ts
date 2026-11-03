/**
 * What issues puts in a person's export of their own data (D-241, D-250, D-254): the issues they made, as they stand.
 * Who each was assigned to is somebody else's and stays out; so do the issues others made that name them, which are
 * the workspace's.
 */
import type { RawBuilder } from '@purlay/db';
import {
  ownedBy,
  personalTableExport,
  workspacesOwnedBy,
  type PersonalContribution,
} from '../../modules/export/personal-catalogue';

const tables = [
  personalTableExport(
    'issues',
    {
      id: 'export',
      workspace_id: 'export',
      title: 'export',
      body: 'export',
      status: 'export',
      created_by: 'export',
      created_at: 'export',
      updated_at: 'export',
      // Another person's: who the issue was given to.
      assignee_id: 'omit',
    },
    ownedBy('created_by'),
  ),
] as const;

export const issuesPersonalExport = {
  id: 'issues',
  tables,
  ownSet: ['issues'],
  workspaces: (userId: string): RawBuilder<unknown>[] => [
    workspacesOwnedBy('issues', 'created_by', userId),
  ],
} satisfies PersonalContribution;
