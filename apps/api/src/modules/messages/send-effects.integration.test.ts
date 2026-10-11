/**
 * What a send does to the people it is for (D-99 §1–§3), against a real database.
 *
 * Inside rolled-back transactions (D-46). Each test builds a room — real users, real
 * memberships — sends into it and reads the rows back: the counters, the mentions,
 * the notifications. What is asserted is the *rule*, so each one names the person it
 * is about and what they should have been told.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { AppError } from '../../platform/errors';
import { fixedClock } from '../../platform/clock';
import { aRoom, counters, notificationsOf, type Room } from '../../testing/rooms';
import { messageHistory, sendMessage, type OutgoingMessage, type Sent } from './messages';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const post = async (
  db: Executor,
  room: Room,
  as: string,
  content: string,
  extra: Partial<OutgoingMessage> = {},
): Promise<Sent> => {
  const member = room.members[as];
  if (member === undefined) throw new Error(`no member ${as}`);
  return await sendMessage(db, clock, member.context, { id: messageId(NOW), content, ...extra });
};

const refusalOf = async (attempt: Promise<unknown>): Promise<AppError> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('the send was accepted where it had to be refused');
};

const idOf = (room: Room, name: string): string => room.members[name]?.userId ?? '';

/** The same list in the order `notificationsOf` returns: by message id, then type. */
const inOrder = <T extends { messageId: string; type: string }>(list: readonly T[]): T[] =>
  [...list].sort((a, b) => a.messageId.localeCompare(b.messageId) || a.type.localeCompare(b.type));

describe('integration: a plain message', () => {
  test('is unread for everyone else, needs nobody, and tells each of them their own numbers', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const sent = await post(db, room, 'alice', 'standup in five');

      expect(await counters(db, room, idOf(room, 'alice'))).toMatchObject({
        unread: 0,
        mentions: 0,
      });
      for (const name of ['bob', 'carol']) {
        expect(await counters(db, room, idOf(room, name))).toMatchObject({
          unread: 1,
          mentions: 0,
        });
        expect(await notificationsOf(db, idOf(room, name))).toEqual([]);
      }

      expect(sent.thread).toBeNull();
      expect(sent.message.mentions).toEqual([]);
      expect(sent.recipients.map((r) => r.userId).sort()).toEqual(
        [idOf(room, 'bob'), idOf(room, 'carol')].sort(),
      );
      for (const recipient of sent.recipients) {
        expect(recipient.state).toEqual({
          lastReadMessageId: null,
          unreadCount: 1,
          unreadMentionCount: 0,
        });
      }
    });
  });

  test('counts accumulate, per recipient, and never for the sender', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], {});
      for (let n = 0; n < 4; n += 1) await post(db, room, 'alice', `one ${String(n)}`);
      await post(db, room, 'bob', 'back');
      expect(await counters(db, room, idOf(room, 'bob'))).toMatchObject({ unread: 4 });
      expect(await counters(db, room, idOf(room, 'alice'))).toMatchObject({ unread: 1 });
    });
  });
});

