/**
 * Identity resolution, against a real database.
 *
 * D-38 exists because the obvious implementation fails on the first sign-in by
 * somebody who has not made an email address public. Each collision it names is
 * a test here, because "we thought about it" and "it does that" are different
 * claims.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { GitHubEmail, GitHubProfile } from './github';
import { resolveIdentity } from './identity';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

const account = (overrides: Partial<GitHubProfile> = {}): GitHubProfile => ({
  id: 4001,
  login: 'octocat',
  name: 'Mona Lisa',
  avatarUrl: 'https://avatars.test/octocat.png',
  ...overrides,
});

const verified = (address: string): readonly GitHubEmail[] => [
  { email: address, primary: true, verified: true },
];

const refusalFrom = async (body: () => Promise<unknown>): Promise<AppError> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('identity resolved where it was required to refuse');
};

describe('integration: GitHub identity', () => {
  test('a first sign-in creates the account', async () => {
    await withRollback(async (db) => {
      const { userId } = await resolveIdentity(db, clock, account(), verified('mona@example.test'));
      const row = await db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();

      expect(row.github_id).toBe('4001');
      expect(row.email).toBe('mona@example.test');
      expect(row.username).toBe('octocat');
      expect(row.display_name).toBe('Mona Lisa');
    });
  });

  test('signing in again returns the same account and refreshes what is display-only', async () => {
    await withRollback(async (db) => {
      const first = await resolveIdentity(db, clock, account(), verified('mona@example.test'));
      const second = await resolveIdentity(
        db,
        clock,
        account({ login: 'monalisa', name: 'Mona' }),
        verified('mona@example.test'),
      );

      expect(second.userId).toBe(first.userId);
      const row = await db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', first.userId)
        .executeTakeFirstOrThrow();
      expect(row.username).toBe('monalisa');
      expect(row.display_name).toBe('Mona');
    });
  });

  /**
   * The address is the identity anchor and `NOT NULL`. GitHub omits it from the
   * profile for anyone who has not made one public, which is common among the
   * developers this product is for — so this is the *likely* path, not the edge.
   */
  test('no primary verified address is refused with a message that says what to fix', async () => {
    await withRollback(async (db) => {
      const noneAtAll = await refusalFrom(() => resolveIdentity(db, clock, account(), []));
      expect(noneAtAll.body.code).toBe('EMAIL_REQUIRED');
      expect(noneAtAll.body.message).toContain('verify');

      const unverified = await refusalFrom(() =>
        resolveIdentity(db, clock, account(), [
          { email: 'mona@example.test', primary: true, verified: false },
        ]),
      );
      expect(unverified.body.code).toBe('EMAIL_REQUIRED');

      const notPrimary = await refusalFrom(() =>
        resolveIdentity(db, clock, account(), [
          { email: 'other@example.test', primary: false, verified: true },
        ]),
      );
      expect(notPrimary.body.code).toBe('EMAIL_REQUIRED');
    });
  });

  test('the primary verified address is chosen out of several', async () => {
    await withRollback(async (db) => {
      const { userId } = await resolveIdentity(db, clock, account(), [
        { email: 'old@example.test', primary: false, verified: true },
        { email: 'unverified@example.test', primary: true, verified: false },
        { email: 'MONA@Example.test', primary: true, verified: true },
      ]);
      const row = await db
        .selectFrom('users')
        .select('email')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      // Lowercased at the boundary, so one address cannot become two accounts (D-40).
      expect(row.email).toBe('mona@example.test');
    });
  });

  /**
   * "Same email, therefore the same person" is a classic account-takeover
   * surface. Never linked silently (D-5, D-38).
   */
  test('a second GitHub account with the same address is refused, never linked', async () => {
    await withRollback(async (db) => {
      const first = await resolveIdentity(db, clock, account(), verified('shared@example.test'));

      const refusal = await refusalFrom(() =>
        resolveIdentity(
          db,
          clock,
          account({ id: 9002, login: 'impostor' }),
          verified('shared@example.test'),
        ),
      );
      expect(refusal.body.code).toBe('ACCOUNT_EMAIL_CONFLICT');
      expect(refusal.status).toBe(409);

      // And the original account is untouched — not relinked, not renamed.
      const rows = await db
        .selectFrom('users')
        .selectAll()
        .where('email', '=', 'shared@example.test')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(first.userId);
      expect(rows[0]?.github_id).toBe('4001');
    });
  });

  /**
   * GitHub lets an account be renamed and the freed name be taken by someone
   * else, so a refresh can collide with a live row. Identity is `github_id`;
   * `username` is display-only, so the incoming user takes a suffix (D-38).
   */
  test('a username taken by somebody else gets a suffix, and the collision is reported', async () => {
    await withRollback(async (db) => {
      await resolveIdentity(
        db,
        clock,
        account({ id: 1, login: 'taken' }),
        verified('one@example.test'),
      );

      const second = await resolveIdentity(
        db,
        clock,
        account({ id: 2, login: 'taken' }),
        verified('two@example.test'),
      );

      const row = await db
        .selectFrom('users')
        .select('username')
        .where('id', '=', second.userId)
        .executeTakeFirstOrThrow();
      expect(row.username).toBe('taken-1');
      expect(second.usernameCollision).toEqual({ wanted: 'taken', stored: 'taken-1' });
    });
  });

  test('keeping your own username across a sign-in is not a collision', async () => {
    await withRollback(async (db) => {
      const first = await resolveIdentity(db, clock, account(), verified('mona@example.test'));
      const again = await resolveIdentity(db, clock, account(), verified('mona@example.test'));
      expect(again.userId).toBe(first.userId);
      expect(again.usernameCollision).toBeUndefined();
    });
  });

  /**
   * `users.username` is VARCHAR(39), GitHub's own limit, so a login that fills it
   * cannot take a `-1` suffix without overflowing — and a login one longer than
   * the limit must not be able to fail a sign-in either. Both raised 22001 and the
   * person was told the server broke (#233).
   */
  describe('a login at the edge of the column', () => {
    const THIRTY_NINE = 'a'.repeat(39);

    test('a 39-character login that is taken is shortened to fit its suffix', async () => {
      await withRollback(async (db) => {
        await resolveIdentity(
          db,
          clock,
          account({ id: 1, login: THIRTY_NINE }),
          verified('one@example.test'),
        );
        const second = await resolveIdentity(
          db,
          clock,
          account({ id: 2, login: THIRTY_NINE }),
          verified('two@example.test'),
        );

        const row = await db
          .selectFrom('users')
          .select('username')
          .where('id', '=', second.userId)
          .executeTakeFirstOrThrow();
        expect(row.username).toBe(`${'a'.repeat(37)}-1`);
        expect(row.username).toHaveLength(39);
        expect(second.usernameCollision).toEqual({ wanted: THIRTY_NINE, stored: row.username });
      });
    });

    test('a 40-character login is truncated, never refused', async () => {
      await withRollback(async (db) => {
        const { userId } = await resolveIdentity(
          db,
          clock,
          account({ id: 3, login: 'b'.repeat(40) }),
          verified('long@example.test'),
        );
        const row = await db
          .selectFrom('users')
          .select('username')
          .where('id', '=', userId)
          .executeTakeFirstOrThrow();
        expect(row.username).toBe('b'.repeat(39));
      });
    });

    test('truncating onto a name that is taken still ends in a free one', async () => {
      await withRollback(async (db) => {
        await resolveIdentity(
          db,
          clock,
          account({ id: 4, login: 'c'.repeat(39) }),
          verified('c1@example.test'),
        );
        const { userId } = await resolveIdentity(
          db,
          clock,
          account({ id: 5, login: 'c'.repeat(40) }),
          verified('c2@example.test'),
        );
        const row = await db
          .selectFrom('users')
          .select('username')
          .where('id', '=', userId)
          .executeTakeFirstOrThrow();
        expect(row.username).toBe(`${'c'.repeat(37)}-1`);
      });
    });

    test('a refresh of an account whose login is 40 characters is not refused either', async () => {
      await withRollback(async (db) => {
        const profile = account({ id: 6, login: 'd'.repeat(40) });
        const first = await resolveIdentity(db, clock, profile, verified('d@example.test'));
        const again = await resolveIdentity(db, clock, profile, verified('d@example.test'));
        expect(again.userId).toBe(first.userId);
      });
    });
  });

  test('a display name longer than the column is cut to fit, not refused', async () => {
    await withRollback(async (db) => {
      const { userId } = await resolveIdentity(
        db,
        clock,
        account({ id: 7, login: 'wordy', name: 'n'.repeat(300) }),
        verified('wordy@example.test'),
      );
      const row = await db
        .selectFrom('users')
        .select('display_name')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(row.display_name).toBe('n'.repeat(128));
    });
  });

  /** GitHub controls this string; PostgreSQL cannot store a NUL, and sign-in never fails on a name. */
  test('a display name with control characters is cleaned, not refused', async () => {
    await withRollback(async (db) => {
      const { userId } = await resolveIdentity(
        db,
        clock,
        account({ id: 8, login: 'nulled', name: 'Mo\u0000na \u202EgnoL\u0007 \uD800ok' }),
        verified('nulled@example.test'),
      );
      const row = await db
        .selectFrom('users')
        .select('display_name')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(row.display_name).toBe('Mona gnoL ok');
    });
  });

  test('a name that is nothing but controls falls back to the login', async () => {
    await withRollback(async (db) => {
      const { userId } = await resolveIdentity(
        db,
        clock,
        account({ id: 9, login: 'blank', name: '\u0000\u0001' }),
        verified('blank@example.test'),
      );
      const row = await db
        .selectFrom('users')
        .select('display_name')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(row.display_name).toBe('blank');
    });
  });
});
