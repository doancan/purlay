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
import { messageId, type ReadNotificationsRequest } from '@purlay/types';
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

const inbox = async (
  db: Executor,
  room: Room,
  userId: string,
  extra: { unreadOnly?: boolean; before?: string; limit?: number } = {},
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
