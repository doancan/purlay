/**
 * The session-token hashing plugin against the real table (D-11, D-179): what is stored is the
 * digest, what comes back to a query keyed by the raw token is the raw token, and what comes back
 * to any other read is the digest. Inside a transaction that is rolled back (D-46).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { sessionTokenDigest, sessionTokenHashing } from './session-token-hashing';
import { closeIntegrationDatabase, withRollback } from './testing';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const RAW = 'raw-token-for-the-plugin-integration';

describe('integration: the session-token hashing plugin', () => {
  test('stores the digest, and gives the raw token back only to a read keyed by it', async () => {
    await withRollback(async (plain) => {
      const hashed = plain.withPlugin(sessionTokenHashing());
      const { id: userId } = await plain
        .insertInto('users')
        .values({ email: 'hashing@example.test', username: 'hashing', display_name: 'H' })
        .returning('id')
        .executeTakeFirstOrThrow();

      const inserted = await hashed
        .insertInto('sessions')
        .values({ user_id: userId, token_hash: RAW, expires_at: new Date(Date.now() + 60_000) })
        .returning(['id', 'token_hash'])
        .executeTakeFirstOrThrow();
      expect(inserted.token_hash).toBe(RAW);

      const { rows } = await sql<{
        token_hash: string;
      }>`select token_hash from sessions where id = ${inserted.id}`.execute(plain);
      expect(rows[0]?.token_hash).toBe(sessionTokenDigest(RAW));

      const byToken = await hashed
        .selectFrom('sessions')
        .select(['id', 'token_hash'])
        .where('token_hash', '=', RAW)
        .executeTakeFirst();
      expect(byToken).toEqual({ id: inserted.id, token_hash: RAW });

      const byUser = await hashed
        .selectFrom('sessions')
        .select('token_hash')
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(byUser.token_hash).toBe(sessionTokenDigest(RAW));

      // The digest it handed out is not a key to the row.
      const byDigest = await hashed
        .selectFrom('sessions')
        .select('id')
        .where('token_hash', '=', byUser.token_hash)
        .executeTakeFirst();
      expect(byDigest).toBeUndefined();

      const deleted = await hashed
        .deleteFrom('sessions')
        .where('token_hash', '=', RAW)
        .executeTakeFirst();
      expect(deleted.numDeletedRows).toBe(1n);
    });
  });
});
