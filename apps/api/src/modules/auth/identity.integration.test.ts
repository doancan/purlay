/**
 * What a GitHub sign-in writes into Purlay's own columns, against a real database (D-38, D-78,
 * D-179). The library decides whose account it is (`better-auth.integration.test.ts`,
 * `ingress/http/auth.integration.test.ts`); what is checked here is what is stored from what GitHub
 * said, because "we thought about it" and "it does that" are different claims: a name that is taken,
 * a login at the edge of its column, control characters, an account erased in the meantime.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { GitHubProfile } from './github';
import {
  availableUsername,
  cleanedProfile,
  recordGitHubSignIn,
  type ResolvedIdentity,
} from './identity';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

type Database = Parameters<Parameters<typeof withRollback>[0]>[0];

const account = (overrides: Partial<GitHubProfile> = {}): GitHubProfile => ({
  id: 4001,
  login: 'octocat',
  name: 'Mona Lisa',
  avatarUrl: 'https://avatars.test/octocat.png',
  ...overrides,
});

/**
 * A GitHub sign-in as the library leaves the database before it opens the session: the account made
 * if this GitHub id has none, with a name nobody would choose, then what the sign-in writes.
 */
const signedIn = async (db: Database, given: GitHubProfile): Promise<ResolvedIdentity> => {
  const githubId = String(given.id);
  const known = await db
    .selectFrom('users')
    .select('id')
    .where('github_id', '=', githubId)
    .executeTakeFirst();
  const row =
    known ??
    (await db
      .insertInto('users')
      .values({
        github_id: githubId,
        email: `${githubId}@users.noreply.github.test`,
        username: `pending-${githubId}`,
        display_name: 'pending',
      })
      .returning('id')
      .executeTakeFirstOrThrow());
  return await recordGitHubSignIn(db, clock, {
    userId: row.id,
    profile: cleanedProfile(given),
    made: known === undefined,
  });
};

const storedFor = async (
  db: Database,
  userId: string,
): Promise<{ username: string; display_name: string }> =>
  await db
    .selectFrom('users')
    .select(['username', 'display_name'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();

describe('integration: what a GitHub sign-in stores from what GitHub said', () => {
  test('a first sign-in stores the login as the username, the name, and the picture', async () => {
    await withRollback(async (db) => {
      const { userId, usernameCollision } = await signedIn(db, account());
      const row = await db
        .selectFrom('users')
        .select(['username', 'display_name', 'avatar_url', 'github_login'])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        username: 'octocat',
        display_name: 'Mona Lisa',
        avatar_url: 'https://avatars.test/octocat.png',
        github_login: 'octocat',
      });
      expect(usernameCollision).toBeUndefined();
    });
  });

  test('signing in again refreshes what is display-only, on the same account', async () => {
    await withRollback(async (db) => {
      const first = await signedIn(db, account());
      const again = await signedIn(db, account({ name: 'Mona Renamed', avatarUrl: null }));
      expect(again.userId).toBe(first.userId);
      const row = await db
        .selectFrom('users')
        .select(['display_name', 'avatar_url'])
        .where('id', '=', first.userId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ display_name: 'Mona Renamed', avatar_url: null });
    });
  });

  /**
   * GitHub lets an account be renamed and the freed name be taken by someone else, so a username can
   * collide with a live row. The incoming user takes a suffix; identity is `github_id`, and
   * `username` is display-only (D-38).
   */
  test('a username taken by somebody else gets a suffix, and the collision is reported', async () => {
    await withRollback(async (db) => {
      await signedIn(db, account({ id: 1, login: 'taken' }));
      const second = await signedIn(db, account({ id: 2, login: 'taken' }));
      expect((await storedFor(db, second.userId)).username).toBe('taken-1');
      expect(second.usernameCollision).toEqual({ wanted: 'taken', stored: 'taken-1' });
    });
  });

  test('keeping your own username across a sign-in is not a collision', async () => {
    await withRollback(async (db) => {
      const first = await signedIn(db, account());
      const again = await signedIn(db, account());
      expect(again.userId).toBe(first.userId);
      expect(again.usernameCollision).toBeUndefined();
    });
  });

  /**
   * `users.username` is VARCHAR(39), GitHub's own limit, so a login that fills it cannot take a `-1`
   * suffix without overflowing — and a login one longer than the limit must not be able to fail a
   * sign-in either. Both raised 22001 and the person was told the server broke (#233).
   */
  describe('a login at the edge of the column', () => {
    const THIRTY_NINE = 'a'.repeat(39);

    test('a 39-character login that is taken is shortened to fit its suffix', async () => {
      await withRollback(async (db) => {
        await signedIn(db, account({ id: 1, login: THIRTY_NINE }));
        const second = await signedIn(db, account({ id: 2, login: THIRTY_NINE }));
        const { username } = await storedFor(db, second.userId);
        expect(username).toBe(`${'a'.repeat(37)}-1`);
        expect(username).toHaveLength(39);
        expect(second.usernameCollision).toEqual({ wanted: THIRTY_NINE, stored: username });
      });
    });

    test('a 40-character login is truncated, never refused', async () => {
      await withRollback(async (db) => {
        const { userId } = await signedIn(db, account({ id: 3, login: 'b'.repeat(40) }));
        expect((await storedFor(db, userId)).username).toBe('b'.repeat(39));
      });
    });

    test('truncating onto a name that is taken still ends in a free one', async () => {
      await withRollback(async (db) => {
        await signedIn(db, account({ id: 4, login: 'c'.repeat(39) }));
        const { userId } = await signedIn(db, account({ id: 5, login: 'c'.repeat(40) }));
        expect((await storedFor(db, userId)).username).toBe(`${'c'.repeat(37)}-1`);
      });
    });

    test('a refresh of an account whose login is 40 characters is not refused either', async () => {
      await withRollback(async (db) => {
        const profile = account({ id: 6, login: 'd'.repeat(40) });
        const first = await signedIn(db, profile);
        const again = await signedIn(db, profile);
        expect(again.userId).toBe(first.userId);
      });
    });
  });

  test('a display name longer than the column is cut to fit, not refused', async () => {
    await withRollback(async (db) => {
      const { userId } = await signedIn(
        db,
        account({ id: 7, login: 'wordy', name: 'n'.repeat(300) }),
      );
      expect((await storedFor(db, userId)).display_name).toBe('n'.repeat(128));
    });
  });

  /** GitHub controls this string; PostgreSQL cannot store a NUL, and sign-in never fails on a name. */
  test('a display name with control characters is cleaned, not refused', async () => {
    await withRollback(async (db) => {
      const { userId } = await signedIn(
        db,
        account({ id: 8, login: 'nulled', name: 'Mo\u0000na \u202EgnoL\u0007 \uD800ok' }),
      );
      expect((await storedFor(db, userId)).display_name).toBe('Mona gnoL ok');
    });
  });

  test('a name that is nothing but controls falls back to the login', async () => {
    await withRollback(async (db) => {
      const { userId } = await signedIn(
        db,
        account({ id: 9, login: 'blank', name: '\u0000\u0001' }),
      );
      expect((await storedFor(db, userId)).display_name).toBe('blank');
    });
  });

  /**
   * GitHub does not issue a name with a NUL in it, but this is a value another system controls, and
   * PostgreSQL refuses a NUL in text outright: the insert raised and sign-in answered 500. Control
   * characters are removed, and what is left is stored — sign-in shortens and cleans what it is given,
   * never fails on it (D-78).
   */
  describe('control characters from GitHub', () => {
    test('a login and a name with a NUL or another control character are cleaned', async () => {
      await withRollback(async (db) => {
        const { userId } = await signedIn(
          db,
          account({ id: 11, login: 'oct\u0000o\u001Bcat\u007F', name: 'Mo\u0000na\u0085 Lisa' }),
        );
        expect(await storedFor(db, userId)).toEqual({
          username: 'octocat',
          display_name: 'Mona Lisa',
        });
      });
    });

    test('a login that is nothing but control characters becomes a name made from the id', async () => {
      await withRollback(async (db) => {
        const { userId } = await signedIn(
          db,
          account({ id: 12, login: '\u0000\u0000', name: '\u0000' }),
        );
        expect(await storedFor(db, userId)).toEqual({
          username: 'user-12',
          display_name: 'user-12',
        });
      });
    });
  });
});

