// Area api-__ID__: ids ascending; areas.ts says what belongs here.
import type { Mutation } from '../mutate';

export const API___UPPER__: readonly Mutation[] = [
  {
    id: '__ID__-declares-no-budget',
    why: 'the module says it needs no share of the database, so its requests can hold every connection and make chat’s sends queue (D-250 rule 7)',
    file: 'apps/api/src/features/__ID__/module.ts',
    find: 'budget: { poolShare: __CAMEL__Budget },',
    replace: "budget: { none: 'a mutant' },",
    tests: ['apps/api/src/module-budgets.test.ts'],
  },
  {
    id: '__ID__-list-forgets-its-workspace-filter',
    why: 'a list shows a person who belongs to two workspaces the rows of the other one (D-21)',
    file: 'apps/api/src/features/__ID__/items.ts',
    find: "      .where('workspace_id', '=', context.workspaceId)\n",
    replace: '',
    tests: ['apps/api/src/features/__ID__/http/__ID__.integration.test.ts'],
  },
  {
    id: '__ID__-route-skips-membership',
    why: 'the list answers a person who is not in the workspace, which tells a stranger the workspace exists (D-21)',
    file: 'apps/api/src/features/__ID__/http/handlers.ts',
    find: 'const context = await requireWorkspaceMembership(database, userId, workspaceId);\n  return await list',
    replace: 'const context = { workspaceId } as never;\n  void userId;\n  return await list',
    tests: ['apps/api/src/features/__ID__/http/__ID__.integration.test.ts'],
  },
];
