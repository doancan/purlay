// Area api-modules-find: ids ascending; areas.ts says what belongs here.
import type { Mutation } from '../mutate';

export const API_MODULES_FIND: readonly Mutation[] = [
  {
    id: 'find-answers-more-than-the-limit',
    why: 'a source that answers more than it was asked for is passed on whole, so the find is as long as the source cares to make it (D-285)',
    file: 'apps/api/src/modules/find/find.ts',
    find: 'hits: outcome.slice(0, limit)',
    replace: 'hits: [...outcome]',
    tests: ['apps/api/src/modules/find/find.integration.test.ts'],
  },
  {
    id: 'find-asks-sources-of-modules-the-workspace-lacks',
    why: 'a workspace that lost a module still finds its things through the search (D-289)',
    file: 'apps/api/src/modules/find/find.ts',
    find: 'filter(({ module }) => entitledTo(context, module));\n  const withheld',
    replace: 'filter(({ module }) => true);\n  const withheld',
    tests: ['apps/api/src/ingress/http/entitlement.integration.test.ts'],
  },
  {
    id: 'find-error-aborts-the-find',
    why: 'a source that throws takes the whole find down with it, so one module’s failure is every module’s (D-285)',
    file: 'apps/api/src/modules/find/find.ts',
    find: "    return { source: source.id, reason: 'error' };",
    replace: '    throw error;',
    tests: ['apps/api/src/modules/find/find.integration.test.ts'],
  },
  {
    id: 'find-module-deadline-ignored',
    why: 'a module that declared a shorter deadline than the find’s is held to the find’s, so its own bound on a request does not hold its search (D-270, D-285)',
    file: 'apps/api/src/modules/find/find.ts',
    find: '  const ms = Math.min(sourceDeadlineMs, deadlineOf(module) ?? sourceDeadlineMs);',
    replace: '  const ms = sourceDeadlineMs;',
    tests: ['apps/api/src/modules/find/find.integration.test.ts'],
  },
  {
    id: 'find-source-deadline-ignored',
    why: 'a source has no deadline worth the name, so one slow module holds the answer of every module and a person waits on the slowest (D-285)',
    file: 'apps/api/src/modules/find/find.ts',
    find: '  const ms = Math.min(sourceDeadlineMs, deadlineOf(module) ?? sourceDeadlineMs);',
    replace: '  const ms = 600_000;',
    tests: ['apps/api/src/modules/find/find.integration.test.ts'],
  },
  {
    id: 'find-source-not-noted-as-its-module',
    why: 'a source runs as nobody, so its statements take the core’s connections and not its module’s share, and a module with a slow search can starve the core (D-266, D-285)',
    file: 'apps/api/src/modules/find/find.ts',
    find: '            module,\n            signal,\n',
    replace: '            signal,\n',
    tests: ['apps/api/src/modules/find/find.integration.test.ts'],
  },
  {
    id: 'find-source-signal-not-passed',
    why: 'a source past its deadline is answered `slow` and its statement goes on in the database, holding its connection (D-270, D-285)',
    file: 'apps/api/src/modules/find/find.ts',
    find: '            module,\n            signal,\n',
    replace: '            module,\n',
    tests: ['apps/api/src/modules/find/find.integration.test.ts'],
  },
];
