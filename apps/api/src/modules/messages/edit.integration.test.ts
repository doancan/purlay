/**
 * Editing a message (D-103): the author replaces the content, the reading is redone once, and the
 * people the new content names for the first time are told — nobody twice, nobody for a name that
 * was taken out.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { MESSAGE_CONTENT_MAX, messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { markRead } from '../channels/read-state';
import { aRoom, counters, notificationsOf, type Room } from '../../testing/rooms';
import { edit as editMessage, reviseMessage } from './edit';
import { issueSession, revokeSession } from '../auth/sessions';
import { aRecordingLogger } from '../../testing/doubles';
import { MARKDOWN_DELIMITERS_MAX, type Engine } from '@purlay/markdown';
import type { ServerFrame } from '@purlay/types';
import { sendMessage, type Sent } from './messages';
import { setResolved } from './threads';
import { atomicallyOn } from '../../platform/transactions';
import { NO_LOG, channelTopic, userTopic, type EventBus } from '../../platform/events';

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
/** `@name` as the test room spelled it: usernames are unique per room, so `@bob` names nobody. */
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

const edit = async (
  db: Executor,
  room: Room,
  as: string,
  id: string,
  content: string,
): ReturnType<typeof reviseMessage> =>
  await reviseMessage(db, later, member(room, as).userId, id, content);

/** The refusal an attempt ended in, or a failure of the test when it did not end in one. */
const refused = async (attempt: Promise<unknown>): Promise<AppError['body']> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof AppError) return error.body;
    throw error;
  }
  throw new Error('expected a refusal, and the attempt succeeded');
};
const refusal = async (attempt: Promise<unknown>): Promise<string> => (await refused(attempt)).code;

const noBus: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => false,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

describe('integration: the author edits', () => {
  test('the content, its reading and its time are the new ones; the id and the thread are not touched', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(db, room, 'alice', 'plain');
      const versionBefore = (
        await db
          .selectFrom('messages')
          .select('state_version')
          .where('id', '=', sent.message.id)
          .executeTakeFirstOrThrow()
      ).state_version;
      const revised = await edit(db, room, 'alice', sent.message.id, '```ts\nconst x = 1\n```');
      expect(revised.message.id).toBe(sent.message.id);
      expect(revised.message.content).toBe('```ts\nconst x = 1\n```');
      expect(revised.message.editedAt).toBe(LATER.toISOString());
      expect(revised.message.createdAt).toBe(sent.message.createdAt);
      expect(revised.message.parentId).toBeNull();
      const row = await db
        .selectFrom('messages')
        .select(['metadata', 'state_version', 'updated_at'])
        .where('id', '=', sent.message.id)
        .executeTakeFirstOrThrow();
      expect(row.metadata).toMatchObject({ codeLanguages: ['ts'] });
      expect(new Date(row.updated_at).toISOString()).toBe(LATER.toISOString());
      expect(row.state_version).toBe(versionBefore + 1);
      expect(revised.version).toBe(versionBefore + 1);
    });
  });

  test('the same content again changes nothing: not the time, not the version', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const sent = await post(db, room, 'alice', 'first');
      // Edited once, so its version is not the zero a new row starts at.
      await edit(db, room, 'alice', sent.message.id, 'once');
      const before = await db
        .selectFrom('messages')
        .select('state_version')
        .where('id', '=', sent.message.id)
        .executeTakeFirstOrThrow();
      // Later again: an edit would move the time; the same words must not.
      const revised = await reviseMessage(
        db,
        fixedClock(new Date('2026-09-09T12:10:00.000Z')),
        member(room, 'alice').userId,
        sent.message.id,
        'once',
      );
      expect(revised.message.editedAt).toBe(LATER.toISOString());
      expect(revised.recipients).toEqual([]);
      expect(revised.version).toBe(before.state_version);
      const after = await db
        .selectFrom('messages')
        .select('state_version')
        .where('id', '=', sent.message.id)
        .executeTakeFirstOrThrow();
      expect(after.state_version).toBe(before.state_version);
    });
  });

  test('a reply in a resolved thread is edited, and the thread stays resolved', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'alice', 'why?');
      const reply = await post(db, room, 'bob', 'because', root.message.id);
      await setResolved(
        { atomically: atomicallyOn(db), clock, bus: noBus, log: NO_LOG },
        member(room, 'alice').userId,
        root.message.id,
        true,
      );
      const revised = await edit(db, room, 'bob', reply.message.id, 'because of the cache');
      expect(revised.message.content).toBe('because of the cache');
      const after = await db
        .selectFrom('messages')
        .select('resolved_at')
        .where('id', '=', root.message.id)
        .executeTakeFirstOrThrow();
      expect(after.resolved_at).not.toBeNull();
    });
  });

  test('content exactly at the limit is accepted', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const sent = await post(db, room, 'alice', 'short');
      const longest = 'x'.repeat(MESSAGE_CONTENT_MAX);
      expect((await edit(db, room, 'alice', sent.message.id, longest)).message.content).toBe(
        longest,
      );
    });
  });

  test('@here is refused on an edit as it is on a send, naming the field', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const sent = await post(db, room, 'alice', 'hello');
      expect(await refused(edit(db, room, 'alice', sent.message.id, 'look @here'))).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { fields: { content: 'broadcast mentions are not available' } },
      });
    });
  });
});

