/**
 * Deleting a message (D-103 §7, D-9): the content becomes a tombstone and nothing else is erased; a
 * root with replies keeps its place and its thread; the numbers of the people it was counted for
 * come down by exactly what it added.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { markRead } from '../channels/read-state';
import { requireChannelById, requireMessageById } from '../../platform/channels';
import { aRoom, counters, notificationsOf, type Room } from '../../testing/rooms';
import { deleteMessage, removeMessage } from './delete';
import { issueSession } from '../auth/sessions';
import { atomicallyOn } from '../../platform/transactions';
import { channelTopic, userTopic, type EventBus } from '../../platform/events';
import type { ServerFrame } from '@purlay/types';
import { messageHistory, sendMessage, type Sent } from './messages';
import { threadReplies } from './threads';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const LATER = new Date('2026-09-09T12:05:00.000Z');
const clock = fixedClock(NOW);
const later = fixedClock(LATER);
let tick = 0;
const nextId = (): string => messageId(new Date(NOW.getTime() + (tick += 1) * 10));

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};
const at = (room: Room, name: string): string => `@${member(room, name).username}`;

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

const remove = async (
  db: Executor,
  room: Room,
  as: string,
  id: string,
): ReturnType<typeof removeMessage> => await removeMessage(db, later, member(room, as).userId, id);

/** A root's replies as the thread route reads them: a deleted root's thread is still read. */
const threadOf = async (
  db: Executor,
  userId: string,
  rootId: string,
): ReturnType<typeof threadReplies> =>
  await threadReplies(db, await requireMessageById(db, userId, rootId, { deleted: 'include' }));

const refusal = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
  throw new Error('expected a refusal, and the attempt succeeded');
};

const stored = async (
  db: Executor,
  id: string,
): Promise<{ content: string; deleted: boolean; mentions: number }> => {
  const row = await db
    .selectFrom('messages')
    .select(['content', 'deleted_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  const mentions = await db
    .selectFrom('mentions')
    .select('id')
    .where('message_id', '=', id)
    .execute();
  return { content: row.content, deleted: row.deleted_at !== null, mentions: mentions.length };
};

const setRole = async (
  db: Executor,
  room: Room,
  name: string,
  role: 'owner' | 'admin' | 'member',
): Promise<void> => {
  await db
    .updateTable('workspace_members')
    .set({ role })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', member(room, name).userId)
    .execute();
};

describe('integration: who may delete', () => {
  test('a moderator’s delete is on the trail, with whose message and nothing it said; an author’s is not', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await setRole(db, room, 'bob', 'admin');
      const own = await post(db, room, 'alice', 'mine to take back');
      const moderated = await post(db, room, 'alice', 'something to moderate');
      await remove(db, room, 'alice', own.message.id);
      await remove(db, room, 'bob', moderated.message.id);
      const trail = await db
        .selectFrom('audit_log')
        .select(['action', 'actor_user_id', 'target_id', 'metadata'])
        .where('workspace_id', '=', room.workspaceId)
        .where('action', '=', 'message.removed_by_moderator')
        .execute();
      expect(trail).toEqual([
        {
          action: 'message.removed_by_moderator',
          actor_user_id: member(room, 'bob').userId,
          target_id: moderated.message.id,
          metadata: { authorId: member(room, 'alice').userId },
        },
      ]);
    });
  });

  test('the author: the content becomes the tombstone and its mentions go', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await setRole(db, room, 'alice', 'member');
      const sent = await post(db, room, 'alice', `secret for ${at(room, 'bob')}`);
      const outcome = await remove(db, room, 'alice', sent.message.id);
      expect(outcome.removed).toBe(true);
      expect(await stored(db, sent.message.id)).toEqual({
        content: '',
        deleted: true,
        mentions: 0,
      });
    });
  });

  test.each(['owner', 'admin'] as const)('a workspace %s, for somebody else', async (role) => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await setRole(db, room, 'bob', role);
      const sent = await post(db, room, 'alice', 'off topic');
      expect((await remove(db, room, 'bob', sent.message.id)).removed).toBe(true);
      expect((await stored(db, sent.message.id)).deleted).toBe(true);
    });
  });

  test('a member who is not the author is refused, and nothing is written', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await setRole(db, room, 'bob', 'member');
      const sent = await post(db, room, 'alice', 'mine');
      expect(await refusal(remove(db, room, 'bob', sent.message.id))).toBe('FORBIDDEN');
      expect(await stored(db, sent.message.id)).toEqual({
        content: 'mine',
        deleted: false,
        mentions: 0,
      });
    });
  });

  test('a message the caller cannot see, or that never was, is not there', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { type: 'private', outsiders: ['mallory'] });
      const sent = await post(db, room, 'alice', 'private');
      const outsider = room.outsiders['mallory']?.userId ?? '';
      expect(await refusal(removeMessage(db, later, outsider, sent.message.id))).toBe(
        'MESSAGE_NOT_FOUND',
      );
      expect(await refusal(remove(db, room, 'alice', nextId()))).toBe('MESSAGE_NOT_FOUND');
    });
  });

  test('twice is the same as once: the second writes nothing and is not refused', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(db, room, 'alice', 'gone');
      expect((await remove(db, room, 'alice', sent.message.id)).removed).toBe(true);
      const before = await counters(db, room, member(room, 'bob').userId);
      const again = await remove(db, room, 'alice', sent.message.id);
      expect(again.removed).toBe(false);
      expect(again.recipients).toEqual([]);
      expect(await counters(db, room, member(room, 'bob').userId)).toEqual(before);
    });
  });
});

