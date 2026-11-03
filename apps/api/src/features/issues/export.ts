/**
 * What issues puts in a workspace's export (D-140, D-250, D-254): every issue of the workspace, whole — an issue is
 * the team's, so nothing of it is a person's own state to leave out. The two people it names are named in the
 * export's people, so a reader can say who made it and who it was for.
 */
import {
  inWorkspace,
  namedInWorkspace,
  tableExport,
  type ExportContribution,
} from '../../modules/export/catalogue';

const tables = [
  tableExport(
    'issues',
    {
      id: 'export',
      workspace_id: 'export',
      title: 'export',
      body: 'export',
      status: 'export',
      assignee_id: 'export',
      created_by: 'export',
      created_at: 'export',
      updated_at: 'export',
    },
    inWorkspace,
  ),
] as const;

/** The tables issues writes into an export. */
export type IssuesWritten = (typeof tables)[number]['name'];

export const issuesExport: ExportContribution = {
  id: 'issues',
  tables,
  people: (scope) => [
    namedInWorkspace('issues', 'created_by', scope),
    namedInWorkspace('issues', 'assignee_id', scope),
  ],
  audit: (rows) => ({ issues: String(rows['issues'] ?? 0) }),
};
