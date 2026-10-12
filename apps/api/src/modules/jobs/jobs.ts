/**
 * The scheduled jobs (D-30): run from the command line by an external scheduler, never by a timer
 * in the API, so a second node does not run them twice. Each is safe to run again tomorrow.
 *
 * **Every run is recorded** in `job_runs` (`SCHEMA.md` §9.2) — when it started, when it last
 * succeeded, how long it took, and on failure its message and how many times in a row — because the
 * known weakness of external scheduling is the cron nobody installed, and a job whose absence is
 * invisible is a job that will be absent. A failure is recorded, logged at `error` and thrown on, so
 * the process exits non-zero and the scheduler sees it too.
 */
import { sql, type Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import type { ObjectStore } from '../../platform/storage';
import { atomicallyOn } from '../../platform/transactions';
import { removeLeftovers } from '../attachments/uploads';

/** An upload nobody has sent after a day is not going to be: the composer sends at once (D-109 §5). */
export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
/** Rows one statement of the sweep takes, so a backlog is a loop and not one long lock. */
const ORPHAN_BATCH = 500;
/** What a failure's message may take of the row: the rest is the log's (§9.2). */
const ERROR_MAX = 500;

export interface JobDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
}

/** What a job did, in counts: logged with its end, never anybody's data. */
type Outcome = Readonly<Record<string, number>>;

export const runJob = async (
  dependencies: JobDependencies,
  name: string,
  work: () => Promise<Outcome>,
): Promise<Outcome> => {
  const { database, clock, log } = dependencies;
  const started = clock.now();
  await database
    .insertInto('job_runs')
    .values({ job_name: name, last_started_at: started })
    .onConflict((conflict) => conflict.column('job_name').doUpdateSet({ last_started_at: started }))
    .execute();
  try {
    const outcome = await work();
    const ended = clock.now();
    const durationMs = ended.getTime() - started.getTime();
    await database
      .updateTable('job_runs')
      .set({
        last_success_at: ended,
        last_duration_ms: durationMs,
        last_error: null,
        consecutive_failures: 0,
      })
      .where('job_name', '=', name)
      .execute();
    log.info('a scheduled job finished', { job: name, durationMs, ...outcome });
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await database
      .updateTable('job_runs')
      .set({
        last_duration_ms: clock.now().getTime() - started.getTime(),
        last_error: message.slice(0, ERROR_MAX),
        consecutive_failures: sql<number>`consecutive_failures + 1`,
      })
      .where('job_name', '=', name)
      .execute();
    log.error('a scheduled job failed', { job: name, error });
    throw error;
  }
};

/**
 * `sweep:orphans`: unsent uploads older than a day, their rows and then their objects. The delete
 * says `message_id IS NULL` itself, so an upload a send links while the sweep runs is re-read and
 * kept, not taken from the message.
 */
export const sweepOrphans = async (
  dependencies: JobDependencies & { readonly storage: ObjectStore },
): Promise<{ removed: number; leftBehind: number }> => {
  const { database, clock, storage, log } = dependencies;
  const cutoff = new Date(clock.now().getTime() - ORPHAN_AGE_MS);
  let removed = 0;
  let leftBehind = 0;
  for (;;) {
    const gone = await database
      .deleteFrom('attachments')
      .where('message_id', 'is', null)
      .where(
        'id',
        'in',
        database
          .selectFrom('attachments')
          .select('id')
          .where('message_id', 'is', null)
          .where('created_at', '<', cutoff)
          .orderBy('id')
          .limit(ORPHAN_BATCH),
      )
      .returning(['storage_key', 'thumbnail_key'])
      .execute();
    removed += gone.length;
    leftBehind += await removeLeftovers(
      storage,
      log,
      gone.flatMap((row) =>
        row.thumbnail_key === null ? [row.storage_key] : [row.storage_key, row.thumbnail_key],
      ),
    );
    if (gone.length < ORPHAN_BATCH) return { removed, leftBehind };
  }
};

/**
 * `reconcile:storage` (I-7): each workspace's `storage_used_bytes` put back to the bytes its
 * messages carry. Its row is locked before the sum is read, so a send that links an upload either
 * committed its increment first or waits and adds it after — a drift is never made by the cure.
 */
export const reconcileStorage = async (dependencies: {
  readonly database: Executor;
  readonly log: Logger;
}): Promise<{ workspaces: number; corrected: number }> => {
  const { database, log } = dependencies;
  const ids = await database.selectFrom('workspaces').select('id').orderBy('id').execute();
  let corrected = 0;
  for (const { id } of ids) {
    const moved = await atomicallyOn(database)(async (transaction) => {
      const { storage_used_bytes: before } = await transaction
        .selectFrom('workspaces')
        .select('storage_used_bytes')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const { bytes: after } = await transaction
        .selectFrom('attachments')
        .select(sql<string>`coalesce(sum(size_bytes), 0)::text`.as('bytes'))
        .where('workspace_id', '=', id)
        .where('message_id', 'is not', null)
        .executeTakeFirstOrThrow();
      if (BigInt(before) === BigInt(after)) return null;
      await transaction
        .updateTable('workspaces')
        .set({ storage_used_bytes: after })
        .where('id', '=', id)
        .execute();
      return { before, after };
    });
    if (moved !== null) {
      corrected += 1;
      log.warn('a workspace’s storage count had drifted, and was put back', {
        workspaceId: id,
        ...moved,
      });
    }
  }
  return { workspaces: ids.length, corrected };
};
