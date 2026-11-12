import type { PushSenderDependencies } from './sender';
/**
 * Telling a device (#78, D-126), through the one send path and real SQL, to a push service of the
 * test's own: who is pushed and who is not, what the browser can read of it — decrypted here with
 * the browser's own key, as the browser would — and what the service's answer does to the device.
 */
import { inMemoryAttention, nobodyActive, type Attention } from '../../platform/attention';
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { enqueuePush } from '../../platform/push-work';
import { movable } from '../../testing/push-world';
import type { EventBus } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { aSession } from '../../testing/signed-in';
import { enableTestPush, TEST_PUSH_POLICY } from '../../testing/push-config';
import { aPushService, aBrowser, KEYS } from '../../testing/push-service';
import { aRoom, type Room } from '../../testing/rooms';
import { aDatabaseThatMustNotBeTouched, aRecordingLogger } from '../../testing/doubles';
import { edit } from '../../features/chat/messages/edit';
import { send } from '../../features/chat/messages/messages';
import { chatPushNotices } from '../../features/chat/notifications/push-notices';
import { noNoticeWords } from './notices';
import { PUSH_FAILURES_MAX, createPushSender, type PushPost } from './sender';
import { serverMetrics, type ServerMetrics } from '../../platform/metrics';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-13T12:00:00.000Z');
const clock = fixedClock(NOW);
/** Nobody is in front of a page unless a test says so (D-143). */
const attention = nobodyActive;