describe('integration: mentions', () => {
  test('a mention is stored once, notifies the person, and counts as needing them', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const bob = room.members['bob']?.username ?? '';
      const carol = (room.members['carol']?.username ?? '').toUpperCase();
      const sent = await post(db, room, 'alice', `hey @${bob} and @${carol}, look`);

      expect([...sent.message.mentions].sort()).toEqual(
        [idOf(room, 'bob'), idOf(room, 'carol')].sort(),
      );
      for (const name of ['bob', 'carol']) {
        expect(await counters(db, room, idOf(room, name))).toMatchObject({
          unread: 1,
          mentions: 1,
        });
        expect(await notificationsOf(db, idOf(room, name))).toEqual([
          { messageId: sent.message.id, type: 'mention' },
        ]);
      }
      const rows = await db
        .selectFrom('mentions')
        .select('mentioned_user_id')
        .where('message_id', '=', sent.message.id)
        .execute();
      expect(rows).toHaveLength(2);
    });
  });

  test('the same name twice is one mention and one notification', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = room.members['bob']?.username ?? '';
      const sent = await post(db, room, 'alice', `@${bob} @${bob} @${bob}`);
      expect(sent.message.mentions).toEqual([idOf(room, 'bob')]);
      expect(await notificationsOf(db, idOf(room, 'bob'))).toHaveLength(1);
      expect(await counters(db, room, idOf(room, 'bob'))).toMatchObject({ unread: 1, mentions: 1 });
    });
  });

  test('quoting a name in code, naming yourself, or naming nobody real tells no one', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice']?.username ?? '';
      const bob = room.members['bob']?.username ?? '';
      const sent = await post(
        db,
        room,
        'alice',
        `\`@${bob}\` @${alice} @nobody-here-${'x'.repeat(5)}`,
      );
      expect(sent.message.mentions).toEqual([]);
      expect(await notificationsOf(db, idOf(room, 'bob'))).toEqual([]);
      expect(await counters(db, room, idOf(room, 'bob'))).toMatchObject({ unread: 1, mentions: 0 });
    });
  });

  test('a person in the workspace but not the channel is told about a mention in a public channel', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { outsiders: ['dave'] });
      const dave = room.outsiders['dave'];
      const sent = await post(
        db,
        room,
        'alice',
        `@${dave?.username ?? ''} you might want to see this`,
      );
      expect(sent.message.mentions).toEqual([dave?.userId ?? '']);
      // Told, with nothing to count: they have no membership row to carry a counter.
      expect(await notificationsOf(db, dave?.userId ?? '')).toEqual([
        { messageId: sent.message.id, type: 'mention' },
      ]);
    });
  });

  test('in a private channel, naming somebody who cannot see it names nobody', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'private', outsiders: ['dave'] });
      const dave = room.outsiders['dave'];
      const sent = await post(
        db,
        room,
        'alice',
        `@${dave?.username ?? ''} @${room.members['bob']?.username ?? ''}`,
      );
      // Mentioning dave would tell him the conversation exists.
      expect(sent.message.mentions).toEqual([idOf(room, 'bob')]);
      expect(await notificationsOf(db, dave?.userId ?? '')).toEqual([]);
    });
  });

  test('a person who left the workspace’s books is not addressable', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await db
        .updateTable('users')
        .set({ deleted_at: NOW })
        .where('id', '=', idOf(room, 'bob'))
        .execute();
      const sent = await post(db, room, 'alice', `@${room.members['bob']?.username ?? ''}`);
      expect(sent.message.mentions).toEqual([]);
    });
  });

  test('@here, @channel and @everyone are refused, and nothing is written', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      for (const word of ['@here', '@Channel', 'wake up @everyone']) {
        const refusal = await refusalOf(post(db, room, 'alice', word));
        expect(refusal.body).toMatchObject({
          code: 'VALIDATION_FAILED',
          details: { fields: { content: expect.any(String) as string } },
        });
      }
      const page = await messageHistory(db, room.members['alice']?.context as never);
      expect(page.data).toEqual([]);
      expect(await counters(db, room, idOf(room, 'bob'))).toMatchObject({ unread: 0 });
    });
  });

  test('quoting @here in code is not a broadcast', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await post(db, room, 'alice', 'the parser refuses `@here`');
      expect(await counters(db, room, idOf(room, 'bob'))).toMatchObject({ unread: 1 });
    });
  });
});

describe('integration: a muted channel', () => {
  test('is still unread, and tells the person nothing about a mention', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await db
        .updateTable('channel_members')
        .set({ notification_level: 'none' })
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', idOf(room, 'bob'))
        .execute();
      await post(db, room, 'alice', `@${room.members['bob']?.username ?? ''} are you there`);
      expect(await notificationsOf(db, idOf(room, 'bob'))).toEqual([]);
      expect(await counters(db, room, idOf(room, 'bob'))).toEqual({
        unread: 1,
        mentions: 0,
        lastRead: null,
      });
    });
  });
});

describe('integration: direct messages', () => {
  test('every message is for the other person, and a mention outranks it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
      const plain = await post(db, room, 'alice', 'hello');
      const named = await post(
        db,
        room,
        'alice',
        `${room.members['bob']?.username ?? ''}, and @${room.members['bob']?.username ?? ''}`,
      );
      expect(await notificationsOf(db, idOf(room, 'bob'))).toEqual(
        inOrder([
          { messageId: plain.message.id, type: 'direct_message' },
          { messageId: named.message.id, type: 'mention' },
        ]),
      );
      expect(await counters(db, room, idOf(room, 'bob'))).toMatchObject({ unread: 2, mentions: 2 });
      expect(await counters(db, room, idOf(room, 'alice'))).toMatchObject({
        unread: 0,
        mentions: 0,
      });
    });
  });

  test('a note to oneself notifies and counts for no one', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { type: 'direct_message' });
      const sent = await post(db, room, 'alice', 'remember this');
      expect(sent.recipients).toEqual([]);
      expect(await notificationsOf(db, idOf(room, 'alice'))).toEqual([]);
      expect(await counters(db, room, idOf(room, 'alice'))).toMatchObject({
        unread: 0,
        mentions: 0,
      });
    });
  });
});

