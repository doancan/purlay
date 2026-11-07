/**
 * Telling a device of a notice a module wrote to the core's inbox (D-286 §9), through the one send path and real SQL: what is
 * pushed, in whose language and where, what Deep Work and quiet hours hold back and deliver once they end, and what is never sent
 * because the person read it, looked at the page, or waited longer than the push is worth.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  withRollback,
  type Executor,
  type Transaction,
} from '@purlay/db';
import { MINUTES_PER_DAY } from '@purlay/types';
import { inMemoryAttention, nobodyActive, type Attention } from '../../platform/attention';
import type { Clock } from '../../platform/clock';
import { NO_LOG, type EventBus } from '../../platform/events';
import { serverMetrics, type ServerMetrics } from '../../platform/metrics';
import type { WrittenNotice } from '../../platform/ports/notification-sink';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aDatabaseThatMustNotBeTouched, aRecordingLogger, NOW } from '../../testing/doubles';
import { aBrowser, aPushService, KEYS } from '../../testing/push-service';
import { aSession } from '../../testing/signed-in';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { notificationSink } from '../inbox/sink';
import type { NoticeWords } from './notices';
import { createPushSender, HELD_PUSH_MAX_MS } from './sender';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const HOUR_MS = 3_600_000;
const KIND = 'thing_assigned';
/** The words of a module of the test's own: its title is in the params, and must never reach a device. */
const words: NoticeWords = (kind, locale, actor) =>
  kind === KIND
    ? {
        body: locale === 'tr' ? `${actor} sana bir şey atadı` : `${actor} assigned you a thing`,
        path: 'things',
      }
    : undefined;

/** A clock the test moves. */
const movable = (start: Date): Clock & { to: (instant: Date) => void } => {
  let current = start;
  return {
    now: (): Date => new Date(current),
    to: (instant): void => {
      current = instant;
    },
  };
};

const quietBus: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => false,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

interface World {
  readonly clock: ReturnType<typeof movable>;
  readonly workspaceId: string;
  readonly ada: string;
  readonly bob: string;
  readonly write: (recipient: string, title?: string) => Promise<WrittenNotice>;
}

const aWorld = async (db: Transaction): Promise<World> => {
  const clock = movable(NOW);
  const workspaceId = (
    await db
      .insertInto('workspaces')
      .values({ name: 'Studio', slug: aUniqueSlug('studio') })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  const member = async (name: string): Promise<string> => {
    const { userId } = await aUserRow(db, name);
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: userId, role: 'member' })
      .execute();
    return userId;
  };
  const ada = await member('ada');
  const bob = await member('bob');
  const sink = notificationSink({
    clock,
    kinds: new Map([[KIND, 'things']]),
    bus: quietBus,
    log: NO_LOG,
    written: serverMetrics(undefined, ['things'], [], [{ module: 'things', kind: KIND }])
      .inboxEntries,
    pushedKinds: new Set([KIND]),
  });
  const context = await requireWorkspaceMembership(db, bob, workspaceId);
  return {
    clock,
    workspaceId,
    ada,
    bob,
    write: async (recipient, title = 'The secret plan'): Promise<WrittenNotice> => {
      clock.to(new Date(clock.now().getTime() + 1));
      const written = await sink.notify(db, context, {
        kind: KIND,
        recipientId: recipient,
        subject: { type: 'thing', id: crypto.randomUUID() },
        params: { title },
      });
      if (written === undefined) throw new Error('nothing was written');
      return written;
    },
  };
};

const subscribe = async (
  db: Executor,
  clock: Clock,
  userId: string,
  browser: { p256dh: string; auth: string },
): Promise<void> => {
  const { sessionId } = await aSession(db, clock, userId, 30);
  await db
    .insertInto('push_subscriptions')
    .values({
      user_id: userId,
      session_id: sessionId,
      endpoint: `https://push.example.com/send/${userId}`,
      p256dh: browser.p256dh,
      auth: browser.auth,
      server_key: KEYS.publicKey,
      failures: 0,
      created_at: new Date(clock.now().getTime() - 60_000),
    })
    .execute();
};

const senderOn = async (
  db: Executor,
  world: World,
  post: Parameters<typeof createPushSender>[0]['post'],
  over: {
    attention?: Attention;
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
    notices: { of: () => Promise.resolve([]) },
    noticeWords: words,
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
      const sender = await senderOn(db, world, service.post, { log: recording });
      const written = await world.write(world.ada);
      await db
        .updateTable('inbox_entries')
        .set({ kind: 'unheard_of' })
        .where('id', '=', written.entryId)
        .execute();
      sender.toldInbox([written]);
      await sender.flush(10_000);
      expect(service.sent).toEqual([]);
      expect(recording.lines.map((line) => line['msg'])).toContain(
        'push not sent: no words for the kind',
      );
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
      expect(failuresOf(metrics, 'chat')).toEqual({ dropped: 1 });
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
        },
      ]);
    }).not.toThrow();
    await sender.flush(10_000);
    expect(failuresOf(metrics, 'chat')).toEqual({ error: 1 });
  });
});
