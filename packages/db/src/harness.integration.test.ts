/**
 * The harness proving itself.
 *
 * Its whole claim is that a test cannot leave anything behind, so the claim is
 * checked the only way it can be: two tests write the same row, and neither
 * sees the other's.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import pg from 'pg';
import {
  buildIntegrationTemplate,
  cloneIntegrationDatabase,
  backendsGone,
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
describe('integration harness: dropping a database whose connections are still closing', () => {
  const urlOf = (name: string): string => {
    const url = new URL(process.env['DATABASE_URL'] ?? '');
    url.pathname = `/${name}`;
    return url.toString();
  };
  const scratchDatabase = async (): Promise<string> => {
    const name = `purlay_drop_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const admin = new pg.Client({ connectionString: urlOf('postgres') });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin.end();
    return name;
  };

  test('is waited for: nobody is connected, so there is nothing to wait for', async () => {
    const name = await scratchDatabase();
    try {
      const started = performance.now();
      expect(await backendsGone(name, 1_000)).toBe(true);
      expect(performance.now() - started).toBeLessThan(500);
    } finally {
      await dropDatabases([name]);
    }
  });

  test('a connection that ends on its own is waited for by the drop, and is not killed by it', async () => {
    const name = await scratchDatabase();
    const client = new pg.Client({ connectionString: urlOf(name) });
    await client.connect();
    const failures: unknown[] = [];
    client.on('error', (error) => failures.push(error));
    setTimeout(() => void client.end(), 150);
    // Not `backendsGone` first: the drop itself is what must wait, or it kills the connection mid-hang-up.
    await dropDatabases([name]);
    expect(failures).toEqual([]);
  });

  test('a connection that never ends is waited for only so long, and then the drop is by force', async () => {
    const name = await scratchDatabase();
    const client = new pg.Client({ connectionString: urlOf(name) });
    await client.connect();
    client.on('error', () => undefined);
    try {
      expect(await backendsGone(name, 100)).toBe(false);
    } finally {
      await dropDatabases([name]);
      await client.end().catch(() => undefined);
    }
  });
});

/**
 * Two test processes at once (D-228): `bun test --parallel` runs the preload in every worker, so two can
 * build one template at the same moment, and one can clone it while another is still connected to it.
 */
describe('integration harness: two processes and one template', () => {
  test('building the same new template twice at once makes it once, and both are told its name', async () => {
    const scratch = `purlay_race_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    try {
      const built = await Promise.all([
        buildIntegrationTemplate(scratch),
        buildIntegrationTemplate(scratch),
      ]);
      expect(built).toEqual([scratch, scratch]);
    } finally {
      await dropDatabases([scratch]);
    }
  });

  test('a clone made while the template is being brought up to date waits for it, and is whole', async () => {
    const [, cloned] = await Promise.all([buildIntegrationTemplate(), cloneIntegrationDatabase()]);
    try {
      const applied = await sql<{ n: string }>`select count(*) as n from kysely_migration`.execute(
        cloned.db,
      );
      expect(Number(applied.rows[0]?.n)).toBeGreaterThan(1);
    } finally {
      await cloned.drop();
    }
  });
});

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
      // Pool shutdown can finish before its socket closes; do not force-drop it mid-hang-up.
      await backendsGone(name, 1_000);
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(control);
      await control.destroy();
    }
  });
});

/**
 * #797: a file's `afterAll` that ran out of time left the shared pool closing while the next file asked for
 * it, and every query after that read "driver has already been destroyed". Whoever asks while a close is
 * under way, or after it, is given a pool that works — never the one being destroyed.
 */
describe('integration harness: the shared pool while it is being closed (#797)', () => {
  test('a close still under way hands the next caller a new pool, not the closing one', async () => {
    const closing = integrationDatabase();
    await sql`select 1`.execute(closing);
    const closed = closeIntegrationDatabase();
    const next = integrationDatabase();
    expect(next).not.toBe(closing);
    const { rows } = await sql<{ one: number }>`select 1 as one`.execute(next);
    expect(rows).toEqual([{ one: 1 }]);
    await closed;
    // The close that was under way ended the old pool only.
    expect(
      (await sql<{ one: number }>`select 1 as one`.execute(integrationDatabase())).rows,
    ).toEqual([{ one: 1 }]);
  });

  test('two closes at once end the pool once, and neither throws', async () => {
    await sql`select 1`.execute(integrationDatabase());
    await Promise.all([closeIntegrationDatabase(), closeIntegrationDatabase()]);
    expect(
      (await sql<{ one: number }>`select 1 as one`.execute(integrationDatabase())).rows,
    ).toEqual([{ one: 1 }]);
  });
});