const quietBus: EventBus = {
  publish: () => Promise.resolve(undefined),
  subscribe: () => false,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

/** Devices are made in the order a test makes them, a millisecond apart. */
let made = 0;

const subscribeDevice = async (
  db: Executor,
  room: Room,
  who: string,
  browser: { p256dh: string; auth: string },
  over: { endpoint?: string; serverKey?: string; failures?: number } = {},
): Promise<string> => {
  await enableTestPush(db, clock);
  const userId = room.members[who]?.userId ?? '';
  const { sessionId } = await aSession(db, clock, userId, 30);
  const row = await db
    .insertInto('push_subscriptions')
    .values({
      user_id: userId,
      session_id: sessionId,
      endpoint: over.endpoint ?? `https://push.example.com/send/${who}`,
      p256dh: browser.p256dh,
      auth: browser.auth,
      server_key: over.serverKey ?? KEYS.publicKey,
      failures: over.failures ?? 0,
      created_at: new Date(NOW.getTime() - 60_000 + (made += 1)),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};

const sending = async (
  db: Executor,
  post: PushPost,
  recording = aRecordingLogger(),
  heard: Attention = attention,
  metrics?: ServerMetrics,
  overrides: Partial<Pick<PushSenderDependencies, 'keys' | 'notices'>> = {},
): Promise<{
  readonly say: (
    room: Room,
    as: string,
    content: string,
    id?: string,
    parentId?: string,
  ) => Promise<string>;
  readonly settled: () => Promise<void>;
}> => {
  const push = await createPushSender({
    database: db,
    clock,
    log: recording.log,
    keys: KEYS,
    attention: heard,
    notices: chatPushNotices,
    noticeWords: noNoticeWords,
    ...TEST_PUSH_POLICY,
    post,
    // The notices are chat's, so the failures of what they told are chat's.
    ...(metrics === undefined ? {} : { failures: metrics.pushFailures, owner: 'chat' }),
    ...overrides,
  });
  let at = 0;
  return {
    say: async (room, as, content, id, parentId): Promise<string> => {
      at += 1;
      const context = room.members[as]?.context;
      if (context === undefined) throw new Error(`no member ${as}`);
      const sent = await send(
        { atomically: atomicallyOn(db), clock, bus: quietBus, push },
        context,
        {
          id: id ?? messageId(new Date(NOW.getTime() + at)),
          content,
          ...(parentId === undefined ? {} : { parentId }),
        },
      );
      return sent.id;
    },
    settled: async (): Promise<void> => {
      await push.flush(10_000);
    },
  };
};

const mention = (room: Room, who: string): string => `@${room.members[who]?.username ?? ''}`;

/** The push failures the registry holds for the notices of a module, by reason (D-221). */
const failuresOf = (metrics: ServerMetrics, module = 'chat'): Record<string, number> =>
  Object.fromEntries(
    (
      metrics.registry.families().find((family) => family.name === 'purlay_push_failures_total')
        ?.samples ?? []
    )
      .filter((sample) => sample.labels['module'] === module)
      .map((sample) => [sample.labels['reason'] ?? '', sample.value]),
  );

describe('integration: a device is told', () => {
  test.each([
    'sound changed',
    'session revoked',
    'private access lost',
    'message read',
    'active page',
    'Deep Work',
  ] as const)('a prepared push is retired after %s during encryption', async (change) => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'private' });
      const browser = await aBrowser();
      const id = await subscribeDevice(db, room, 'bob', browser);
      const service = aPushService();
      const looking = inMemoryAttention(clock);
      let lookups = 0;
      const { say, settled } = await sending(
        db,
        service.post,
        aRecordingLogger(),
        looking,
        undefined,
        {
          keys: async () => {
            lookups += 1;
            if (lookups === 2) {
              if (change === 'sound changed')
                await db
                  .updateTable('push_subscriptions')
                  .set({ sound: false })
                  .where('id', '=', id)
                  .execute();
              else if (change === 'session revoked')
                await db.deleteFrom('push_subscriptions').where('id', '=', id).execute();
              else if (change === 'private access lost')
                await db
                  .deleteFrom('channel_members')
                  .where('channel_id', '=', room.channelId)
                  .where('user_id', '=', room.members['bob']!.userId)
                  .execute();
              else if (change === 'message read')
                await db
                  .updateTable('notifications')
                  .set({ read_at: NOW })
                  .where('channel_id', '=', room.channelId)
                  .where('user_id', '=', room.members['bob']!.userId)
                  .execute();
              else if (change === 'active page')
                looking.heard(room.members['bob']!.userId, room.workspaceId);
              else
                await db
                  .updateTable('workspace_members')
                  .set({
                    is_deep_work_active: true,
                    deep_work_until: new Date(NOW.getTime() + 60_000),
                  })
                  .where('workspace_id', '=', room.workspaceId)
                  .where('user_id', '=', room.members['bob']!.userId)
                  .execute();
            }
            return KEYS;
          },
        },
      );
      await say(room, 'alice', mention(room, 'bob'));
      await settled();
      expect(lookups).toBeGreaterThanOrEqual(2);
      expect(service.sent).toHaveLength(0);
    });
  });
  test('each device receives its own sound choice in the encrypted payload', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const browser = await aBrowser();
      const muted = await subscribeDevice(db, room, 'bob', browser);
      await db
        .updateTable('push_subscriptions')
        .set({ sound: false })
        .where('id', '=', muted)
        .execute();
      await subscribeDevice(db, room, 'bob', browser, {
        endpoint: 'https://push.example.com/send/bob-loud',
      });
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      await say(room, 'alice', mention(room, 'bob'));
      await settled();
      expect(service.sent).toHaveLength(2);
      for (const sent of service.sent) {
        expect(await browser.read(sent.body)).toMatchObject({
          silent: !sent.url.endsWith('bob-loud'),
        });
      }
    });
  });
  test('of a mention, in its person’s language, with who and where and never what was said', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = await aBrowser();
      await subscribeDevice(db, room, 'bob', bob);
      await db
        .updateTable('users')
        .set({ locale: 'tr' })
        .where('id', '=', room.members['bob']?.userId ?? '')
        .execute();
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      await say(room, 'alice', `${mention(room, 'bob')} the secret plan`);
      await settled();

      expect(service.sent.map((push) => push.url)).toEqual(['https://push.example.com/send/bob']);
      const [push] = service.sent;
      expect(push?.headers['content-encoding']).toBe('aes128gcm');
      expect(push?.headers['authorization']).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
      const channel = await db
        .selectFrom('channels')
        .select('name')
        .where('id', '=', room.channelId)
        .executeTakeFirstOrThrow();
      const read = await bob.read(push?.body ?? new Uint8Array());
      expect(read).toMatchObject({
        title: `#${channel.name ?? ''}`,
        body: 'alice senden bahsetti',
        tag: `channel:${room.channelId}`,
      });
      expect(JSON.stringify(read)).not.toContain('secret');
    });
  });

  test('of a group, titled by its other people and saying it was written to the conversation', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol'], { type: 'direct_message' });
      const bob = await aBrowser();
      await subscribeDevice(db, room, 'bob', bob);
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      await say(room, 'alice', 'shipping at five');
      await settled();
      const [push] = service.sent;
      const read = await bob.read(push?.body ?? new Uint8Array());
      const others = ['alice', 'carol'];
      expect(read).toMatchObject({ body: 'alice wrote to the conversation' });
      const title = (read as { title: string }).title;
      expect(title.split(', ').sort()).toEqual(others);
    });
  });

  test('of a reply, saying whose thread it is: theirs, or one they are only in (D-162)', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const bob = await aBrowser();
      const carol = await aBrowser();
      await subscribeDevice(db, room, 'bob', bob);
      await subscribeDevice(db, room, 'carol', carol);
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      const root = await say(room, 'carol', 'who owns the cache?');
      await say(room, 'bob', 'me', undefined, root);
      await settled();
      service.sent.length = 0;
      await say(room, 'alice', 'or me', undefined, root);
      await settled();
      for (const push of service.sent) {
        const device = push.url.endsWith('/bob') ? bob : carol;
        const payload = (await device.read(push.body)) as { url: string };
        expect(new URL(payload.url, 'https://purlay.test').searchParams.get('thread')).toBe(root);
      }
      const bodies = new Map<string, unknown>();
      for (const push of service.sent) {
        const device = push.url.endsWith('/bob') ? bob : carol;
        bodies.set(push.url, ((await device.read(push.body)) as { body: string }).body);
      }
      expect(Object.fromEntries(bodies)).toEqual({
        'https://push.example.com/send/bob': 'alice replied in a thread you’re in',
        'https://push.example.com/send/carol': 'alice replied in your thread',
      });
    });
  });

  test('once: a retried send tells nobody again, and the author is never told', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await subscribeDevice(db, room, 'alice', await aBrowser());
      await subscribeDevice(db, room, 'bob', await aBrowser());
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      const id = messageId(NOW);
      await say(room, 'alice', `${mention(room, 'bob')} ping`, id);
      await say(room, 'alice', `${mention(room, 'bob')} ping`, id);
      await settled();
      expect(service.sent.map((push) => push.url)).toEqual(['https://push.example.com/send/bob']);
    });
  });

  test('of a mention an edit added, once however often it is saved', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await subscribeDevice(db, room, 'bob', await aBrowser());
      const service = aPushService();
      const push = await createPushSender({
        database: db,
        clock,
        log: aRecordingLogger().log,
        keys: KEYS,
        attention,
        notices: chatPushNotices,
        noticeWords: noNoticeWords,
        ...TEST_PUSH_POLICY,
        post: service.post,
      });
      const { say } = await sending(db, service.post);
      const id = await say(room, 'alice', 'see the plan');
      const { sessionId } = await aSession(db, clock, room.members['alice']?.userId ?? '', 30);
      const caller = { userId: room.members['alice']?.userId ?? '', sessionId };
      const editing = { atomically: atomicallyOn(db), clock, bus: quietBus, push };
      await edit(editing, caller, id, `see the plan ${mention(room, 'bob')}`);
      await edit(editing, caller, id, `see the plan, ${mention(room, 'bob')}`);
      await push.flush();
      expect(service.sent.map((sent) => sent.url)).toEqual(['https://push.example.com/send/bob']);
    });
  });

  test('not of a message that needs nobody, nor in Deep Work, nor in a muted channel', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      await subscribeDevice(db, room, 'bob', await aBrowser());
      await subscribeDevice(db, room, 'carol', await aBrowser());
      await db
        .updateTable('workspace_members')
        .set({ is_deep_work_active: true, deep_work_until: new Date(NOW.getTime() + 3_600_000) })
        .where('user_id', '=', room.members['bob']?.userId ?? '')
        .execute();
      await db
        .updateTable('channel_members')
        .set({ notification_level: 'none' })
        .where('user_id', '=', room.members['carol']?.userId ?? '')
        .execute();
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      await say(room, 'alice', 'a plain message');
      await say(room, 'alice', `${mention(room, 'bob')} ${mention(room, 'carol')} look`);
      await settled();
      expect(service.sent).toEqual([]);
    });
  });

  test('not while its person is in front of that workspace’s page — and never later; another workspace still is (D-143)', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      await subscribeDevice(db, room, 'bob', await aBrowser());
      await subscribeDevice(db, room, 'carol', await aBrowser());
      const heard = inMemoryAttention(clock);
      heard.heard(room.members['bob']?.userId ?? '', room.workspaceId);
      // Carol is active, but somewhere else.
      heard.heard(room.members['carol']?.userId ?? '', '0199155c-6200-7b7f-8c11-0000000000ff');
      const service = aPushService();
      const recording = aRecordingLogger();
      const { say, settled } = await sending(db, service.post, recording, heard);
      await say(room, 'alice', `${mention(room, 'bob')} ${mention(room, 'carol')} look`);
      await settled();
      expect(service.sent.map((push) => push.url)).toEqual(['https://push.example.com/send/carol']);
      expect(recording.lines.map((line) => [line['msg'], line['people']])).toContainEqual([
        'push held: the person is active',
        1,
      ]);
    });
  });

  test('not of a message its person has already read past', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await subscribeDevice(db, room, 'bob', await aBrowser());
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      // Bob has read up to a message newer than the one about to be sent.
      const later = await say(room, 'alice', 'newer', messageId(new Date(NOW.getTime() + 1_000)));
      await db
        .updateTable('channel_members')
        .set({ last_read_message_id: later })
        .where('user_id', '=', room.members['bob']?.userId ?? '')
        .execute();
      await say(room, 'alice', `${mention(room, 'bob')} older`, messageId(NOW));
      await settled();
      expect(service.sent).toEqual([]);
    });
  });

  test('not on a device of a session signed out, nor one made with a key since replaced', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      await subscribeDevice(db, room, 'bob', await aBrowser());
      // Ending a session deletes its row, and with it the session's devices (D-179).
      await db
        .deleteFrom('sessions')
        .where('user_id', '=', room.members['bob']?.userId ?? '')
        .execute();
      const stale = await subscribeDevice(db, room, 'carol', await aBrowser(), {
        serverKey: `B${'x'.repeat(86)}`,
      });
      // A stale-key device is ignored even when its old crypto material no longer decodes.
      await db
        .updateTable('push_subscriptions')
        .set({ p256dh: 'old-device-material' })
        .where('id', '=', stale)
        .execute();
      const recording = aRecordingLogger();
      const service = aPushService();
      const { say, settled } = await sending(db, service.post, recording);
      await say(room, 'alice', `${mention(room, 'bob')} ${mention(room, 'carol')} look`);
      await settled();
      expect(service.sent).toEqual([]);
      expect(recording.lines).toHaveLength(0);
    });
  });
});