describe('integration: a reply', () => {
  test('moves its root’s summary, and tells the root’s author and earlier repliers', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol', 'dave']);
      const root = await post(db, room, 'alice', 'why is the backoff 4s?');
      const first = await post(db, room, 'bob', 'rate limit', { parentId: root.message.id });
      expect(first.thread).toMatchObject({
        rootId: root.message.id,
        summary: { replyCount: 1, resolvedAt: null, resolvedBy: null },
      });
      expect(first.thread?.summary.lastReplyAt).toBe(NOW.toISOString());
      expect(first.message.parentId).toBe(root.message.id);
      expect(first.message.thread).toBeNull();

      const second = await post(db, room, 'carol', 'documented in the postmortem', {
        parentId: root.message.id,
      });
      expect(second.thread?.summary.replyCount).toBe(2);

      // Alice started it, Bob answered it: both are told of Carol's reply. Dave is only
      // somebody in the channel, and is told nothing beyond "unread".
      expect(await notificationsOf(db, idOf(room, 'alice'))).toEqual(
        inOrder([
          { messageId: first.message.id, type: 'thread_reply' },
          { messageId: second.message.id, type: 'thread_reply' },
        ]),
      );
      expect(await notificationsOf(db, idOf(room, 'bob'))).toEqual([
        { messageId: second.message.id, type: 'thread_reply' },
      ]);
      expect(await notificationsOf(db, idOf(room, 'dave'))).toEqual([]);
      expect(await counters(db, room, idOf(room, 'alice'))).toMatchObject({
        unread: 0 + 2,
        mentions: 2,
      });
      expect(await counters(db, room, idOf(room, 'bob'))).toMatchObject({
        unread: 1 + 1,
        mentions: 1,
      });
      expect(await counters(db, room, idOf(room, 'dave'))).toMatchObject({
        unread: 3,
        mentions: 0,
      });
    });
  });

  test('the strongest reason wins: a reply that names the root’s author is one mention, not two', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'alice', 'question');
      const reply = await post(
        db,
        room,
        'bob',
        `@${room.members['alice']?.username ?? ''} here is the answer`,
        {
          parentId: root.message.id,
        },
      );
      expect(await notificationsOf(db, idOf(room, 'alice'))).toEqual([
        { messageId: reply.message.id, type: 'mention' },
      ]);
      expect(await counters(db, room, idOf(room, 'alice'))).toMatchObject({ mentions: 1 });
    });
  });

  test('answering your own thread tells nobody who has not joined it, yourself included', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'alice', 'question');
      await post(db, room, 'alice', 'an update', { parentId: root.message.id });
      expect(await notificationsOf(db, idOf(room, 'bob'))).toEqual([]);
      // The root's author is a thread participant, and here also the sender: told nothing.
      expect(await notificationsOf(db, idOf(room, 'alice'))).toEqual([]);
      expect(await counters(db, room, idOf(room, 'alice'))).toMatchObject({
        unread: 0,
        mentions: 0,
      });
    });
  });

  test('a reply is not in the feed, and the feed’s root carries the summary', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'alice', 'question');
      await post(db, room, 'bob', 'answer', { parentId: root.message.id });
      const page = await messageHistory(db, room.members['alice']?.context as never);
      expect(page.data.map((m) => m.id)).toEqual([root.message.id]);
      expect(page.data[0]?.thread).toMatchObject({ replyCount: 1 });
    });
  });

  test('a thousand replies are counted exactly', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'alice', 'a long argument');
      let last: Sent | undefined;
      for (let n = 0; n < 1_000; n += 1) {
        last = await post(db, room, n % 2 === 0 ? 'bob' : 'alice', `reply ${String(n)}`, {
          parentId: root.message.id,
        });
      }
      expect(last?.thread?.summary.replyCount).toBe(1_000);
      const row = await db
        .selectFrom('messages')
        .select('thread_reply_count')
        .where('id', '=', root.message.id)
        .executeTakeFirstOrThrow();
      const actual = await db
        .selectFrom('messages')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('parent_id', '=', root.message.id)
        .executeTakeFirstOrThrow();
      expect({ stored: row.thread_reply_count, rows: Number(actual.n) }).toEqual({
        stored: 1_000,
        rows: 1_000,
      });
    });
  }, 60_000);
});

