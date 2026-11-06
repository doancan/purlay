/**
 * A module's workers on a real database and a real lease (`MODULES.md` §7, §9): chat's delivery loops still deliver, and an
 * iteration that holds its connection past its module's deadline is cancelled on the server, counted, and followed by the
 * next. A statement is made to wait without a clock: `pg_sleep` on a leased connection, which the database reports in
 * `pg_stat_activity` while it runs, so that a cancellation is seen on the server and not assumed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  leasingExecutor,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { compose } from '../../composition';
import { chatModule } from '../../features/chat/module';
import { scheduleMessage } from '../../features/chat/scheduled/scheduled';
import { fixedClock } from '../../platform/clock';
import type { EventBus } from '../../platform/events';
import type { ModuleBudget } from '../../platform/module-budget';
import { moduleConnections } from '../../platform/module-budget';
import { atomicallyOn } from '../../platform/transactions';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { startWorkers, type RunningWorker } from './module-workers';

const TEST_MS = 60_000;
const SHARE: ModuleBudget = { maxConcurrent: 1, queueTimeoutMs: 300, statementTimeoutMs: 30_000 };
const DEADLINE_MS = 500;
const manifests = [
  { id: 'chat', budget: chatModule.manifest.budget },
  { id: 'slow', budget: { poolShare: (): ModuleBudget => SHARE } },
] as const;

const bus: EventBus = {
  publish: async () => {
    await Promise.resolve();
  },
  subscribe: () => false,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const dependencies = (
  clock: ReturnType<typeof fixedClock>,
): {
  readonly failures: { module: string; worker: string }[];
  readonly log: ReturnType<typeof aRecordingLogger>;
  readonly shared: Parameters<typeof startWorkers>[1];
} => {
  const failures: { module: string; worker: string }[] = [];
  const log = aRecordingLogger();
  return {
    failures,
    log,
    shared: {
      database: leasingExecutor(cloned.db, moduleConnections(manifests, 10)),
      clock,
      log: log.log,
      bus,
      failures: {
        inc: (labels): void => {
          failures.push(labels);
        },
      },
    },
  };
};

const sleepersOnServer = async (): Promise<number> =>
  Number(
    (
      await sql<{ n: string }>`select count(*)::text as n from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and state = 'active' and query ilike '%pg_sleep%'`.execute(cloned.db)
    ).rows[0]?.n ?? '0',
  );

const until = async (condition: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> => {
  const gone = performance.now() + ms;
  while (!(await condition())) {
    if (performance.now() > gone) throw new Error('the condition did not come true in time');
    await Bun.sleep(25);
  }
};

describe('integration: a module’s workers', () => {
  test(
    'chat’s workers deliver a scheduled message that is due, through chat’s share, and count no failure',
    async () => {
      const now = new Date('2026-10-28T12:00:00Z');
      const due = fixedClock(new Date(now.getTime() + 60_000));
      const room = await aRoom(cloned.db, ['alice']);
      const alice = room.members['alice'];
      if (alice === undefined) throw new Error('missing test member');
      const id = messageId(now);
      await atomicallyOn(cloned.db)(
        async (tx) =>
          await scheduleMessage(tx, fixedClock(now), alice.userId, room.channelId, id, {
            content: 'Delivered by the worker',
            sendAt: due.now().toISOString(),
          }),
      );
      const { failures, shared } = dependencies(due);
      const workers = startWorkers(compose([chatModule]).workers, shared);
      try {
        await until(
          async () =>
            (
              await cloned.db
                .selectFrom('scheduled_messages')
                .select('state')
                .where('id', '=', id)
                .executeTakeFirstOrThrow()
            ).state === 'sent',
        );
      } finally {
        await workers.stop();
      }
      const sent = await cloned.db
        .selectFrom('messages')
        .select('content')
        .where('channel_id', '=', room.channelId)
        .execute();
      expect(sent.map((row) => row.content)).toEqual(['Delivered by the worker']);
      expect(failures).toEqual([]);
    },
    TEST_MS,
  );

  test(
    'an iteration past its module’s deadline is cancelled on the server and counted, gives its share back, and the next iteration runs',
    async () => {
      const { failures, log, shared } = dependencies(fixedClock(new Date()));
      let calls = 0;
      const worker: RunningWorker = {
        module: 'slow',
        name: 'wait:long',
        intervalMs: 50,
        deadlineMs: DEADLINE_MS,
        work: async ({ database }) => {
          calls += 1;
          // The first holds its one connection; the next must be able to take the module's share again.
          if (calls === 1) await sql`select pg_sleep(30)`.execute(database);
          else await sql`select 1`.execute(database);
        },
      };
      const started = performance.now();
      const workers = startWorkers([worker], shared);
      try {
        await until(() => calls >= 3);
      } finally {
        await workers.stop();
      }
      expect(performance.now() - started).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
      await until(async () => (await sleepersOnServer()) === 0, 3_000);
      expect(failures).toEqual([{ module: 'slow', worker: 'wait:long' }]);
      expect(
        log.lines.some(
          (line) =>
            line['module'] === 'slow' &&
            line['worker'] === 'wait:long' &&
            line['level'] === 'error',
        ),
      ).toBe(true);
    },
    TEST_MS,
  );

  test(
    'a worker that throws is its own failure: counted every time, and the loop and the process go on',
    async () => {
      const { failures, shared } = dependencies(fixedClock(new Date()));
      let calls = 0;
      const workers = startWorkers(
        [
          {
            module: 'slow',
            name: 'fail:always',
            intervalMs: 20,
            deadlineMs: DEADLINE_MS,
            work: async ({ database }): Promise<void> => {
              calls += 1;
              await database.transaction().execute(async (transaction) => {
                await sql`select 1`.execute(transaction);
                throw new Error('failed under its transaction');
              });
            },
          },
        ],
        shared,
      );
      try {
        await until(() => calls >= 3);
      } finally {
        await workers.stop();
      }
      expect(failures.length).toBeGreaterThanOrEqual(3);
      expect(new Set(failures.map((failure) => failure.worker))).toEqual(new Set(['fail:always']));
    },
    TEST_MS,
  );
});