describe('integration: what the push service answers', () => {
  const answered = async (
    status: number,
    failures = 0,
  ): Promise<{ failures: number } | undefined> => {
    let kept: { failures: number } | undefined;
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const id = await subscribeDevice(db, room, 'bob', await aBrowser(), { failures });
      const { say, settled } = await sending(db, aPushService(status).post);
      await say(room, 'alice', `${mention(room, 'bob')} ping`);
      await settled();
      kept = await db
        .selectFrom('push_subscriptions')
        .select('failures')
        .where('id', '=', id)
        .executeTakeFirst();
    });
    return kept;
  };

  test('taken, it keeps the device and forgets its failures', async () => {
    expect(await answered(201, 3)).toEqual({ failures: 0 });
  });

  test.each([404, 410])('%p — the browser dropped it — forgets the device', async (status) => {
    expect(await answered(status)).toBeUndefined();
  });

  test('a temporary failure is counted without treating it as a browser unsubscribe', async () => {
    expect(await answered(500)).toEqual({ failures: 1 });
    expect(await answered(429, PUSH_FAILURES_MAX - 2)).toEqual({ failures: PUSH_FAILURES_MAX - 1 });
  });

  test.each([429, 500, 503])(
    '%p keeps a live device at the recorded failure limit',
    async (status) => {
      expect(await answered(status, PUSH_FAILURES_MAX - 1)).toEqual({
        failures: PUSH_FAILURES_MAX,
      });
      expect(await answered(status, PUSH_FAILURES_MAX)).toEqual({ failures: PUSH_FAILURES_MAX });
    },
  );

  test('a large restored failure streak cannot overflow or disable the subscription', async () => {
    expect(await answered(503, 2_147_483_647)).toEqual({ failures: PUSH_FAILURES_MAX });
  });

  test('a later message tries the retained device and success clears its failure streak', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const id = await subscribeDevice(db, room, 'bob', await aBrowser(), {
        failures: PUSH_FAILURES_MAX - 1,
      });
      let requests = 0;
      const metrics = serverMetrics(undefined, ['chat']);
      const recording = aRecordingLogger();
      const post: PushPost = () => {
        requests += 1;
        return Promise.resolve({ kind: 'answered', status: requests === 1 ? 503 : 201 });
      };
      const { say, settled } = await sending(db, post, recording, attention, metrics);
      await say(room, 'alice', `${mention(room, 'bob')} first`);
      await settled();
      expect(
        await db.selectFrom('push_subscriptions').select('failures').where('id', '=', id).execute(),
      ).toEqual([{ failures: PUSH_FAILURES_MAX }]);
      expect(failuresOf(metrics)).toMatchObject({ not_taken: 1 });
      expect(recording.lines.some((line) => line['msg'] === 'push device forgotten')).toBe(false);
      await say(room, 'alice', `${mention(room, 'bob')} next`);
      await settled();
      expect(requests).toBe(2);
      expect(
        await db.selectFrom('push_subscriptions').select('failures').where('id', '=', id).execute(),
      ).toEqual([{ failures: 0 }]);
    });
  });

  test.each(['timeout', 'network connection lost'])(
    'repeated %s responses retain the live device and bound the failure streak',
    async (reason) => {
      await withRollback(async (db) => {
        const room = await aRoom(db, ['alice', 'bob']);
        const id = await subscribeDevice(db, room, 'bob', await aBrowser(), {
          failures: PUSH_FAILURES_MAX - 1,
        });
        let requests = 0;
        const post: PushPost = () => {
          requests += 1;
          return Promise.resolve({ kind: 'failed', reason });
        };
        const { say, settled } = await sending(db, post);
        for (let i = 0; i < 10; i++) {
          await say(room, 'alice', `${mention(room, 'bob')} message ${String(i)}`);
          await settled();
        }
        expect(requests).toBe(10);
        expect(
          await db
            .selectFrom('push_subscriptions')
            .select('failures')
            .where('id', '=', id)
            .execute(),
        ).toEqual([{ failures: PUSH_FAILURES_MAX }]);
      });
    },
  );

  test.each([201, 410, 503])(
    '%p cannot change a device handed to another account while the request was in flight',
    async (status) => {
      await withRollback(async (db) => {
        const room = await aRoom(db, ['alice', 'bob', 'carol']);
        const id = await subscribeDevice(db, room, 'bob', await aBrowser(), { failures: 4 });
        const userId = room.members['carol']?.userId ?? '';
        const { sessionId } = await aSession(db, clock, userId, 30);
        const post: PushPost = async () => {
          await db
            .updateTable('push_subscriptions')
            .set({ user_id: userId, session_id: sessionId, failures: 3 })
            .where('id', '=', id)
            .execute();
          return { kind: 'answered', status };
        };
        const { say, settled } = await sending(db, post);
        await say(room, 'alice', `${mention(room, 'bob')} message`);
        await settled();
        expect(
          await db
            .selectFrom('push_subscriptions')
            .select('failures')
            .where('id', '=', id)
            .execute(),
        ).toEqual([{ failures: 3 }]);
      });
    },
  );

  test('a success for an earlier session cannot clear the newer session’s failure streak', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const id = await subscribeDevice(db, room, 'bob', await aBrowser(), { failures: 4 });
      const { sessionId } = await aSession(db, clock, room.members['bob']?.userId ?? '', 30);
      const post: PushPost = async () => {
        await db
          .updateTable('push_subscriptions')
          .set({ session_id: sessionId, failures: 3 })
          .where('id', '=', id)
          .execute();
        return { kind: 'answered', status: 201 };
      };
      const { say, settled } = await sending(db, post);
      await say(room, 'alice', `${mention(room, 'bob')} message`);
      await settled();
      expect(
        await db.selectFrom('push_subscriptions').select('failures').where('id', '=', id).execute(),
      ).toEqual([{ failures: 3 }]);
    });
  });

  test.each([400, 401, 403, 413])(
    '%p — this server’s request refused — is said loudly, and is no device’s fault',
    async (status) => {
      await withRollback(async (db) => {
        const room = await aRoom(db, ['alice', 'bob']);
        const id = await subscribeDevice(db, room, 'bob', await aBrowser(), { failures: 2 });
        const recording = aRecordingLogger();
        const { say, settled } = await sending(db, aPushService(status).post, recording);
        await say(room, 'alice', `${mention(room, 'bob')} ping`);
        await settled();
        expect(
          await db
            .selectFrom('push_subscriptions')
            .select('failures')
            .where('id', '=', id)
            .execute(),
        ).toEqual([{ failures: 2 }]);
        expect(
          recording.lines.map((line) => [line['level'], line['msg'], line['status']]),
        ).toContainEqual(['error', 'push refused: this server’s request', status]);
      });
    },
  );

  /** What `/metrics` says of pushes: each that did not reach its service, by why; a device gone is no failure. */
  test.each([
    [201, {}],
    [410, {}],
    [500, { not_taken: 1 }],
    [429, { not_taken: 1 }],
    [403, { refused: 1 }],
  ] as const)('a push answered %p is counted as a failure by why: %o', async (status, counted) => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await subscribeDevice(db, room, 'bob', await aBrowser());
      const metrics = serverMetrics(undefined, ['chat']);
      const { say, settled } = await sending(
        db,
        aPushService(status).post,
        aRecordingLogger(),
        attention,
        metrics,
      );
      await say(room, 'alice', `${mention(room, 'bob')} ping`);
      await settled();
      expect(failuresOf(metrics)).toEqual({
        refused: 0,
        not_taken: 0,
        error: 0,
        dropped: 0,
        throttled: 0,
        ...counted,
      });
      // What chat's notices could not deliver is not the core's: nothing is counted under any other owner.
      expect(Object.values(failuresOf(metrics, 'core')).every((count) => count === 0)).toBe(true);
    });
  });

  test('one person’s slow push services do not hold anybody else’s', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      for (const n of [1, 2, 3]) {
        await subscribeDevice(db, room, 'bob', await aBrowser(), {
          endpoint: `https://slow.example.com/${String(n)}`,
        });
      }
      await subscribeDevice(db, room, 'carol', await aBrowser());
      const posted: string[] = [];
      const held: (() => void)[] = [];
      let released = false;
      const post: PushPost = (url) => {
        posted.push(url.href);
        if (url.hostname !== 'slow.example.com' || released) {
          return Promise.resolve({ kind: 'answered', status: 201 });
        }
        return new Promise((resolve) => {
          held.push(() => {
            resolve({ kind: 'answered', status: 201 });
          });
        });
      };
      const { say, settled } = await sending(db, post);
      await say(room, 'alice', `${mention(room, 'bob')} ${mention(room, 'carol')} look`);
      try {
        // Carol's push goes while two of Bob's hang, and Bob's third waits for one of his own.
        for (
          let turn = 0;
          turn < 50 &&
          (!posted.some((url) => url === 'https://push.example.com/send/carol') ||
            posted.filter((url) => url.startsWith('https://slow.example.com/')).length < 2);
          turn++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(posted.filter((url) => url.startsWith('https://slow.example.com/'))).toHaveLength(2);
        expect(posted).toContain('https://push.example.com/send/carol');
      } finally {
        released = true;
        for (const release of held) release();
        await settled();
      }
      expect(posted.filter((url) => url.startsWith('https://slow.example.com/'))).toHaveLength(3);
    });
  });

  test('a device that moved to somebody else before its turn is not sent to', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const ids: string[] = [];
      for (const n of [1, 2, 3]) {
        ids.push(
          await subscribeDevice(db, room, 'bob', await aBrowser(), {
            endpoint: `https://push.example.com/bob/${String(n)}`,
          }),
        );
      }
      const { sessionId } = await aSession(db, clock, room.members['carol']?.userId ?? '', 30);
      const posted: string[] = [];
      let moved = false;
      const post: PushPost = async (url) => {
        posted.push(url.href);
        if (!moved) {
          moved = true;
          // While Bob's first two go, his third is signed into by Carol on its browser.
          await db
            .updateTable('push_subscriptions')
            .set({ user_id: room.members['carol']?.userId ?? '', session_id: sessionId })
            .where('id', '=', ids[2] ?? '')
            .execute();
        }
        return { kind: 'answered', status: 201 };
      };
      const { say, settled } = await sending(db, post);
      await say(room, 'alice', `${mention(room, 'bob')} look`);
      await settled();
      expect(posted).toHaveLength(2);
      expect(posted).not.toContain('https://push.example.com/bob/3');
    });
  });

  test('a device whose session was signed out while its push waited is not sent to', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const ids: string[] = [];
      for (const n of [1, 2, 3]) {
        ids.push(
          await subscribeDevice(db, room, 'bob', await aBrowser(), {
            endpoint: `https://push.example.com/bob/${String(n)}`,
          }),
        );
      }
      const posted: string[] = [];
      let signedOut = false;
      const post: PushPost = async (url) => {
        posted.push(url.href);
        if (!signedOut) {
          signedOut = true;
          // While Bob's first two go, he signs out of the browser his third is on.
          const third = await db
            .selectFrom('push_subscriptions')
            .select('session_id')
            .where('id', '=', ids[2] ?? '')
            .executeTakeFirstOrThrow();
          await db.deleteFrom('sessions').where('id', '=', third.session_id).execute();
        }
        return { kind: 'answered', status: 201 };
      };
      const { say, settled } = await sending(db, post);
      await say(room, 'alice', `${mention(room, 'bob')} look`);
      await settled();
      expect(posted).toHaveLength(2);
      expect(posted).not.toContain('https://push.example.com/bob/3');
    });
  });

  test('one device’s failure is said, and the person’s other devices are still told', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      for (const n of [1, 2]) {
        await subscribeDevice(db, room, 'bob', await aBrowser(), {
          endpoint: `https://push.example.com/bob/${String(n)}`,
        });
      }
      const posted: string[] = [];
      const post: PushPost = (url) => {
        posted.push(url.href);
        return url.pathname.endsWith('/1')
          ? Promise.reject(new Error('the socket broke'))
          : Promise.resolve({ kind: 'answered', status: 201 });
      };
      const recording = aRecordingLogger();
      const metrics = serverMetrics(undefined, ['chat']);
      const { say, settled } = await sending(db, post, recording, attention, metrics);
      await say(room, 'alice', `${mention(room, 'bob')} look`);
      await settled();
      expect(failuresOf(metrics)).toMatchObject({ error: 1, not_taken: 0 });
      expect(posted.sort()).toEqual([
        'https://push.example.com/bob/1',
        'https://push.example.com/bob/2',
      ]);
      expect(recording.lines.map((line) => line['msg'])).toContain('push delivery failed');
    });
  });

  test('a database that fails while claiming is said without throwing at the source write', async () => {
    const recording = aRecordingLogger();
    const metrics = serverMetrics(undefined, ['chat']);
    const push = await createPushSender({
      database: aDatabaseThatMustNotBeTouched(new Error('the database is down')),
      clock,
      log: recording.log,
      keys: KEYS,
      attention,
      notices: chatPushNotices,
      noticeWords: noNoticeWords,
      ...TEST_PUSH_POLICY,
      post: () => Promise.reject(new Error('nothing is posted')),
      failures: metrics.pushFailures,
      owner: 'chat',
    });
    push.told('m-1', ['u-1']);
    await push.flush(1_000);
    expect(failuresOf(metrics)).toMatchObject({ error: 1 });
    expect(
      recording.lines.map((line) => [line['level'], line['msg'], line['messageId'], line['stage']]),
    ).toContainEqual(['error', 'push delivery failed', undefined, 'claiming durable pushes']);
  });

  test('past the durable work bound the oldest occurrences are dropped, and the newest delivered', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const recipient = room.members['bob']!.userId;
      await subscribeDevice(db, room, 'bob', await aBrowser());
      const time = movable(NOW);
      const sent: string[] = [];
      for (let n = 0; n < 4; n += 1) {
        time.to(new Date(NOW.getTime() + n + 1));
        const message = await send(
          { atomically: atomicallyOn(db), clock: time, bus: quietBus },
          room.members['alice']!.context,
          { id: messageId(time.now()), content: `${mention(room, 'bob')} look ${String(n)}` },
        );
        sent.push(message.id);
      }
      const notice = await db
        .selectFrom('notifications')
        .selectAll()
        .where('message_id', '=', sent[3]!)
        .where('user_id', '=', recipient)
        .executeTakeFirstOrThrow();
      // The same production admission bound, with three instead of a thousand occurrences.
      await enqueuePush(
        db,
        time.now(),
        [
          {
            source: 'message',
            sourceId: notice.id,
            recordId: notice.message_id,
            workspaceId: notice.workspace_id,
            userId: recipient,
            module: 'chat',
            kind: notice.type,
            createdAt: notice.created_at,
          },
        ],
        3,
      );
      expect(
        (
          await db
            .selectFrom('push_intents')
            .select('record_id')
            .where('state', '=', 'overflow')
            .execute()
        ).map((row) => row.record_id),
      ).toEqual([sent[0]!]);
      const service = aPushService();
      const recording = aRecordingLogger();
      const metrics = serverMetrics(undefined, ['chat']);
      const sender = await createPushSender({
        database: db,
        clock: time,
        log: recording.log,
        keys: KEYS,
        attention,
        notices: chatPushNotices,
        noticeWords: noNoticeWords,
        ...TEST_PUSH_POLICY,
        post: service.post,
        failures: metrics.pushFailures,
      });
      await sender.flush(10_000);
      expect(service.sent).toHaveLength(3);
      expect(failuresOf(metrics)).toMatchObject({ dropped: 1 });
      expect(
        recording.lines.find((line) => line['msg'] === 'pending pushes retired'),
      ).toMatchObject({ reason: 'overflow', dropped: 1 });
    });
  });

  test('a shutdown waits for pushes on their way only as long as its bound, and says what it left', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await subscribeDevice(db, room, 'bob', await aBrowser());
      const recording = aRecordingLogger();
      const push = await createPushSender({
        database: db,
        clock,
        log: recording.log,
        keys: KEYS,
        attention,
        notices: chatPushNotices,
        noticeWords: noNoticeWords,
        ...TEST_PUSH_POLICY,
        post: () => new Promise(() => undefined),
      });
      const context = room.members['alice']?.context;
      if (context === undefined) throw new Error('no alice');
      await send({ atomically: atomicallyOn(db), clock, bus: quietBus, push }, context, {
        id: messageId(NOW),
        content: `${mention(room, 'bob')} ping`,
      });
      await push.flush(50);
      expect(recording.lines.map((line) => [line['msg'], line['running']])).toContainEqual([
        'pushes left at shutdown',
        1,
      ]);
    });
  });

  test('an endpoint push may never reach is forgotten without being tried', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const id = await subscribeDevice(db, room, 'bob', await aBrowser(), {
        endpoint: 'https://10.0.0.7/push',
      });
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      await say(room, 'alice', `${mention(room, 'bob')} ping`);
      await settled();
      expect(service.sent).toEqual([]);
      expect(
        await db.selectFrom('push_subscriptions').select('id').where('id', '=', id).execute(),
      ).toEqual([]);
    });
  });
});

