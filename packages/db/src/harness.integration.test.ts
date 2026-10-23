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
  buildIntegrationTemplate,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  dropDatabases,
  integrationDatabase,
  migrateIntegrationDatabase,
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

/**
 * The cost of the clones, held to a budget: a hook has five seconds, and the
 * runner's "a beforeEach/afterEach hook timed out" was a hook that needed more.
 *
 * Measured, so the numbers can be argued with. On a laptop a template is built from
 * nothing in about 0.12 s, a clone made in 0.03 s and dropped in 0.01 s. On a disk
 * throttled to 8 MB/s (a container run with `--device-write-bps`) they are 3.3 s,
 * 0.5 s and up to 1.3 s — and that is the kind of disk where the hooks failed. The
 * budgets are half a hook for the template (built once per process, in the preload,
 * and here from nothing in a database of its own, so the test does not time a
 * template that already exists) and a fifth of one for a clone and for a drop. A
 * test that crosses them is saying that the next file's `beforeAll` is about to
 * time out.
 */
describe('integration harness cost', () => {
  const TEMPLATE_BUDGET_MS = 2_500;
  const CLONE_BUDGET_MS = 1_000;
  const DROP_BUDGET_MS = 1_000;

  const timed = async <T>(work: () => Promise<T>): Promise<{ result: T; ms: number }> => {
    const started = performance.now();
    const result = await work();
    return { result, ms: performance.now() - started };
  };

  test('a template is built from nothing, then cloned and dropped, inside the hook budget', async () => {
    const scratch = `purlay_budget_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    let building = Number.POSITIVE_INFINITY;
    try {
      building = (await timed(async () => await buildIntegrationTemplate(scratch))).ms;
    } finally {
      await dropDatabases([scratch]);
    }

    const cloning = await timed(async () => await cloneIntegrationDatabase());
    const cloned = cloning.result;
    // The control: what was timed has the whole schema in it, so it is not quick for being empty.
    const applied = await sql<{ n: string }>`select count(*) as n from kysely_migration`.execute(
      cloned.db,
    );
    expect(Number(applied.rows[0]?.n)).toBeGreaterThan(1);
    const dropping = await timed(async () => {
      await cloned.drop();
    });

    expect(building).toBeLessThan(TEMPLATE_BUDGET_MS);
    expect(cloning.ms).toBeLessThan(CLONE_BUDGET_MS);
    expect(dropping.ms).toBeLessThan(DROP_BUDGET_MS);
  });
});

describe('integration: the database the rollback harness uses directly', () => {
  // `withRollback` runs on the configured database itself, not on a clone of the migrated template: one
  // that was last migrated before a migration was added answers "relation does not exist" to the tests that
  // use it, which reads as a defect in whatever the tests were about.
  test('is brought up to date by the run itself, from whatever it was left at', async () => {
    const source = process.env['DATABASE_URL'] ?? '';
    const name = `purlay_harness_stale_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const admin = new URL(source);
    admin.pathname = '/postgres';
    const target = new URL(source);
    target.pathname = `/${name}`;
    const { Kysely, PostgresDialect } = await import('kysely');
    const pg = (await import('pg')).default;
    const control = new Kysely<unknown>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: admin.toString(), max: 1 }),
      }),
    });
    try {
      await sql`create database ${sql.id(name)}`.execute(control);
      await migrateIntegrationDatabase(target.toString());
      const inspected = new Kysely<unknown>({
        dialect: new PostgresDialect({
          pool: new pg.Pool({ connectionString: target.toString(), max: 1 }),
        }),
      });
      try {
        const tables = await sql<{
          name: string;
        }>`select to_regclass('public.server_settings')::text as name`.execute(inspected);
        expect(tables.rows[0]?.name).toBe('server_settings');
        // A second run finds nothing to do and fails on nothing.
        await migrateIntegrationDatabase(target.toString());
      } finally {
        await inspected.destroy();
      }
    } finally {
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(control);
      await control.destroy();
    }
  });
});
