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
import { DAY_MS, type Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import type { ObjectStore } from '../../platform/storage';
import { atomicallyOn } from '../../platform/transactions';
import { drainObjectDeletions, enqueueObjectDeletions } from '../attachments/deletions';
import { sweepAdminVerification } from '../setup/verification';

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
  try {
    await database
      .insertInto('job_runs')
      .values({ job_name: name, last_started_at: started })
      .onConflict((conflict) =>
        conflict.column('job_name').doUpdateSet({ last_started_at: started }),
      )
      .execute();
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
    // Said first: recording it needs the database, which may be what failed.
    log.error('a scheduled job failed', { job: name, error });
    await database
      .updateTable('job_runs')
      .set({
        last_duration_ms: clock.now().getTime() - started.getTime(),
        last_error: message.slice(0, ERROR_MAX),
        consecutive_failures: sql<number>`consecutive_failures + 1`,
      })
      .where('job_name', '=', name)
      .execute()
      .catch((recording: unknown) => {
        log.error('a failed job could not be recorded', { job: name, error: recording });
      });
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
    // The rows and their keys' place in the queue, together (D-141).
    const { count, keys } = await atomicallyOn(database)(async (transaction) => {
      const gone = await transaction
        .deleteFrom('attachments')
        .where('message_id', 'is', null)
        .where(
          'id',
          'in',
          transaction
            .selectFrom('attachments')
            .select('id')
            .where('message_id', 'is', null)
            .where('created_at', '<', cutoff)
            .orderBy('id')
            .limit(ORPHAN_BATCH),
        )
        .returning(['storage_key', 'thumbnail_key'])
        .execute();
      const named = gone.flatMap((row) =>
        row.thumbnail_key === null ? [row.storage_key] : [row.storage_key, row.thumbnail_key],
      );
      await enqueueObjectDeletions(transaction, named);
      return { count: gone.length, keys: named };
    });
    removed += count;
    leftBehind += await drainObjectDeletions(
      { atomically: atomicallyOn(database), storage, log },
      keys,
    );
    if (count < ORPHAN_BATCH) return { removed, leftBehind };
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

/**
 * `sweep:link-previews` (D-23): the unfurl cache past its expiry. The expiry is also enforced where
 * the cache is read, so a sweep that did not run serves nothing stale — it only lets the table grow.
 */
export const sweepLinkPreviews = async (dependencies: {
  readonly database: Executor;
  readonly clock: Clock;
}): Promise<{ removed: number }> => {
  const result = await dependencies.database
    .deleteFrom('link_previews')
    .where('expires_at', '<=', dependencies.clock.now())
    .executeTakeFirst();
  return { removed: Number(result.numDeletedRows) };
};

/** How long a delivery's id is kept: GitHub redelivers only the last three days, so this is a margin. */
export const GITHUB_DELIVERIES_KEPT_DAYS = 30;

/**
 * Forgets the ids of deliveries older than `GITHUB_DELIVERIES_KEPT_DAYS` (D-134 §5): what makes a
 * redelivery post nothing, needed only while GitHub can still send one again — the feeds' and the GitHub
 * App's (D-246) — and, with them, the handshakes of trips to GitHub that were never brought back and the
 * records of creating an issue (D-246 §4). Bounded by
 * the indexes on `received_at` and `expires_at`; idempotent, as every job is (D-30).
 */
export const sweepGitHubDeliveries = async (dependencies: {
  readonly database: Executor;
  readonly clock: Clock;
}): Promise<{ removed: number }> => {
  const before = new Date(
    dependencies.clock.now().getTime() - GITHUB_DELIVERIES_KEPT_DAYS * DAY_MS,
  );
  const feeds = await dependencies.database
    .deleteFrom('github_deliveries')
    .where('received_at', '<', before)
    .executeTakeFirst();
  const app = await dependencies.database
    .deleteFrom('github_app_deliveries')
    .where('received_at', '<', before)
    .executeTakeFirst();
  const over = dependencies.clock.now();
  const trips = await dependencies.database
    .deleteFrom('github_app_handshakes')
    .where('expires_at', '<=', over)
    .executeTakeFirst();
  // The record of creating an issue is as long as a lost answer can still be looked for (D-246 §4).
  const operations = await dependencies.database
    .deleteFrom('github_operations')
    .where('updated_at', '<', before)
    .executeTakeFirst();
  return {
    removed:
      Number(feeds.numDeletedRows) +
      Number(app.numDeletedRows) +
      Number(trips.numDeletedRows) +
      Number(operations.numDeletedRows),
  };
};

/**
 * Sign-in links and their counters, a day past use (D-138, D-179): every row of `verifications` a day
 * after it expired, whatever its identifier — a sign-in link (`magic-link:`) opens for fifteen minutes, a
 * reset or the state of an abandoned GitHub round trip (with its PKCE verifier) for less than an hour, and a
 * day is a margin, not a reader — and `rate_limits` rows whose
 * `last_request` is more than a day old: the library's (a client address and a path) are a day past
 * any window it keeps, and Purlay's sign-in counters hold when their hour closes, so theirs is a day
 * closed. A row that has not expired is never touched. And the
 * setup administrator's address link once its day is over (`sweepAdminVerification`), and the invitation
 * passports a day past their hour or their use (D-179 §5).
 */
export const sweepEmailSignIns = async (dependencies: {
  readonly database: Executor;
  readonly clock: Clock;
}): Promise<{ removed: number }> => {
  const before = new Date(dependencies.clock.now().getTime() - DAY_MS);
  const links = await dependencies.database
    .deleteFrom('verifications')
    .where('expires_at', '<', before)
    .executeTakeFirst();
  const counters = await dependencies.database
    .deleteFrom('rate_limits')
    .where('last_request', '<', String(before.getTime()))
    .executeTakeFirst();
  // And the setup administrator's address link once it no longer opens (D-179 §4.3).
  const adminLink = await sweepAdminVerification(dependencies.database, dependencies.clock);
  // And the passports a newcomer's invitation made: none opens past its hour, and a spent one has done its
  // work — a day is a margin for the person who comes back, not a reader.
  const passports = await dependencies.database
    .deleteFrom('invitation_passports')
    .where((eb) => eb.or([eb('expires_at', '<', before), eb('consumed_at', '<', before)]))
    .executeTakeFirst();
  // And the native sign-in codes (D-191): none opens past its two minutes, and a spent one has made its
  // session — a day is a margin for whoever reads the table to see what happened, not for a code.
  const nativeCodes = await dependencies.database
    .deleteFrom('native_authorizations')
    .where('expires_at', '<', before)
    .executeTakeFirst();
  return {
    removed:
      Number(links.numDeletedRows) +
      Number(counters.numDeletedRows) +
      adminLink +
      Number(passports.numDeletedRows) +
      Number(nativeCodes.numDeletedRows),
  };
};
