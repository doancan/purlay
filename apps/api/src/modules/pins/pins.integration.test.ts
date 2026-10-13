/**
 * A channel's pins against the real database (#485, D-130): a member pins and lets go, a visible
 * non-member is refused, a change says whether it was one, the bound counts what is shown, and the
 * list is the channel's, newest first, with who pinned each.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import { messageId, PINS_MAX } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { aRoom, type Room } from '../../testing/rooms';
import { channelPins, pinMessage, unpinMessage } from './pins';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
let tick = 0;
const anId = (): string => messageId(new Date(NOW.getTime() - 3_600_000 + (tick += 1)));
/** A clock at `seconds` past NOW: pins made later sort first. */
const at = (seconds: number): ReturnType<typeof fixedClock> =>
  fixedClock(new Date(NOW.getTime() + seconds * 1000));

const idOf = (room: Room, name: string): string => room.members[name]?.userId ?? '';

const said = async (db: Executor, room: Room, by = 'alice'): Promise<string> => {
  const id = anId();
  await db
    .insertInto('messages')
    .values({
      id,
      workspace_id: room.workspaceId,
      channel_id: room.channelId,
      sender_id: idOf(room, by),
      content: 'worth keeping',
    })
    .execute();
  return id;
};

const codeOf = async (attempt: Promise<unknown>): Promise<string> =>
  await attempt.then(
    () => 'taken',
    (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
  );

/** One attempt in a savepoint: a refused one must not end the test's transaction. */
const attempt = async (db: Executor, run: () => Promise<unknown>): Promise<string> => {
  await sql`savepoint attempt`.execute(db);
  const code = await codeOf(run());
  await sql`${sql.raw(code === 'taken' ? 'release' : 'rollback to')} savepoint attempt`.execute(db);
  return code;
};

const contextOf = (room: Room, name: string): NonNullable<Room['members'][string]>['context'] => {
  const context = room.members[name]?.context;
  if (context === undefined) throw new Error(`no ${name}`);
  return context;
};

describe('integration: pinning', () => {
  test('a member pins, and pinning again changes nothing; letting go, and again', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const message = await said(db, room);

      expect(await pinMessage(db, at(0), idOf(room, 'bob'), message)).toEqual({
        channelId: room.channelId,
        changed: true,
      });
      expect(await pinMessage(db, at(5), idOf(room, 'alice'), message)).toEqual({
        channelId: room.channelId,
        changed: false,
      });
      const [pin] = await channelPins(db, contextOf(room, 'alice'));
      // Pinned again, it is left as it was: by whom, and when.
      expect(pin?.pinnedBy?.id).toBe(idOf(room, 'bob'));
      expect(pin?.pinnedAt).toBe(NOW.toISOString());

      expect(await unpinMessage(db, idOf(room, 'alice'), message)).toEqual({
        channelId: room.channelId,
        changed: true,
      });
      expect(await unpinMessage(db, idOf(room, 'alice'), message)).toEqual({
        channelId: room.channelId,
        changed: false,
      });
      expect(await channelPins(db, contextOf(room, 'alice'))).toEqual([]);
    });
  });

  test('a workspace member who can see the channel but is not in it is refused, both ways', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['carol'] });
      const carol = room.outsiders['carol']?.userId ?? '';
      const message = await said(db, room);
      await pinMessage(db, at(0), idOf(room, 'alice'), message);

      expect(await attempt(db, () => pinMessage(db, at(0), carol, anId()))).toBe(
        'MESSAGE_NOT_FOUND',
      );
      expect(await attempt(db, () => pinMessage(db, at(0), carol, message))).toBe('FORBIDDEN');
      expect(await attempt(db, () => unpinMessage(db, carol, message))).toBe('FORBIDDEN');
      // Refused, nothing moved.
      expect((await channelPins(db, contextOf(room, 'alice'))).map((p) => p.message.id)).toEqual([
        message,
      ]);
    });
  });

  test('a message deleted as it was pinned: it cannot be pinned again, its pin is not listed, and it can be let go', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const kept = await said(db, room);
      const gone = await said(db, room);
      await pinMessage(db, at(0), idOf(room, 'alice'), gone);
      await pinMessage(db, at(1), idOf(room, 'alice'), kept);
      await db.updateTable('messages').set({ deleted_at: NOW }).where('id', '=', gone).execute();

      expect((await channelPins(db, contextOf(room, 'alice'))).map((p) => p.message.id)).toEqual([
        kept,
      ]);
      expect(await attempt(db, () => pinMessage(db, at(2), idOf(room, 'alice'), gone))).toBe(
        'MESSAGE_NOT_FOUND',
      );
      expect(await unpinMessage(db, idOf(room, 'alice'), gone)).toEqual({
        channelId: room.channelId,
        changed: true,
      });
    });
  });

  test('the list is newest pin first, with the message as read and who pinned it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const older = await said(db, room, 'bob');
      const newer = await said(db, room);
      await pinMessage(db, at(10), idOf(room, 'alice'), older);
      await pinMessage(db, at(0), idOf(room, 'bob'), newer);

      const pins = await channelPins(db, contextOf(room, 'bob'));

      expect(pins.map((p) => [p.message.id, p.pinnedBy?.id, p.pinnedAt])).toEqual([
        [older, idOf(room, 'alice'), new Date(NOW.getTime() + 10_000).toISOString()],
        [newer, idOf(room, 'bob'), NOW.toISOString()],
      ]);
      expect(pins[0]?.message.sender.id).toBe(idOf(room, 'bob'));
      expect(pins[0]?.message.content).toBe('worth keeping');
    });
  });

  test('a pin outlives the account of whoever made it, said as nobody', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const message = await said(db, room);
      await pinMessage(db, at(0), idOf(room, 'bob'), message);
      await db
        .updateTable('pinned_messages')
        .set({ pinned_by: null })
        .where('message_id', '=', message)
        .execute();

      const [pin] = await channelPins(db, contextOf(room, 'alice'));
      expect(pin?.message.id).toBe(message);
      expect(pin?.pinnedBy).toBeNull();
    });
  });

  test('in an archived channel there is nothing to pin or let go', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const message = await said(db, room);
      await pinMessage(db, at(0), idOf(room, 'alice'), message);
      await db
        .updateTable('channels')
        .set({ deleted_at: NOW })
        .where('id', '=', room.channelId)
        .execute();
      expect(await attempt(db, () => unpinMessage(db, idOf(room, 'alice'), message))).toBe(
        'MESSAGE_NOT_FOUND',
      );
      expect(await attempt(db, () => pinMessage(db, at(1), idOf(room, 'alice'), message))).toBe(
        'MESSAGE_NOT_FOUND',
      );
    });
  });

  test('a conversation has pins, and a reply can be one, with its thread’s root', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
      const root = await said(db, room);
      const reply = anId();
      await db
        .insertInto('messages')
        .values({
          id: reply,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: idOf(room, 'bob'),
          content: 'the answer',
          parent_id: root,
        })
        .execute();
      await pinMessage(db, at(0), idOf(room, 'bob'), reply);
      const [pin] = await channelPins(db, contextOf(room, 'alice'));
      expect([pin?.message.id, pin?.message.parentId]).toEqual([reply, root]);
    });
  });

  test('another channel’s pins are not this one’s', async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice']);
      const there = await aRoom(db, ['bob']);
      await pinMessage(db, at(0), idOf(there, 'bob'), await said(db, there, 'bob'));
      expect(await channelPins(db, contextOf(here, 'alice'))).toEqual([]);
    });
  });
});

