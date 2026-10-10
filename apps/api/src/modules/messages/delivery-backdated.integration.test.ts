/**
 * A message whose id is older than a person's read position (D-99 §1, §4, review H-API 1).
 *
 * A client may send an id up to a minute in the past (`MESSAGE_ID_SKEW`), and an outbox
 * drained after a disconnect is exactly that: Bob has read past M, then Alice's queued
 * message arrives with an id that sorts *below* M. It is behind Bob's position — he has,
 * by every definition the read recount uses, already read past it — so counting it as
 * unread made the stored number disagree with a recount and left a badge that
 * `PUT /read` could not clear (`messageId <= current` is a no-op).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { markRead } from '../channels/read-state';
import { aRoom, counters, notificationsOf } from '../../testing/rooms';
import { sendMessage } from './messages';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const at = (offsetMs: number): string => messageId(new Date(NOW.getTime() + offsetMs));

describe('integration: a message behind the reader', () => {
  test('is not unread, does not need them, and is already read in their inbox', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      if (alice === undefined || bob === undefined) throw new Error('room');

      const newer = await sendMessage(db, clock, alice.context, { id: at(0), content: 'newer' });
      await markRead(db, clock, bob.context, newer.message.id);
      expect(await counters(db, room, bob.userId)).toMatchObject({ unread: 0, mentions: 0 });

      // Ten seconds *before* the message Bob has read, and naming him.
      const late = await sendMessage(db, clock, alice.context, {
        id: at(-10_000),
        content: `@${bob.username} you missed this one`,
      });

      expect(await counters(db, room, bob.userId)).toMatchObject({ unread: 0, mentions: 0 });
      const held = await notificationsOf(db, bob.userId);
      expect(held.map((n) => [n.messageId, n.type])).toEqual([[late.message.id, 'mention']]);
      const rows = await db
        .selectFrom('notifications')
        .select('read_at')
        .where('user_id', '=', bob.userId)
        .execute();
      expect(rows.every((row) => row.read_at !== null)).toBe(true);

      // And the recount agrees: reading to the same place again changes nothing.
      const again = await markRead(db, clock, bob.context, newer.message.id);
      expect(again.moved).toBe(false);
      expect(again.state).toMatchObject({ unreadCount: 0, unreadMentionCount: 0 });
      // What a later, further read recounts is what the stored number already said.
      const later = await sendMessage(db, clock, alice.context, {
        id: at(1_000),
        content: 'later',
      });
      expect(await counters(db, room, bob.userId)).toMatchObject({ unread: 1 });
      const read = await markRead(db, clock, bob.context, later.message.id);
      expect(read.state).toMatchObject({ unreadCount: 0, unreadMentionCount: 0 });
    });
  });

  test('a newer message still counts, and tells the recipients the numbers the row now holds', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      const carol = room.members['carol'];
      if (alice === undefined || bob === undefined || carol === undefined) throw new Error('room');

      const first = await sendMessage(db, clock, alice.context, { id: at(0), content: 'first' });
      await markRead(db, clock, bob.context, first.message.id);
      const second = await sendMessage(db, clock, alice.context, {
        id: at(5_000),
        content: `@${bob.username} newer`,
      });

      expect(await counters(db, room, bob.userId)).toMatchObject({ unread: 1, mentions: 1 });
      const told = second.recipients.find((r) => r.userId === bob.userId);
      expect(told?.state).toMatchObject({ unreadCount: 1, unreadMentionCount: 1 });
      // Carol never read anything: every message is unread for her, backdated or not.
      await sendMessage(db, clock, alice.context, { id: at(-20_000), content: 'oldest' });
      expect(await counters(db, room, carol.userId)).toMatchObject({ unread: 3 });
    });
  });

  test('a person who has not joined has no position, so the notification is unread', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['dave'] });
      const alice = room.members['alice'];
      const dave = room.outsiders['dave'];
      if (alice === undefined || dave === undefined) throw new Error('room');
      await sendMessage(db, clock, alice.context, {
        id: at(-5_000),
        content: `@${dave.username} look`,
      });
      const rows = await db
        .selectFrom('notifications')
        .select('read_at')
        .where('user_id', '=', dave.userId)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.read_at).toBeNull();
    });
  });
});
