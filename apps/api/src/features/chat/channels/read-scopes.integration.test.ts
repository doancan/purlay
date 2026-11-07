/** Catch-up receipts must not read unseen history or unrelated conversations (#1193). */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aChannelWith, aConversation } from '../../../testing/conversations';
import type { TestUser } from '../../../testing/users';
import { readThreadNotifications } from '../notifications/notifications';
import { removeMessage } from '../messages/delete';
import { hideMessage } from '../messages/hide';
import { reviseMessage } from '../messages/edit';
import { joinChannel } from './channels';
import { leaveChannel } from './settings';
import { catchUpIn } from './catch-up';
import { requireChannelById, type ChannelContext } from './guard';
import { markAllRead, markRead, markUnread } from './read-state';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const joinedAt = new Date('2026-11-07T12:00:00.000Z');
const clock = fixedClock(joinedAt);
const instant = (seconds: number): Date => new Date(joinedAt.getTime() + seconds * 1000);

interface Room {
  readonly reader: TestUser;
  readonly writer: TestUser;
  readonly context: ChannelContext;
}

const room = async (db: Executor): Promise<Room> => {
  const { workspaceId, users } = await aConversation(db, 'scope-reader', 'scope-writer');
  const [reader, writer] = users as [TestUser, TestUser];
  const channelId = await aChannelWith(db, workspaceId, 'catch-up', writer);
  return { reader, writer, context: await requireChannelById(db, reader.userId, channelId) };
};

/** UUID order and the server's write time are independent: a client's clock can lag (D-33). */
const say = async (
  db: Executor,
  setup: Room,
  written: number,
  options: { readonly idAt?: number; readonly parentId?: string } = {},
): Promise<string> => {
  const id = messageId(instant(options.idAt ?? written));
  await db
    .insertInto('messages')
    .values({
      id,
      workspace_id: setup.context.workspaceId,
      channel_id: setup.context.channelId,
      sender_id: setup.writer.userId,
      content: 'A delivery handover',
      parent_id: options.parentId ?? null,
      created_at: instant(written),
    })
    .execute();
  if (options.parentId !== undefined) {
    await db
      .updateTable('messages')
      .set({
        thread_reply_count: sql<number>`thread_reply_count + 1`,
        thread_last_reply_at: instant(written),
      })
      .where('id', '=', options.parentId)
      .execute();
  }
  return id;
};

/** As in the read-position suite, seed the counter that message delivery maintains. */
const waiting = async (db: Executor, setup: Room, count: number): Promise<void> => {
  await db
    .updateTable('channel_members')
    .set({ unread_count: count })
    .where('channel_id', '=', setup.context.channelId)
    .where('user_id', '=', setup.reader.userId)
    .execute();
};

const unread = async (db: Executor, setup: Room): Promise<number> =>
  (
    await db
      .selectFrom('channel_members')
      .select('unread_count')
      .where('channel_id', '=', setup.context.channelId)
      .where('user_id', '=', setup.reader.userId)
      .executeTakeFirstOrThrow()
  ).unread_count;

