// Area api-modules-audit: ids ascending; areas.ts says what belongs here.
import type { Mutation } from '../mutate';

export const API_MODULES_AUDIT: readonly Mutation[] = [
  {
    id: 'audit-export-later-page-source-recheck-lost',
    why: 'an in-flight later audit page releases bytes after its exact company source was revoked, borrowing retained independent membership (D-311)',
    file: 'apps/api/src/modules/audit/audit-export.ts',
    find: '          const next = await read(cursor);\n          const reader = await requireTrailReader(executor, context, access);\n',
    replace:
      '          const next = await read(cursor);\n          const reader = { context, delegated: !access.mayRead(context.role) };\n',
    tests: ['apps/api/src/ingress/http/audit-source-handoff.integration.test.ts'],
  },
  {
    id: 'audit-export-not-on-the-trail',
    why: 'somebody takes the whole trail away and the trail cannot say who (D-222)',
    file: 'apps/api/src/modules/audit/audit-export.ts',
    find: "      action: 'audit.exported',\n",
    replace: "      action: 'workspace.exported',\n",
    tests: ['apps/api/src/modules/audit/audit-export.integration.test.ts'],
  },
  {
    id: 'audit-export-reads-ahead',
    why: 'the download reads pages nobody asked for, and a reader who went away still costs the database (D-222)',
    file: 'apps/api/src/modules/audit/audit-export.ts',
    find: '    { highWaterMark: 0 },\n',
    replace: '    { highWaterMark: 1 },\n',
    tests: ['apps/api/src/modules/audit/audit-export.integration.test.ts'],
  },
  {
    id: 'audit-export-runs-a-formula',
    why: 'a display name that starts with = runs as a formula in the spreadsheet the trail is opened in (D-222)',
    file: 'apps/api/src/modules/audit/csv.ts',
    find: "  const defused = FORMULA_START.test(value) ? `'${value}` : value;\n",
    replace: '  const defused = value;\n',
    tests: ['apps/api/src/modules/audit/audit-export.integration.test.ts'],
  },
  {
    id: 'audit-filter-ignores-the-actor',
    why: 'the trail narrowed to one person shows everybody’s acts as theirs (D-222)',
    file: 'apps/api/src/modules/audit/audit.ts',
    find: "    statement = statement.where('audit_log.actor_user_id', '=', filter.actorId);\n",
    replace: "    statement = statement.where('audit_log.actor_user_id', 'is not', null);\n",
    tests: ['apps/api/src/modules/audit/audit-export.integration.test.ts'],
  },
  {
    id: 'audit-filter-takes-an-empty-window',
    why: 'a window that ends where it starts is answered as an empty trail instead of refused (D-222)',
    file: 'apps/api/src/modules/audit/audit.ts',
    find: '  if (from !== undefined && to !== undefined && from >= to) {\n',
    replace: '  if (from !== undefined && to !== undefined && from > to) {\n',
    tests: ['apps/api/src/modules/audit/audit-export.integration.test.ts'],
  },
  {
    id: 'audit-trail-cursor-ignored',
    why: 'the next page of the trail is the first one again, and anything older can never be read',
    file: 'apps/api/src/modules/audit/audit.ts',
    find: "  if (page.before !== undefined) statement = statement.where('audit_log.id', '<', page.before);\n",
    replace: '',
    tests: ['apps/api/src/modules/audit/audit.integration.test.ts'],
  },
  {
    id: 'audit-trail-not-append-only',
    why: 'a service rewrites the audit trail, which is then no record of what happened (I-9)',
    file: 'apps/api/src/modules/audit/audit.ts',
    find: "    .insertInto('audit_log')\n",
    replace: "    .deleteFrom('audit_log')\n",
    tests: ['apps/api/src/modules/audit/append-only.test.ts'],
  },
  {
    id: 'audit-trail-read-by-a-member',
    why: 'any member reads who removed whom and who was made an admin',
    file: 'apps/api/src/modules/audit/audit.ts',
    find: "  await requireWorkspaceCapabilityNow(executor, current, 'audit.read');\n",
    replace:
      "  if (current.userId.length === 0) await requireWorkspaceCapabilityNow(executor, current, 'audit.read');\n",
    tests: ['apps/api/src/modules/audit/audit.integration.test.ts'],
  },
  {
    id: 'server-trail-rewritten',
    why: 'the server’s trail is written with a delete first: it is no longer append-only',
    file: 'apps/api/src/modules/audit/server-audit.ts',
    find: "  const id = messageId(now);\n  await executor\n    .insertInto('server_audit_log')",
    replace:
      "  const id = messageId(now);\n  await executor.deleteFrom('server_audit_log').where('actor_user_id', '=', entry.actorUserId).execute();\n  await executor\n    .insertInto('server_audit_log')",
    tests: ['apps/api/src/modules/audit/append-only.test.ts'],
  },
  {
    id: 'trail-shows-what-the-role-cannot-read',
    why: 'a row whose reading permission the role lacks is in its page all the same, so a module’s own read permission hides nothing (D-222)',
    file: 'apps/api/src/modules/audit/audit.ts',
    find: '  if (unreadable.length > 0) {',
    replace: '  if (false as boolean) {',
    tests: ['apps/api/src/modules/audit/audit.integration.test.ts'],
  },
];
