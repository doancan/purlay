/** Where a push that did not go is counted, and under whose name (D-221, D-250 rule 7). */
import type { Counter, PushFailure } from '../../platform/metrics';
import { CORE_OWNER } from '../../platform/module-kit/ownership';

/** Counts `by` pushes lost for `reason`, under `module` (the notice's own) or else the sender's owner. */
export type FailureCount = (reason: PushFailure, by?: number, module?: string) => void;

interface FailureCountDependencies {
  /** Absent, nothing is counted. */
  readonly failures?: Counter<'reason' | 'module'>;
  /** The module whose notices the sender delivers; absent, the core's. */
  readonly owner?: string;
}

export const createFailureCount =
  (dependencies: FailureCountDependencies): FailureCount =>
  (reason, by = 1, module): void => {
    dependencies.failures?.inc({ reason, module: module ?? dependencies.owner ?? CORE_OWNER }, by);
  };
