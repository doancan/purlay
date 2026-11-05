/**
 * What chat may take from the shared database (`MODULES.md` §7, D-266): nearly all of what the modules may take
 * together, since chat is the product and the others are kept from slowing it. It is capped so that the core keeps
 * its reserve (`coreReserve`) and issues is left a connection of its own, so no module is starved by chat either.
 * Measured at a pool of ten with chat and issues both saturating their shares: the core's reads kept their p95 of a
 * few tens of milliseconds, where with no cap they waited half a second for a connection (D-266).
 */
import { POOL_DEFAULTS } from '@purlay/db';
import { coreReserve, type ModuleBudget } from '../../platform/module-budget';

/** Chat's sends wait for a connection as long as the pool itself would have let them, so they are no worse off. */
const CHAT_QUEUE_TIMEOUT_MS = POOL_DEFAULTS.connectionTimeoutMs;

/** Never more than the modules may take together less one for the next module, and at least one. */
export const chatBudget = (poolMax: number): ModuleBudget => ({
  maxConcurrent: Math.max(1, poolMax - coreReserve(poolMax) - 1),
  queueTimeoutMs: CHAT_QUEUE_TIMEOUT_MS,
  // The pool's own: chat's statements are not cut shorter than the core's, and a connection need not be told so each time.
  statementTimeoutMs: POOL_DEFAULTS.statementTimeoutMs,
});
