/**
 * The inbox (D-106): what is waiting for a person in one workspace, and marking it read — which is
 * also what the mention badge of each channel it touches is counted from (D-99 §4, I-6).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  sql,
  withRollback,
  type Executor,
  type Transaction,
} from '@purlay/db';
import {
  messageId,
  THREAD_EXCERPT_MAX,
  type ReadNotificationsRequest,
  type NotificationType,
  type NotificationQuery,
} from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { visibleChannelIds } from '../../platform/channels';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aRoom, counters, type Room } from '../../testing/rooms';
import { sendMessage, type Sent } from '../messages/messages';
import { inboxOf, readNotifications } from './notifications';

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

const post = async (db: Executor, room: Room, as: string, content: string): Promise<Sent> =>
  await sendMessage(db, clock, member(room, as).context, { id: nextId(), content });

/** Alice names Bob in each of `contents`; each is one notification for Bob, in this order. */
const mentions = async (db: Executor, room: Room, contents: readonly string[]): Promise<void> => {
  for (const content of contents) {
    await post(db, room, 'alice', `@${member(room, 'bob').username} ${content}`);
  }
};

/** Puts `userId` in `room`'s workspace and channel too: one person, two inboxes. */
const alsoIn = async (db: Executor, room: Room, userId: string): Promise<void> => {
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: room.workspaceId, user_id: userId, role: 'member' })
    .execute();
  await db
    .insertInto('channel_members')
    .values({ channel_id: room.channelId, user_id: userId, joined_at: new Date('2026-01-01') })
    .execute();
};

const inbox = async (
  db: Executor,
  room: Room,
  userId: string,
  extra: Omit<NotificationQuery, 'workspaceId'> = {},
): Promise<{ contents: string[]; ids: string[]; nextCursor: string | null }> => {
  const context = await requireWorkspaceMembership(db, userId, room.workspaceId);
  const page = await inboxOf(db, context, await visibleChannelIds(db, context), {
    workspaceId: room.workspaceId,
    ...extra,
  });
  return {
    contents: page.data.map((n) => n.message.content.replace(/^@\S+ /, '')),
    ids: page.data.map((n) => n.id),
    nextCursor: page.nextCursor,
  };
};

const read = async (
  db: Transaction,
  userId: string,
  input: ReadNotificationsRequest,
): ReturnType<typeof readNotifications> => await readNotifications(db, clock, userId, input);

const refusalOf = async (attempt: Promise<unknown>): Promise<AppError> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('accepted where it had to be refused');
};

describe('integration: the inbox', () => {
  test('newest first, with the message, a page at a time', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await mentions(db, room, ['one', 'two', 'three']);
      const bob = member(room, 'bob').userId;
      const first = await inbox(db, room, bob, { limit: 2 });
      expect(first.contents).toEqual(['three', 'two']);
      expect(first.nextCursor).toBe(first.ids[1] ?? null);
      const second = await inbox(db, room, bob, { limit: 2, before: first.nextCursor ?? '' });
      expect(second).toMatchObject({ contents: ['one'], nextCursor: null });
    });
  });

  test('ordered by when the person was told, not by when the message was written', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await mentions(db, room, ['older message', 'newer message']);
      const bob = member(room, 'bob').userId;
      const [olderMessage] = (await inbox(db, room, bob)).ids.slice(-1);
      // The older message's notification is the later one: a resolution of an old question is.
      await db
        .updateTable('notifications')
        .set({ created_at: sql<Date>`created_at + interval '1 minute'` })
        .where('id', '=', olderMessage ?? '')
        .execute();
      expect((await inbox(db, room, bob)).contents).toEqual(['older message', 'newer message']);
    });
  });

  test('only what is unread, when asked', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await mentions(db, room, ['kept', 'seen']);
      const bob = member(room, 'bob').userId;
      const [seen] = (await inbox(db, room, bob)).ids;
      await read(db, bob, { ids: [seen ?? ''] });
      expect((await inbox(db, room, bob, { unreadOnly: true })).contents).toEqual(['kept']);
      expect((await inbox(db, room, bob)).contents).toEqual(['seen', 'kept']);
    });
  });

  test('never a deleted message, nor one in a channel the person can no longer see', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'private' });
      await mentions(db, room, ['gone', 'stays']);
      const bob = member(room, 'bob').userId;
      const gone = await db
        .selectFrom('messages')
        .select('id')
        .where('content', 'like', '%gone')
        .executeTakeFirstOrThrow();
      await db.updateTable('messages').set({ deleted_at: NOW }).where('id', '=', gone.id).execute();
      expect((await inbox(db, room, bob)).contents).toEqual(['stays']);
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', bob)
        .execute();
      expect((await inbox(db, room, bob)).contents).toEqual([]);
    });
  });

  test('is the caller’s own: another person’s notifications are not in it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      await mentions(db, room, ['for bob']);
      expect((await inbox(db, room, member(room, 'carol').userId)).contents).toEqual([]);
    });
  });

  test('a cursor that is not one of the caller’s notifications is refused, not an empty page', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      await mentions(db, room, ['for bob']);
      const [bobs] = (await inbox(db, room, member(room, 'bob').userId)).ids;
      for (const before of [bobs ?? '', '00000000-0000-4000-8000-000000000000']) {
        const refusal = await refusalOf(inbox(db, room, member(room, 'carol').userId, { before }));
        expect(refusal.body.code).toBe('VALIDATION_FAILED');
      }
    });
  });
});