describe('integration: what a GitHub sign-in through the library writes (D-179)', () => {
  test('never writes GitHub onto an erased account: refused, and the tombstone untouched (I-11)', async () => {
    await withRollback(async (db) => {
      const tombstone = await db
        .insertInto('users')
        .values({
          email: `erased-${crypto.randomUUID().slice(0, 8)}@deleted.invalid`,
          username: `deleted-user-${crypto.randomUUID().slice(0, 8)}`,
          display_name: 'deleted',
          deleted_at: clock.now(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const refused = await recordGitHubSignIn(db, clock, {
        userId: tombstone.id,
        profile: { id: 4242, login: 'back-again', name: 'Back', avatarUrl: null },
        made: false,
      }).then(
        () => 'written',
        (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
      );
      expect(refused).toBe('UNAUTHENTICATED');
      const after = await db
        .selectFrom('users')
        .select(['github_id', 'github_login', 'github_connected_at', 'avatar_url'])
        .where('id', '=', tombstone.id)
        .executeTakeFirstOrThrow();
      expect(after).toEqual({
        github_id: null,
        github_login: null,
        github_connected_at: null,
        avatar_url: null,
      });
    });
  });

  test('refuses a sign-in for an account that does not exist, and writes nothing', async () => {
    await withRollback(async (db) => {
      const refused = await recordGitHubSignIn(db, clock, {
        userId: crypto.randomUUID(),
        profile: { id: 4343, login: 'nobody', name: 'Nobody', avatarUrl: null },
        made: false,
      }).then(
        () => 'written',
        (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
      );
      expect(refused).toBe('UNAUTHENTICATED');
      const rows = await db
        .selectFrom('users')
        .select('id')
        .where('github_id', '=', '4343')
        .execute();
      expect(rows).toEqual([]);
    });
  });
});

describe('integration: a login that every suffix has already taken', () => {
  test('is refused rather than looped on, once a hundred names are taken', async () => {
    await withRollback(async (db) => {
      const names = [
        'crowd',
        ...Array.from({ length: 99 }, (_, index) => `crowd-${String(index + 1)}`),
      ];
      await db
        .insertInto('users')
        .values(
          names.map((username, index) => ({
            email: `crowd-${String(index)}@example.test`,
            username,
            display_name: username,
          })),
        )
        .execute();
      const outcome = await availableUsername(db, 'crowd', undefined).then(
        (name) => name,
        (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
      );
      expect(outcome).toBe('INTERNAL');
    });
  });
});
