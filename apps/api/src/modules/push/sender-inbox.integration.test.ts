/**
 * Telling a device of a notice a module wrote to the core's inbox (D-286 §9), through the one send path and real SQL: what is
 * pushed, in whose language and where, what Deep Work and quiet hours hold back and deliver once they end, and what is never sent
 * because the person read it, looked at the page, or waited longer than the push is worth.
 */
import { afterAll, describe, expect, jest, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { MINUTES_PER_DAY } from '@purlay/types';
import { enqueuePush } from '../../platform/push-work';
import { inMemoryAttention, nobodyActive, type Attention } from '../../platform/attention';
import { serverMetrics, type ServerMetrics } from '../../platform/metrics';
import { aDatabaseThatMustNotBeTouched, aRecordingLogger, NOW } from '../../testing/doubles';
import { aBrowser, aPushService, KEYS } from '../../testing/push-service';
import { TEST_PUSH_POLICY } from '../../testing/push-config';
import { aUserRow } from '../../testing/users';
import { aWorld, KIND, movable, subscribe, words, type World } from '../../testing/push-world';
import {
  createPushSender,
  HELD_PUSH_MAX_MS,
  NOTICE_PUSH_BUDGET,
  PUSH_FAILURES_MAX,
} from './sender';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const HOUR_MS = 3_600_000;
const HELD_CHECK_MS = 60_000;
const senderOn = async (
  db: Executor,
  world: World,
  post: Parameters<typeof createPushSender>[0]['post'],
  over: {
    attention?: Attention;
    noticeWords?: Parameters<typeof createPushSender>[0]['noticeWords'];
    metrics?: ServerMetrics;
    log?: ReturnType<typeof aRecordingLogger>;
  } = {},
): Promise<Awaited<ReturnType<typeof createPushSender>>> =>
  await createPushSender({
    database: db,
    clock: world.clock,
    log: (over.log ?? aRecordingLogger()).log,
    keys: KEYS,
    attention: over.attention ?? nobodyActive,
    notices: { of: () => Promise.resolve([]), canDeliver: () => Promise.resolve(false) },
    noticeWords: over.noticeWords ?? words,
    ...TEST_PUSH_POLICY,
    post,
    ...(over.metrics === undefined ? {} : { failures: over.metrics.pushFailures, owner: 'chat' }),
  });

/** The failures counted under a module, by reason: the notices of `things` under `things`, the sender's own under `chat`. */
const failuresOf = (metrics: ServerMetrics, module = 'things'): Record<string, number> =>
  Object.fromEntries(
    (
      metrics.registry.families().find((family) => family.name === 'purlay_push_failures_total')
        ?.samples ?? []
    )
      .filter((sample) => sample.labels['module'] === module && sample.value > 0)
      .map((sample) => [sample.labels['reason'] ?? '', sample.value]),
  );

describe('integration: a device is told of a module’s notice', () => {
  test('in its person’s language, with who and where, and never the words the notice carries', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const browser = await aBrowser();
      await subscribe(db, world.clock, world.ada, browser);
      await db.updateTable('users').set({ locale: 'tr' }).where('id', '=', world.ada).execute();
      const service = aPushService();
      const sender = await senderOn(db, world, service.post);
      sender.toldInbox([await world.write(world.ada)]);
      await sender.flush(10_000);

      expect(service.sent.map((push) => push.url)).toEqual([
        `https://push.example.com/send/${world.ada}`,
      ]);
      const read = await browser.read(service.sent[0]?.body ?? new Uint8Array());
      const slug = (
        await db
          .selectFrom('workspaces')
          .select('slug')
          .where('id', '=', world.workspaceId)
          .executeTakeFirstOrThrow()
      ).slug;
      expect(read).toMatchObject({
        title: 'Studio',
        body: 'bob sana bir şey atadı',
        url: `/w/${slug}/things`,
      });
      expect(JSON.stringify(read)).not.toContain('secret');
    });
  });

  test('only on the devices of the person told, and only once for the same notice', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      await subscribe(db, world.clock, world.bob, await aBrowser());
      const service = aPushService();
      const sender = await senderOn(db, world, service.post);
      const written = await world.write(world.ada);
      sender.toldInbox([written]);
      await sender.flush(10_000);
      expect(service.sent).toHaveLength(1);
      expect(service.sent[0]?.url).toBe(`https://push.example.com/send/${world.ada}`);
    });
  });

  test('and a push service that does not take it is counted under the module whose notice it was', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      const metrics = serverMetrics(undefined, ['things'], [], []);
      const sender = await senderOn(db, world, aPushService(503).post, { metrics });
      sender.toldInbox([await world.write(world.ada)]);
      await sender.flush(10_000);
      expect(failuresOf(metrics)).toEqual({ not_taken: 1 });
      expect(failuresOf(metrics, 'chat')).toEqual({});
    });
  });

  test('a module’s temporary provider failure retains its device and is still counted at the limit', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      await db
        .updateTable('push_subscriptions')
        .set({ failures: PUSH_FAILURES_MAX - 1 })
        .where('user_id', '=', world.ada)
        .execute();
      const metrics = serverMetrics(undefined, ['things'], [], []);
      const sender = await senderOn(db, world, aPushService(503).post, { metrics });
      sender.toldInbox([await world.write(world.ada)]);
      await sender.flush(10_000);
      expect(
        await db
          .selectFrom('push_subscriptions')
          .select('failures')
          .where('user_id', '=', world.ada)
          .execute(),
      ).toEqual([{ failures: PUSH_FAILURES_MAX }]);
      expect(failuresOf(metrics)).toEqual({ not_taken: 1 });
      expect(failuresOf(metrics, 'chat')).toEqual({});
    });
  });

  test('not when the person has read it already', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      const service = aPushService();
      const sender = await senderOn(db, world, service.post);
      const written = await world.write(world.ada);
      await db
        .updateTable('inbox_entries')
        .set({ read_at: world.clock.now() })
        .where('id', '=', written.entryId)
        .execute();
      sender.toldInbox([written]);
      await sender.flush(10_000);
      expect(service.sent).toEqual([]);
    });
  });

  test('not when the person is in front of the workspace’s page, now or later', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      const looking = inMemoryAttention(world.clock);
      looking.heard(world.ada, world.workspaceId);
      const service = aPushService();
      const sender = await senderOn(db, world, service.post, { attention: looking });
      sender.toldInbox([await world.write(world.ada)]);
      await sender.flush(10_000);
      world.clock.to(new Date(world.clock.now().getTime() + HOUR_MS));
      await sender.releaseHeld();
      await sender.flush(10_000);
      expect(service.sent).toEqual([]);
    });
  });

  test('not when no running module has words for its kind, and it is said', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      const service = aPushService();
      const recording = aRecordingLogger();
      const sender = await senderOn(db, world, service.post, {
        log: recording,
        noticeWords: () => undefined,
      });
      const written = await world.write(world.ada);
      sender.toldInbox([written]);
      await sender.flush(10_000);
      expect(service.sent).toEqual([]);
      expect(recording.lines.map((line) => line['msg'])).toContain(
        'push not sent: no words for the kind',
      );
    });
  });
});

