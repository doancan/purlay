/** What __ID__ puts in a workspace's export (D-140): every row of the workspace, whole. */
import type { RawBuilder } from '@purlay/db';
import {
  inWorkspace,
  tableExport,
  type ExportContribution,
} from '../../modules/export/catalogue';

const tables = [
  tableExport(
    '__SNAKE__',
    { id: 'export', workspace_id: 'export', title: 'export', created_at: 'export' },
    inWorkspace,
  ),
] as const;

export const __CAMEL__Export = {
  id: '__ID__',
  tables,
  ownSet: ['__SNAKE__'],
  people: (): RawBuilder<unknown>[] => [],
  audit: (rows: Readonly<Record<string, number>>): Record<string, string> => ({
    __SNAKE__: String(rows['__SNAKE__'] ?? 0),
  }),
} satisfies ExportContribution;