describe('integration: who may not', () => {
  test('another member sending the very words already there is refused too, not answered', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(db, room, 'alice', 'mine');
      expect(await refusal(edit(db, room, 'bob', sent.message.id, 'mine'))).toBe('FORBIDDEN');
    });
  });

  test('the author, removed from the private channel since, is told it is not there', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'private' });
      const sent = await post(db, room, 'alice', 'said before leaving');
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', member(room, 'alice').userId)
        .execute();
      expect(await refusal(edit(db, room, 'alice', sent.message.id, 'changed'))).toBe(
        'MESSAGE_NOT_FOUND',
      );
      expect(
        (
          await db
            .selectFrom('messages')
            .select('content')
            .where('id', '=', sent.message.id)
            .executeTakeFirstOrThrow()
        ).content,
      ).toBe('said before leaving');
    });
  });

  test('another member of the channel is refused, and nothing is written', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(db, room, 'alice', 'mine');
      expect(await refusal(edit(db, room, 'bob', sent.message.id, 'now mine'))).toBe('FORBIDDEN');
      const row = await db
        .selectFrom('messages')
        .select(['content', 'edited_at'])
        .where('id', '=', sent.message.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ content: 'mine', edited_at: null });
    });
  });

  test('somebody in another workspace, or outside a private channel, is told it is not there', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { type: 'private', outsiders: ['mallory'] });
      const other = await aRoom(db, ['eve']);
      const sent = await post(db, room, 'alice', 'private');
      const outsider = room.outsiders['mallory']?.userId;
      if (outsider === undefined) throw new Error('no outsider');
      expect(await refusal(reviseMessage(db, later, outsider, sent.message.id, 'x'))).toBe(
        'MESSAGE_NOT_FOUND',
      );
      expect(
        await refusal(reviseMessage(db, later, member(other, 'eve').userId, sent.message.id, 'x')),
      ).toBe('MESSAGE_NOT_FOUND');
    });
  });

  test('a deleted message, an unknown id and a malformed one are not there', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const sent = await post(db, room, 'alice', 'going');
      await db
        .updateTable('messages')
        .set({ deleted_at: NOW, content: '' })
        .where('id', '=', sent.message.id)
        .execute();
      expect(await refusal(edit(db, room, 'alice', sent.message.id, 'back'))).toBe(
        'MESSAGE_NOT_FOUND',
      );
      expect(await refusal(edit(db, room, 'alice', nextId(), 'x'))).toBe('MESSAGE_NOT_FOUND');
      expect(await refusal(edit(db, room, 'alice', 'not-an-id', 'x'))).toBe('MESSAGE_NOT_FOUND');
    });
  });
});

