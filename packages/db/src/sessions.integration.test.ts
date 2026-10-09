/**
 * The session purge: bounded, and never a live session.
 *
 * Inside a transaction that is rolled back (D-46).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { purgeDeadSessions } from './sessions';
import { closeIntegrationDatabase, withRollback } from './testing';
import type { Executor } from './client';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const addUser = async (db: Executor): Promise<string> =>
  (
    await db
      .insertInto('users')
      .values({ email: 'purge@example.test', username: 'purge', display_name: 'Purge' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;

const addSession = async (
  db: Executor,
  userId: string,
  label: string,
  expiresInHours: number,
  revoked: boolean,
): Promise<void> => {
  await db
    .insertInto('sessions')
    .values({
      user_id: userId,
      token_hash: label,
      expires_at: new Date(NOW.getTime() + expiresInHours * HOUR),
      revoked_at: revoked ? new Date(NOW.getTime() - HOUR) : null,
    })
    .execute();
};

const remaining = async (db: Executor, userId: string): Promise<string[]> =>
  (
    await db
      .selectFrom('sessions')
      .select('token_hash')
      .where('user_id', '=', userId)
      .orderBy('token_hash')
      .execute()
  ).map((row) => row.token_hash);

describe('integration: purging dead sessions', () => {
  test('removes expired and revoked sessions and keeps the live ones', async () => {
    await withRollback(async (db) => {
      const user = await addUser(db);
      await addSession(db, user, 'live', 24, false);
      await addSession(db, user, 'expired', -1, false);
      await addSession(db, user, 'revoked', 24, true);
      await addSession(db, user, 'both', -1, true);

      expect(await purgeDeadSessions(db, NOW, 100)).toBe(3);
      expect(await remaining(db, user)).toEqual(['live']);
      expect(await purgeDeadSessions(db, NOW, 100)).toBe(0);
    });
  });

  test('a session that expires exactly now is dead; one that expires a moment later is not', async () => {
    await withRollback(async (db) => {
      const user = await addUser(db);
      await db
        .insertInto('sessions')
        .values([
          { user_id: user, token_hash: 'edge', expires_at: NOW },
          { user_id: user, token_hash: 'after', expires_at: new Date(NOW.getTime() + 1) },
        ])
        .execute();
      expect(await purgeDeadSessions(db, NOW, 100)).toBe(1);
      expect(await remaining(db, user)).toEqual(['after']);
    });
  });

  test('one call removes at most the batch it was given, so a backlog is worked through in turns', async () => {
    await withRollback(async (db) => {
      const user = await addUser(db);
      for (let n = 0; n < 7; n += 1)
        await addSession(db, user, `dead-${String(n)}`, -1, n % 2 === 0);
      await addSession(db, user, 'live', 24, false);

      const removed: number[] = [];
      for (let turn = 0; turn < 10; turn += 1) {
        const count = await purgeDeadSessions(db, NOW, 3);
        removed.push(count);
        if (count === 0) break;
      }
      expect(removed).toEqual([3, 3, 1, 0]);
      expect(await remaining(db, user)).toEqual(['live']);
    });
  });

  test('refuses a batch that is not a positive whole number', async () => {
    await withRollback(async (db) => {
      for (const batch of [0, 1.5, -3]) {
        const outcome = await purgeDeadSessions(db, NOW, batch).then(
          () => 'accepted',
          (error: unknown) => String(error),
        );
        expect(outcome).toContain('batch must be a positive whole number');
      }
    });
  });
});