/**
 * The same executor, counting the statements it is asked to run: Kysely calls a plugin once per
 * executed query, so the count is exact.
 */
const counting = (db: Executor): { readonly db: Executor; readonly count: () => number } => {
  let statements = 0;
  const counted = db.withPlugin({
    transformQuery: (args) => args.node,
    transformResult: (args) => {
      statements += 1;
      return Promise.resolve(args.result);
    },
  });
  return { db: counted, count: () => statements };
};

const reply = async (
  db: Executor,
  room: Room,
  as: string,
  rootId: string,
  content: string,
): Promise<Sent> =>
  await sendMessage(db, clock, member(room, as).context, {
    id: nextId(),
    content,
    parentId: rootId,
  });

const pageOf = async (
  db: Executor,
  room: Room,
  userId: string,
): Promise<Awaited<ReturnType<typeof inboxOf>>> => {
  const context = await requireWorkspaceMembership(db, userId, room.workspaceId);
  return await inboxOf(db, context, await visibleChannelIds(db, context), {
    workspaceId: room.workspaceId,
  });
};

describe('integration: a reply’s thread, in brief (D-162)', () => {
  test('a reply names its root by its first line, plain, and says whose it is; anything else carries none', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const bob = member(room, 'bob').userId;
      const carol = member(room, 'carol').userId;
      const mine = await post(db, room, 'bob', '**Deploy** checklist for `friday`');
      await reply(db, room, 'alice', mine.message.id, 'done');
      // Carol's question, which Bob only answered: he is in it, it is not his.
      const theirs = await post(db, room, 'carol', 'Who owns the cache?');
      await reply(db, room, 'bob', theirs.message.id, 'me');
      await reply(db, room, 'alice', theirs.message.id, 'or me');
      await mentions(db, room, ['plain']);

      const page = await pageOf(db, room, bob);
      expect(page.data.map((n) => [n.type, n.thread])).toEqual([
        ['mention', null],
        [
          'thread_reply',
          { rootId: theirs.message.id, excerpt: 'Who owns the cache?', authorId: carol },
        ],
        [
          'thread_reply',
          { rootId: mine.message.id, excerpt: 'Deploy checklist for friday', authorId: bob },
        ],
      ]);
    });
  });

  test('a long root is cut to one line of the contract’s length, and a deleted one is not quoted', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = member(room, 'bob').userId;
      const long = await post(db, room, 'bob', `${'word '.repeat(60)}\n\nsecond paragraph`);
      await reply(db, room, 'alice', long.message.id, 'seen');
      const gone = await post(db, room, 'bob', 'a secret that was taken back');
      await reply(db, room, 'alice', gone.message.id, 'answered');
      await db
        .updateTable('messages')
        .set({ deleted_at: NOW })
        .where('id', '=', gone.message.id)
        .execute();

      const [answered, seen] = (await pageOf(db, room, bob)).data;
      expect(answered?.thread).toEqual({ rootId: gone.message.id, excerpt: null, authorId: bob });
      expect(JSON.stringify(answered)).not.toContain('secret');
      const excerpt = seen?.thread?.excerpt ?? '';
      expect(excerpt.length).toBeLessThanOrEqual(THREAD_EXCERPT_MAX);
      expect(excerpt.endsWith('…')).toBe(true);
      expect(excerpt.startsWith('word word')).toBe(true);
      expect(excerpt).not.toContain('\n');
    });
  });

  test('a thread in a channel the person can no longer see is not in the inbox at all', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'private' });
      const bob = member(room, 'bob').userId;
      const root = await post(db, room, 'bob', 'private plans');
      await reply(db, room, 'alice', root.message.id, 'yes');
      expect((await pageOf(db, room, bob)).data.map((n) => n.thread?.excerpt)).toEqual([
        'private plans',
      ]);
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', bob)
        .execute();
      expect((await pageOf(db, room, bob)).data).toEqual([]);
    });
  });

  test('costs the same however many threads the page names: no read per row', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = member(room, 'bob').userId;
      const context = await requireWorkspaceMembership(db, bob, room.workspaceId);
      const visible = await visibleChannelIds(db, context);
      const cost = async (): Promise<{ statements: number; rows: number }> => {
        const meter = counting(db);
        const page = await inboxOf(meter.db, context, visible, { workspaceId: room.workspaceId });
        return { statements: meter.count(), rows: page.data.length };
      };
      const threads = async (n: number): Promise<void> => {
        for (let i = 0; i < n; i += 1) {
          const root = await post(db, room, 'bob', `question ${String(i)}`);
          await reply(db, room, 'alice', root.message.id, 'answer');
        }
      };

      await threads(2);
      const few = await cost();
      await threads(10);
      const many = await cost();

      // A meter that counted nothing, or a page that held nothing, would pass for the wrong reason.
      expect(few).toMatchObject({ rows: 2 });
      expect(few.statements).toBeGreaterThan(0);
      expect(many).toEqual({ statements: few.statements, rows: 12 });
    });
  });
});

