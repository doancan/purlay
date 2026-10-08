/**
 * The harness proving itself.
 *
 * Its whole claim is that a test cannot leave anything behind, so the claim is
 * checked the only way it can be: two tests write the same row, and neither
 * sees the other's.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  integrationDatabase,
  withRollback,
} from './testing';

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

  /**
   * The clone is for what a transaction cannot do, so its claims are different:
   * it has the whole schema, a commit in it reaches nothing else, and dropping it
   * leaves nothing behind (D-46).
   */
  test('a cloned database is migrated, separate, and gone once dropped', async () => {
    const shared = integrationDatabase();
    const { db, drop } = await cloneIntegrationDatabase();
    const name = (await sql<{ name: string }>`select current_database() as name`.execute(db))
      .rows[0]?.name;
    expect(name).toMatch(/_[0-9a-f]{12}$/);

    const slug = `clone-probe-${crypto.randomUUID().slice(0, 8)}`;
    await db.insertInto('workspaces').values({ name: 'Clone', slug }).execute();
    expect(
      await db.selectFrom('workspaces').select('slug').where('slug', '=', slug).execute(),
    ).toHaveLength(1);
    expect(
      await shared.selectFrom('workspaces').select('slug').where('slug', '=', slug).execute(),
    ).toEqual([]);

    await drop();
    const left = await sql`select 1 from pg_database where datname = ${name ?? ''}`.execute(shared);
    expect(left.rows).toEqual([]);
  });
});