describe('integration: a loop of notices cannot spam a person’s devices', () => {
  test('past the burst the pushes of one person and kind are dropped and counted, and another person is told', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const carol = (await aUserRow(db, 'carol')).userId;
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: world.workspaceId, user_id: carol, role: 'member' })
        .execute();
      await subscribe(db, world.clock, world.ada, await aBrowser());
      await subscribe(db, world.clock, carol, await aBrowser());
      const metrics = serverMetrics(undefined, ['things'], [], []);
      const service = aPushService();
      const sender = await senderOn(db, world, service.post, { metrics });
      const extra = 4;
      for (let i = 0; i < NOTICE_PUSH_BUDGET.burst + extra; i += 1) {
        sender.toldInbox([await world.write(world.ada)]);
      }
      sender.toldInbox([await world.write(carol)]);
      await sender.flush(10_000);
      const to = (user: string): number =>
        service.sent.filter((push) => push.url === `https://push.example.com/send/${user}`).length;
      expect(to(world.ada)).toBe(NOTICE_PUSH_BUDGET.burst);
      expect(to(carol)).toBe(1);
      expect(failuresOf(metrics)).toEqual({ throttled: extra });

      // The notices are in the inbox in any case; a minute on, the person is told of the next one.
      world.clock.to(
        new Date(world.clock.now().getTime() + (1 / NOTICE_PUSH_BUDGET.perSecond) * 1000),
      );
      sender.toldInbox([await world.write(world.ada)]);
      await sender.flush(10_000);
      expect(to(world.ada)).toBe(NOTICE_PUSH_BUDGET.burst + 1);
    });
  });
});