describe('integration: queued notification authority', () => {
  test.each([
    'server disabled',
    'private access',
    'workspace access',
    'message read',
    'message deleted',
    'message hidden',
    'channel muted',
    'mentions only',
    'all messages unchanged',
    'Deep Work',
    'quiet hours',
    'active page',
    'account suspended',
    'account deleted',
    'workspace deleted',
    'channel deleted',
    'reason no longer pushed',
    'suppressed',
    'sound off',
    'unchanged',
  ] as const)('rechecks %s while a device waits', async (change) => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'private' });
      const heard = inMemoryAttention(clock);
      const browser = await aBrowser();
      for (const number of [1, 2, 3]) {
        await subscribeDevice(db, room, 'bob', browser, {
          endpoint: `https://audit-push.example.com/device/${String(number)}`,
        });
      }
      const posted: string[] = [];
      const payloads: unknown[] = [];
      const held: (() => void)[] = [];
      let released = false;
      const post: PushPost = async (url, _headers, body) => {
        payloads.push(await browser.read(body));
        posted.push(url.pathname);
        if (released) return { kind: 'answered', status: 201 };
        return await new Promise((resolve) => {
          held.push(() => {
            resolve({ kind: 'answered', status: 201 });
          });
        });
      };
      let enabled = true;
      const { say, settled } = await sending(db, post, aRecordingLogger(), heard, undefined, {
        keys: () => Promise.resolve(enabled ? KEYS : undefined),
      });
      const everyMessage = change === 'mentions only' || change === 'all messages unchanged';
      if (everyMessage) {
        await db
          .updateTable('channel_members')
          .set({ notification_level: 'all' })
          .where('channel_id', '=', room.channelId)
          .where('user_id', '=', room.members['bob']?.userId ?? '')
          .execute();
      }
      const id = await say(
        room,
        'alice',
        everyMessage ? 'a channel update' : `${mention(room, 'bob')} a private message`,
      );
      try {
        for (let turn = 0; turn < 100 && posted.length < 2; turn += 1) await Bun.sleep(10);
        expect(posted).toHaveLength(2);
        const bob = room.members['bob'];
        if (bob === undefined) throw new Error('audit recipient is missing');
        if (change === 'server disabled') {
          enabled = false;
        } else if (change === 'private access') {
          await db
            .deleteFrom('channel_members')
            .where('channel_id', '=', room.channelId)
            .where('user_id', '=', bob.userId)
            .execute();
        } else if (change === 'workspace access') {
          await db
            .deleteFrom('workspace_members')
            .where('workspace_id', '=', room.workspaceId)
            .where('user_id', '=', bob.userId)
            .execute();
        } else if (change === 'message read') {
          await db
            .updateTable('notifications')
            .set({ read_at: NOW })
            .where('message_id', '=', id)
            .where('user_id', '=', bob.userId)
            .execute();
        } else if (change === 'message deleted') {
          await db.updateTable('messages').set({ deleted_at: NOW }).where('id', '=', id).execute();
        } else if (change === 'message hidden') {
          await db
            .insertInto('hidden_messages')
            .values({
              user_id: bob.userId,
              workspace_id: room.workspaceId,
              channel_id: room.channelId,
              message_id: id,
              hidden_at: NOW,
            })
            .execute();
        } else if (change === 'channel muted') {
          await db
            .updateTable('channel_members')
            .set({ notification_level: 'none' })
            .where('channel_id', '=', room.channelId)
            .where('user_id', '=', bob.userId)
            .execute();
        } else if (change === 'mentions only') {
          await db
            .updateTable('channel_members')
            .set({ notification_level: 'mentions' })
            .where('channel_id', '=', room.channelId)
            .where('user_id', '=', bob.userId)
            .execute();
        } else if (change === 'Deep Work') {
          await db
            .updateTable('workspace_members')
            .set({ is_deep_work_active: true, deep_work_until: new Date(NOW.getTime() + 3600000) })
            .where('workspace_id', '=', room.workspaceId)
            .where('user_id', '=', bob.userId)
            .execute();
        } else if (change === 'quiet hours') {
          await db
            .updateTable('users')
            .set({ time_zone: 'UTC', quiet_from: 0, quiet_to: 1439, quiet_days: 127 })
            .where('id', '=', bob.userId)
            .execute();
        } else if (change === 'sound off') {
          await db
            .updateTable('push_subscriptions')
            .set({ sound: false })
            .where('user_id', '=', bob.userId)
            .execute();
        } else if (change === 'active page') {
          heard.heard(bob.userId, room.workspaceId);
        } else if (change === 'account suspended') {
          await db
            .updateTable('users')
            .set({ suspended_at: NOW })
            .where('id', '=', bob.userId)
            .execute();
        } else if (change === 'account deleted') {
          await db
            .updateTable('users')
            .set({ deleted_at: NOW })
            .where('id', '=', bob.userId)
            .execute();
        } else if (change === 'workspace deleted') {
          await db
            .updateTable('workspaces')
            .set({ deleted_at: NOW })
            .where('id', '=', room.workspaceId)
            .execute();
        } else if (change === 'channel deleted') {
          await db
            .updateTable('channels')
            .set({ deleted_at: NOW })
            .where('id', '=', room.channelId)
            .execute();
        } else if (change === 'reason no longer pushed') {
          await db
            .updateTable('notifications')
            .set({ type: 'thread_resolved' })
            .where('message_id', '=', id)
            .where('user_id', '=', bob.userId)
            .execute();
        } else if (change === 'suppressed') {
          await db
            .updateTable('notifications')
            .set({ suppressed_by_deep_work: true })
            .where('message_id', '=', id)
            .where('user_id', '=', bob.userId)
            .execute();
        }
        released = true;
        for (const release of held) release();
        await settled();
        if (change === 'sound off') expect(payloads.at(-1)).toMatchObject({ silent: true });
        // The third device was still waiting when authority was revoked.
        expect(posted).toHaveLength(
          change === 'unchanged' || change === 'all messages unchanged' || change === 'sound off'
            ? 3
            : 2,
        );
      } finally {
        released = true;
        for (const release of held) release();
        await settled();
      }
    });
  });
});

