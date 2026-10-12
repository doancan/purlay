/**
 * A member's notification level (D-107): what each level is told of a new message, what it moves
 * on the badge, and that only a member can set their own.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type NotificationLevel } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireChannelById } from '../../platform/channels';
import { aRoom, counters, notificationsOf, type Room } from '../../testing/rooms';
import { sendMessage, type Sent } from '../messages/messages';
import { reviseMessage } from '../messages/edit';
import { markRead } from './read-state';
import { setNotificationLevel } from './notification-level';

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
  db: Executor,
  room: Room,
  name: string,
  to: NotificationLevel,
): Promise<void> => {
  await setNotificationLevel(db, member(room, name).context, to);
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
      const refusal = await refusalOf(setNotificationLevel(db, context, 'all'));
      expect(refusal.body.code).toBe('CHANNEL_NOT_FOUND');
    });
  });
});
