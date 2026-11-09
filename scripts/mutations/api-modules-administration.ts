// Area api-modules-administration: ids ascending; areas.ts says what belongs here.
import type { Mutation } from '../mutate';

export const API_MODULES_ADMINISTRATION: readonly Mutation[] = [
  {
    id: 'outbox-change-drops-the-reason',
    why: 'an entry says that a fact was discarded and not why (D-288 §12)',
    file: 'apps/api/src/modules/administration/outbox.ts',
    find: '      note: input.reason.trim(),\n',
    replace: '',
    tests: ['apps/api/src/ingress/http/server.integration.test.ts'],
  },
  {
    id: 'outbox-change-not-on-the-trail',
    why: 'a fact is discarded and no entry says by whom or why, so the auditor’s question has no answer (D-288 §12)',
    file: 'apps/api/src/modules/administration/outbox.ts',
    find: '  for (const fact of changed)\n',
    replace: '  for (const fact of [] as typeof changed)\n',
    tests: ['apps/api/src/ingress/http/server.integration.test.ts'],
  },
  {
    id: 'outbox-change-skips-the-administrator-recheck',
    why: 'an administrator demoted a moment ago still requeues or discards a fact (D-288 §12, D-292 §2)',
    file: 'apps/api/src/modules/administration/outbox.ts',
    find: '  await lockServerAdministrator(tx, admin);\n  const { verdicts',
    replace: '  const { verdicts',
    tests: ['apps/api/src/ingress/http/server.integration.test.ts'],
  },
  {
    id: 'outbox-inspect-not-on-the-trail',
    why: 'a payload is read and no entry says by whom, so the auditor’s question has no answer (D-288 §12)',
    file: 'apps/api/src/modules/administration/outbox.ts',
    find: "  await recordServerAudit(tx, clock, {\n    actorUserId: admin.userId,\n    action: 'server.fact_inspected',",
    replace:
      "  if (clock.now().getTime() < 0) await recordServerAudit(tx, clock, {\n    actorUserId: admin.userId,\n    action: 'server.fact_inspected',",
    tests: ['apps/api/src/ingress/http/server.integration.test.ts'],
  },
  {
    id: 'outbox-inspect-skips-the-administrator-recheck',
    why: 'an administrator demoted a moment ago still reads a payload (D-288 §12, D-292 §2)',
    file: 'apps/api/src/modules/administration/outbox.ts',
    find: '  await lockServerAdministrator(tx, admin);\n  const fact',
    replace: '  const fact',
    tests: ['apps/api/src/ingress/http/server.integration.test.ts'],
  },
  {
    id: 'workspace-list-shows-a-row-that-has-run-out',
    why: 'the console shows a grant that ended as if it still held, so what it says and what the server does differ (D-289)',
    file: 'apps/api/src/modules/administration/inventory.ts',
    find: 'row.valid_until === null || new Date(row.valid_until) > now',
    replace: 'true',
    tests: ['apps/api/src/ingress/http/server.integration.test.ts'],
  },
];
