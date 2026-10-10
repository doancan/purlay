/**
 * Moving a read position: forward only, recounted from rows, refused for a message
 * that is not in the channel (D-99 §4, I-3, I-6).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { requireChannelById, type ChannelContext } from '../../platform/channels';
import { aChannelWith, aConversation, aMessageIn } from '../../testing/conversations';
import type { TestUser } from '../../testing/users';
import { markRead } from './read-state';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

interface Setup {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly reader: TestUser;
  readonly writer: TestUser;
  readonly context: ChannelContext;
  readonly say: (
    sender: TestUser,
    options?: { parentId?: string; deleted?: boolean },
  ) => Promise<string>;
}

const aReaderAndAWriter = async (db: Executor): Promise<Setup> => {
  const { workspaceId, users } = await aConversation(db, 'rs-reader', 'rs-writer');
  const [reader, writer] = users as [TestUser, TestUser];
  const channelId = await aChannelWith(db, workspaceId, 'talk', reader, writer);
  const context = await requireChannelById(db, reader.userId, channelId);
  return {
    workspaceId,
    channelId,
    reader,
    writer,
    context,
    say: async (sender, options) =>
      await aMessageIn(db, { workspaceId, channelId }, sender, options),
  };
};

const stateOf = async (db: Executor, setup: Setup): Promise<unknown> => {
  const row = await db
    .selectFrom('channel_members')
    .select(['last_read_message_id', 'unread_count', 'unread_mention_count'])
    .where('channel_id', '=', setup.channelId)
    .where('user_id', '=', setup.reader.userId)
    .executeTakeFirstOrThrow();
  return row;
};

const aNotification = async (
  db: Executor,
  setup: Setup,
  messageId: string,
  type: 'mention' | 'direct_message' | 'thread_reply' | 'thread_resolved',
): Promise<void> => {
  await db
    .insertInto('notifications')
    .values({
      user_id: setup.reader.userId,
      workspace_id: setup.workspaceId,
      channel_id: setup.channelId,
      message_id: messageId,
      type,
    })
    .execute();
};

describe('integration: moving a read position', () => {
  test('recounts what is past it from the messages, and ignores your own and deleted ones', async () => {
    await withRollback(async (db) => {
      const setup = await aReaderAndAWriter(db);
      const first = await setup.say(setup.writer);
      await setup.say(setup.writer);
      await setup.say(setup.reader);
      await setup.say(setup.writer, { deleted: true });
      await setup.say(setup.writer);
      // The counters as a send would have left them: three by others past nothing read.
      await db
        .updateTable('channel_members')
        .set({ unread_count: 3 })
        .where('user_id', '=', setup.reader.userId)
        .execute();

      const outcome = await markRead(db, clock, setup.context, first);
      expect(outcome.moved).toBe(true);
      // Past `first`: one more from the writer, the reader's own, a deleted one, one more from
      // the writer. Their own and the deleted one are not waiting for them.
      expect(outcome.state).toEqual({
        lastReadMessageId: first,
        unreadCount: 2,
        unreadMentionCount: 0,
      });
    });
  });

  test('replies count as unread, as roots do', async () => {
    await withRollback(async (db) => {
      const setup = await aReaderAndAWriter(db);
      const root = await setup.say(setup.reader);
      await setup.say(setup.writer, { parentId: root });

      const outcome = await markRead(db, clock, setup.context, root);
      expect(outcome.state.unreadCount).toBe(1);
    });
  });

  test('what needs you is the lesser of the unread messages and the unread notifications of its kinds', async () => {
    await withRollback(async (db) => {
      const setup = await aReaderAndAWriter(db);
      const first = await setup.say(setup.writer);
      const mention = await setup.say(setup.writer);
      const reply = await setup.say(setup.writer);
      await setup.say(setup.writer);
      await aNotification(db, setup, mention, 'mention');
      await aNotification(db, setup, reply, 'thread_reply');
      // Told, and not counted: a resolution is not a message.
      await aNotification(db, setup, reply, 'thread_resolved');

      const outcome = await markRead(db, clock, setup.context, first);
      expect(outcome.state).toEqual({
        lastReadMessageId: first,
        unreadCount: 3,
        unreadMentionCount: 2,
      });
    });
  });

  /** I-6: a mention can not outnumber the messages, whatever the notification rows say. */
  test('never reports more that need you than are unread', async () => {
    await withRollback(async (db) => {
      const setup = await aReaderAndAWriter(db);
      const first = await setup.say(setup.writer);
      const second = await setup.say(setup.writer);
      await aNotification(db, setup, second, 'mention');
      await aNotification(db, setup, second, 'direct_message');
      await aNotification(db, setup, second, 'thread_reply');

      const outcome = await markRead(db, clock, setup.context, first);
      expect(outcome.state.unreadCount).toBe(1);
      expect(outcome.state.unreadMentionCount).toBe(1);
    });
  });

  test('marks the notifications at or behind the position read, and only those', async () => {
    await withRollback(async (db) => {
      const setup = await aReaderAndAWriter(db);
      const behind = await setup.say(setup.writer);
      const at = await setup.say(setup.writer);
      const past = await setup.say(setup.writer);
      for (const id of [behind, at, past]) await aNotification(db, setup, id, 'mention');

      await markRead(db, clock, setup.context, at);
      const unread = await db
        .selectFrom('notifications')
        .select('message_id')
        .where('read_at', 'is', null)
        .execute();
      expect(unread.map((row) => row.message_id)).toEqual([past]);
    });
  });

  test('a position at or behind the current one changes nothing, and says so', async () => {
    await withRollback(async (db) => {
      const setup = await aReaderAndAWriter(db);
      const first = await setup.say(setup.writer);
      const second = await setup.say(setup.writer);
      await setup.say(setup.writer);
      await markRead(db, clock, setup.context, second);
      const afterSecond = await stateOf(db, setup);

      for (const behind of [second, first]) {
        const outcome = await markRead(db, clock, setup.context, behind);
        expect(outcome.moved).toBe(false);
        expect(outcome.state.lastReadMessageId).toBe(second);
        expect(outcome.state.unreadCount).toBe(1);
        expect(await stateOf(db, setup)).toEqual(afterSecond);
      }
    });
  });

  test('a message of another channel is MESSAGE_NOT_FOUND, not a database error', async () => {
    await withRollback(async (db) => {
      const setup = await aReaderAndAWriter(db);
      const elsewhere = await aChannelWith(db, setup.workspaceId, 'elsewhere', setup.writer);
      const theirs = await aMessageIn(
        db,
        { workspaceId: setup.workspaceId, channelId: elsewhere },
        setup.writer,
      );

      for (const id of [theirs, crypto.randomUUID()]) {
        const error = await markRead(db, clock, setup.context, id).catch((t: unknown) => t);
        expect(error).toMatchObject({ status: 404, body: { code: 'MESSAGE_NOT_FOUND' } });
      }
      expect((await stateOf(db, setup)) as { last_read_message_id: unknown }).toMatchObject({
        last_read_message_id: null,
      });
    });
  });

  test('a channel you can see and have not joined has no position to move', async () => {
    await withRollback(async (db) => {
      const setup = await aReaderAndAWriter(db);
      const stranger = await aConversation(db, 'rs-nobody');
      // Same workspace, public channel, not a member of it.
      const [outsider] = stranger.users;
      if (outsider === undefined) throw new Error('no outsider was made');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: setup.workspaceId, user_id: outsider.userId })
        .execute();
      const context = await requireChannelById(db, outsider.userId, setup.channelId);
      const message = await setup.say(setup.writer);

      const error = await markRead(db, clock, context, message).catch((t: unknown) => t);
      expect(error).toMatchObject({ status: 404, body: { code: 'CHANNEL_NOT_FOUND' } });
    });
  });
});