describe('integration: catch-up read scopes', () => {
  test('a post-join message with an earlier client id cannot resurrect pre-join history', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      const old = await say(db, setup, -5);
      await joinChannel(db, clock, setup.context);
      const arrived = await say(db, setup, 1, { idAt: -10 });
      expect(arrived < old).toBe(true);
      await waiting(db, setup, 1);
      const result = await markRead(db, clock, setup.context, arrived);
      expect(result.state.unreadCount).toBe(0);
    });
  });

  test('an explicit historical rewind keeps the whole requested range unread', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      const first = await say(db, setup, -20);
      await say(db, setup, -10);
      await joinChannel(db, clock, setup.context);
      const latest = await say(db, setup, 1);
      await waiting(db, setup, 1);
      await markRead(db, clock, setup.context, latest);
      const result = await markUnread(db, setup.context, first);
      expect(result.state.unreadCount).toBe(3);
    });
  });

  test('reading unfollowed threads out of order preserves another reply and an unseen root', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      await joinChannel(db, clock, setup.context);
      const first = await say(db, setup, 1);
      const second = await say(db, setup, 2);
      await markRead(db, clock, setup.context, second);
      const root = await say(db, setup, 3);
      const secondReply = await say(db, setup, 4, { parentId: second });
      const firstReply = await say(db, setup, 5, { parentId: first });
      await waiting(db, setup, 3);

      await readThreadNotifications(db, clock, setup.reader.userId, first, {
        lastReadMessageId: firstReply,
      });
      expect(await unread(db, setup)).toBe(2);
      await readThreadNotifications(db, clock, setup.reader.userId, second, {
        lastReadMessageId: secondReply,
      });
      expect(await unread(db, setup)).toBe(1);
      expect((await markRead(db, clock, setup.context, root)).state.unreadCount).toBe(0);
    });
  });

  test('a read bound must belong to the requested thread', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      await joinChannel(db, clock, setup.context);
      const first = await say(db, setup, 1);
      const second = await say(db, setup, 2);
      const otherReply = await say(db, setup, 3, { parentId: second });
      const answer: unknown = await readThreadNotifications(db, clock, setup.reader.userId, first, {
        lastReadMessageId: otherReply,
      }).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(answer).toMatchObject({ body: { code: 'MESSAGE_NOT_FOUND' } });
    });
  });

  for (const action of ['hide', 'delete'] as const) {
    test(`${action} of an already-read reply preserves an unrelated unread root`, async () => {
      await withRollback(async (db) => {
        const setup = await room(db);
        await joinChannel(db, clock, setup.context);
        const root = await say(db, setup, 1);
        await markRead(db, clock, setup.context, root);
        const answer = await say(db, setup, 2, { parentId: root });
        await waiting(db, setup, 1);
        await readThreadNotifications(db, clock, setup.reader.userId, root, {
          lastReadMessageId: answer,
        });
        await say(db, setup, 3);
        await waiting(db, setup, 1);
        if (action === 'hide') await hideMessage(db, clock, setup.reader.userId, answer);
        else await removeMessage(db, clock, setup.writer.userId, answer);
        expect(await unread(db, setup)).toBe(1);
      });
    });
  }

  test('a new mention in a read reply asks for it again, and the thread can clear it again', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      await joinChannel(db, clock, setup.context);
      const root = await say(db, setup, 1);
      await markRead(db, clock, setup.context, root);
      const answer = await say(db, setup, 2, { parentId: root });
      await waiting(db, setup, 1);
      await readThreadNotifications(db, clock, setup.reader.userId, root, {
        lastReadMessageId: answer,
      });
      await reviseMessage(
        db,
        fixedClock(instant(3)),
        setup.writer.userId,
        answer,
        `@${setup.reader.username} please check`,
      );
      expect(await unread(db, setup)).toBe(1);
      await readThreadNotifications(db, clock, setup.reader.userId, root, {
        lastReadMessageId: answer,
      });
      expect(await unread(db, setup)).toBe(0);
    });
  });

  test('reading a thread twice is idempotent and a stale device cannot move its cursor backwards', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      await joinChannel(db, clock, setup.context);
      const root = await say(db, setup, 1);
      await markRead(db, clock, setup.context, root);
      const older = await say(db, setup, 2, { parentId: root });
      const newest = await say(db, setup, 3, { parentId: root });
      await waiting(db, setup, 2);
      const first = await readThreadNotifications(db, clock, setup.reader.userId, root, {
        lastReadMessageId: newest,
      });
      expect(first).toHaveLength(1);
      expect(
        await readThreadNotifications(db, clock, setup.reader.userId, root, {
          lastReadMessageId: newest,
        }),
      ).toEqual([]);
      expect(
        await readThreadNotifications(db, clock, setup.reader.userId, root, {
          lastReadMessageId: older,
        }),
      ).toEqual([]);
      expect(await unread(db, setup)).toBe(0);
      const saved = await db
        .selectFrom('thread_reads')
        .select('last_read_message_id')
        .where('channel_id', '=', setup.context.channelId)
        .where('user_id', '=', setup.reader.userId)
        .where('root_id', '=', root)
        .executeTakeFirstOrThrow();
      expect(saved.last_read_message_id).toBe(newest);
    });
  });

  test('a new mention of someone already notified does not duplicate the badge on deletion', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      await joinChannel(db, clock, setup.context);
      const root = await say(db, setup, 1);
      await markRead(db, clock, setup.context, root);
      const answer = await say(db, setup, 2, { parentId: root });
      await waiting(db, setup, 1);
      await db
        .insertInto('notifications')
        .values({
          user_id: setup.reader.userId,
          workspace_id: setup.context.workspaceId,
          channel_id: setup.context.channelId,
          message_id: answer,
          type: 'thread_reply',
        })
        .execute();
      await db
        .updateTable('channel_members')
        .set({ unread_mention_count: 1 })
        .where('channel_id', '=', setup.context.channelId)
        .where('user_id', '=', setup.reader.userId)
        .execute();
      await reviseMessage(
        db,
        fixedClock(instant(3)),
        setup.writer.userId,
        answer,
        `@${setup.reader.username} please check`,
      );
      expect(
        await db
          .selectFrom('notifications')
          .select('id')
          .where('message_id', '=', answer)
          .where('user_id', '=', setup.reader.userId)
          .execute(),
      ).toHaveLength(1);
      expect(await unread(db, setup)).toBe(1);
      await say(db, setup, 4);
      await waiting(db, setup, 2);
      await removeMessage(db, clock, setup.writer.userId, answer);
      expect(await unread(db, setup)).toBe(1);
    });
  });

  test('rewinding into history never reads an unseen post-join message with an earlier client id', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      await say(db, setup, -20);
      const historical = await say(db, setup, -5);
      await joinChannel(db, clock, setup.context);
      const arrived = await say(db, setup, 1, { idAt: -15 });
      await waiting(db, setup, 1);
      expect((await markUnread(db, setup.context, historical)).state.unreadCount).toBe(2);
      expect((await markRead(db, clock, setup.context, arrived)).state.unreadCount).toBe(1);
      expect((await markRead(db, clock, setup.context, historical)).state.unreadCount).toBe(0);
    });
  });

  test('rewinding a read thread preserves unseen roots before that thread', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      await joinChannel(db, clock, setup.context);
      const first = await say(db, setup, 1);
      await markRead(db, clock, setup.context, first);
      await say(db, setup, 2);
      const root = await say(db, setup, 3);
      const reply = await say(db, setup, 4, { parentId: root });
      await waiting(db, setup, 3);
      await readThreadNotifications(db, clock, setup.reader.userId, root, {
        lastReadMessageId: reply,
      });
      expect(await unread(db, setup)).toBe(2);
      expect((await markUnread(db, setup.context, reply)).state.unreadCount).toBe(3);
    });
  });

  test('reading displayed roots never reads an undisplayed unfollowed reply between them', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      await joinChannel(db, clock, setup.context);
      const root = await say(db, setup, 1);
      await markRead(db, clock, setup.context, root);
      const reply = await say(db, setup, 2, { parentId: root });
      const later = await say(db, setup, 3);
      await waiting(db, setup, 2);
      expect((await markRead(db, clock, setup.context, later)).state.unreadCount).toBe(1);
      await readThreadNotifications(db, clock, setup.reader.userId, root, {
        lastReadMessageId: reply,
      });
      expect(await unread(db, setup)).toBe(0);
    });
  });

  test('explicitly marking every channel read can clear those unfollowed replies without moving the feed', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      await joinChannel(db, clock, setup.context);
      const root = await say(db, setup, 1);
      await markRead(db, clock, setup.context, root);
      await say(db, setup, 2, { parentId: root });
      const later = await say(db, setup, 3);
      await waiting(db, setup, 2);
      await markRead(db, clock, setup.context, later);
      const context = await requireWorkspaceMembership(
        db,
        setup.reader.userId,
        setup.context.workspaceId,
      );
      await markAllRead(db, clock, context);
      expect(await unread(db, setup)).toBe(0);
      expect(await markAllRead(db, clock, context)).toEqual([]);
    });
  });
  test('leaving drops private receipts and a rejoin starts at its own join floor', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      await joinChannel(db, clock, setup.context);
      const root = await say(db, setup, 1);
      const reply = await say(db, setup, 2, { parentId: root });
      await waiting(db, setup, 2);
      await readThreadNotifications(db, clock, setup.reader.userId, root, {
        lastReadMessageId: reply,
      });
      await leaveChannel(db, setup.context);
      expect(
        await db
          .selectFrom('thread_reads')
          .selectAll()
          .where('user_id', '=', setup.reader.userId)
          .execute(),
      ).toEqual([]);
      await joinChannel(db, fixedClock(instant(10)), setup.context);
      const joined = await db
        .selectFrom('channel_read_scopes')
        .select(['unread_since', 'thread_read_baseline_id'])
        .where('channel_id', '=', setup.context.channelId)
        .where('user_id', '=', setup.reader.userId)
        .executeTakeFirstOrThrow();
      expect(joined).toEqual({
        unread_since: instant(10),
        thread_read_baseline_id: null,
      });
      expect((await catchUpIn(db, setup.context)).threads).toEqual([]);
    });
  });

  test('purging only the cursor reply retains a useful receipt; purging its root removes it', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      await joinChannel(db, clock, setup.context);
      const root = await say(db, setup, 1);
      const reply = await say(db, setup, 2, { parentId: root });
      await waiting(db, setup, 2);
      await readThreadNotifications(db, clock, setup.reader.userId, root, {
        lastReadMessageId: reply,
      });
      await db.deleteFrom('messages').where('id', '=', reply).execute();
      expect(
        await db
          .selectFrom('thread_reads')
          .select('last_read_message_id')
          .where('root_id', '=', root)
          .execute(),
      ).toEqual([{ last_read_message_id: reply }]);
      const next = await say(db, setup, 3, { parentId: root });
      expect(
        (await catchUpIn(db, setup.context)).threads.map((thread) => thread.firstUnreadMessageId),
      ).toEqual([next]);
      await db.deleteFrom('messages').where('id', '=', next).execute();
      await db.deleteFrom('messages').where('id', '=', root).execute();
      expect(
        await db.selectFrom('thread_reads').selectAll().where('root_id', '=', root).execute(),
      ).toEqual([]);
    });
  });
});