describe('integration: replies that must be refused', () => {
  test('to a message that is not there', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const refusal = await refusalOf(post(db, room, 'alice', 'x', { parentId: messageId(NOW) }));
      expect(refusal.body.code).toBe('MESSAGE_NOT_FOUND');
    });
  });

  test('to a reply: threads are two levels deep', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'alice', 'q');
      const reply = await post(db, room, 'bob', 'a', { parentId: root.message.id });
      const refusal = await refusalOf(
        post(db, room, 'alice', 'deeper', { parentId: reply.message.id }),
      );
      expect(refusal.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { fields: { parentId: expect.any(String) as string } },
      });
    });
  });

  test('to a message in another channel, which looks exactly like one that is not there', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice']);
      const there = await aRoom(db, ['erin']);
      const elsewhere = await post(db, there, 'erin', 'private to there');
      const refusal = await refusalOf(
        post(db, here, 'alice', 'x', { parentId: elsewhere.message.id }),
      );
      const absent = await refusalOf(post(db, here, 'alice', 'x', { parentId: messageId(NOW) }));
      expect(refusal.body).toEqual(absent.body);
    });
  });

  test('to a message that was deleted', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const root = await post(db, room, 'alice', 'q');
      await db
        .updateTable('messages')
        .set({ deleted_at: NOW })
        .where('id', '=', root.message.id)
        .execute();
      const refusal = await refusalOf(post(db, room, 'alice', 'x', { parentId: root.message.id }));
      expect(refusal.body.code).toBe('MESSAGE_NOT_FOUND');
    });
  });
});

describe('integration: a retry', () => {
  test('writes, counts and notifies once', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = room.members['bob']?.username ?? '';
      const input = { id: messageId(NOW), content: `@${bob} ping` };
      const alice = room.members['alice']?.context;
      if (alice === undefined) throw new Error('no alice');

      const first = await sendMessage(db, clock, alice, input);
      const again = await sendMessage(db, clock, alice, input);

      expect(again.message).toEqual(first.message);
      expect(first.recipients).toHaveLength(1);
      // Told again from the rows as they are (so a lost publish is repaired), never counted again.
      expect(again.recipients).toEqual(first.recipients);
      expect(await counters(db, room, idOf(room, 'bob'))).toMatchObject({ unread: 1, mentions: 1 });
      expect(await notificationsOf(db, idOf(room, 'bob'))).toHaveLength(1);
    });
  });

  test('of a reply does not count it twice, and still reports the thread as it stands', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'alice', 'q');
      const bob = room.members['bob']?.context;
      if (bob === undefined) throw new Error('no bob');
      const input = { id: messageId(NOW), content: 'a', parentId: root.message.id };

      const first = await sendMessage(db, clock, bob, input);
      const again = await sendMessage(db, clock, bob, input);

      expect(first.thread?.summary.replyCount).toBe(1);
      expect(again.thread).toEqual(first.thread);
      expect(again.recipients).toEqual(first.recipients);
      expect(await counters(db, room, idOf(room, 'alice'))).toMatchObject({
        unread: 1,
        mentions: 1,
      });
    });
  });

  test('somebody else’s id is a conflict, and writes nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const id = messageId(NOW);
      const alice = room.members['alice']?.context;
      const bob = room.members['bob']?.context;
      if (alice === undefined || bob === undefined) throw new Error('no members');
      await sendMessage(db, clock, alice, { id, content: 'mine' });
      const refusal = await refusalOf(sendMessage(db, clock, bob, { id, content: 'not yours' }));
      expect(refusal.body.code).toBe('MESSAGE_ID_CONFLICT');
      expect(await counters(db, room, idOf(room, 'alice'))).toMatchObject({ unread: 0 });
    });
  });
});

describe('integration: the invariant the counters keep (I-6)', () => {
  test('what needs you never exceeds what is unread, after any mix of messages', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const bob = room.members['bob']?.username ?? '';
      const root = await post(db, room, 'alice', 'q');
      await post(db, room, 'bob', 'a', { parentId: root.message.id });
      await post(db, room, 'carol', `@${bob} @${room.members['alice']?.username ?? ''}`);
      await post(db, room, 'alice', 'plain');
      await post(db, room, 'carol', 'reply', { parentId: root.message.id });
      for (const name of ['alice', 'bob', 'carol']) {
        const { unread, mentions } = await counters(db, room, idOf(room, name));
        expect({ name, ok: unread >= mentions }).toEqual({ name, ok: true });
      }
    });
  });
});
