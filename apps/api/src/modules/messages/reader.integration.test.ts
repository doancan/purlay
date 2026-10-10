/**
 * The one reader (D-99 §8): what a built message carries, and that building a page
 * costs the same number of queries whether it holds five messages or fifty.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { aRoom, type Room } from '../../testing/rooms';
import { messageHistory, missedIn, sendMessage } from './messages';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

const post = async (
  db: Executor,
  room: Room,
  as: string,
  content: string,
  seconds: number,
  parentId?: string,
): Promise<string> => {
  const member = room.members[as];
  if (member === undefined) throw new Error(`no member ${as}`);
  const sent = await sendMessage(db, fixedClock(at(seconds)), member.context, {
    id: messageId(at(seconds)),
    content,
    parentId,
  });
  return sent.message.id;
};

/** Counts the statements a body sends through this executor. */
const counting = async <T>(
  db: Executor,
  body: (counted: Executor) => Promise<T>,
): Promise<{ result: T; queries: number }> => {
  let queries = 0;
  const counted = db.withPlugin({
    transformQuery: (args) => {
      queries += 1;
      return args.node;
    },
    transformResult: (args) => Promise.resolve(args.result),
  });
  const result = await body(counted);
  return { result, queries };
};

describe('integration: building a page of messages', () => {
  test('carries parent, thread, reactions and mentions, built from the rows', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = room.members['bob'];
      const alice = room.members['alice'];
      if (bob === undefined || alice === undefined) throw new Error('no members');
      const root = await post(db, room, 'alice', `hello @${bob.username}`, 0);
      await post(db, room, 'bob', 'an answer', 1, root);
      await db
        .insertInto('reactions')
        .values([
          { message_id: root, user_id: bob.userId, emoji: '👍' },
          { message_id: root, user_id: alice.userId, emoji: '👍' },
        ])
        .execute();
      await db
        .updateTable('messages')
        .set({ resolved_at: at(5), resolved_by: bob.userId })
        .where('id', '=', root)
        .execute();

      const page = await messageHistory(db, alice.context);
      expect(page.data).toHaveLength(1);
      const [message] = page.data;
      expect(message).toMatchObject({
        id: root,
        parentId: null,
        mentions: [bob.userId],
        thread: {
          replyCount: 1,
          lastReplyAt: at(1).toISOString(),
          resolvedAt: at(5).toISOString(),
          resolvedBy: { id: bob.userId, username: bob.username },
        },
      });
      expect(message?.reactions).toHaveLength(1);
      expect(message?.reactions[0]?.emoji).toBe('👍');
      expect([...(message?.reactions[0]?.userIds ?? [])].sort()).toEqual(
        [alice.userId, bob.userId].sort(),
      );
    });
  });

  test('costs a fixed number of queries, however long the page', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = room.members['bob'];
      const context = room.members['alice']?.context;
      if (bob === undefined || context === undefined) throw new Error('no members');
      for (let n = 0; n < 50; n += 1) {
        const id = await post(db, room, 'alice', `message ${String(n)} @${bob.username}`, n);
        await db
          .insertInto('reactions')
          .values({ message_id: id, user_id: bob.userId, emoji: '🎉' })
          .execute();
        await db
          .updateTable('messages')
          .set({ resolved_at: at(100), resolved_by: bob.userId, thread_reply_count: 1 })
          .where('id', '=', id)
          .execute();
      }

      const five = await counting(
        db,
        async (counted) => await messageHistory(counted, context, { limit: 5 }),
      );
      const fifty = await counting(
        db,
        async (counted) => await messageHistory(counted, context, { limit: 50 }),
      );
      expect(five.result.data).toHaveLength(5);
      expect(fifty.result.data).toHaveLength(50);
      // The page, the reactions, the mentions and the people who resolved: four, always.
      expect(five.queries).toBe(4);
      expect(fifty.queries).toBe(five.queries);
    });
  });

  test('a replay of several channels is built together: still a fixed number of queries', async () => {
    await withRollback(async (db) => {
      const rooms = [
        await aRoom(db, ['alice']),
        await aRoom(db, ['alice']),
        await aRoom(db, ['alice']),
      ];
      for (const room of rooms) {
        for (let n = 0; n < 4; n += 1) await post(db, room, 'alice', `m${String(n)}`, n);
      }
      const wanted = (
        take: number,
      ): { context: NonNullable<Room['members'][string]>['context']; after: string }[] =>
        rooms.slice(0, take).flatMap((room) => {
          const context = room.members['alice']?.context;
          return context === undefined ? [] : [{ context, after: messageId(new Date(0)) }];
        });

      const one = await counting(db, async (counted) => await missedIn(counted, wanted(1), 10));
      const three = await counting(db, async (counted) => await missedIn(counted, wanted(3), 10));
      expect([...three.result.values()].map((replay) => replay.data.length)).toEqual([4, 4, 4]);
      expect(three.queries).toBe(one.queries);
    });
  });

  test('an empty page asks for nothing beyond its own query', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const context = room.members['alice']?.context;
      if (context === undefined) throw new Error('no alice');
      const empty = await counting(db, async (counted) => await messageHistory(counted, context));
      expect(empty.result.data).toEqual([]);
      expect(empty.queries).toBe(1);
    });
  });
});