describe('integration: what Deep Work and quiet hours hold back', () => {
  test('waits for the end of Deep Work and is then delivered once', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const browser = await aBrowser();
      await subscribe(db, world.clock, world.ada, browser);
      await db
        .updateTable('workspace_members')
        .set({
          is_deep_work_active: true,
          deep_work_until: new Date(world.clock.now().getTime() + 2 * HOUR_MS),
        })
        .where('user_id', '=', world.ada)
        .execute();
      const service = aPushService();
      const sender = await senderOn(db, world, service.post);
      sender.toldInbox([await world.write(world.ada)]);
      await sender.flush(10_000);
      expect(service.sent).toEqual([]);

      // Still inside it: asked again, still held.
      world.clock.to(new Date(world.clock.now().getTime() + HOUR_MS));
      await sender.releaseHeld();
      await sender.flush(10_000);
      expect(service.sent).toEqual([]);

      world.clock.to(new Date(world.clock.now().getTime() + 2 * HOUR_MS));
      await sender.releaseHeld();
      await sender.flush(10_000);
      expect(service.sent).toHaveLength(1);
      expect(await browser.read(service.sent[0]?.body ?? new Uint8Array())).toMatchObject({
        body: 'bob assigned you a thing',
      });

      await sender.releaseHeld();
      await sender.flush(10_000);
      expect(service.sent).toHaveLength(1);
    });
  });

  test('recovers committed work on its own one-second poll without an after-commit hint', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      const service = aPushService();
      const arrived = Promise.withResolvers<undefined>();
      jest.useFakeTimers();
      const sender = await senderOn(db, world, async (...args) => {
        const answer = await service.post(...args);
        arrived.resolve(undefined);
        return answer;
      });
      try {
        await sender.releaseHeld();
        await world.write(world.ada);
        jest.advanceTimersByTime(999);
        expect(service.sent).toEqual([]);
        jest.advanceTimersByTime(1);
        await arrived.promise;
        expect(service.sent).toHaveLength(1);
        await sender.flush(10_000);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('waits for the end of the person’s quiet hours, read on the clock of their time zone', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      const minuteNow = world.clock.now().getUTCHours() * 60 + world.clock.now().getUTCMinutes();
      // Quiet from an hour ago to two hours ahead, every day, on a UTC clock.
      await db
        .updateTable('users')
        .set({
          time_zone: 'UTC',
          quiet_from: (minuteNow + MINUTES_PER_DAY - 60) % MINUTES_PER_DAY,
          quiet_to: (minuteNow + 120) % MINUTES_PER_DAY,
          quiet_days: 0b1111111,
        })
        .where('id', '=', world.ada)
        .execute();
      const service = aPushService();
      const sender = await senderOn(db, world, service.post);
      sender.toldInbox([await world.write(world.ada)]);
      await sender.flush(10_000);
      expect(service.sent).toEqual([]);

      world.clock.to(new Date(world.clock.now().getTime() + 3 * HOUR_MS));
      await sender.releaseHeld();
      await sender.flush(10_000);
      expect(service.sent).toHaveLength(1);
    });
  });

  test('is never delivered once the person read the notice meanwhile', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      await db
        .updateTable('workspace_members')
        .set({
          is_deep_work_active: true,
          deep_work_until: new Date(world.clock.now().getTime() + HOUR_MS),
        })
        .where('user_id', '=', world.ada)
        .execute();
      const service = aPushService();
      const sender = await senderOn(db, world, service.post);
      const written = await world.write(world.ada);
      sender.toldInbox([written]);
      await sender.flush(10_000);
      await db
        .updateTable('inbox_entries')
        .set({ read_at: world.clock.now() })
        .where('id', '=', written.entryId)
        .execute();
      world.clock.to(new Date(world.clock.now().getTime() + 2 * HOUR_MS));
      await sender.releaseHeld();
      await sender.flush(10_000);
      expect(service.sent).toEqual([]);
    });
  });

  test('is dropped, and counted, when it waited longer than a push is worth', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      await db
        .updateTable('workspace_members')
        .set({
          is_deep_work_active: true,
          deep_work_until: new Date(world.clock.now().getTime() + HOUR_MS),
        })
        .where('user_id', '=', world.ada)
        .execute();
      const metrics = serverMetrics(undefined, ['things'], [], []);
      const service = aPushService();
      const sender = await senderOn(db, world, service.post, { metrics });
      sender.toldInbox([await world.write(world.ada)]);
      await sender.flush(10_000);
      // The Deep Work is over, but the notice is older than the push may be.
      world.clock.to(new Date(world.clock.now().getTime() + HELD_PUSH_MAX_MS + 1));
      await sender.releaseHeld();
      await sender.flush(10_000);
      expect(service.sent).toEqual([]);
      expect(failuresOf(metrics)).toEqual({ dropped: 1 });
    });
  });

  test('holds only as many as may wait: past it the oldest are dropped and counted, and the rest are delivered', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      await db
        .updateTable('workspace_members')
        .set({
          is_deep_work_active: true,
          deep_work_until: new Date(world.clock.now().getTime() + HOUR_MS),
        })
        .where('user_id', '=', world.ada)
        .execute();
      const metrics = serverMetrics(undefined, ['things'], [], []);
      const recording = aRecordingLogger();
      const service = aPushService();
      const written = [
        await world.write(world.ada, 'one'),
        await world.write(world.ada, 'two'),
        await world.write(world.ada, 'three'),
      ];
      const last = written[2]!;
      const row = await db
        .selectFrom('inbox_entries')
        .select('created_at')
        .where('id', '=', last.entryId)
        .executeTakeFirstOrThrow();
      await enqueuePush(
        db,
        world.clock.now(),
        [
          {
            source: 'inbox',
            sourceId: last.entryId,
            recordId: last.entryId,
            workspaceId: last.workspaceId,
            userId: last.recipientId,
            module: last.module,
            kind: last.kind,
            createdAt: row.created_at,
          },
        ],
        2,
      );
      const sender = await senderOn(db, world, service.post, { metrics, log: recording });
      sender.toldInbox(written);
      await sender.flush(10_000);
      expect(service.sent).toEqual([]);
      expect(failuresOf(metrics)).toEqual({ dropped: 1 });
      expect(
        recording.lines.find((line) => line['msg'] === 'pending pushes retired'),
      ).toMatchObject({ reason: 'overflow', dropped: 1 });

      world.clock.to(new Date(world.clock.now().getTime() + 2 * HOUR_MS));
      await sender.releaseHeld();
      await sender.flush(10_000);
      expect(service.sent).toHaveLength(2);
    });
  });

  test('holds a notice for the person in Deep Work and not for another told at the same time', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const carol = (await aUserRow(db, 'carol')).userId;
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: world.workspaceId, user_id: carol, role: 'member' })
        .execute();
      await subscribe(db, world.clock, world.ada, await aBrowser());
      await subscribe(db, world.clock, carol, await aBrowser());
      await db
        .updateTable('workspace_members')
        .set({
          is_deep_work_active: true,
          deep_work_until: new Date(world.clock.now().getTime() + HOUR_MS),
        })
        .where('user_id', '=', world.ada)
        .execute();
      const service = aPushService();
      const sender = await senderOn(db, world, service.post);
      sender.toldInbox([await world.write(world.ada), await world.write(carol)]);
      await sender.flush(10_000);
      expect(service.sent.map((push) => push.url)).toEqual([
        `https://push.example.com/send/${carol}`,
      ]);
    });
  });
});

