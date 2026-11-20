/**
 * A member's notification level (D-107): what each level is told of a new message, what it moves
 * on the badge, and that only a member can set their own — for good, or for a while (D-329).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  withRollback,
  type Executor,
  type Transaction,
} from '@purlay/db';
import { messageId, type NotificationLevel } from '@purlay/types';
import { fixedClock, HOUR_MS, type Clock } from '../../../platform/clock';
import { aMovableClock } from '../../../testing/doubles';
import { AppError } from '../../../platform/errors';
import { requireChannelById } from './guard';
import { aRoom, counters, notificationsOf, type Room } from '../../../testing/rooms';
import { sendMessage, type Sent } from '../messages/messages';
import { reviseMessage } from '../messages/edit';
import { markRead } from './read-state';
import { setNotificationLevel } from './notification-level';
import { channelFor } from './channels';
import { chatPushNotices } from '../notifications/push-notices';
import { setResolved } from '../messages/threads';
import { atomicallyOn } from '../../../platform/transactions';
import { PUSH_QUIET_BUS } from '../../../testing/pending-push';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const nextId = (): string => messageId(new Date(NOW.getTime() + (tick += 1) * 10));

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};

const post = async (
  db: Executor,
  room: Room,
  as: string,
  content: string,
  parentId?: string,
): Promise<Sent> =>
  await sendMessage(db, clock, member(room, as).context, {
    id: nextId(),
    content,
    ...(parentId === undefined ? {} : { parentId }),
  });

const level = async (
  db: Transaction,
  room: Room,
  name: string,
  to: NotificationLevel,
): Promise<void> => {
  await setNotificationLevel(db, clock, member(room, name).context, to);
};

const refusalOf = async (attempt: Promise<unknown>): Promise<AppError> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('accepted where it had to be refused');
};

describe('integration: what each level is told', () => {
  test('all: every message by somebody else, on the badge; mentions (the default): only what names them', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      await level(db, room, 'bob', 'all');
      const sent = await post(db, room, 'alice', 'a plain message');
      const bob = member(room, 'bob').userId;
      expect(await notificationsOf(db, bob)).toEqual([
        { messageId: sent.message.id, type: 'channel_message' },
      ]);
      expect(await counters(db, room, bob)).toMatchObject({ unread: 1, mentions: 1 });
      const carol = member(room, 'carol').userId;
      expect(await notificationsOf(db, carol)).toEqual([]);
      expect(await counters(db, room, carol)).toMatchObject({ unread: 1, mentions: 0 });
    });
  });

  test('all: a mention is still the one reason given, once', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await level(db, room, 'bob', 'all');
      const sent = await post(db, room, 'alice', `@${member(room, 'bob').username} look`);
      expect(await notificationsOf(db, member(room, 'bob').userId)).toEqual([
        { messageId: sent.message.id, type: 'mention' },
      ]);
    });
  });

  test('all: an edit that names them adds nothing — they were told of the message already (I-6)', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await level(db, room, 'bob', 'all');
      const sent = await post(db, room, 'alice', 'a plain message');
      await reviseMessage(
        db,
        clock,
        member(room, 'alice').userId,
        sent.message.id,
        `@${member(room, 'bob').username} a plain message`,
      );
      const bob = member(room, 'bob').userId;
      expect(await notificationsOf(db, bob)).toEqual([
        { messageId: sent.message.id, type: 'channel_message' },
      ]);
      expect(await counters(db, room, bob)).toMatchObject({ unread: 1, mentions: 1 });
    });
  });

  test('none: not a mention, not an answer in their own thread; the message is still unread', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'bob', 'my question');
      await level(db, room, 'bob', 'none');
      await post(db, room, 'alice', `@${member(room, 'bob').username} here`);
      await post(db, room, 'alice', 'an answer', root.message.id);
      const bob = member(room, 'bob').userId;
      expect(await notificationsOf(db, bob)).toEqual([]);
      expect(await counters(db, room, bob)).toMatchObject({ unread: 2, mentions: 0 });
    });
  });

  test('a read counts the badge again the way the send did: what all was told is still waiting past it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await level(db, room, 'bob', 'all');
      const first = await post(db, room, 'alice', 'one');
      await post(db, room, 'alice', 'two');
      await post(db, room, 'alice', 'three');
      await markRead(db, clock, member(room, 'bob').context, first.message.id);
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 2,
        mentions: 2,
      });
    });
  });
});

describe('integration: setting it', () => {
  test('changes the member’s own row, and nobody else’s', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await level(db, room, 'bob', 'none');
      const rows = await db
        .selectFrom('channel_members')
        .select(['user_id', 'notification_level'])
        .where('channel_id', '=', room.channelId)
        .execute();
      const of = (name: string): string | undefined =>
        rows.find((row) => row.user_id === member(room, name).userId)?.notification_level;
      expect([of('alice'), of('bob')]).toEqual(['mentions', 'none']);
    });
  });

  test('a public channel the person has not joined is not theirs to set: the stranger’s answer', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['dave'] });
      const dave = room.outsiders['dave']?.userId ?? '';
      const context = await requireChannelById(db, dave, room.channelId);
      const refusal = await refusalOf(setNotificationLevel(db, clock, context, 'all'));
      expect(refusal.body.code).toBe('CHANNEL_NOT_FOUND');
      // Nor for a while: no timer is written for somebody with no membership to time.
      const timed = await refusalOf(
        setNotificationLevel(
          db,
          clock,
          context,
          'none',
          new Date(NOW.getTime() + HOUR_MS).toISOString(),
        ),
      );
      expect(timed.body.code).toBe('CHANNEL_NOT_FOUND');
      expect(
        await db
          .selectFrom('channel_level_timers')
          .select('user_id')
          .where('user_id', '=', dave)
          .execute(),
      ).toEqual([]);
    });
  });
});

describe('integration: a level for a while (D-329)', () => {
  /** A message sent at the moving clock's instant, so its id is within the skew the send allows. */
  const postAt = async (
    db: Executor,
    at: Clock,
    room: Room,
    as: string,
    content: string,
  ): Promise<Sent> =>
    await sendMessage(db, at, member(room, as).context, {
      id: messageId(new Date(at.now().getTime() + (tick += 1))),
      content,
    });

  const inAnHour = (from: Clock): string => new Date(from.now().getTime() + HOUR_MS).toISOString();

  const levelOf = async (
    db: Executor,
    at: Clock,
    room: Room,
    name: string,
  ): Promise<{ level: string | null; until: string | null | undefined }> => {
    const channel = await channelFor(db, member(room, name).userId, room.channelId, at.now());
    return { level: channel.notificationLevel, until: channel.notificationLevelUntil };
  };

  test('muted for an hour: nothing is told while it lasts, and the level before it is back when it ends', async () => {
    await withRollback(async (db) => {
      const at = aMovableClock(NOW);
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = member(room, 'bob');
      await setNotificationLevel(db, at, bob.context, 'all');
      const until = inAnHour(at);
      await setNotificationLevel(db, at, bob.context, 'none', until);
      expect(await levelOf(db, at, room, 'bob')).toEqual({ level: 'none', until });

      await postAt(db, at, room, 'alice', `@${bob.username} while muted`);
      expect(await notificationsOf(db, bob.userId)).toEqual([]);

      // A minute before the end it still holds; at the end, `all` is in force again with no write.
      at.advance(HOUR_MS - 60_000);
      expect((await levelOf(db, at, room, 'bob')).level).toBe('none');
      at.advance(60_000);
      expect(await levelOf(db, at, room, 'bob')).toEqual({ level: 'all', until: null });
      const after = await postAt(db, at, room, 'alice', 'a plain message after');
      expect(await notificationsOf(db, bob.userId)).toEqual([
        { messageId: after.message.id, type: 'channel_message' },
      ]);
    });
  });

  test('the level that comes back is the one in force before: muting again for longer still returns to it', async () => {
    await withRollback(async (db) => {
      const at = aMovableClock(NOW);
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = member(room, 'bob').context;
      await setNotificationLevel(db, at, bob, 'all');
      await setNotificationLevel(db, at, bob, 'none', inAnHour(at));
      at.advance(30 * 60_000);
      // Chosen again while the first lasts: the level to return to is still `all`, not the first mute.
      const later = new Date(at.now().getTime() + 8 * HOUR_MS).toISOString();
      await setNotificationLevel(db, at, bob, 'mentions', later);
      expect(await levelOf(db, at, room, 'bob')).toEqual({ level: 'mentions', until: later });
      at.advance(8 * HOUR_MS);
      expect(await levelOf(db, at, room, 'bob')).toEqual({ level: 'all', until: null });
      // After one has ended, a new one returns to the level that had come back, not to anything older.
      await setNotificationLevel(db, at, bob, 'none', inAnHour(at));
      at.advance(HOUR_MS);
      expect((await levelOf(db, at, room, 'bob')).level).toBe('all');
    });
  });

  test('a level for good chosen while one for a while lasts ends the timer: no end, nothing comes back', async () => {
    await withRollback(async (db) => {
      const at = aMovableClock(NOW);
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = member(room, 'bob');
      await setNotificationLevel(db, at, bob.context, 'none', inAnHour(at));
      await setNotificationLevel(db, at, bob.context, 'none');
      expect(await levelOf(db, at, room, 'bob')).toEqual({ level: 'none', until: null });
      at.advance(2 * HOUR_MS);
      expect((await levelOf(db, at, room, 'bob')).level).toBe('none');
      expect(
        await db
          .selectFrom('channel_level_timers')
          .select('user_id')
          .where('channel_id', '=', room.channelId)
          .execute(),
      ).toEqual([]);
    });
  });

  test('only the member’s own row is timed; nobody else’s level moves', async () => {
    await withRollback(async (db) => {
      const at = aMovableClock(NOW);
      const room = await aRoom(db, ['alice', 'bob']);
      await setNotificationLevel(db, at, member(room, 'bob').context, 'none', inAnHour(at));
      expect(await levelOf(db, at, room, 'alice')).toEqual({ level: 'mentions', until: null });
      const timers = await db
        .selectFrom('channel_level_timers')
        .select(['user_id', 'then_level'])
        .where('channel_id', '=', room.channelId)
        .execute();
      expect(timers).toEqual([{ user_id: member(room, 'bob').userId, then_level: 'mentions' }]);
    });
  });

  test('an end now, in the past, or past Deep Work’s bound is refused by name, and nothing is written', async () => {
    await withRollback(async (db) => {
      const at = aMovableClock(NOW);
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = member(room, 'bob').context;
      for (const until of [
        NOW.toISOString(),
        new Date(NOW.getTime() - 60_000).toISOString(),
        new Date(NOW.getTime() + 24 * HOUR_MS + 1).toISOString(),
      ]) {
        const refusal = await refusalOf(setNotificationLevel(db, at, bob, 'none', until));
        expect(refusal.body).toMatchObject({
          code: 'VALIDATION_FAILED',
          details: { fields: { until: 'ahead, and at most 24 hours' } },
        });
      }
      expect(await levelOf(db, at, room, 'bob')).toEqual({ level: 'mentions', until: null });
      // The bound itself is allowed.
      const bound = new Date(NOW.getTime() + 24 * HOUR_MS).toISOString();
      await setNotificationLevel(db, at, bob, 'none', bound);
      expect(await levelOf(db, at, room, 'bob')).toEqual({ level: 'none', until: bound });
    });
  });

  test('a thread resolved while its author is muted tells them nothing; after the mute ends, it does', async () => {
    await withRollback(async (db) => {
      const at = aMovableClock(NOW);
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = member(room, 'bob');
      const resolve = async (rootId: string, resolved: boolean): Promise<void> => {
        await setResolved(
          { atomically: atomicallyOn(db), clock: at, bus: PUSH_QUIET_BUS },
          member(room, 'alice').userId,
          rootId,
          resolved,
        );
      };
      const root = await postAt(db, at, room, 'bob', 'my question');
      await sendMessage(db, at, member(room, 'alice').context, {
        id: messageId(new Date(at.now().getTime() + (tick += 1))),
        content: 'an answer',
        parentId: root.message.id,
      });
      await setNotificationLevel(db, at, bob.context, 'none', inAnHour(at));
      await resolve(root.message.id, true);
      const resolutions = async (): Promise<readonly string[]> =>
        (await notificationsOf(db, bob.userId))
          .filter((row) => row.type === 'thread_resolved')
          .map((row) => row.messageId);
      expect(await resolutions()).toEqual([]);
      await resolve(root.message.id, false);
      at.advance(HOUR_MS);
      await resolve(root.message.id, true);
      expect(await resolutions()).toEqual([root.message.id]);
    });
  });

  test('a queued push is asked about the level in force as it goes', async () => {
    await withRollback(async (db) => {
      const at = aMovableClock(NOW);
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = member(room, 'bob');
      await setNotificationLevel(db, at, bob.context, 'all');
      const sent = await postAt(db, at, room, 'alice', 'a plain message');
      expect(await chatPushNotices.canDeliver(db, sent.message.id, bob.userId, at.now())).toBe(
        true,
      );
      await setNotificationLevel(db, at, bob.context, 'none', inAnHour(at));
      expect(await chatPushNotices.canDeliver(db, sent.message.id, bob.userId, at.now())).toBe(
        false,
      );
      at.advance(HOUR_MS);
      expect(await chatPushNotices.canDeliver(db, sent.message.id, bob.userId, at.now())).toBe(
        true,
      );
    });
  });
});
