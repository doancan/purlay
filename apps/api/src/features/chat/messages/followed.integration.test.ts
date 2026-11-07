/** The caller's real follow relation across visible channels, without changing receipts. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, sql, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { FollowedThreadsPage, messageId, type FollowedThreadsQuery } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aRoom, type Room } from '../../../testing/rooms';
import { requireMessageById } from '../channels/guard';
import { setFollowing } from './follow';
import { followedThreads } from './followed';
import { removeMessage } from './delete';

afterAll(async () => {
  await closeIntegrationDatabase();
});
const NOW = new Date('2026-11-07T12:00:00.000Z');
const clock = fixedClock(NOW);
let written = 0;
const who = (room: Room, name: string): string => {
  const user = room.members[name] ?? room.outsiders[name];
  if (user === undefined) throw new Error(`Missing fixture person ${name}`);
  return user.userId;
};
const say = async (
  db: Executor,
  room: Room,
  sender: string,
  options: { readonly parentId?: string; readonly at?: string } = {},
): Promise<string> => {
  written += 1;
  const id = messageId(new Date(NOW.getTime() + written));
  const at = options.at ?? new Date(NOW.getTime() + written).toISOString();
  await db
    .insertInto('messages')
    .values({
      id,
      workspace_id: room.workspaceId,
      channel_id: room.channelId,
      sender_id: who(room, sender),
      content: `Conversation ${String(written)}`,
      parent_id: options.parentId ?? null,
      created_at: at,
    })
    .execute();
  // This reader fixture seeds the same denormalised summary the send service maintains.
  if (options.parentId !== undefined)
    await db
      .updateTable('messages')
      .set({
        thread_reply_count: sql<number>`thread_reply_count + 1`,
        thread_last_reply_at: at,
      })
      .where('id', '=', options.parentId)
      .execute();
  return id;
};
const choose = async (
  db: Executor,
  room: Room,
  name: string,
  root: string,
  following: boolean,
): Promise<void> => {
  await setFollowing(db, clock, await requireMessageById(db, who(room, name), root), following);
};
const page = async (
  db: Executor,
  room: Room,
  name: string,
  query: FollowedThreadsQuery = {},
): Promise<FollowedThreadsPage> => {
  const result = await followedThreads(
    db,
    await requireWorkspaceMembership(db, who(room, name), room.workspaceId),
    query,
  );
  expect(Value.Check(FollowedThreadsPage, result)).toBe(true);
  return result;
};

describe('integration: followed conversations', () => {
  test('includes implicit authors/repliers and explicit follows once; an explicit unfollow survives another reply', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const authored = await say(db, room, 'alice');
      const answered = await say(db, room, 'bob');
      await say(db, room, 'alice', { parentId: answered });
      const watched = await say(db, room, 'bob');
      await choose(db, room, 'alice', watched, true);
      await choose(db, room, 'alice', authored, true);
      const ignored = await say(db, room, 'bob');
      await say(db, room, 'alice', { parentId: ignored });
      await choose(db, room, 'alice', ignored, false);
      await say(db, room, 'alice', { parentId: ignored });
      await say(db, room, 'bob');
      const ids = (await page(db, room, 'alice')).data.map((row) => row.root.id);
      expect(new Set(ids)).toEqual(new Set([authored, answered, watched]));
      expect(ids).toHaveLength(3);
      const oldReply = await say(db, room, 'bob');
      const removed = await say(db, room, 'alice', { parentId: oldReply });
      await db.updateTable('messages').set({ deleted_at: NOW }).where('id', '=', removed).execute();
      expect((await page(db, room, 'alice')).data.map((row) => row.root.id)).not.toContain(
        oldReply,
      );
    });
  });

  test('preserves microsecond activity and UUID ties across complete keyset pages', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const first = await say(db, room, 'alice', { at: '2026-11-07T12:00:00.000001Z' });
      const second = await say(db, room, 'alice', { at: '2026-11-07T12:00:00.000002Z' });
      const third = await say(db, room, 'alice', { at: '2026-11-07T12:00:00.000002Z' });
      const one = await page(db, room, 'alice', { limit: 1 });
      expect(one.data.map((row) => row.root.id)).toEqual([third]);
      expect(one.nextCursor).toEqual({ activityAt: '2026-11-07T12:00:00.000002Z', rootId: third });
      if (one.nextCursor === null) throw new Error('Missing continuation');
      const two = await page(db, room, 'alice', {
        limit: 1,
        beforeActivityAt: one.nextCursor.activityAt,
        beforeRootId: one.nextCursor.rootId,
      });
      expect(two.data.map((row) => row.root.id)).toEqual([second]);
      if (two.nextCursor === null) throw new Error('Missing second continuation');
      const last = await page(db, room, 'alice', {
        limit: 1,
        beforeActivityAt: two.nextCursor.activityAt,
        beforeRootId: two.nextCursor.rootId,
      });
      expect(last.data.map((row) => row.root.id)).toEqual([first]);
      expect(last.nextCursor).toBeNull();
    });
  });

  test('counts waiting replies from the existing scope and listing never acknowledges them', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await say(db, room, 'alice');
      const first = await say(db, room, 'bob', { parentId: root });
      const last = await say(db, room, 'bob', { parentId: root });
      expect((await page(db, room, 'alice', { unreadOnly: true })).data[0]?.unread).toEqual({
        count: 2,
        firstUnreadMessageId: first,
      });
      expect(
        await db
          .selectFrom('thread_reads')
          .select('root_id')
          .where('root_id', '=', root)
          .where('user_id', '=', who(room, 'alice'))
          .execute(),
      ).toEqual([]);
      await db
        .insertInto('thread_reads')
        .values({
          channel_id: room.channelId,
          user_id: who(room, 'alice'),
          root_id: root,
          last_read_message_id: first,
          read_at: NOW,
        })
        .execute();
      expect((await page(db, room, 'alice')).data[0]?.unread).toEqual({
        count: 1,
        firstUnreadMessageId: last,
      });
      await db
        .updateTable('thread_reads')
        .set({ last_read_message_id: last })
        .where('root_id', '=', root)
        .where('user_id', '=', who(room, 'alice'))
        .execute();
      expect((await page(db, room, 'alice', { unreadOnly: true })).data).toEqual([]);
      expect((await page(db, room, 'alice')).data[0]?.unread).toEqual({
        count: 0,
        firstUnreadMessageId: null,
      });
    });
  });

  test('keeps a public nonmember follow with unknown receipts, and removes a private conversation after membership loss', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['bob'] });
      const root = await say(db, room, 'alice');
      await choose(db, room, 'bob', root, true);
      expect((await page(db, room, 'bob')).data[0]?.unread).toBeNull();
      expect((await page(db, room, 'bob', { unreadOnly: true })).data).toEqual([]);
      const privateRoom = await aRoom(db, ['owner', 'reader'], { type: 'private' });
      const secret = await say(db, privateRoom, 'owner');
      await choose(db, privateRoom, 'reader', secret, true);
      expect((await page(db, privateRoom, 'reader')).data.map((row) => row.root.id)).toEqual([
        secret,
      ]);
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', privateRoom.channelId)
        .where('user_id', '=', who(privateRoom, 'reader'))
        .execute();
      expect((await page(db, privateRoom, 'reader')).data).toEqual([]);
    });
  });

  test('confines follows to this workspace and rechecks a stale context after membership loss', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice']);
      const there = await aRoom(db, ['owner']);
      const userId = who(here, 'alice');
      const local = await say(db, here, 'alice');
      const remote = await say(db, there, 'owner');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: there.workspaceId, user_id: userId, role: 'member' })
        .execute();
      await setFollowing(db, clock, await requireMessageById(db, userId, remote), true);
      expect((await page(db, here, 'alice', { limit: 1 })).data.map((row) => row.root.id)).toEqual([
        local,
      ]);
      const stale = await requireWorkspaceMembership(db, userId, here.workspaceId);
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', here.workspaceId)
        .where('user_id', '=', userId)
        .execute();
      expect((await followedThreads(db, stale)).data).toEqual([]);
    });
  });

  test('omits hidden roots before pagination and returns only a tombstone for a deleted root', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await say(db, room, 'alice');
      await say(db, room, 'bob', { parentId: root });
      await removeMessage(db, clock, who(room, 'alice'), root);
      const hidden = await say(db, room, 'alice');
      await db
        .insertInto('hidden_messages')
        .values({
          user_id: who(room, 'alice'),
          message_id: hidden,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          hidden_at: NOW,
        })
        .execute();
      const result = await page(db, room, 'alice', { limit: 1 });
      expect(result.data.map((row) => row.root.id)).toEqual([root]);
      expect(result.nextCursor).toBeNull();
      expect(result.data[0]?.root).toMatchObject({
        content: '',
        deletedAt: NOW.toISOString(),
        attachments: [],
        mentions: [],
        reactions: [],
      });
    });
  });

  test('removes deleted channels and workspaces even when a follow and an old context still exist', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      await say(db, room, 'alice');
      const context = await requireWorkspaceMembership(db, who(room, 'alice'), room.workspaceId);
      await db
        .updateTable('channels')
        .set({ deleted_at: NOW })
        .where('id', '=', room.channelId)
        .execute();
      expect((await followedThreads(db, context)).data).toEqual([]);
      await db
        .updateTable('channels')
        .set({ deleted_at: null })
        .where('id', '=', room.channelId)
        .execute();
      await db
        .updateTable('workspaces')
        .set({ deleted_at: NOW })
        .where('id', '=', room.workspaceId)
        .execute();
      expect((await followedThreads(db, context)).data).toEqual([]);
    });
  });

  test('honours explicit join scopes and late mentions while excluding hidden, own and deleted replies', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const userId = who(room, 'alice');
      const root = await say(db, room, 'alice');
      const old = await say(db, room, 'bob', { parentId: root, at: '2025-12-01T12:00:00.000Z' });
      // An absent legacy scope is unknown; a new join scope deliberately starts history read.
      expect((await page(db, room, 'alice')).data[0]?.unread?.count).toBe(1);
      await db
        .insertInto('channel_read_scopes')
        .values({ channel_id: room.channelId, user_id: userId, unread_since: NOW })
        .execute();
      expect((await page(db, room, 'alice', { unreadOnly: true })).data).toEqual([]);
      await db
        .insertInto('notifications')
        .values({
          user_id: userId,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          message_id: old,
          type: 'mention',
        })
        .execute();
      expect((await page(db, room, 'alice', { unreadOnly: true })).data[0]?.unread).toEqual({
        count: 1,
        firstUnreadMessageId: old,
      });
      await db
        .insertInto('hidden_messages')
        .values({
          user_id: userId,
          message_id: old,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
        })
        .execute();
      await say(db, room, 'alice', { parentId: root });
      const gone = await say(db, room, 'bob', { parentId: root });
      await removeMessage(db, clock, who(room, 'bob'), gone);
      expect((await page(db, room, 'alice', { unreadOnly: true })).data).toEqual([]);
      expect((await page(db, room, 'alice')).data[0]?.unread).toEqual({
        count: 0,
        firstUnreadMessageId: null,
      });
    });
  });

  test('uses a fixed number of reads for one root and the maximum page instead of a query per conversation', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      for (let index = 0; index < 100; index += 1) await say(db, room, 'alice');
      const context = await requireWorkspaceMembership(db, who(room, 'alice'), room.workspaceId);
      let reads = 0;
      const counted = db.withPlugin({
        transformQuery: (args) => {
          reads += 1;
          return args.node;
        },
        transformResult: (args) => Promise.resolve(args.result),
      });
      const one = await followedThreads(counted, context, { limit: 1 });
      const oneReads = reads;
      reads = 0;
      const maximum = await followedThreads(counted, context, { limit: 100 });
      expect(one.data).toHaveLength(1);
      expect(maximum.data).toHaveLength(100);
      expect(maximum.nextCursor).toBeNull();
      expect(oneReads).toBeGreaterThan(0);
      expect(reads).toBe(oneReads);
    });
  });

  test('excludes an unjoined public follow before paginating unread conversations', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const waiting = await say(db, room, 'bob');
      await say(db, room, 'alice', { parentId: waiting });
      const channel = await db
        .insertInto('channels')
        .values({ workspace_id: room.workspaceId, name: 'unjoined', type: 'public' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('channel_members')
        .values({ channel_id: channel.id, user_id: who(room, 'alice') })
        .execute();
      const other = { ...room, channelId: channel.id };
      const unknown = await say(db, other, 'alice');
      await choose(db, other, 'bob', unknown, true);
      await say(db, other, 'alice', { parentId: unknown });
      const result = await page(db, room, 'bob', { limit: 1, unreadOnly: true });
      expect(result.data.map((row) => row.root.id)).toEqual([waiting]);
      expect(result.nextCursor).toBeNull();
    });
  });

  test.each(['read', 'hide'] as const)(
    'a %s between selecting roots and hydrating them cannot return a stale unread row',
    async (change) => {
      await withRollback(async (db) => {
        const room = await aRoom(db, ['alice', 'bob']);
        const root = await say(db, room, 'alice');
        const reply = await say(db, room, 'bob', { parentId: root });
        const userId = who(room, 'alice');
        const context = await requireWorkspaceMembership(db, userId, room.workspaceId);
        let changed = false;
        const observed = db.withPlugin({
          transformQuery: (args) => args.node,
          transformResult: async (args) => {
            if (!changed && args.result.rows.some((row) => 'activity_at' in row)) {
              changed = true;
              if (change === 'read')
                await db
                  .insertInto('thread_reads')
                  .values({
                    channel_id: room.channelId,
                    root_id: root,
                    user_id: userId,
                    last_read_message_id: reply,
                    read_at: NOW,
                  })
                  .execute();
              else
                await db
                  .insertInto('hidden_messages')
                  .values({
                    user_id: userId,
                    message_id: root,
                    workspace_id: room.workspaceId,
                    channel_id: room.channelId,
                  })
                  .execute();
            }
            return args.result;
          },
        });
        const result = await followedThreads(observed, context, { unreadOnly: true });
        expect(changed).toBe(true);
        expect(result.data).toEqual([]);
        expect(result.nextCursor).toBeNull();
      });
    },
  );
});