describe('integration: a push that cannot be looked up', () => {
  test('is said and counted, never thrown at the write that told', async () => {
    const recording = aRecordingLogger();
    const metrics = serverMetrics(undefined, ['things'], [], []);
    const world = {
      clock: movable(NOW),
      workspaceId: crypto.randomUUID(),
    } as unknown as World;
    const sender = await senderOn(aDatabaseThatMustNotBeTouched(), world, aPushService().post, {
      log: recording,
      metrics,
    });
    expect(() => {
      sender.toldInbox([
        {
          entryId: crypto.randomUUID(),
          workspaceId: world.workspaceId,
          recipientId: crypto.randomUUID(),
          module: 'things',
          kind: KIND,
          collapsed: 0,
        },
      ]);
    }).not.toThrow();
    await sender.flush(10_000);
    expect(failuresOf(metrics, 'chat')).toEqual({ error: 1 });
  });

  test('when asking again for what is held, is said and counted, never thrown at the timer', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      await db
        .updateTable('workspace_members')
        .set({
          is_deep_work_active: true,
          deep_work_until: new Date(world.clock.now().getTime() + HOUR_MS),
        })
        .where('user_id', '=', world.ada)
        .execute();
      let gone = false;
      const flaky = new Proxy(db, {
        get(target, property): unknown {
          if (gone) throw new Error('the database went away');
          const member: unknown = Reflect.get(target, property, target);
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
      const metrics = serverMetrics(undefined, ['things'], [], []);
      const service = aPushService();
      const sender = await senderOn(flaky, world, service.post, { metrics });
      sender.toldInbox([await world.write(world.ada)]);
      await sender.flush(10_000);

      gone = true;
      await sender.releaseHeld();
      gone = false;
      await sender.flush(10_000);
      expect(failuresOf(metrics, 'chat')).toEqual({ error: 1 });
      expect(service.sent).toEqual([]);
    });
  });
});

