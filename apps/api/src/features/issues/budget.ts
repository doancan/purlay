/**
 * What issues may take from the shared database (`MODULES.md` §7): a share of the pool, so that a module whose
 * queries are slow cannot hold every connection and make chat's sends queue behind it (`module-budget.ts`).
 * Chat is not budgeted: it is what the others are kept from slowing.
 */
import type { ModuleBudget } from '../../platform/module-budget';

/** A third of the pool: what is left, two thirds, is chat's and the core's. */
const POOL_SHARE_DIVISOR = 3;
/** A request over the share waits this long for a slot, then is told the database is busy and may retry. */
const ISSUES_QUEUE_TIMEOUT_MS = 1_000;
/** Far past any statement of a list of issues or a write to one; under the pool's own limit of thirty seconds. */
const ISSUES_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * The share of a pool of `poolMax` connections: a third, never more than the pool less one so that something is
 * always left for the others, and at least one so that the module can work at all (a pool of one has nothing to
 * leave, and is the one case the second bound gives way).
 */
export const issuesBudget = (poolMax: number): ModuleBudget => ({
  maxConcurrent: Math.max(1, Math.min(Math.floor(poolMax / POOL_SHARE_DIVISOR), poolMax - 1)),
  queueTimeoutMs: ISSUES_QUEUE_TIMEOUT_MS,
  statementTimeoutMs: ISSUES_STATEMENT_TIMEOUT_MS,
});
