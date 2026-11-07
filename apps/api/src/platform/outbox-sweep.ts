/**
 * `sweep:outbox` (`MODULES.md` §4, D-288 §9): the outbox keeps a delivery as long as someone may want to see it and no longer, so
 * the table of transient rows stays the size of what is in flight. It runs in every process whichever modules run, because the
 * rows are there whether or not their consumer is: a fact held for a module that stays off is given up on at its expiry.
 *
 * - delivered or skipped: gone a day after they ended;
 * - dead: kept thirty days, to be looked at (the overview and the `purlay_outbox_dead` gauge say they are there);
 * - pending and past `expires_at`: counted as expired and deleted, a fact nobody came for in the days its declaration allows.
 *
 * In batches of one statement each, so a long backlog is a loop and not one long lock on a table the claim reads.
 */
import type { Executor } from '@purlay/db';
import { DAY_MS, type Clock } from './clock';

export const OUTBOX_FINISHED_KEPT_DAYS = 1;
export const OUTBOX_DEAD_KEPT_DAYS = 30;
const SWEEP_BATCH = 5_000;

/** What a sweep took, by the rule that took it. */
export type SweptOutbox = Readonly<Record<'finished' | 'dead' | 'expired', number>>;

export const sweepOutbox = async (dependencies: {
  readonly database: Executor;
  readonly clock: Clock;
}): Promise<SweptOutbox> => {
  const { database, clock } = dependencies;
  const now = clock.now();
  const finishedBefore = new Date(now.getTime() - OUTBOX_FINISHED_KEPT_DAYS * DAY_MS);
  const deadBefore = new Date(now.getTime() - OUTBOX_DEAD_KEPT_DAYS * DAY_MS);

  // Batches of one statement until one comes back short.
  const untilShort = async (batch: () => Promise<number>): Promise<number> => {
    let removed = 0;
    for (;;) {
      const count = await batch();
      removed += count;
      if (count < SWEEP_BATCH) return removed;
    }
  };
  const deleted = (gone: { readonly numDeletedRows: bigint }): number =>
    Number(gone.numDeletedRows);
  return {
    finished: await untilShort(async () =>
      deleted(
        await database
          .deleteFrom('outbox')
          .where(
            'id',
            'in',
            database
              .selectFrom('outbox')
              .select('id')
              .where('state', 'in', ['delivered', 'skipped'])
              .where('finished_at', '<', finishedBefore)
              .limit(SWEEP_BATCH),
          )
          .executeTakeFirstOrThrow(),
      ),
    ),
    dead: await untilShort(async () =>
      deleted(
        await database
          .deleteFrom('outbox')
          .where(
            'id',
            'in',
            database
              .selectFrom('outbox')
              .select('id')
              .where('state', '=', 'dead')
              .where('finished_at', '<', deadBefore)
              .limit(SWEEP_BATCH),
          )
          .executeTakeFirstOrThrow(),
      ),
    ),
    expired: await untilShort(async () =>
      deleted(
        await database
          .deleteFrom('outbox')
          .where(
            'id',
            'in',
            database
              .selectFrom('outbox')
              .select('id')
              .where('state', '=', 'pending')
              .where('expires_at', '<=', now)
              .limit(SWEEP_BATCH),
          )
          .executeTakeFirstOrThrow(),
      ),
    ),
  };
};