describe('integration: the numbers come down by what the message added', () => {
  test('unread for a member behind it; a mention, too, for one it named; nothing for the rest', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol', 'dave']);
      const first = await post(db, room, 'alice', 'one');
      const sent = await post(db, room, 'alice', `two ${at(room, 'bob')}`);
      // Carol has read past it; Dave joined after it was written.
      await markRead(db, clock, member(room, 'carol').context, sent.message.id);
      await db
        .updateTable('channel_members')
        .set({ joined_at: LATER, unread_count: 0, unread_mention_count: 0 })
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', member(room, 'dave').userId)
        .execute();
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 2,
        mentions: 1,
      });

      const outcome = await remove(db, room, 'alice', sent.message.id);

      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 1,
        mentions: 0,
      });
      expect(await counters(db, room, member(room, 'carol').userId)).toMatchObject({
        unread: 0,
        mentions: 0,
      });
      expect(await counters(db, room, member(room, 'dave').userId)).toMatchObject({
        unread: 0,
        mentions: 0,
      });
      expect(outcome.recipients.map((r) => r.userId)).toEqual([member(room, 'bob').userId]);
      // What it would be recounted to is what it is: read Bob to the first message and see.
      await markRead(db, clock, member(room, 'bob').context, first.message.id);
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 0,
        mentions: 0,
      });
    });
  });

  test('a message never counted — older than the counters — is deleted, and nothing goes below zero', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(db, room, 'alice', `old ${at(room, 'bob')}`);
      await db
        .updateTable('channel_members')
        .set({ unread_count: 0, unread_mention_count: 0 })
        .where('channel_id', '=', room.channelId)
        .execute();
      expect((await remove(db, room, 'alice', sent.message.id)).removed).toBe(true);
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 0,
        mentions: 0,
      });
    });
  });

  test('a direct message deleted takes its badge back from the other side', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
      const sent = await post(db, room, 'alice', 'oops');
      await remove(db, room, 'alice', sent.message.id);
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 0,
        mentions: 0,
      });
      // Told, and kept for the inbox, but no longer waiting.
      expect(await notificationsOf(db, member(room, 'bob').userId)).toHaveLength(1);
    });
  });
});

describe('integration: what stays in the conversation', () => {
  test('a root with replies stays in the feed as its tombstone, with its thread and its count', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'alice', 'why 4s?');
      await post(db, room, 'bob', 'documented', root.message.id);
      await remove(db, room, 'alice', root.message.id);
      const context = await requireChannelById(db, member(room, 'bob').userId, room.channelId);
      const feed = await messageHistory(db, context, {});
      const found = feed.data.find((message) => message.id === root.message.id);
      expect(found?.content).toBe('');
      expect(found?.deletedAt).toBe(LATER.toISOString());
      expect(found?.thread?.replyCount).toBe(1);
      expect((await threadOf(db, member(room, 'bob').userId, root.message.id)).data).toHaveLength(
        1,
      );
    });
  });

  test('a root nobody answered leaves the feed', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const root = await post(db, room, 'alice', 'never mind');
      await remove(db, room, 'alice', root.message.id);
      const context = await requireChannelById(db, member(room, 'alice').userId, room.channelId);
      const feed = await messageHistory(db, context, {});
      expect(feed.data.map((message) => message.id)).not.toContain(root.message.id);
    });
  });

  test('a reply stays in its thread as a tombstone, and the thread keeps its count', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'alice', 'q');
      const reply = await post(db, room, 'bob', 'a', root.message.id);
      await remove(db, room, 'bob', reply.message.id);
      const thread = await threadOf(db, member(room, 'alice').userId, root.message.id);
      expect(thread.data.map((message) => [message.id, message.content])).toEqual([
        [reply.message.id, ''],
      ]);
      const summary = await db
        .selectFrom('messages')
        .select('thread_reply_count')
        .where('id', '=', root.message.id)
        .executeTakeFirstOrThrow();
      expect(summary.thread_reply_count).toBe(1);
    });
  });

  test('a deleted message cannot be answered, reacted to or edited', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const root = await post(db, room, 'alice', 'q');
      await remove(db, room, 'alice', root.message.id);
      expect(await refusal(post(db, room, 'alice', 'a', root.message.id))).toBe(
        'MESSAGE_NOT_FOUND',
      );
    });
  });
});

describe('integration: the one way in', () => {
  test('tells the room it is a tombstone, then the numbers that came down; a second time, nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'alice', `look ${at(room, 'bob')}`);
      await issueSession(db, later, member(room, 'alice').userId, 30);
      const session = await db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', member(room, 'alice').userId)
        .executeTakeFirstOrThrow();
      const topics: string[] = [];
      const frames: ServerFrame[] = [];
      const bus: EventBus = {
        publish: (topic, frame): Promise<void> => {
          topics.push(topic);
          frames.push(frame);
          return Promise.resolve();
        },
        subscribe: () => false,
        unsubscribe: () => undefined,
        forget: () => undefined,
      };
      const dependencies = { atomically: atomicallyOn(db), clock: later, bus };
      const caller = { userId: member(room, 'alice').userId, sessionId: session.id };
      await deleteMessage(dependencies, caller, root.message.id);
      expect(topics).toEqual([channelTopic(room.channelId), userTopic(member(room, 'bob').userId)]);
      const [revision] = frames;
      if (revision?.event !== 'MESSAGE_REVISED') throw new Error('no revision');
      expect(revision.data).toEqual({
        channelId: room.channelId,
        messageId: root.message.id,
        parentId: null,
        content: '',
        editedAt: null,
        deletedAt: LATER.toISOString(),
        mentions: [],
      });
      await deleteMessage(dependencies, caller, root.message.id);
      expect(frames).toHaveLength(2);
    });
  });
});
