/**
 * The bound on a channel's pins (D-130) under two pins at once: one below the bound, two members
 * pinning at the same instant cannot both be the last. The first holds the channel's row; the
 * second waits for it, then counts what the first wrote.
 *
 * Deterministic: the first pin is held open until the second is seen waiting on a lock. Without
 * the lock the second would count before the first committed, and both would be taken.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId, PINS_MAX } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { aRoom } from '../../testing/rooms';
import { pinMessage } from './pins';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
});

/** Whether a statement here is waiting on a lock, asked of the database until one is. */
const waitingOnALock = async (db: ClonedDatabase['db']): Promise<boolean> => {
  for (let look = 0; look < 500; look += 1) {
    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`.execute(db);
    if ((rows[0]?.count ?? 0) > 0) return true;
  }
  return false;
};

describe('integration: two pins at the bound at once', () => {
  test('one is taken, the other refused', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice', 'bob']);
    const alice = room.members['alice']?.userId ?? '';
    const bob = room.members['bob']?.userId ?? '';
    const message = (n: number): string => messageId(new Date(NOW.getTime() - 3_600_000 + n));
    const kept = Array.from({ length: PINS_MAX - 1 }, (_, n) => message(n));
    const [first, second] = [message(PINS_MAX), message(PINS_MAX + 1)];
    await db
      .insertInto('messages')
      .values(
        [...kept, first, second].map((id) => ({
          id,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: alice,
          content: 'kept',
        })),
      )
      .execute();
    await db
      .insertInto('pinned_messages')
      .values(
        kept.map((id) => ({
          message_id: id,
          channel_id: room.channelId,
          workspace_id: room.workspaceId,
          pinned_by: alice,
        })),
      )
      .execute();

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pinned: () => void = () => undefined;
    const firstPinned = new Promise<void>((resolve) => {
      pinned = resolve;
    });
    const firstDone = db.transaction().execute(async (transaction) => {
      await pinMessage(transaction, clock, alice, first);
      pinned();
      await held;
    });
    await firstPinned;
    const secondDone = db
      .transaction()
      .execute(async (transaction) => await pinMessage(transaction, clock, bob, second))
      .then(
        () => 'taken',
        (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
      );

    // The second is waiting on the first's lock. Asserted, not hoped for: a second that finished
    // first would have counted without it, and its refusal would prove nothing about the lock.
    const waited = await waitingOnALock(db);
    // Let go before asserting, so a failure here does not leave the first transaction open.
    release();
    expect(waited).toBe(true);
    await firstDone;
    expect(await secondDone).toBe('PINS_LIMIT');
  });

  test('the same message pinned by two members at once is pinned once, and neither is refused', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice', 'bob']);
    const alice = room.members['alice']?.userId ?? '';
    const bob = room.members['bob']?.userId ?? '';
    const message = messageId(NOW);
    await db
      .insertInto('messages')
      .values({
        id: message,
        workspace_id: room.workspaceId,
        channel_id: room.channelId,
        sender_id: alice,
        content: 'pin me',
      })
      .execute();

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pinned: () => void = () => undefined;
    const firstPinned = new Promise<void>((resolve) => {
      pinned = resolve;
    });
    const firstDone = db.transaction().execute(async (transaction) => {
      const change = await pinMessage(transaction, clock, alice, message);
      pinned();
      await held;
      return change.changed;
    });
    await firstPinned;
    const secondDone = db
      .transaction()
      .execute(async (transaction) => (await pinMessage(transaction, clock, bob, message)).changed);
    const waited = await waitingOnALock(db);
    // Let go before asserting, so a failure here does not leave the first transaction open.
    release();
    expect(waited).toBe(true);

    expect([await firstDone, await secondDone]).toEqual([true, false]);
    const rows = await db
      .selectFrom('pinned_messages')
      .select('pinned_by')
      .where('message_id', '=', message)
      .execute();
    expect(rows).toEqual([{ pinned_by: alice }]);
  });
});
