// Area api-modules-quotas: ids ascending; areas.ts says what belongs here.
import type { Mutation } from '../mutate';

export const API_MODULES_QUOTAS: readonly Mutation[] = [
  {
    id: 'quota-change-not-on-the-trail',
    why: 'an operator moves a workspace’s limit and the workspace’s own trail does not say so',
    file: 'apps/api/src/modules/quotas/operate.ts',
    find: "    action: 'quota.changed',\n",
    replace: "    action: 'workspace.exported',\n",
    tests: ['apps/api/src/modules/quotas/quotas.integration.test.ts'],
  },
  {
    id: 'quota-reason-length-unchecked',
    why: 'a reason past what the table holds reaches the database and comes back as a raw error instead of the command’s own words',
    file: 'apps/api/src/modules/quotas/operate.ts',
    find: "  if (reason !== undefined && reason.trim().length > QUOTA_REASON_MAX)\n    return { kind: 'reason-too-long' };\n",
    replace: '',
    tests: ['apps/api/src/modules/quotas/quotas.integration.test.ts'],
  },
  {
    id: 'quota-same-command-writes-again',
    why: 'the same limit set again is written and recorded again, so the trail fills with changes nobody made',
    file: 'apps/api/src/modules/quotas/operate.ts',
    find: 'if (limit === null ? !held : before === limit) {',
    replace: 'if (limit === null ? !held : false) {',
    tests: ['apps/api/src/modules/quotas/quotas.integration.test.ts'],
  },
  {
    id: 'quota-set-without-a-reason',
    why: 'a limit is set with nothing said of why, and the next operator cannot tell what it is for',
    file: 'apps/api/src/modules/quotas/operate.ts',
    find: "  if (limit !== null && (reason === undefined || reason.trim() === ''))\n    return { kind: 'no-reason' };\n",
    replace: '',
    tests: ['apps/api/src/modules/quotas/quotas.integration.test.ts'],
  },
  {
    id: 'quota-trail-carries-the-reason',
    why: 'the operator’s words are copied onto the workspace’s trail, which its members read',
    file: 'apps/api/src/modules/quotas/operate.ts',
    find: '      kind,\n      ...(before === null ? {} : { from: String(before) }),',
    replace:
      '      kind,\n      reason,\n      ...(before === null ? {} : { from: String(before) }),',
    tests: ['apps/api/src/modules/quotas/quotas.integration.test.ts'],
  },
];
