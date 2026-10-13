/**
 * Saved messages (#484, D-128) against real SQL: saved, moved, let go; shown only where the person
 * can read; bounded, and saving again never refused; pages that survive a save removed; and the
 * person's own devices told, nobody else.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  withRollback,
  type Executor,
  type Transaction,
} from '@purlay/db';
import { messageId, SAVED_MAX, type SavedState } from '@purlay/types';
import { AppError } from '../../platform/errors';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aRoom, type Room } from '../../testing/rooms';
import { saveMessage, savedIds, savedPage, unsaveMessage } from './saved';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);

let written = 0;
/** A message in the room's channel, by its first person. */
const aMessageIn = async (db: Executor, room: Room): Promise<string> => {
  written += 1;
  const id = messageId(new Date(NOW.getTime() - 60_000 + written));
  const [first] = Object.values(room.members);
  await db
    .insertInto('messages')
    .values({
      id,
      workspace_id: room.workspaceId,
      channel_id: room.channelId,
      sender_id: first?.userId ?? '',
      content: `message ${String(written)}`,
    })
    .execute();
  return id;
};

const idOf = (room: Room, name: string): string => room.members[name]?.userId ?? '';

const save = async (
  db: Transaction,
  userId: string,
  id: string,
  state?: SavedState,
): Promise<string> =>
  await saveMessage(db, clock, userId, id, state === undefined ? {} : { state });

const listed = async (
  db: Executor,
  room: Room,
  name: string,
  state: SavedState = 'in_progress',
): Promise<string[]> => {
  const context = await requireWorkspaceMembership(db, idOf(room, name), room.workspaceId);
  return (await savedPage(db, context, { state })).data.map((item) => item.message.id);
};

const refusal = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
  throw new Error('expected a refusal, and the attempt succeeded');
};

describe('integration: saving a message', () => {
  test('is listed in progress, moved by state, and saving again keeps its state', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const first = await aMessageIn(db, room);
      await save(db, idOf(room, 'alice'), first);
      expect(await listed(db, room, 'alice')).toEqual([first]);
      // Bob's list is his own.
      expect(await listed(db, room, 'bob')).toEqual([]);
      await save(db, idOf(room, 'alice'), first, 'completed');
      expect(await listed(db, room, 'alice')).toEqual([]);
      expect(await listed(db, room, 'alice', 'completed')).toEqual([first]);
      await save(db, idOf(room, 'alice'), first);
      expect(await listed(db, room, 'alice', 'completed')).toEqual([first]);
      const context = await requireWorkspaceMembership(db, idOf(room, 'alice'), room.workspaceId);
      expect(await savedIds(db, context)).toEqual([
        { messageId: first, channelId: room.channelId, state: 'completed' },
      ]);
    });
  });

  test('let go is gone, and letting go twice is the same answer', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const first = await aMessageIn(db, room);
      await save(db, idOf(room, 'alice'), first);
      await unsaveMessage(db, idOf(room, 'alice'), first);
      await unsaveMessage(db, idOf(room, 'alice'), first);
      expect(await listed(db, room, 'alice')).toEqual([]);
    });
  });

  test('a deleted message cannot be saved; one saved and then deleted is not shown, and can be let go', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const kept = await aMessageIn(db, room);
      const gone = await aMessageIn(db, room);
      await save(db, idOf(room, 'alice'), kept);
      await db.updateTable('messages').set({ deleted_at: NOW }).where('id', '=', gone).execute();
      expect(await refusal(save(db, idOf(room, 'alice'), gone))).toBe('MESSAGE_NOT_FOUND');
      await db.updateTable('messages').set({ deleted_at: NOW }).where('id', '=', kept).execute();
      expect(await listed(db, room, 'alice')).toEqual([]);
      await unsaveMessage(db, idOf(room, 'alice'), kept);
      const rows = await db
        .selectFrom('saved_messages')
        .select('id')
        .where('message_id', '=', kept)
        .execute();
      expect(rows).toEqual([]);
    });
  });

  test('a channel the person left is not shown, and shown again when they are back in it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'private' });
      const first = await aMessageIn(db, room);
      await save(db, idOf(room, 'bob'), first);
      expect(await listed(db, room, 'bob')).toEqual([first]);
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', idOf(room, 'bob'))
        .execute();
      expect(await listed(db, room, 'bob')).toEqual([]);
      expect(await refusal(save(db, idOf(room, 'bob'), first))).toBe('MESSAGE_NOT_FOUND');
      await db
        .insertInto('channel_members')
        .values({ channel_id: room.channelId, user_id: idOf(room, 'bob') })
        .execute();
      expect(await listed(db, room, 'bob')).toEqual([first]);
    });
  });
});

describe('integration: the bound', () => {
  test(`a ${String(SAVED_MAX)}th save is taken, the next refused, and saving again never`, async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = idOf(room, 'alice');
      // One statement each: the messages, then the saves, up to one below the bound.
      const ids = Array.from({ length: SAVED_MAX - 1 }, (_, n) =>
        messageId(new Date(NOW.getTime() - 3_600_000 + n)),
      );
      await db
        .insertInto('messages')
        .values(
          ids.map((id) => ({
            id,
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            sender_id: alice,
            content: 'kept',
          })),
        )
        .execute();
      await db
        .insertInto('saved_messages')
        .values(
          ids.map((id) => ({
            id: Bun.randomUUIDv7(),
            user_id: alice,
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            message_id: id,
          })),
        )
        .execute();
      const last = await aMessageIn(db, room);
      await save(db, alice, last);
      const past = await aMessageIn(db, room);
      expect(await refusal(save(db, alice, past))).toBe('SAVED_LIMIT');
      await save(db, alice, last, 'archived');
    });
  });
});

describe('integration: pages', () => {
  test('newest saved first, and a cursor whose save was let go still goes on', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = idOf(room, 'alice');
      const made: string[] = [];
      for (let n = 0; n < 3; n += 1) {
        const id = await aMessageIn(db, room);
        // A second apart, so the saves' own ids are in the order they were made.
        await saveMessage(db, fixedClock(new Date(NOW.getTime() + n * 1000)), alice, id, {});
        made.push(id);
      }
      const context = await requireWorkspaceMembership(db, alice, room.workspaceId);
      const first = await savedPage(db, context, { state: 'in_progress', limit: 2 });
      expect(first.data.map((item) => item.message.id)).toEqual(made.slice(1).reverse());
      expect(first.nextCursor).not.toBeNull();
      await unsaveMessage(db, alice, made[1] ?? '');
      const second = await savedPage(db, context, {
        state: 'in_progress',
        limit: 2,
        before: first.nextCursor ?? '',
      });
      expect(second.data.map((item) => item.message.id)).toEqual(made.slice(0, 1));
      expect(second.nextCursor).toBeNull();
    });
  });
});