describe('integration: who is told', () => {
  test('a name the edit adds is told once; one already named is not told again', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const sent = await post(db, room, 'alice', `ask ${at(room, 'bob')}`);
      const revised = await edit(
        db,
        room,
        'alice',
        sent.message.id,
        `ask ${at(room, 'bob')} and ${at(room, 'carol')}`,
      );
      expect(revised.message.mentions.toSorted()).toEqual(
        [member(room, 'bob').userId, member(room, 'carol').userId].toSorted(),
      );
      const mentionsOf = async (name: string): Promise<number> =>
        (await notificationsOf(db, member(room, name).userId)).filter((n) => n.type === 'mention')
          .length;
      expect(await mentionsOf('bob')).toBe(1);
      expect(await mentionsOf('carol')).toBe(1);
      expect((await counters(db, room, member(room, 'carol').userId)).mentions).toBe(1);
      // The same edit again: nobody new.
      await edit(
        db,
        room,
        'alice',
        sent.message.id,
        `ask ${at(room, 'bob')} and ${at(room, 'carol')}`,
      );
      expect(await mentionsOf('carol')).toBe(1);
      // A name added, taken out, added back: told the first time only.
      await edit(db, room, 'alice', sent.message.id, `ask ${at(room, 'bob')}`);
      await edit(
        db,
        room,
        'alice',
        sent.message.id,
        `ask ${at(room, 'bob')} and ${at(room, 'carol')}`,
      );
      expect(await mentionsOf('carol')).toBe(1);
      expect((await counters(db, room, member(room, 'carol').userId)).mentions).toBe(1);
    });
  });

  test('somebody told about another message is told about this one: the lookup is of this message', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      await post(db, room, 'bob', `earlier, ${at(room, 'carol')}`);
      const sent = await post(db, room, 'alice', 'hello');
      const revised = await edit(db, room, 'alice', sent.message.id, `hello ${at(room, 'carol')}`);
      expect(revised.recipients.map((r) => r.userId)).toEqual([member(room, 'carol').userId]);
      expect(
        (await notificationsOf(db, member(room, 'carol').userId)).filter(
          (n) => n.messageId === sent.message.id,
        ),
      ).toEqual([{ messageId: sent.message.id, type: 'mention' }]);
    });
  });

  test("only this channel is counted: the person's other channels are as they were", async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'carol']);
      const elsewhere = await aRoom(db, ['dave']);
      const quiet = await aRoom(db, ['erin']);
      // Carol is in two other channels: one with something unread, one with nothing.
      for (const [other, unread] of [
        [elsewhere, 2],
        [quiet, 0],
      ] as const) {
        await db
          .insertInto('channel_members')
          .values({
            channel_id: other.channelId,
            user_id: member(room, 'carol').userId,
            unread_count: unread,
            // Long before the message: so only the channel filter can keep these rows out.
            joined_at: new Date('2026-01-01T00:00:00.000Z'),
          })
          .execute();
      }
      const sent = await post(db, room, 'alice', 'hello');
      const revised = await edit(db, room, 'alice', sent.message.id, `hello ${at(room, 'carol')}`);
      expect(revised.recipients).toHaveLength(1);
      expect(await counters(db, elsewhere, member(room, 'carol').userId)).toMatchObject({
        unread: 2,
        mentions: 0,
      });
      expect(await counters(db, quiet, member(room, 'carol').userId)).toMatchObject({
        unread: 0,
        mentions: 0,
      });
    });
  });

  test('a member of the workspace who is not in the channel is told for the inbox, and counted nowhere', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['olga'] });
      const olga = room.outsiders['olga'];
      if (olga === undefined) throw new Error('no outsider');
      const sent = await post(db, room, 'alice', 'hello');
      const revised = await edit(db, room, 'alice', sent.message.id, `hello @${olga.username}`);
      expect(revised.message.mentions).toEqual([olga.userId]);
      expect(revised.recipients).toEqual([]);
      expect(await notificationsOf(db, olga.userId)).toEqual([
        { messageId: sent.message.id, type: 'mention' },
      ]);
    });
  });

  test('somebody who joined at the very instant the message was written is counted, as a send counts them', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(db, room, 'alice', 'hello');
      await db
        .updateTable('channel_members')
        .set({ joined_at: NOW })
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', member(room, 'bob').userId)
        .execute();
      await edit(db, room, 'alice', sent.message.id, `hello ${at(room, 'bob')}`);
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 1,
        mentions: 1,
      });
      const told = await db
        .selectFrom('notifications')
        .select('read_at')
        .where('user_id', '=', member(room, 'bob').userId)
        .executeTakeFirstOrThrow();
      expect(told.read_at).toBeNull();
    });
  });

  test('a name taken out is no longer a mention; what it was told is not withdrawn', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(db, room, 'alice', `ask ${at(room, 'bob')}`);
      const revised = await edit(db, room, 'alice', sent.message.id, 'never mind');
      expect(revised.message.mentions).toEqual([]);
      expect(
        (await notificationsOf(db, member(room, 'bob').userId)).filter((n) => n.type === 'mention'),
      ).toHaveLength(1);
    });
  });

  test('somebody who has read past the message is told for the inbox, and nothing is counted', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(db, room, 'alice', 'hello');
      await markRead(db, clock, member(room, 'bob').context, sent.message.id);
      await edit(db, room, 'alice', sent.message.id, `hello ${at(room, 'bob')}`);
      const told = await db
        .selectFrom('notifications')
        .select('read_at')
        .where('user_id', '=', member(room, 'bob').userId)
        .where('type', '=', 'mention')
        .execute();
      expect(told).toHaveLength(1);
      expect(told[0]?.read_at).not.toBeNull();
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 0,
        mentions: 0,
      });
    });
  });

  test('somebody who joined after the message was written is told for the inbox, and nothing is counted', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(db, room, 'alice', 'before you came');
      // Bob joins now: the message was never counted for him, so counting a mention would put
      // his mentions above his unread messages, which the database refuses (I-6).
      await db
        .updateTable('channel_members')
        .set({
          joined_at: LATER,
          unread_count: 0,
          unread_mention_count: 0,
          last_read_message_id: null,
        })
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', member(room, 'bob').userId)
        .execute();
      await edit(db, room, 'alice', sent.message.id, `before you came ${at(room, 'bob')}`);
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 0,
        mentions: 0,
      });
      const told = await db
        .selectFrom('notifications')
        .select('read_at')
        .where('user_id', '=', member(room, 'bob').userId)
        .execute();
      expect(told).toHaveLength(1);
      expect(told[0]?.read_at).not.toBeNull();
    });
  });

  test('the other side of a direct message, named by an edit, was told already: nothing more, and no refusal', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
      const sent = await post(db, room, 'alice', 'hello');
      const before = await counters(db, room, member(room, 'bob').userId);
      expect(before).toMatchObject({ unread: 1, mentions: 1 });
      // Counting a second notification would put Bob's mentions above his unread (I-6): a 500.
      const revised = await edit(db, room, 'alice', sent.message.id, `hello ${at(room, 'bob')}`);
      expect(revised.message.mentions).toEqual([member(room, 'bob').userId]);
      expect(revised.recipients).toEqual([]);
      expect(await counters(db, room, member(room, 'bob').userId)).toEqual(before);
      expect(await notificationsOf(db, member(room, 'bob').userId)).toHaveLength(1);
    });
  });

  test('the author of a thread, named by an edit of a reply, was told already: nothing more', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'alice', 'why?');
      const reply = await post(db, room, 'bob', 'because', root.message.id);
      const before = await counters(db, room, member(room, 'alice').userId);
      await edit(db, room, 'bob', reply.message.id, `because, ${at(room, 'alice')}`);
      expect(await counters(db, room, member(room, 'alice').userId)).toEqual(before);
      expect(await notificationsOf(db, member(room, 'alice').userId)).toEqual([
        { messageId: reply.message.id, type: 'thread_reply' },
      ]);
    });
  });

  test('an edit moves nobody else: every other unread count and version is as it was', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol', 'dave']);
      const sent = await post(db, room, 'alice', 'hello');
      const snapshot = async (): Promise<unknown> =>
        await db
          .selectFrom('channel_members')
          .select(['user_id', 'unread_count', 'unread_mention_count', 'state_version'])
          .where('channel_id', '=', room.channelId)
          .where('user_id', '<>', member(room, 'carol').userId)
          .orderBy('user_id')
          .execute();
      const before = await snapshot();
      await edit(db, room, 'alice', sent.message.id, `hello ${at(room, 'carol')}`);
      expect(await snapshot()).toEqual(before);
    });
  });

  test('a name inside fenced code is not a mention', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(db, room, 'alice', 'hello');
      const revised = await edit(
        db,
        room,
        'alice',
        sent.message.id,
        `\`\`\`\n${at(room, 'bob')}\n\`\`\``,
      );
      expect(revised.message.mentions).toEqual([]);
      expect(await notificationsOf(db, member(room, 'bob').userId)).toEqual([]);
    });
  });

  test('a member who muted the channel, and the author, are told nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await db
        .updateTable('channel_members')
        .set({ notification_level: 'none' })
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', member(room, 'bob').userId)
        .execute();
      const sent = await post(db, room, 'alice', 'hello');
      await edit(
        db,
        room,
        'alice',
        sent.message.id,
        `hello ${at(room, 'bob')} ${at(room, 'alice')}`,
      );
      expect(await notificationsOf(db, member(room, 'bob').userId)).toEqual([]);
      expect(await notificationsOf(db, member(room, 'alice').userId)).toEqual([]);
    });
  });

  test('an unread message gains a mention: the mention count moves and the unread count does not', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(db, room, 'alice', 'hello');
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 1,
        mentions: 0,
      });
      const revised = await edit(db, room, 'alice', sent.message.id, `hello ${at(room, 'bob')}`);
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 1,
        mentions: 1,
      });
      expect(revised.recipients.map((r) => r.userId)).toEqual([member(room, 'bob').userId]);
    });
  });
});