describe('integration: at most PINS_MAX a channel', () => {
  const pinned = async (db: Executor, room: Room, count: number): Promise<string[]> => {
    const ids = Array.from({ length: count }, () => anId());
    await db
      .insertInto('messages')
      .values(
        ids.map((id) => ({
          id,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: idOf(room, 'alice'),
          content: 'kept',
        })),
      )
      .execute();
    await db
      .insertInto('pinned_messages')
      .values(
        ids.map((id) => ({
          message_id: id,
          channel_id: room.channelId,
          workspace_id: room.workspaceId,
          pinned_by: idOf(room, 'alice'),
        })),
      )
      .execute();
    return ids;
  };

  test('another channel at the bound does not take this one’s places', async () => {
    await withRollback(async (db) => {
      const full = await aRoom(db, ['alice']);
      await pinned(db, full, PINS_MAX);
      const here = await aRoom(db, ['alice']);
      const message = await said(db, here);
      expect(await attempt(db, () => pinMessage(db, at(0), idOf(here, 'alice'), message))).toBe(
        'taken',
      );
    });
  });

  test('one below the bound is taken; at it, refused; a deleted message’s pin does not count', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const ids = await pinned(db, room, PINS_MAX - 1);
      const last = await said(db, room);
      const past = await said(db, room);

      expect(await attempt(db, () => pinMessage(db, at(0), idOf(room, 'alice'), last))).toBe(
        'taken',
      );
      expect(await attempt(db, () => pinMessage(db, at(0), idOf(room, 'alice'), past))).toBe(
        'PINS_LIMIT',
      );
      // Pinning what is pinned is never refused, at the bound or past it.
      expect(await attempt(db, () => pinMessage(db, at(0), idOf(room, 'alice'), last))).toBe(
        'taken',
      );

      await db
        .updateTable('messages')
        .set({ deleted_at: NOW })
        .where('id', '=', ids[0] ?? '')
        .execute();
      expect(await attempt(db, () => pinMessage(db, at(0), idOf(room, 'alice'), past))).toBe(
        'taken',
      );
      expect(await channelPins(db, contextOf(room, 'alice'))).toHaveLength(PINS_MAX);
    });
  });
});
