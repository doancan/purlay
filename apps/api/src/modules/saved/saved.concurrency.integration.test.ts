/**
 * The bound on saved messages (D-128) under two saves at once: one below the bound, two people's
 * worth of saving at the same instant cannot both be the last. The first holds the person's
 * membership row; the second waits for it, then counts what the first wrote.
 *
 * Deterministic: the first save is held open until the second is seen waiting on a lock. Without
 * the lock the second would count before the first committed, and both would be taken.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  type ClonedDatabase,
  CLONE_HOOK_MS,
} from '@purlay/db';
import { messageId, SAVED_MAX } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { aRoom } from '../../testing/rooms';
import { saveMessage } from './saved';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
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

describe('integration: two saves at the bound at once', () => {
  test('one is taken, the other refused', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice']);
    const alice = room.members['alice']?.userId ?? '';
    const message = (n: number): string => messageId(new Date(NOW.getTime() - 3_600_000 + n));
    const kept = Array.from({ length: SAVED_MAX - 1 }, (_, n) => message(n));
    const [first, second] = [message(SAVED_MAX), message(SAVED_MAX + 1)];
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
      .insertInto('saved_messages')
      .values(
        kept.map((id) => ({
          id: Bun.randomUUIDv7(),
          user_id: alice,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          message_id: id,
        })),
      )
      .execute();

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saved: () => void = () => undefined;
    const firstSaved = new Promise<void>((resolve) => {
      saved = resolve;
    });
    const firstDone = db.transaction().execute(async (transaction) => {
      await saveMessage(transaction, clock, alice, first, {});
      saved();
      await held;
    });
    await firstSaved;
    const secondDone = db
      .transaction()
      .execute(async (transaction) => await saveMessage(transaction, clock, alice, second, {}))
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
    expect(await secondDone).toBe('SAVED_LIMIT');
  });
});
