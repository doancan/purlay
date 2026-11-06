/**
 * A module's scheduled job runs in the share of the pool its module declared, against the deadline its manifest gives, and a
 * failure of it is its own (`MODULES.md` §7, D-274), on a real database and a pool of its own.
 *
 * A job is made to wait without a clock: `pg_sleep` on a leased connection, which the database reports in `pg_stat_activity`
 * while it runs, so that a cancellation is seen on the server and not assumed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
  type DatabasePool,
} from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { ModuleBudget } from '../../platform/module-budget';
import { aRecordingLogger, NOW } from '../../testing/doubles';
import { jobFamilies, readJobRuns } from './metrics';
import { scheduledJobRunner } from './module-shares';

const POOL = 4;
const TEST_MS = 60_000;
const SHARE: ModuleBudget = { maxConcurrent: 1, queueTimeoutMs: 300, statementTimeoutMs: 30_000 };
const DEADLINE_MS = 500;

const manifests = [
  {
    id: 'slow',
    budget: { poolShare: (): ModuleBudget => SHARE },
    jobDeadline: { ms: DEADLINE_MS },
  },
  { id: 'other', budget: { poolShare: (): ModuleBudget => SHARE }, jobDeadline: { ms: 30_000 } },
  {
    id: 'patient',
    budget: { poolShare: (): ModuleBudget => SHARE },
    jobDeadline: { none: 'a test of a job nothing stops' },
  },
] as const;

const OWNERS: Readonly<Record<string, string>> = {
  'slow:job': 'slow',
  'slow:again': 'slow',
  'other:job': 'other',
  'other:again': 'other',
  'patient:job': 'patient',
  'core:job': 'core',
};

let cloned: ClonedDatabase;
const logged = aRecordingLogger();
let run: ReturnType<typeof scheduledJobRunner>;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  run = scheduledJobRunner({
    database: cloned.db,
    clock: fixedClock(NOW),
    log: logged.log,
    manifests,
    poolMax: POOL,
    ownerOf: (job) => OWNERS[job] ?? 'core',
  });
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const sleeping = async (
  seconds: number,
  database: DatabasePool,
): Promise<Record<string, number>> => {
  await sql`select pg_sleep(${seconds})`.execute(database);
  return { slept: seconds };
};

/** Statements of the test's pool that are still sleeping on the server: what a deadline is meant to have ended. */
const sleepersOnServer = async (): Promise<number> =>
  Number(
    (
      await sql<{ n: string }>`select count(*)::text as n from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and state = 'active' and query ilike '%pg_sleep%'`.execute(cloned.db)
    ).rows[0]?.n ?? '0',
  );

const untilNoSleepers = async (): Promise<void> => {
  const gone = performance.now() + 3_000;
  while ((await sleepersOnServer()) > 0) {
    if (performance.now() > gone) throw new Error('a statement was left sleeping on the server');
    await Bun.sleep(25);
  }
};

const rowOf = async (
  job: string,
): Promise<{ consecutive_failures: number; last_error: string | null } | undefined> =>
  await cloned.db
    .selectFrom('job_runs')
    .select(['consecutive_failures', 'last_error'])
    .where('job_name', '=', job)
    .executeTakeFirst();

