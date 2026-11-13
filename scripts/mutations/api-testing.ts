// Area api-testing: ids ascending; areas.ts says what belongs here.
import type { Mutation } from '../mutate';

export const API_TESTING: readonly Mutation[] = [
  {
    id: 'workspace-cohort-confirms-nonbudget-failure',
    why: 'A process, stale receipt or functional failure gets another attempt, hiding a broken guard as measurement noise (D-227).',
    file: 'apps/api/src/testing/workspace-delivery-measurements.ts',
    find: '          if (!(error instanceof CohortBudgetExceeded)) throw error;\n',
    replace: '',
    tests: ['apps/api/src/testing/workspace-delivery-measurements.test.ts'],
  },
  {
    id: 'workspace-cohort-skips-confirmation',
    why: 'An over-budget first result is forgiven without a second real complete measurement, so a slowdown that repeats can pass (D-227).',
    file: 'apps/api/src/testing/workspace-delivery-measurements.ts',
    find: "          p95 = await take('confirmation');\n",
    replace: '          p95 = error.p95Ms;\n',
    tests: ['apps/api/src/testing/workspace-delivery-measurements.test.ts'],
  },
];
