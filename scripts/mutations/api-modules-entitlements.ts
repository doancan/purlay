// Area api-modules-entitlements: ids ascending; areas.ts says what belongs here.
import type { Mutation } from '../mutate';

export const API_MODULES_ENTITLEMENTS: readonly Mutation[] = [
  {
    id: 'entitlement-restriction-allowed-while-a-peer-is-behind',
    why: 'withdrawing a module is allowed whatever the cluster reads (D-292)',
    file: 'apps/api/src/modules/entitlements/peers.ts',
    find: "write.state === 'off' ||",
    replace: 'false ||',
    tests: ['apps/api/src/modules/entitlements/peers.test.ts'],
  },
  {
    id: 'entitlement-restriction-guessed-when-the-cluster-cannot-be-asked',
    why: 'a restriction is written when Redis cannot say whether every node reads grants (D-292)',
    file: 'apps/api/src/modules/entitlements/peers.ts',
    find: 'behind = await peersBehind();',
    replace: 'behind = await peersBehind().catch(() => 0);',
    tests: ['apps/api/src/modules/entitlements/peers.test.ts'],
  },
  {
    id: 'entitlement-write-accepts-a-module-no-workspace-is-granted',
    why: 'an operator withdraws chat from a workspace, which the sockets cannot honour, and the edition file says it sold what it cannot take back (D-289)',
    file: 'apps/api/src/modules/entitlements/apply.ts',
    find: "    if (carried.entitlement === 'always')\n",
    replace: '    if (false as boolean)\n',
    tests: ['apps/api/src/modules/entitlements/apply.integration.test.ts'],
  },
  {
    id: 'entitlement-write-accepts-a-module-the-build-lacks',
    why: 'a typo in an edition file is stored as a grant for a module nobody has, and nothing says so (D-289)',
    file: 'apps/api/src/modules/entitlements/apply.ts',
    find: '    if (carried === undefined) throw',
    replace: '    if (false as boolean) throw',
    tests: ['apps/api/src/modules/entitlements/apply.integration.test.ts'],
  },
  {
    id: 'entitlement-write-accepts-an-end-that-has-passed',
    why: 'a grant that has already ended is stored, audited and reported as a change (D-289)',
    file: 'apps/api/src/modules/entitlements/apply.ts',
    find: '      if (write.validUntil.getTime() <= now.getTime())',
    replace: '      if (false as boolean)',
    tests: ['apps/api/src/modules/entitlements/apply.integration.test.ts'],
  },
  {
    id: 'entitlement-write-accepts-module-without-its-requires',
    why: 'a module is granted to a workspace that lacks the one it needs, and fails on the first thing it asks of it (D-289)',
    file: 'apps/api/src/modules/entitlements/apply.ts',
    find: '    if (!effective.has(write.module)) {',
    replace: '    if (false as boolean) {',
    tests: ['apps/api/src/modules/entitlements/apply.integration.test.ts'],
  },
  {
    id: 'entitlement-write-records-a-repeat',
    why: 'running the edition file twice, or retrying a request, writes the same row and the same trail entry again (D-289)',
    file: 'apps/api/src/modules/entitlements/apply.ts',
    find: '        row?.state === write.state &&\n',
    replace: '        false &&\n',
    tests: ['apps/api/src/modules/entitlements/apply.integration.test.ts'],
  },
  {
    id: 'workspace-modules-write-skips-audit',
    why: 'an operator changes what a customer may use and the trail does not say so (D-289, D-222)',
    file: 'apps/api/src/modules/entitlements/apply.ts',
    find: '    await recordServerAudit(tx, clock, {\n      actorUserId: actor.userId,\n      action: ACTIONS[write.state],',
    replace:
      '    await (async (): Promise<void> => undefined)({\n      actorUserId: actor.userId,\n      action: ACTIONS[write.state],',
    tests: ['apps/api/src/modules/entitlements/apply.integration.test.ts'],
  },
];
