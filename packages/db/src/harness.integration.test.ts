/**
 * The harness proving itself.
 *
 * Its whole claim is that a test cannot leave anything behind, so the claim is
 * checked the only way it can be: two tests write the same row, and neither
 * sees the other's.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from './testing';

const SLUG = 'harness-probe';

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration harness', () => {
  test('a write is visible inside the transaction', async () => {
    await withRollback(async (db) => {
      await db.insertInto('workspaces').values({ name: 'Probe', slug: SLUG }).execute();
      const found = await db
        .selectFrom('workspaces')
        .select('slug')
        .where('slug', '=', SLUG)
        .executeTakeFirst();
      expect(found?.slug).toBe(SLUG);
    });
  });

  test('and is gone afterwards, so the next test starts clean', async () => {
    await withRollback(async (db) => {
      const found = await db
        .selectFrom('workspaces')
        .select('slug')
        .where('slug', '=', SLUG)
        .executeTakeFirst();
      expect(found).toBeUndefined();
    });
  });

  test('the same row can be written again, in either order', async () => {
    await withRollback(async (db) => {
      await db.insertInto('workspaces').values({ name: 'Probe', slug: SLUG }).execute();
      const count = await db
        .selectFrom('workspaces')
        .select(({ fn }) => fn.countAll().as('n'))
        .where('slug', '=', SLUG)
        .executeTakeFirstOrThrow();
      expect(Number(count.n)).toBe(1);
    });
  });
});
