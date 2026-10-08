/**
 * How many frames a connection may send (`ARCHITECTURE.md` §5.5, §6.2).
 *
 * **A seam, not just a function.** An in-process limiter on N nodes grants N
 * times the quota, so the cloud's several nodes need a shared one (D-25). Callers
 * hold the interface; the in-process bucket below is the only implementation in
 * Phase 0–2, and swapping it is an adapter, not a refactor (D-7).
 *
 * **The numbers are provisional (O-4).** Ten frames a second with a burst of
 * twenty is the working value §5.5 records, and it is generous for what Phase 0
 * sends — messages, subscriptions, pings; typing indicators, the real volume,
 * arrive in Phase 1. What closes O-4 is a measurement, written there.
 */
import type { Clock } from '../platform/clock';

export interface RateLimiter {
  /** Returns false when the caller is over budget. Never throws, never blocks. */
  readonly consume: (key: string, cost?: number) => Promise<boolean>;
  /**
   * Drops what is held for a key nobody will use again. A per-connection key
   * that outlived its connection is memory that grows with every reconnect.
   */
  readonly forget: (key: string) => void;
}

export interface RateBudget {
  /** Sustained rate, in frames per second. */
  readonly perSecond: number;
  /** How many may arrive at once from a connection that has been quiet. */
  readonly burst: number;
}

/** §5.5's working value. Provisional until O-4 is closed by a measurement. */
export const SOCKET_FRAME_BUDGET: RateBudget = { perSecond: 10, burst: 20 };

interface Bucket {
  tokens: number;
  refilledAt: number;
}

/**
 * A token bucket per key, held in this process.
 *
 * A bucket rather than a sliding window because the budget is stated as a rate
 * *and* a burst, which is exactly a bucket's two parameters: it starts full,
 * spends one token a frame, and refills continuously. A sliding window has one
 * parameter and would have to pick which of the two to honour.
 *
 * Resets on restart, which O-4 acknowledges: a restart drops every connection,
 * and each one starts again with a full bucket.
 */
export const inProcessRateLimiter = (clock: Clock, budget: RateBudget): RateLimiter => {
  const buckets = new Map<string, Bucket>();

  return {
    consume: async (key: string, cost = 1): Promise<boolean> => {
      const now = clock.now().getTime();
      const bucket = buckets.get(key) ?? { tokens: budget.burst, refilledAt: now };
      const elapsed = Math.max(0, now - bucket.refilledAt) / 1000;
      bucket.tokens = Math.min(budget.burst, bucket.tokens + elapsed * budget.perSecond);
      bucket.refilledAt = now;

      const allowed = bucket.tokens >= cost;
      if (allowed) bucket.tokens -= cost;
      buckets.set(key, bucket);
      return await Promise.resolve(allowed);
    },
    forget: (key: string): void => {
      buckets.delete(key);
    },
  };
};
