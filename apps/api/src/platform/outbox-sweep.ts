/**
 * `sweep:outbox` (`MODULES.md` §4, D-288 §9): the outbox keeps a delivery as long as someone may want to see it and no longer, so
 * the table of transient rows stays the size of what is in flight. It runs in every process whichever modules run, because the
 * rows are there whether or not their consumer is: a fact held for a module that stays off is given up on at its expiry.
 *
 * - delivered or skipped: gone a day after they ended;
 * - dead or discarded: kept `deadKeptDays` (a hundred and eighty unless the operator says; D-288 §12), to be looked at, requeued or
 *   answered for. A dead fact is a business fact that was not delivered, so it is never taken silently after a month;
 *   the overview and the `purlay_outbox_dead` gauge say they are there;
 * - pending and past `expires_at`: deleted, a fact nobody came for in the days its declaration allows, and added in the same
 *   statement to `outbox_expired` by consumer and fact type: `purlay_outbox_expired_total` and its alert say a fact was given up on,
 *   which the log line of a job in another process would not (D-353).
 *
 * In batches of one statement each, so a long backlog is a loop and not one long lock on a table the claim reads.
 */
import { sql, type Executor } from '@purlay/db';
import { DAY_MS, type Clock } from './clock';

const OUTBOX_FINISHED_KEPT_DAYS = 1;
/** How long a dead or discarded fact is kept unless `OUTBOX_DEAD_KEPT_DAYS` (`CONFIG.md`) says otherwise: the default, and the figure the documents state. */
export const OUTBOX_DEAD_KEPT_DAYS = 180;
const SWEEP_BATCH = 5_000;

/** What a sweep took, by the rule that took it. */
export type SweptOutbox = Readonly<Record<'finished' | 'dead' | 'discarded' | 'expired', number>>;

/**
 * One batch of the pending rows past their expiry, deleted and counted in one statement: a fact is in `outbox_expired` exactly when it
 * is gone from `outbox`, whatever stops the sweep. Returns how many it took.
 */
const sweepExpired = async (database: Executor, now: Date): Promise<number> => {
  const { rows } = await sql<{ taken: string }>`
    with gone as (
      delete from outbox where id in (
        select id from outbox where state = 'pending' and expires_at <= ${now} limit ${SWEEP_BATCH}
      ) returning consumer, type
    ), counted as (
      select consumer, type, count(*) as taken from gone group by consumer, type
    ), added as (
      insert into outbox_expired (consumer, type, expired, last_expired_at)
      select consumer, type, taken, ${now} from counted
      on conflict (consumer, type) do update
        set expired = outbox_expired.expired + excluded.expired, last_expired_at = excluded.last_expired_at
    )
    select coalesce(sum(taken), 0) as taken from counted`.execute(database);
  return Number(rows[0]?.taken ?? 0);
};

export const sweepOutbox = async (dependencies: {
  readonly database: Executor;
  readonly clock: Clock;
  /** `OUTBOX_DEAD_KEPT_DAYS`: how long a dead or discarded fact is kept. */
  readonly deadKeptDays: number;
}): Promise<SweptOutbox> => {
  const { database, clock, deadKeptDays } = dependencies;
  const now = clock.now();
  const finishedBefore = new Date(now.getTime() - OUTBOX_FINISHED_KEPT_DAYS * DAY_MS);
  const deadBefore = new Date(now.getTime() - deadKeptDays * DAY_MS);

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
    discarded: await untilShort(async () =>
      deleted(
        await database
          .deleteFrom('outbox')
          .where(
            'id',
            'in',
            database
              .selectFrom('outbox')
              .select('id')
              .where('state', '=', 'discarded')
              .where('finished_at', '<', deadBefore)
              .limit(SWEEP_BATCH),
          )
          .executeTakeFirstOrThrow(),
      ),
    ),
    expired: await untilShort(async () => await sweepExpired(database, now)),
  };
};