describe('integration: a module’s scheduled job', () => {
  test(
    'that holds its connection past the module’s deadline is cancelled on the server, recorded as a failure with the module, and gives its share back',
    async () => {
      const started = performance.now();
      const ok = await run('slow:job', async (database) => await sleeping(30, database));
      const took = performance.now() - started;
      expect(ok).toBe(false);
      expect(took).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
      expect(took).toBeLessThan(5_000);
      await untilNoSleepers();
      expect(await rowOf('slow:job')).toMatchObject({ consecutive_failures: 1 });
      expect((await rowOf('slow:job'))?.last_error).toContain('deadline');
      expect(
        logged.lines.some(
          (line) =>
            line['msg'] === 'a scheduled job failed' &&
            line['job'] === 'slow:job' &&
            line['module'] === 'slow',
        ),
      ).toBe(true);
      // The slot and the connection came back: the module's next job runs, and the failures start again from none.
      expect(await run('slow:job', async () => await Promise.resolve({ done: 1 }))).toBe(true);
      expect(await rowOf('slow:job')).toMatchObject({ consecutive_failures: 0 });
    },
    TEST_MS,
  );

  test(
    'that waits on something that is not the database is ended at its deadline too, and what it asks of the database after is refused',
    async () => {
      let askedAfter: unknown = 'not asked';
      const ok = await run('slow:job', async (database) => {
        await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS + 300));
        askedAfter = await sql`select 1`.execute(database).catch((error: unknown) => error);
        return {};
      });
      expect(ok).toBe(false);
      await Bun.sleep(DEADLINE_MS);
      expect(askedAfter).toBeInstanceOf(Error);
    },
    TEST_MS,
  );

  test(
    'that throws is a failure of its own: logged with its module, counted, its connection and share given back, the process untouched',
    async () => {
      const before = (await rowOf('slow:again'))?.consecutive_failures ?? 0;
      const ok = await run('slow:again', async (database) => {
        await database.transaction().execute(async (transaction) => {
          await sql`select 1`.execute(transaction);
          throw new Error('the job failed under its transaction');
        });
        return {};
      });
      expect(ok).toBe(false);
      expect(await rowOf('slow:again')).toMatchObject({
        consecutive_failures: before + 1,
        last_error: 'the job failed under its transaction',
      });
      expect(
        logged.lines.some(
          (line) =>
            line['msg'] === 'a scheduled job failed' &&
            line['job'] === 'slow:again' &&
            line['module'] === 'slow',
        ),
      ).toBe(true);
      // A throw before any await is the same.
      expect(
        await run('slow:again', () => {
          throw new Error('thrown at once');
        }),
      ).toBe(false);
      expect(await rowOf('slow:again')).toMatchObject({ consecutive_failures: before + 2 });
      expect(await run('slow:again', async () => await Promise.resolve({ done: 1 }))).toBe(true);
    },
    TEST_MS,
  );

  test(
    'that fails shows in the consecutive-failures gauge under its module, and a success puts it back to none',
    async () => {
      await run('other:job', () => Promise.reject(new Error('failed')));
      const gauge = async (): Promise<number | undefined> =>
        jobFamilies(['other:job'], await readJobRuns(cloned.db), (job) => OWNERS[job] ?? 'core')
          .find((family) => family.name === 'purlay_job_consecutive_failures')
          ?.samples.find((sample) => sample.labels['module'] === 'other')?.value;
      expect(await gauge()).toBe(1);
      await run('other:job', () => Promise.resolve({}));
      expect(await gauge()).toBe(0);
    },
    TEST_MS,
  );

  test(
    'that is slow holds its module’s share, so the module’s next job is refused as busy, while another module’s job and the core’s read are answered',
    async () => {
      const slow = run('other:job', async (database) => await sleeping(1.2, database));
      await Bun.sleep(100);
      const started = performance.now();
      let refused: unknown;
      const again = await run('other:again', async (database) => {
        try {
          await sql`select 1`.execute(database);
        } catch (error) {
          refused = error;
          throw error;
        }
        return {};
      });
      expect(again).toBe(false);
      expect(refused).toBeInstanceOf(AppError);
      expect((refused as AppError).message).toContain(
        "other module's share of the database is in use",
      );
      // Another module's job takes its own share at once, and so does the core's own connection.
      const otherStarted = performance.now();
      expect(
        await run('patient:job', async (database) => {
          await sql`select 1`.execute(database);
          return {};
        }),
      ).toBe(true);
      expect(performance.now() - otherStarted).toBeLessThan(250);
      expect(
        await run('core:job', async (database) => {
          await sql`select 1`.execute(database);
          return {};
        }),
      ).toBe(true);
      expect(performance.now() - started).toBeLessThan(1_100);
      expect(await slow).toBe(true);
    },
    TEST_MS,
  );

  test(
    'of a module that declared no deadline is not stopped, and a core job has none either',
    async () => {
      expect(await run('patient:job', async (database) => await sleeping(0.8, database))).toBe(
        true,
      );
      expect(await run('core:job', async (database) => await sleeping(0.8, database))).toBe(true);
    },
    TEST_MS,
  );

  test(
    'the core’s own job is given the pool as it is, not a module’s share',
    async () => {
      // Two core jobs at once both run: a share of one would have refused the second.
      const results = await Promise.all([
        run('core:job', async (database) => await sleeping(0.5, database)),
        run('core:job', async (database) => await sleeping(0.5, database)),
      ]);
      expect(results).toEqual([true, true]);
    },
    TEST_MS,
  );
});