describe('integration: marking read', () => {
  test('by id: read, and the channel’s mention badge counted again from the rows', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await mentions(db, room, ['one', 'two']);
      const bob = member(room, 'bob').userId;
      expect(await counters(db, room, bob)).toMatchObject({ unread: 2, mentions: 2 });
      const [newest] = (await inbox(db, room, bob)).ids;
      const told = await read(db, bob, { ids: [newest ?? ''] });
      // The messages are still unread; one of them no longer needs Bob.
      expect(await counters(db, room, bob)).toMatchObject({ unread: 2, mentions: 1 });
      // What Bob's other devices are told: this channel, as the row now is.
      expect(
        told.map((t) => [t.channelId, t.state.unreadCount, t.state.unreadMentionCount]),
      ).toEqual([[room.channelId, 2, 1]]);
    });
  });

  test('again is nothing: no channel to tell', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await mentions(db, room, ['one']);
      const bob = member(room, 'bob').userId;
      const ids = (await inbox(db, room, bob)).ids;
      expect(await read(db, bob, { ids })).toHaveLength(1);
      expect(await read(db, bob, { ids })).toEqual([]);
    });
  });

  test('somebody else’s id is not read, and says nothing about whether it exists', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      await mentions(db, room, ['for bob']);
      const bob = member(room, 'bob').userId;
      const ids = (await inbox(db, room, bob)).ids;
      expect(await read(db, member(room, 'carol').userId, { ids })).toEqual([]);
      expect(await counters(db, room, bob)).toMatchObject({ mentions: 1 });
    });
  });

  test('a workspace, up to and including `before`: what came after is still waiting', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await mentions(db, room, ['one', 'two', 'three']);
      const bob = member(room, 'bob').userId;
      const [, middle] = (await inbox(db, room, bob)).ids;
      await read(db, bob, { workspaceId: room.workspaceId, before: middle ?? '' });
      expect((await inbox(db, room, bob, { unreadOnly: true })).contents).toEqual(['three']);
      await read(db, bob, { workspaceId: room.workspaceId });
      expect((await inbox(db, room, bob, { unreadOnly: true })).contents).toEqual([]);
      expect(await counters(db, room, bob)).toMatchObject({ unread: 3, mentions: 0 });
    });
  });

  test('a workspace is that workspace: the same person’s other inbox is untouched', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const other = await aRoom(db, ['carol']);
      const bob = member(room, 'bob');
      await alsoIn(db, other, bob.userId);
      await mentions(db, room, ['here']);
      await sendMessage(db, clock, member(other, 'carol').context, {
        id: nextId(),
        content: `@${bob.username} there`,
      });
      const [theirs] = (await inbox(db, other, bob.userId)).ids;
      // A cursor from the other workspace is not a place in this one.
      const refusal = await refusalOf(inbox(db, room, bob.userId, { before: theirs ?? '' }));
      expect(refusal.body.code).toBe('VALIDATION_FAILED');
      await read(db, bob.userId, { workspaceId: room.workspaceId });
      expect((await inbox(db, room, bob.userId, { unreadOnly: true })).contents).toEqual([]);
      expect((await inbox(db, other, bob.userId, { unreadOnly: true })).contents).toEqual([
        'there',
      ]);
    });
  });

  test('a workspace the caller is not in is the stranger’s answer', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const elsewhere = await aRoom(db, ['dave']);
      const refusal = await refusalOf(
        read(db, member(room, 'alice').userId, { workspaceId: elsewhere.workspaceId }),
      );
      expect(refusal.body.code).toBe('WORKSPACE_NOT_FOUND');
    });
  });
});

