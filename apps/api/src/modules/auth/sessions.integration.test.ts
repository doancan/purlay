/**
 * Sessions, against a real database.
 *
 * The central claim is that a database dump hands over no live session, so the
 * first test looks for the raw token in every column of the row it created. The
 * rest are the four ways a session must stop working, each asserted to produce
 * the *same* answer — nothing — because a caller able to tell them apart could
 * ask questions about accounts it does not own.
 *
 * Inside a transaction that is rolled back (D-46).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { issueSession, resolveSession, revokeAllSessions, revokeSession } from './sessions';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const later = (days: number): ReturnType<typeof fixedClock> =>
  fixedClock(new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000));

const addUser = async (db: Executor, name: string): Promise<string> => {
  const row = await db
    .insertInto('users')
    .values({ email: `${name}@example.test`, username: name, display_name: name })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};

describe('integration: sessions', () => {
  test('a fresh token resolves to its owner', async () => {
    await withRollback(async (db) => {
      const userId = await addUser(db, 'session-owner');
      const { token, expiresAt } = await issueSession(db, clock, userId, 30);

      expect(expiresAt.toISOString()).toBe('2026-10-09T12:00:00.000Z');
      expect(await resolveSession(db, clock, token)).toMatchObject({ userId });
    });
  });

  /**
   * The whole reason only a hash is stored. This looks at every value in the row
   * rather than at `token_hash` alone: a token that leaked into `user_agent`
   * would pass a narrower assertion.
   */
  test('the raw token appears nowhere in the database', async () => {
    await withRollback(async (db) => {
      const userId = await addUser(db, 'session-secret');
      const { token } = await issueSession(db, clock, userId, 30, {
        userAgent: 'probe/1.0',
        ipAddress: '10.0.0.1',
      });

      const row = await db
        .selectFrom('sessions')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();

      expect(JSON.stringify(row)).not.toContain(token);
      // And what is stored is the hash of it, at the right length.
      expect(row.token_hash).toHaveLength(64);
      expect(row.token_hash).not.toBe(token);
    });
  });

  test('two sessions never collide', async () => {
    await withRollback(async (db) => {
      const userId = await addUser(db, 'session-twice');
      const first = await issueSession(db, clock, userId, 30);
      const second = await issueSession(db, clock, userId, 30);
      expect(first.token).not.toBe(second.token);
      expect(first.token).toHaveLength(64);
    });
  });

  test('an expired session resolves to nothing', async () => {
    await withRollback(async (db) => {
      const userId = await addUser(db, 'session-expired');
      const { token } = await issueSession(db, clock, userId, 1);
      expect(await resolveSession(db, later(2), token)).toBeUndefined();
    });
  });

  test('a revoked session resolves to nothing, and the row survives as evidence', async () => {
    await withRollback(async (db) => {
      const userId = await addUser(db, 'session-revoked');
      const { token } = await issueSession(db, clock, userId, 30);
      await revokeSession(db, clock, token);

      expect(await resolveSession(db, clock, token)).toBeUndefined();
      const rows = await db
        .selectFrom('sessions')
        .selectAll()
        .where('user_id', '=', userId)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revoked_at).not.toBeNull();
    });
  });

  test('signing out everywhere revokes every live session and reports how many', async () => {
    await withRollback(async (db) => {
      const userId = await addUser(db, 'session-everywhere');
      const a = await issueSession(db, clock, userId, 30);
      const b = await issueSession(db, clock, userId, 30);
      await revokeSession(db, clock, a.token);

      // Only the still-live one is counted: revoking twice must not inflate it.
      expect(await revokeAllSessions(db, clock, userId)).toHaveLength(1);
      expect(await resolveSession(db, clock, b.token)).toBeUndefined();
    });
  });

  test("a deleted user's session stops working", async () => {
    await withRollback(async (db) => {
      const userId = await addUser(db, 'session-deleted');
      const { token } = await issueSession(db, clock, userId, 30);
      await db.updateTable('users').set({ deleted_at: NOW }).where('id', '=', userId).execute();

      expect(await resolveSession(db, clock, token)).toBeUndefined();
    });
  });

  test('an unknown token resolves to nothing rather than raising', async () => {
    await withRollback(async (db) => {
      expect(await resolveSession(db, clock, 'not-a-real-token')).toBeUndefined();
      expect(await resolveSession(db, clock, '')).toBeUndefined();
    });
  });

  /**
   * `last_used_at` is refreshed lazily. Writing it on every request would put an
   * `UPDATE` on the hottest path to maintain a column whose only consumer is a
   * device list nobody has built (D-60).
   */
  test('last_used_at is refreshed when stale, and left alone when fresh', async () => {
    await withRollback(async (db) => {
      const userId = await addUser(db, 'session-seen');
      const { token } = await issueSession(db, clock, userId, 30);
      const readBack = async (): Promise<Date> => {
        const row = await db
          .selectFrom('sessions')
          .select('last_used_at')
          .where('user_id', '=', userId)
          .executeTakeFirstOrThrow();
        return new Date(row.last_used_at);
      };
      const created = await readBack();

      const soon = fixedClock(new Date(NOW.getTime() + 60_000));
      await resolveSession(db, soon, token);
      expect((await readBack()).getTime()).toBe(created.getTime());

      const tomorrow = later(1);
      await resolveSession(db, tomorrow, token);
      expect((await readBack()).getTime()).toBe(tomorrow.now().getTime());
    });
  });
});