describe('integration: successive edits', () => {
  test('the later is what stays, and the versions climb', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const sent = await post(db, room, 'alice', 'v0');
      const first = await edit(db, room, 'alice', sent.message.id, 'v1');
      const second = await edit(db, room, 'alice', sent.message.id, 'v2');
      expect(second.version).toBeGreaterThan(first.version);
      expect(
        (
          await db
            .selectFrom('messages')
            .select('content')
            .where('id', '=', sent.message.id)
            .executeTakeFirstOrThrow()
        ).content,
      ).toBe('v2');
    });
  });
});

describe('integration: the one way in', () => {
  const recording = (): { bus: EventBus; frames: ServerFrame[]; topics: string[] } => {
    const frames: ServerFrame[] = [];
    const topics: string[] = [];
    return {
      frames,
      topics,
      bus: {
        publish: (topic, frame): Promise<void> => {
          topics.push(topic);
          frames.push(frame);
          return Promise.resolve();
        },
        subscribe: () => false,
        unsubscribe: () => undefined,
        forget: () => undefined,
      },
    };
  };

  test('after the commit, tells the newly named their numbers, and nobody else anything', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const sent = await post(db, room, 'alice', `hi ${at(room, 'bob')}`);
      const { token } = await issueSession(db, later, member(room, 'alice').userId, 30);
      const session = await db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', member(room, 'alice').userId)
        .executeTakeFirstOrThrow();
      expect(token).not.toBe('');
      const { bus, frames, topics } = recording();
      const message = await editMessage(
        { atomically: atomicallyOn(db), clock: later, bus },
        { userId: member(room, 'alice').userId, sessionId: session.id },
        sent.message.id,
        `hi ${at(room, 'bob')} and ${at(room, 'carol')}`,
      );
      expect(message.editedAt).toBe(LATER.toISOString());
      expect(frames.map((frame) => frame.event)).toEqual([
        'MESSAGE_REVISED',
        'CHANNEL_STATE',
        'NOTIFICATIONS_UPDATED',
      ]);
      // The room first, with the revision at the message's version; then Carol's own numbers, then
      // her inbox (D-106).
      expect(topics).toEqual([
        channelTopic(room.channelId),
        userTopic(member(room, 'carol').userId),
        userTopic(member(room, 'carol').userId),
      ]);
      expect(frames[2]).toMatchObject({ data: { workspaceId: room.workspaceId } });
      const [revision, frame] = frames;
      if (revision?.event !== 'MESSAGE_REVISED') throw new Error('no revision');
      expect(revision.data).toEqual({
        channelId: room.channelId,
        messageId: sent.message.id,
        parentId: null,
        content: message.content,
        editedAt: LATER.toISOString(),
        deletedAt: null,
        mentions: message.mentions,
      });
      const stored = await db
        .selectFrom('messages')
        .select('state_version')
        .where('id', '=', sent.message.id)
        .executeTakeFirstOrThrow();
      expect(revision.version).toBe(stored.state_version);
      if (frame?.event !== 'CHANNEL_STATE') throw new Error('no channel state');
      expect(frame.data.channelId).toBe(room.channelId);
      expect(frame.data.state.unreadMentionCount).toBe(1);
      const row = await db
        .selectFrom('channel_members')
        .select('state_version')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', member(room, 'carol').userId)
        .executeTakeFirstOrThrow();
      expect(frame.version).toBe(row.state_version);
    });
  });

  test('the same words again tell nobody anything', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const sent = await post(db, room, 'alice', 'once');
      await issueSession(db, later, member(room, 'alice').userId, 30);
      const session = await db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', member(room, 'alice').userId)
        .executeTakeFirstOrThrow();
      const { bus, frames } = recording();
      await editMessage(
        { atomically: atomicallyOn(db), clock: later, bus },
        { userId: member(room, 'alice').userId, sessionId: session.id },
        sent.message.id,
        'once',
      );
      expect(frames).toEqual([]);
    });
  });

  test('a session ended before the edit commits writes nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const sent = await post(db, room, 'alice', 'mine');
      const { token } = await issueSession(db, later, member(room, 'alice').userId, 30);
      const session = await db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', member(room, 'alice').userId)
        .executeTakeFirstOrThrow();
      await revokeSession(db, later, token);
      expect(
        await refusal(
          editMessage(
            { atomically: atomicallyOn(db), clock: later, bus: noBus },
            { userId: member(room, 'alice').userId, sessionId: session.id },
            sent.message.id,
            'after signing out',
          ),
        ),
      ).toBe('UNAUTHENTICATED');
      expect(
        (
          await db
            .selectFrom('messages')
            .select('content')
            .where('id', '=', sent.message.id)
            .executeTakeFirstOrThrow()
        ).content,
      ).toBe('mine');
    });
  });

  test('a body stored as typed for its complexity is not logged as an engine failure', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const sent = await post(db, room, 'alice', 'before');
      await issueSession(db, later, member(room, 'alice').userId, 30);
      const session = await db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', member(room, 'alice').userId)
        .executeTakeFirstOrThrow();
      const { log, lines } = aRecordingLogger();
      await editMessage(
        { atomically: atomicallyOn(db), clock: later, bus: noBus, log },
        { userId: member(room, 'alice').userId, sessionId: session.id },
        sent.message.id,
        '*a'.repeat(MARKDOWN_DELIMITERS_MAX + 1),
      );
      expect(lines.filter((line) => line['level'] === 'error')).toEqual([]);
    });
  });

  test('the engine failing inside its bounds: stored as typed, logged with its cause and not the body', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const sent = await post(db, room, 'alice', 'before');
      await issueSession(db, later, member(room, 'alice').userId, 30);
      const session = await db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', member(room, 'alice').userId)
        .executeTakeFirstOrThrow();
      const engine: Engine = {
        blocks: () => ({ type: 'root', children: [] }),
        full: (): never => {
          throw new RangeError('Maximum call stack size exceeded');
        },
      };
      const { log, lines } = aRecordingLogger();
      const body = 'a secret plan in **bold**';
      await editMessage(
        { atomically: atomicallyOn(db), clock: later, bus: noBus, log, engine },
        { userId: member(room, 'alice').userId, sessionId: session.id },
        sent.message.id,
        body,
      );
      const row = await db
        .selectFrom('messages')
        .select(['content', 'metadata'])
        .where('id', '=', sent.message.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ content: body, metadata: {} });
      const failures = lines.filter(
        (line) => line['msg'] === 'markdown engine failed inside its bounds',
      );
      expect(failures).toHaveLength(1);
      expect(JSON.stringify(failures[0])).toContain('Maximum call stack size exceeded');
      expect(JSON.stringify(lines)).not.toContain('secret plan');
    });
  });
});