/** Real messages and recipient rows, varying stored reasons without changing delivery rules. */
const typedHistory = async (
  db: Executor,
  room: Room,
  types: readonly NotificationType[],
): Promise<void> => {
  for (const [index, type] of types.entries()) {
    const sent = await post(
      db,
      room,
      'alice',
      `@${member(room, 'bob').username} typed-${String(index)}`,
    );
    await db
      .updateTable('notifications')
      .set({ type })
      .where('message_id', '=', sent.message.id)
      .where('user_id', '=', member(room, 'bob').userId)
      .execute();
  }
};

describe('integration: notification type filtering before pagination', () => {
  test('older matches fill the first page; a union walks the total order with no gaps, including ties', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = member(room, 'bob').userId;
      await typedHistory(db, room, [
        'thread_reply',
        'mention',
        'thread_resolved',
        'direct_message',
        'mention',
        'channel_message',
      ]);
      const context = await requireWorkspaceMembership(db, bob, room.workspaceId);
      const visible = await visibleChannelIds(db, context);
      const unfiltered = await inboxOf(db, context, visible, {
        workspaceId: room.workspaceId,
        limit: 1,
      });
      expect(unfiltered.data.map((row) => row.type)).toEqual(['channel_message']);
      const first = await inboxOf(db, context, visible, {
        workspaceId: room.workspaceId,
        types: 'thread_reply,thread_resolved',
        limit: 2,
      });
      expect(first.data.map((row) => row.type)).toEqual(['thread_resolved', 'thread_reply']);
      expect(first.nextCursor).toBeNull(); // Older excluded rows are not another filtered page.

      const reply = first.data[1];
      if (reply === undefined) throw new Error('missing the oldest filtered notification');
      // Two notifications share the timestamp AND message: the final notification ID breaks the tie.
      await db
        .insertInto('notifications')
        .values({
          user_id: bob,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          message_id: reply.message.id,
          type: 'thread_resolved',
          created_at: NOW,
        })
        .execute();
      // A difference PostgreSQL retains but JavaScript Date would round away.
      await db
        .updateTable('notifications')
        .set({ created_at: sql<Date>`created_at + interval '1 microsecond'` })
        .where('id', '=', first.data[0]?.id ?? '')
        .execute();
      const all = await inboxOf(db, context, visible, { workspaceId: room.workspaceId });
      const expected = all.data
        .filter((row) => row.type === 'thread_reply' || row.type === 'thread_resolved')
        .map((row) => row.id);
      const seen: string[] = [];
      let before: string | undefined;
      for (let page = 0; page <= expected.length; page += 1) {
        const next = await inboxOf(db, context, visible, {
          workspaceId: room.workspaceId,
          types: 'thread_reply,thread_resolved',
          limit: 1,
          ...(before === undefined ? {} : { before }),
        });
        seen.push(...next.data.map((row) => row.id));
        if (next.nextCursor === null) break;
        expect(next.data).toHaveLength(1);
        expect(next.nextCursor).toBe(next.data.at(-1)?.id ?? '');
        before = next.nextCursor;
      }
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(seen.length);
      expect(
        (await inbox(db, room, bob, { types: 'mention', limit: 1 })).nextCursor,
      ).not.toBeNull();
    });
  });

  test('all supported reasons, unread state and an anchor of another type compose without changing the cursor rule', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = member(room, 'bob').userId;
      await typedHistory(db, room, [
        'thread_reply',
        'mention',
        'direct_message',
        'thread_resolved',
        'channel_message',
      ]);
      const context = await requireWorkspaceMembership(db, bob, room.workspaceId);
      const visible = await visibleChannelIds(db, context);
      const all = await inboxOf(db, context, visible, { workspaceId: room.workspaceId });
      for (const row of all.data) {
        const query = { workspaceId: room.workspaceId, types: row.type };
        expect((await inboxOf(db, context, visible, query)).data.map((item) => item.id)).toEqual([
          row.id,
        ]);
        expect(
          (await inboxOf(db, context, visible, { ...query, unreadOnly: false })).data.map(
            (item) => item.id,
          ),
        ).toEqual([row.id]);
        await db
          .updateTable('notifications')
          .set({ read_at: NOW })
          .where('id', '=', row.id)
          .execute();
        expect((await inboxOf(db, context, visible, { ...query, unreadOnly: true })).data).toEqual(
          [],
        );
        expect(
          (await inboxOf(db, context, visible, { ...query, unreadOnly: false })).data,
        ).toHaveLength(1);
      }
      const anchor = all.data[0];
      if (anchor === undefined) throw new Error('missing the anchor');
      expect(
        (
          await inboxOf(db, context, visible, {
            workspaceId: room.workspaceId,
            before: anchor.id,
            types: 'thread_reply',
            unreadOnly: false,
          })
        ).data.map((row) => row.type),
      ).toEqual(['thread_reply']);
      expect(
        (
          await inboxOf(db, context, visible, {
            workspaceId: room.workspaceId,
            before: anchor.id,
            types: 'thread_reply',
            unreadOnly: true,
          })
        ).data,
      ).toEqual([]);
    });
  });

  test('filtering never widens current channel visibility, deleted targets, recipient or workspace scope', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol'], { type: 'private' });
      const bob = member(room, 'bob').userId;
      expect(
        (
          await refusalOf(
            inbox(db, room, bob, {
              types: 'mention',
              before: '00000000-0000-4000-8000-000000000000',
            }),
          )
        ).body.code,
      ).toBe('VALIDATION_FAILED');
      await typedHistory(db, room, ['thread_reply', 'thread_reply']);
      expect(
        (await inbox(db, room, member(room, 'carol').userId, { types: 'thread_reply' })).ids,
      ).toEqual([]);
      const first = await inbox(db, room, bob, { types: 'thread_reply' });
      const target = await db
        .selectFrom('notifications')
        .select('message_id')
        .where('id', '=', first.ids[0] ?? '')
        .executeTakeFirstOrThrow();
      await db
        .updateTable('messages')
        .set({ deleted_at: NOW })
        .where('id', '=', target.message_id)
        .execute();
      expect((await inbox(db, room, bob, { types: 'thread_reply' })).ids).toHaveLength(1);
      // A retained notification whose message was deleted remains a valid ordering anchor.
      expect(
        (await inbox(db, room, bob, { types: 'thread_reply', before: first.ids[0] ?? '' })).ids,
      ).toHaveLength(1);
      const other = await aRoom(db, ['alice']);
      await alsoIn(db, other, bob);
      const sent = await post(
        db,
        other,
        'alice',
        `@${member(room, 'bob').username} another workspace`,
      );
      await db
        .updateTable('notifications')
        .set({ type: 'thread_reply' })
        .where('message_id', '=', sent.message.id)
        .where('user_id', '=', bob)
        .execute();
      const foreign = await inbox(db, other, bob, { types: 'thread_reply' });
      expect(foreign.ids).toHaveLength(1);
      expect(
        (
          await refusalOf(
            inbox(db, room, bob, { types: 'thread_reply', before: foreign.ids[0] ?? '' }),
          )
        ).body.code,
      ).toBe('VALIDATION_FAILED');
      expect(
        (
          await refusalOf(
            inbox(db, room, member(room, 'carol').userId, {
              types: 'thread_reply',
              before: first.ids[0] ?? '',
            }),
          )
        ).body.code,
      ).toBe('VALIDATION_FAILED');
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', bob)
        .execute();
      expect((await inbox(db, room, bob, { types: 'thread_reply' })).ids).toEqual([]);
    });
  });

  test('filtered pages keep a bounded query count instead of hydrating each candidate separately', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = member(room, 'bob').userId;
      await typedHistory(db, room, ['thread_reply']);
      const context = await requireWorkspaceMembership(db, bob, room.workspaceId);
      const visible = await visibleChannelIds(db, context);
      const small = counting(db);
      await inboxOf(small.db, context, visible, {
        workspaceId: room.workspaceId,
        types: 'thread_reply',
      });
      await typedHistory(db, room, ['mention', 'thread_reply', 'thread_resolved', 'thread_reply']);
      const larger = counting(db);
      await inboxOf(larger.db, context, visible, {
        workspaceId: room.workspaceId,
        types: 'thread_reply,thread_resolved',
      });
      expect(larger.count()).toBe(small.count());
      expect(larger.count()).toBeGreaterThan(0);
    });
  });
});
