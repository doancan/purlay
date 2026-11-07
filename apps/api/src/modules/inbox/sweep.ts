/**
 * `sweep:inbox` (D-286): the inbox keeps a notice that was read for 30 days and every notice for 180, so a person who never
 * opens it does not leave a table that only grows. It runs in every process whichever modules run, because the rows are
 * there whether or not the module that wrote them is: a notice of a module that is off is hidden, not kept for ever.
 *
 * In batches of one statement each, so a long backlog is a loop and not one long lock on a table people read.
 */
import type { Executor } from '@purlay/db';
import { DAY_MS, type Clock } from '../../platform/clock';

export const INBOX_READ_KEPT_DAYS = 30;
export const INBOX_KEPT_DAYS = 180;
const SWEEP_BATCH = 1_000;

export const sweepInbox = async (dependencies: {
  readonly database: Executor;
  readonly clock: Clock;
}): Promise<{ removed: number }> => {
  const { database, clock } = dependencies;
  const now = clock.now().getTime();
  const readBefore = new Date(now - INBOX_READ_KEPT_DAYS * DAY_MS);
  const createdBefore = new Date(now - INBOX_KEPT_DAYS * DAY_MS);
  let removed = 0;
  for (;;) {
    const gone = await database
      .deleteFrom('inbox_entries')
      .where(
        'id',
        'in',
        database
          .selectFrom('inbox_entries')
          .select('id')
          .where((entry) =>
            entry.or([entry('read_at', '<', readBefore), entry('created_at', '<', createdBefore)]),
          )
          .limit(SWEEP_BATCH),
      )
      .executeTakeFirst();
    const count = Number(gone.numDeletedRows);
    removed += count;
    if (count < SWEEP_BATCH) return { removed };
  }
};