describe('integration: the initial push lookup omits notices no longer owed', () => {
  test.each(['read', 'suppressed'] as const)(
    'does not route a notice already %s',
    async (change) => {
      await withRollback(async (db) => {
        const room = await aRoom(db, ['alice', 'bob']);
        const recipient = room.members['bob']?.userId ?? '';
        const { say, settled } = await sending(db, aPushService().post);
        const id = await say(room, 'alice', `${mention(room, 'bob')} ping`);
        await settled();
        expect(await chatPushNotices.of(db, id, [recipient])).toHaveLength(1);
        await db
          .updateTable('notifications')
          .set(change === 'read' ? { read_at: NOW } : { suppressed_by_deep_work: true })
          .where('message_id', '=', id)
          .where('user_id', '=', recipient)
          .execute();
        expect(await chatPushNotices.of(db, id, [recipient])).toEqual([]);
      });
    },
  );
});

describe('integration: push destinations agree with the message location', () => {
  test.each([
    'reply mention',
    'reply reminder',
    'top-level mention',
    'top-level reminder',
    'root thread reply',
  ] as const)('%s opens its own destination', async (kind) => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const recipient = room.members['bob']?.userId ?? '';
      const browser = await aBrowser();
      await subscribeDevice(db, room, 'bob', browser);
      let offset = 0;
      const say = async (
        _room: Room,
        _actor: string,
        content: string,
        _id?: string,
        parentId?: string,
      ): Promise<string> => {
        const result = await send(
          { atomically: atomicallyOn(db), clock, bus: quietBus },
          room.members['alice']!.context,
          {
            id: messageId(new Date(NOW.getTime() + ++offset)),
            content,
            ...(parentId === undefined ? {} : { parentId }),
          },
        );
        return result.id;
      };
      const root = await say(room, 'alice', `${mention(room, 'bob')} a question`);
      const id = kind.startsWith('reply')
        ? await say(room, 'alice', `${mention(room, 'bob')} an answer`, undefined, root)
        : root;
      await db
        .updateTable('notifications')
        .set({ read_at: NOW })
        .where('message_id', '<>', id)
        .execute();
      if (kind.includes('reminder') || kind === 'root thread reply') {
        await db
          .updateTable('notifications')
          .set({ type: kind === 'root thread reply' ? 'thread_reply' : 'reminder' })
          .where('message_id', '=', id)
          .where('user_id', '=', recipient)
          .execute();
      }
      const service = aPushService();
      const sender = await createPushSender({
        database: db,
        clock,
        log: aRecordingLogger().log,
        keys: KEYS,
        attention,
        notices: chatPushNotices,
        noticeWords: noNoticeWords,
        ...TEST_PUSH_POLICY,
        post: service.post,
      });
      sender.told(id, [recipient]);
      await sender.flush(10_000);
      expect(service.sent).toHaveLength(1);
      const payload = (await browser.read(service.sent[0]?.body ?? new Uint8Array())) as {
        url: string;
      };
      const target = new URL(payload.url, 'https://purlay.test');
      expect(target.pathname.endsWith(`/c/${room.channelId}`)).toBe(true);
      expect(target.searchParams.get('thread')).toBe(
        kind.startsWith('reply') || kind === 'root thread reply' ? root : null,
      );
    });
  });
});