describe('integration: queued module notification authority', () => {
  test.each([
    'Deep Work',
    'read',
    'membership',
    'workspace deleted',
    'account suspended',
    'account deleted',
    'unchanged',
  ] as const)('rechecks %s before posting the waiting device', async (change) => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const browser = await aBrowser();
      for (const device of [1, 2, 3]) {
        await subscribe(db, world.clock, world.ada, browser);
        await db
          .updateTable('push_subscriptions')
          .set({ endpoint: `https://push.example.com/queued/${String(device)}` })
          .where('user_id', '=', world.ada)
          .where('endpoint', '=', `https://push.example.com/send/${world.ada}`)
          .execute();
      }
      const posted: string[] = [];
      const pending: (() => void)[] = [];
      let released = false;
      const sender = await senderOn(db, world, (url) => {
        posted.push(url.pathname);
        if (released) return Promise.resolve({ kind: 'answered', status: 201 });
        return new Promise((resolve) => {
          pending.push(() => {
            resolve({ kind: 'answered', status: 201 });
          });
        });
      });
      const written = await world.write(world.ada);
      sender.toldInbox([written]);
      try {
        for (let turn = 0; turn < 100 && posted.length < 2; turn += 1) await Bun.sleep(10);
        expect(posted).toHaveLength(2);
        if (change === 'Deep Work') {
          await db
            .updateTable('workspace_members')
            .set({ is_deep_work_active: true, deep_work_until: new Date(NOW.getTime() + HOUR_MS) })
            .where('workspace_id', '=', world.workspaceId)
            .where('user_id', '=', world.ada)
            .execute();
        } else if (change === 'read') {
          await db
            .updateTable('inbox_entries')
            .set({ read_at: world.clock.now() })
            .where('id', '=', written.entryId)
            .execute();
        } else if (change === 'membership') {
          await db
            .deleteFrom('workspace_members')
            .where('workspace_id', '=', world.workspaceId)
            .where('user_id', '=', world.ada)
            .execute();
        } else if (change === 'workspace deleted') {
          await db
            .updateTable('workspaces')
            .set({ deleted_at: world.clock.now() })
            .where('id', '=', world.workspaceId)
            .execute();
        } else if (change === 'account suspended') {
          await db
            .updateTable('users')
            .set({ suspended_at: world.clock.now() })
            .where('id', '=', world.ada)
            .execute();
        } else if (change === 'account deleted') {
          await db
            .updateTable('users')
            .set({ deleted_at: world.clock.now() })
            .where('id', '=', world.ada)
            .execute();
        }
        released = true;
        for (const release of pending) release();
        await sender.flush(10_000);
        expect(posted).toHaveLength(change === 'unchanged' ? 3 : 2);
        if (change === 'Deep Work') {
          await db
            .updateTable('workspace_members')
            .set({ is_deep_work_active: false, deep_work_until: null })
            .where('workspace_id', '=', world.workspaceId)
            .where('user_id', '=', world.ada)
            .execute();
          world.clock.to(new Date(world.clock.now().getTime() + HELD_CHECK_MS));
        }
        await sender.releaseHeld();
        await sender.flush(10_000);
        const expected = change === 'Deep Work' || change === 'unchanged' ? 3 : 2;
        expect(posted).toHaveLength(expected);
        expect(new Set(posted).size).toBe(expected);
      } finally {
        released = true;
        for (const release of pending) release();
        await sender.flush(10_000);
      }
    });
  });
});
