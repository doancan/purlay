// Area api-modules-inbox: ids ascending; areas.ts says what belongs here.
import type { Mutation } from '../mutate';

export const API_MODULES_INBOX: readonly Mutation[] = [
  {
    id: 'sink-accepts-an-undeclared-kind',
    why: 'a module writes a notice of a kind no manifest declares, and a person is told something no screen can say (D-286)',
    file: 'apps/api/src/modules/inbox/sink.ts',
    find: '    if (module === undefined) {\n',
    replace: '    if (module === undefined && false) {\n',
    tests: ['apps/api/src/modules/inbox/sink.integration.test.ts'],
  },
  {
    id: 'sink-adds-a-second-unread-notice',
    why: 'a retried request, or two assignments of one issue, leave the person two unread notices for one thing (D-286)',
    file: 'apps/api/src/modules/inbox/sink.ts',
    find: "          .where('read_at', 'is', null)\n",
    replace: "          .where('read_at', 'is not', null)\n",
    tests: ['apps/api/src/modules/inbox/sink.integration.test.ts'],
  },
  {
    id: 'sink-notifies-a-non-member',
    why: 'a person who left the workspace, or is of another, is told of its issues: a cross-tenant leak through a notice (D-286)',
    file: 'apps/api/src/modules/inbox/sink.ts',
    find: '    if (member === undefined) return undefined;\n',
    replace: '',
    tests: ['apps/api/src/modules/inbox/sink.integration.test.ts'],
  },
  {
    id: 'sink-notifies-the-actor',
    why: 'a person who assigns an issue to themselves is told of their own act, and the badge counts it (D-286)',
    file: 'apps/api/src/modules/inbox/sink.ts',
    find: '    if (notice.recipientId === context.userId) return undefined;\n',
    replace: '',
    tests: ['apps/api/src/modules/inbox/sink.integration.test.ts'],
  },
  {
    id: 'sink-skips-the-params-check',
    why: 'a module writes a body, or more than the table holds, into a notice, and the database refuses it as a 500 or keeps a person’s words (D-286)',
    file: 'apps/api/src/modules/inbox/sink.ts',
    find: '    if (problem !== undefined) throw',
    replace: '    if (problem !== undefined && false) throw',
    tests: ['apps/api/src/modules/inbox/sink.integration.test.ts'],
  },
  {
    id: 'sink-takes-the-module-from-the-caller',
    why: 'a notice is attributed to a module that did not declare its kind, so it would be listed and hidden with the wrong one (D-286)',
    file: 'apps/api/src/modules/inbox/sink.ts',
    find: '        module,\n        kind: notice.kind,\n        actor_id',
    replace: "        module: 'chat',\n        kind: notice.kind,\n        actor_id",
    tests: ['apps/api/src/modules/inbox/sink.integration.test.ts'],
  },
  {
    id: 'sweep-inbox-keeps-the-oldest',
    why: 'a notice nobody reads stays for ever and the table only grows (D-286)',
    file: 'apps/api/src/modules/inbox/sweep.ts',
    find: "entry('created_at', '<', createdBefore)",
    replace: "entry('created_at', '<', new Date(0))",
    tests: ['apps/api/src/modules/inbox/sweep.integration.test.ts'],
  },
  {
    id: 'sweep-inbox-keeps-what-was-read-long-ago',
    why: 'what a person read months ago is kept as long as what they never opened (D-286)',
    file: 'apps/api/src/modules/inbox/sweep.ts',
    find: "entry('read_at', '<', readBefore)",
    replace: "entry('read_at', '<', new Date(0))",
    tests: ['apps/api/src/modules/inbox/sweep.integration.test.ts'],
  },
];
