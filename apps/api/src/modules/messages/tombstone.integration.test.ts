/**
 * Removing many messages of a channel at once takes back exactly what removing them one by one
 * would (D-139 §2): the retention purge and content erasure lean on that, and the delete's own tests
 * see only one message at a time. The room: a reader who has read the first, a member who joined
 * after it, the person a message named, and the author, whose own messages were never counted.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { markRead } from '../channels/read-state';
import { aRoom, counters, type Room } from '../../testing/rooms';
import { sendMessage } from './messages';
import { takeBack, tombstoneRows, type Counted } from './tombstone';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const LATER = new Date('2026-09-09T12:05:00.000Z');
const clock = fixedClock(NOW);

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};

/** Three messages from ada, the second naming bob; bob has read the first; cy joined after it. */
const scene = async (db: Transaction): Promise<{ room: Room; sent: Counted[] }> => {
  const room = await aRoom(db, ['ada', 'bob', 'cy']);
  const sent: Counted[] = [];
  for (const [n, content] of ['first', `for @${member(room, 'bob').username}`, 'third'].entries()) {
    const at = new Date(NOW.getTime() + (n + 1) * 1000);
    const result = await sendMessage(db, fixedClock(at), member(room, 'ada').context, {
      id: messageId(at),
      content,
    });
    sent.push({
      id: result.message.id,
      senderId: member(room, 'ada').userId,
      createdAt: new Date(result.message.createdAt),
    });
    if (n === 0) {
      // cy arrives after the first: it was counted for cy at the send, but a late join is what the
      // rule must tell apart, so the join moves past it and the count with it.
      await db
        .updateTable('channel_members')
        .set({ joined_at: new Date(at.getTime() + 500), unread_count: 0 })
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', member(room, 'cy').userId)
        .execute();
    }
  }
  const first = sent[0];
  if (first === undefined) throw new Error('nothing sent');
  await markRead(db, clock, member(room, 'bob').context, first.id);
  return { room, sent };
};

const everyone = async (
  db: Transaction,
  room: Room,
): Promise<Record<string, { unread: number; mentions: number }>> => {
  const out: Record<string, { unread: number; mentions: number }> = {};
  for (const name of ['ada', 'bob', 'cy']) {
    const { unread, mentions } = await counters(db, room, member(room, name).userId);
    out[name] = { unread, mentions };
  }
  return out;
};

describe('integration: taking back many messages at once', () => {
  test('is what taking them back one by one gives, and leaves nothing counted or waiting', async () => {
    type Counters = Awaited<ReturnType<typeof everyone>>;
    let together: Counters = {};
    let oneByOne: Counters = {};
    await withRollback(async (db) => {
      const { room, sent } = await scene(db);
      expect(await everyone(db, room)).toEqual({
        ada: { unread: 0, mentions: 0 },
        bob: { unread: 2, mentions: 1 },
        cy: { unread: 2, mentions: 0 },
      });
      await takeBack(db, LATER, room.channelId, sent);
      const waiting = await db
        .selectFrom('notifications')
        .select('id')
        .where(
          'message_id',
          'in',
          sent.map((message) => message.id),
        )
        .where('read_at', 'is', null)
        .execute();
      expect(waiting).toEqual([]);
      together = await everyone(db, room);
    });
    await withRollback(async (db) => {
      const { room, sent } = await scene(db);
      for (const message of sent) await takeBack(db, LATER, room.channelId, [message]);
      oneByOne = await everyone(db, room);
    });
    expect(together).toEqual({
      ada: { unread: 0, mentions: 0 },
      bob: { unread: 0, mentions: 0 },
      cy: { unread: 0, mentions: 0 },
    });
    expect(oneByOne).toEqual(together);
  });

  test('tombstones only what is live, and takes its mentions, pin and history with it', async () => {
    await withRollback(async (db) => {
      const { room, sent } = await scene(db);
      const ids = sent.map((message) => message.id);
      const [first] = ids;
      if (first === undefined) throw new Error('nothing sent');
      await db
        .insertInto('pinned_messages')
        .values({
          message_id: first,
          channel_id: room.channelId,
          workspace_id: room.workspaceId,
          pinned_by: member(room, 'ada').userId,
          pinned_at: NOW,
        })
        .execute();
      expect((await tombstoneRows(db, LATER, ids)).map((row) => row.id).sort()).toEqual(
        [...ids].sort(),
      );
      // Again: nothing is live, so nothing changes and nothing is said.
      expect(await tombstoneRows(db, LATER, ids)).toEqual([]);
      const rows = await db
        .selectFrom('messages')
        .select(['content', 'deleted_at'])
        .where('id', 'in', ids)
        .execute();
      expect(rows.every((row) => row.content === '' && row.deleted_at !== null)).toBe(true);
      for (const table of ['mentions', 'pinned_messages', 'message_versions'] as const) {
        expect(
          await db.selectFrom(table).select('message_id').where('message_id', 'in', ids).execute(),
        ).toEqual([]);
      }
    });
  });
});
