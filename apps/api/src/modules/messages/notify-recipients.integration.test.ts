/**
 * Who is told, and how many (D-99 §1–§2, D-34; review H-API 6).
 *
 * A reply tells the root's author and everyone who answered before. Each of them must still
 * be able to see the channel — somebody removed from a private channel since replying is told
 * nothing about it (the notification row would name a conversation they may no longer know
 * exists) — and the set is bounded, because a thread with ten thousand participants must not
 * make one reply write ten thousand rows.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { atomicallyOn } from '../../platform/transactions';
import { fixedClock } from '../../platform/clock';
import { NO_LOG, type EventBus } from '../../platform/events';
import { markRead } from '../channels/read-state';
import { aRoom, counters, notificationsOf, type Room } from '../../testing/rooms';
import { sendMessage, type OutgoingMessage, type Sent } from './messages';
import { setResolved } from './threads';
import { THREAD_PARTICIPANTS_MAX } from './delivery';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const nextId = (): string => messageId(new Date(NOW.getTime() + (tick += 1) * 10));

const post = async (
  db: Executor,
  room: Room,
  as: string,
  content: string,
  extra: Partial<OutgoingMessage> = {},
): Promise<Sent> => {
  const member = room.members[as];
  if (member === undefined) throw new Error(`no member ${as}`);
  return await sendMessage(db, clock, member.context, { id: nextId(), content, ...extra });
};

const idOf = (room: Room, name: string): string => room.members[name]?.userId ?? '';

const removeFromChannel = async (db: Executor, room: Room, name: string): Promise<void> => {
  await db
    .deleteFrom('channel_members')
    .where('channel_id', '=', room.channelId)
    .where('user_id', '=', idOf(room, name))
    .execute();
};

describe('integration: a thread reply goes to people who can still see the channel', () => {
  test('somebody removed from a private channel since they replied is told nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol', 'dave'], { type: 'private' });
      const root = await post(db, room, 'alice', 'why 4s?');
      await post(db, room, 'bob', 'documented?', { parentId: root.message.id });
      await post(db, room, 'carol', 'not sure', { parentId: root.message.id });
      await removeFromChannel(db, room, 'carol');

      await post(db, room, 'dave', 'it is in the postmortem', { parentId: root.message.id });

      const told = async (name: string): Promise<string[]> =>
        (await notificationsOf(db, idOf(room, name)))
          .filter((n) => n.type === 'thread_reply')
          .map((n) => n.type);
      // Alice started it and was told of all three replies; Bob of the two after his own.
      expect(await told('alice')).toHaveLength(3);
      expect(await told('bob')).toHaveLength(2);
      // Carol has no membership now: dave's reply told her nothing, and she holds no row.
      expect(await notificationsOf(db, idOf(room, 'carol'))).toEqual([]);
    });
  });

  test('a person who left the workspace is not told either', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const root = await post(db, room, 'alice', 'question');
      await post(db, room, 'bob', 'answer', { parentId: root.message.id });
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', idOf(room, 'bob'))
        .execute();
      await post(db, room, 'carol', 'another', { parentId: root.message.id });
      expect(await notificationsOf(db, idOf(room, 'bob'))).toEqual([]);
    });
  });

  test('the set is bounded: the root author and the most recent repliers, nobody else', async () => {
    await withRollback(async (db) => {
      const names = ['alice', ...Array.from({ length: 60 }, (_, n) => `r${String(n)}`), 'last'];
      const room = await aRoom(db, names);
      const root = await post(db, room, 'alice', 'a thread everybody joined');
      for (const name of names.slice(1, 61)) {
        await post(db, room, name, 'me too', { parentId: root.message.id });
      }
      await post(db, room, 'last', 'the final word', { parentId: root.message.id });

      const rows = await db
        .selectFrom('notifications')
        .select('user_id')
        .where('channel_id', '=', room.channelId)
        .where('type', '=', 'thread_reply')
        .where('message_id', 'in', (eb) =>
          eb
            .selectFrom('messages')
            .select('id')
            .where('content', '=', 'the final word')
            .where('channel_id', '=', room.channelId),
        )
        .execute();
      const told = new Set(rows.map((row) => row.user_id));
      // The most recent THREAD_PARTICIPANTS_MAX repliers, and the root's author besides.
      expect(told.size).toBe(THREAD_PARTICIPANTS_MAX + 1);
      expect(told.has(idOf(room, 'alice'))).toBe(true);
      expect(told.has(idOf(room, 'r59'))).toBe(true);
      expect(told.has(idOf(room, 'r0'))).toBe(false);
    });
  });
});

describe('integration: a resolution is told only to an author who can still see the channel', () => {
  const noBus: EventBus = {
    publish: () => Promise.resolve(),
    subscribe: () => false,
    unsubscribe: () => undefined,
    forget: () => undefined,
  };

  test('an author removed from the private channel is not notified', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol'], { type: 'private' });
      const root = await post(db, room, 'alice', 'question');
      await post(db, room, 'bob', 'answer', { parentId: root.message.id });
      await removeFromChannel(db, room, 'alice');
      await setResolved(
        { atomically: atomicallyOn(db), clock, bus: noBus, log: NO_LOG },
        idOf(room, 'bob'),
        root.message.id,
        true,
      );
      const told = (await notificationsOf(db, idOf(room, 'alice'))).filter(
        (n) => n.type === 'thread_resolved',
      );
      expect(told).toEqual([]);
    });
  });
});

describe('integration: what a recount finds is what is still there', () => {
  test('a deleted message that needed the person no longer counts toward what needs them', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      if (alice === undefined || bob === undefined) throw new Error('room');
      const mention = await post(db, room, 'alice', `@${bob.username} please look`);
      await post(db, room, 'alice', 'and an unrelated one');
      await db
        .updateTable('messages')
        .set({ deleted_at: NOW })
        .where('id', '=', mention.message.id)
        .execute();
      // Reading to a point before both leaves both past the position: only the live one counts.
      const before = messageId(new Date(NOW.getTime() - 1));
      await db
        .insertInto('messages')
        .values({
          id: before,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: bob.userId,
          content: 'bob says hello',
        })
        .execute();
      const outcome = await markRead(db, clock, bob.context, before);
      expect(outcome.state).toMatchObject({ unreadCount: 1, unreadMentionCount: 0 });
      expect(await counters(db, room, bob.userId)).toMatchObject({ unread: 1, mentions: 0 });
    });
  });
});
