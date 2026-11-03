/**
 * The database as each module set leaves it (D-250 rule 6, `MODULES.md` §5): the core alone, each set on the
 * core, and every set. A set that is off creates nothing, and what a set creates is its own — so a table that
 * turns up in a database where its module is off is a migration that named it from the core's side.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import {
  migrateToLatest,
  PRODUCT_MIGRATION_SETS,
  setsNamedBy,
  type MigrationSet,
} from './migrator';
import { TABLE_OWNERS } from './table-owners';
import { closeIntegrationDatabase, dropDatabases, DROP_HOOK_MS } from './testing';

const databases: string[] = [];

const open = (name: string): Kysely<unknown> => {
  const url = new URL(process.env['DATABASE_URL'] ?? '');
  url.pathname = `/${name}`;
  return new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url.toString(), max: 1 }),
    }),
  });
};

// Dropped together, as the other files drop theirs: one at a time they outlived the five seconds a hook is given.
afterAll(async () => {
  await dropDatabases(databases);
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

/** Each test makes and migrates several databases, on a server that other files are also using. */
const MIGRATING_MS = 60_000;

/** The tables of a database that has had the core's migrations and these sets, and nothing else. */
const tablesAfter = async (sets: readonly MigrationSet[]): Promise<string[]> => {
  const name = `cells_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = open('postgres');
  try {
    await sql`create database ${sql.id(name)}`.execute(admin);
  } finally {
    await admin.destroy();
  }
  databases.push(name);
  const db = open(name);
  try {
    const { error } = await migrateToLatest(db, undefined, { modules: sets });
    expect(error).toBeUndefined();
    const { rows } = await sql<{ name: string }>`
      select table_name as name from information_schema.tables
      where table_schema = current_schema() and table_type = 'BASE TABLE'
        and table_name not like 'kysely\_%'
      order by 1`.execute(db);
    return rows.map((row) => row.name);
  } finally {
    await db.destroy();
  }
};

describe('integration: the cells of the matrix, migrated', () => {
  test(
    'a set that is off creates nothing, and what a set creates is its own',
    async () => {
      const core = await tablesAfter(setsNamedBy('none'));
      expect(core.length).toBeGreaterThan(0);
      for (const set of PRODUCT_MIGRATION_SETS) {
        const alone = await tablesAfter(setsNamedBy(set.id));
        const added = alone.filter((table) => !core.includes(table));
        expect(added.length).toBeGreaterThan(0);
        expect(added.filter((table) => TABLE_OWNERS[table] !== set.id)).toEqual([]);
        expect(core.filter((table) => !alone.includes(table))).toEqual([]);
      }
    },
    MIGRATING_MS,
  );

  test(
    'every set together is the core and what each set adds, no more',
    async () => {
      const core = await tablesAfter(setsNamedBy('none'));
      const every = await tablesAfter(setsNamedBy(undefined));
      const own = Object.entries(TABLE_OWNERS)
        .filter(([table, owner]) => owner !== 'core' && !core.includes(table))
        .map(([table]) => table);
      expect(every).toEqual([...core, ...own].sort());
    },
    MIGRATING_MS,
  );
});
