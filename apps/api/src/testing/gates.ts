/**
 * A transaction held open on purpose, so a test decides the interleaving instead of hoping for it.
 *
 * A race test that fires two calls with `Promise.all` passes when the scheduler happens to run
 * them one after the other — which, for a call that is a few statements long, is most of the
 * time — and so proves nothing about the lock it is named after. Here the first caller finishes
 * its work and then waits, uncommitted, holding every lock it took; the second is started while
 * it waits; the first is released. What the second saw is then decided by the locks alone:
 * remove the lock under test and the second reads what the first has not yet committed.
 *
 * Test-only (`testing/` is out of the production image and lint refuses an import of it).
 */
import type { Atomically } from '../platform/transactions';

export interface Held {
  /** `atomically`, but its body's transaction waits for `release()` before it commits. */
  readonly atomically: Atomically;
  /** Resolves when the body has finished and the transaction is waiting, locks held. */
  readonly holding: Promise<void>;
  readonly release: () => void;
}

/** Wraps `atomically` so that its transaction stays open, after the body, until released. */
export const holdOpen = (atomically: Atomically): Held => {
  let release: () => void = () => undefined;
  let reached: () => void = () => undefined;
  const gate = new Promise<void>((open) => {
    release = open;
  });
  const holding = new Promise<void>((open) => {
    reached = open;
  });
  return {
    holding,
    release,
    atomically: async (body) =>
      await atomically(async (transaction) => {
        const result = await body(transaction);
        reached();
        await gate;
        return result;
      }),
  };
};

/**
 * How long a call that is expected to be *waiting* on a lock is given to show that it is not.
 * A wait is not observable, only its absence is: a call that has not finished after this long
 * while the holder is still open is blocked, and one that has is not. Generous on purpose —
 * a lock that works costs the test this much; a lock that does not is caught either way,
 * because the outcome, not the timing, is what the tests assert.
 */
export const BLOCKED_FOR_MS = 150;
