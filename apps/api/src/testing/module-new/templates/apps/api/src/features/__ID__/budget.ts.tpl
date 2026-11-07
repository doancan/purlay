/**
 * What __ID__ may take from the shared database (`MODULES.md` §7): a share of the pool, so that a module whose queries are
 * slow cannot hold every connection and make chat's sends queue behind it (`platform/module-budget.ts`).
 */
import type { ModuleBudget } from '../../platform/module-budget';

/** A third of the pool: what is left is chat's and the core's. */
const POOL_SHARE_DIVISOR = 3;
/** A request over the share waits this long for a slot, then is told the database is busy and may retry. */
const QUEUE_TIMEOUT_MS = 1_000;
/** Far past any statement of a list or a write to one; under the pool's own limit of thirty seconds. */
const STATEMENT_TIMEOUT_MS = 5_000;

/** A third of a pool of `poolMax`, at least one and never all of it but for a pool of one. */
export const __CAMEL__Budget = (poolMax: number): ModuleBudget => ({
  maxConcurrent: Math.max(1, Math.min(Math.floor(poolMax / POOL_SHARE_DIVISOR), poolMax - 1)),
  queueTimeoutMs: QUEUE_TIMEOUT_MS,
  statementTimeoutMs: STATEMENT_TIMEOUT_MS,
});