describe('integration: live push settings', () => {
  for (const stage of ['lookup', 'last recipient check'] as const) {
    test(`live push disabled during ${stage} never reaches a provider and leaves devices intact`, async () => {
      await withRollback(async (db) => {
        const room = await aRoom(db, ['alice', 'bob']);
        await subscribeDevice(db, room, 'bob', await aBrowser());
        const service = aPushService(201);
        const recording = aRecordingLogger();
        let enabled = stage !== 'lookup';
        let recipientChecks = 0;
        const sender = await sending(db, service.post, recording, attention, undefined, {
          keys: () => Promise.resolve(enabled ? KEYS : undefined),
          notices: {
            ...chatPushNotices,
            canDeliver: async (...args) => {
              const allowed = await chatPushNotices.canDeliver(...args);
              // The first checks precede key lookup/encryption. Disable at the final source check
              // to exercise the last dynamic-key guard rather than an earlier redundant check.
              recipientChecks += 1;
              if (recipientChecks === 3) enabled = false;
              return allowed;
            },
          },
        });
        await sender.say(room, 'alice', `${mention(room, 'bob')} a notice`);
        await sender.settled();
        expect(service.sent).toHaveLength(0);
        expect(recording.lines).toHaveLength(0);
        expect(
          await db
            .selectFrom('push_subscriptions')
            .select('id')
            .where('user_id', '=', room.members['bob']?.userId ?? '')
            .execute(),
        ).toHaveLength(1);
      });
    });
  }
});
