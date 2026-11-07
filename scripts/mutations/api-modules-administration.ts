// Area api-modules-administration: ids ascending; areas.ts says what belongs here.
import type { Mutation } from '../mutate';

export const API_MODULES_ADMINISTRATION: readonly Mutation[] = [
  {
    id: 'workspace-list-shows-a-row-that-has-run-out',
    why: 'the console shows a grant that ended as if it still held, so what it says and what the server does differ (D-289)',
    file: 'apps/api/src/modules/administration/inventory.ts',
    find: 'row.valid_until === null || new Date(row.valid_until) > now',
    replace: 'true',
    tests: ['apps/api/src/ingress/http/server.integration.test.ts'],
  },
];
