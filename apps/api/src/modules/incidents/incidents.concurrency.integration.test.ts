/**
 * A channel's incident under two at once (D-137 §5), on two real connections: two declarations racing
 * with different ids open one incident, the other told `INCIDENT_OPEN`; two changes at once are one
 * after the other, both on the timeline in the order they were made.
 *
 * Deterministic: the first is held open until the second is seen waiting on a lock. Without the open
 * index the second declaration would not wait, and both would be taken.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  type ClonedDatabase,
  type Transaction,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import type { ChannelContext } from '../../platform/channels';
import { AppError } from '../../platform/errors';
import { aRoom } from '../../testing/rooms';
import { changeIncident, declareIncident, incidentUpdates } from './incidents';

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

/** Runs `first` in a transaction held open, then `second`, which must wait for it; then lets go. */
const raced = async <T>(
  db: ClonedDatabase['db'],
  first: (transaction: Transaction) => Promise<unknown>,
  second: () => Promise<T>,
): Promise<{ readonly waited: boolean; readonly second: T }> => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => undefined;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const firstDone = db.transaction().execute(async (transaction) => {
    await first(transaction);
    started();
    await held;
  });
  await firstStarted;
  const secondDone = second();
  const waited = await waitingOnALock(db);
  // Let go before asserting, so a failure here does not leave the first transaction open.
  release();
  await firstDone;
  return { waited, second: await secondDone };
};

const contextOf = (room: Awaited<ReturnType<typeof aRoom>>, name: string): ChannelContext => {
  const context = room.members[name]?.context;
  if (context === undefined) throw new Error(`no ${name}`);
  return context;
};

describe('integration: two at once', () => {
  test('two declarations with different ids open one incident; the other is told one is open', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice', 'bob']);
    const [one, two] = [messageId(NOW), messageId(new Date(NOW.getTime() + 1))];
    const { waited, second } = await raced(
      db,
      (transaction) =>
        declareIncident(transaction, clock, contextOf(room, 'alice'), { id: one, severity: 1 }),
      () =>
        db
          .transaction()
          .execute(
            async (transaction) =>
              await declareIncident(transaction, clock, contextOf(room, 'bob'), {
                id: two,
                severity: 2,
              }),
          )
          .then(
            () => 'taken',
            (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
          ),
    );
    expect(waited).toBe(true);
    expect(second).toBe('INCIDENT_OPEN');
    const open = await db
      .selectFrom('incidents')
      .select('id')
      .where('channel_id', '=', room.channelId)
      .execute();
    expect(open).toEqual([{ id: one }]);
  });

  test('the same declaration twice at once — a retry racing its first attempt — is one incident, and both are answered it', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice']);
    const id = messageId(NOW);
    const declare = (transaction: Transaction): ReturnType<typeof declareIncident> =>
      declareIncident(transaction, clock, contextOf(room, 'alice'), { id, severity: 2 });
    const { waited, second } = await raced(db, declare, () => db.transaction().execute(declare));
    expect(waited).toBe(true);
    expect([second.changed, second.incident.id]).toEqual([false, id]);
  });

  test('one id declared in two channels at once: one is taken, the other a conflict, never a failure', async () => {
    const db = cloned.db;
    const here = await aRoom(db, ['alice']);
    const there = await aRoom(db, ['bob']);
    const id = messageId(NOW);
    const { waited, second } = await raced(
      db,
      (transaction) =>
        declareIncident(transaction, clock, contextOf(here, 'alice'), { id, severity: 2 }),
      () =>
        db
          .transaction()
          .execute(
            async (transaction) =>
              await declareIncident(transaction, clock, contextOf(there, 'bob'), {
                id,
                severity: 2,
              }),
          )
          .then(
            () => 'taken',
            (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
          ),
    );
    expect(waited).toBe(true);
    expect(second).toBe('INCIDENT_ID_CONFLICT');
  });

  test('two changes at once are one after the other, and both are on the timeline', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice', 'bob']);
    const id = messageId(NOW);
    await db.transaction().execute(async (transaction) => {
      await declareIncident(transaction, clock, contextOf(room, 'alice'), { id, severity: 3 });
    });
    const { waited, second } = await raced(
      db,
      (transaction) =>
        changeIncident(transaction, clock, contextOf(room, 'alice'), id, { status: 'mitigating' }),
      () =>
        db
          .transaction()
          .execute(
            async (transaction) =>
              await changeIncident(transaction, clock, contextOf(room, 'bob'), id, { severity: 1 }),
          ),
    );
    expect(waited).toBe(true);
    expect(second.incident).toMatchObject({ status: 'mitigating', severity: 1 });
    const timeline = await incidentUpdates(db, contextOf(room, 'alice'), id, {});
    expect(timeline.data.map((entry) => entry.change)).toEqual([
      { kind: 'severity', from: 3, to: 1 },
      { kind: 'status', from: 'investigating', to: 'mitigating' },
      { kind: 'declared', severity: 3 },
    ]);
  });
});
