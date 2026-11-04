/**
 * The database as each module set leaves it (D-250 rule 6, `MODULES.md` §5): the core alone, each set on the
 * core, and every set. A set that is off creates nothing, and what a set creates is its own — so a table that
 * turns up in a database where its module is off is a migration that named it from the core's side.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import {
  migrateToLatest,
  PRODUCT_MIGRATION_SETS,
  setsNamedBy,
  type MigrationSet,
} from './migrator';
import {
  CORE_COLUMNS_A_SET_CHANGES,
  CORE_ENUMS_A_SET_CHANGES,
  TABLE_OWNERS,
  type TableOwner,
} from './table-owners';

const owners: Readonly<Record<string, TableOwner>> = TABLE_OWNERS;
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

/** What a database holds after the core's migrations and these sets: its tables, and each table's columns as written. */
interface Shape {
  readonly tables: readonly string[];
  /** `table.column type null|not null default`, one entry per column. */
  readonly columns: readonly string[];
  /** `type: value, value, ...`, one entry per enum type, its values in their sort order. */
  readonly enums: readonly string[];
}

const shapeAfter = async (sets: readonly MigrationSet[]): Promise<Shape> => {
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
    const columns = await sql<{ line: string }>`
      select table_name || '.' || column_name || ' ' || data_type || ' '
          || is_nullable || ' ' || coalesce(column_default, '') as line
      from information_schema.columns
      where table_schema = current_schema() and table_name not like 'kysely\_%'
      order by 1`.execute(db);
    const enums = await sql<{ line: string }>`
      select t.typname || ': ' || string_agg(e.enumlabel, ', ' order by e.enumsortorder) as line
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = current_schema()
      group by t.typname
      order by 1`.execute(db);
    return {
      tables: rows.map((row) => row.name),
      columns: columns.rows.map((row) => row.line),
      enums: enums.rows.map((row) => row.line),
    };
  } finally {
    await db.destroy();
  }
};

const tablesAfter = async (sets: readonly MigrationSet[]): Promise<string[]> => [
  ...(await shapeAfter(sets)).tables,
];

/**
 * The columns of the core's tables that a set changed: one that is not in the cell with the set, or one that is
 * there and was not in the core alone. A module adds tables of its own; a change to the core's is the declared
 * link and nothing else (`CORE_COLUMNS_A_SET_CHANGES`).
 */
const coreColumnsChanged = (core: Shape, withSet: Shape): string[] => {
  const coreTables = new Set(core.tables);
  const ofCore = (line: string): boolean => coreTables.has(line.slice(0, line.indexOf('.')));
  const before = new Set(core.columns);
  const after = new Set(withSet.columns);
  const changed = [
    ...core.columns.filter((line) => !after.has(line)),
    ...withSet.columns.filter((line) => ofCore(line) && !before.has(line)),
  ];
  return changed.filter(
    (line) => !CORE_COLUMNS_A_SET_CHANGES.includes(line.slice(0, line.indexOf(' '))),
  );
};

const enumName = (line: string): string => line.slice(0, line.indexOf(':'));

/**
 * The enum types of the core that a set altered or dropped: a value added, removed or renamed changes what the
 * core's columns accept without changing a column. A module creates enum types of its own; one of the core's is
 * the declared link and nothing else (`CORE_ENUMS_A_SET_CHANGES`).
 */
const coreEnumsChanged = (core: Shape, withSet: Shape): string[] => {
  const after = new Set(withSet.enums);
  return core.enums
    .filter((line) => !after.has(line))
    .map(enumName)
    .filter((type) => !CORE_ENUMS_A_SET_CHANGES.includes(type));
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
        expect(added.filter((table) => owners[table] !== set.id)).toEqual([]);
        expect(core.filter((table) => !alone.includes(table))).toEqual([]);
      }
    },
    MIGRATING_MS,
  );

  test(
    'issues has a table only where its set was applied: not on the core alone, not beside chat alone',
    async () => {
      expect(await tablesAfter(setsNamedBy('none'))).not.toContain('issues');
      expect(await tablesAfter(setsNamedBy('chat'))).not.toContain('issues');
      const alone = await tablesAfter(setsNamedBy('issues'));
      expect(alone).toContain('issues');
      expect(alone).not.toContain('scheduled_messages');
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

describe('integration: a set leaves the columns of the core as they were', () => {
  test(
    'no set changes a column of a core table, except the ones the link declares',
    async () => {
      const core = await shapeAfter(setsNamedBy('none'));
      for (const set of PRODUCT_MIGRATION_SETS) {
        const alone = await shapeAfter(setsNamedBy(set.id));
        expect(coreColumnsChanged(core, alone)).toEqual([]);
      }
    },
    MIGRATING_MS,
  );

  test(
    'no set alters an enum type of the core, except the ones the link declares',
    async () => {
      const core = await shapeAfter(setsNamedBy('none'));
      expect(core.enums.length).toBeGreaterThan(0);
      const problems: string[] = [];
      for (const set of PRODUCT_MIGRATION_SETS) {
        const alone = await shapeAfter(setsNamedBy(set.id));
        for (const type of coreEnumsChanged(core, alone)) {
          problems.push(
            `set '${set.id}' alters the core's enum type '${type}': a module creates enum types of its own; ` +
              `record a deliberate change to the core's in CORE_ENUMS_A_SET_CHANGES (packages/db/src/table-owners.ts)`,
          );
        }
      }
      expect(problems).toEqual([]);
    },
    MIGRATING_MS,
  );

  test(
    'a scratch set that adds a value to a core enum is named, type and all',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'scratch-set-'));
      try {
        writeFileSync(
          join(directory, '0001_stray.sql'),
          "CREATE TABLE scratch_own (id uuid PRIMARY KEY);\nALTER TYPE user_role ADD VALUE 'scratch_role';\n",
        );
        const core = await shapeAfter([]);
        const withScratch = await shapeAfter([{ id: 'scratch', directory }]);
        expect(coreEnumsChanged(core, withScratch)).toEqual(['user_role']);
        expect(coreColumnsChanged(core, withScratch)).toEqual([]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    MIGRATING_MS,
  );

  test(
    'a scratch set that adds a column to a core table is named, column and all',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'scratch-set-'));
      try {
        writeFileSync(
          join(directory, '0001_stray.sql'),
          'CREATE TABLE scratch_own (id uuid PRIMARY KEY);\nALTER TABLE workspaces ADD COLUMN scratch_flag boolean;\n',
        );
        const core = await shapeAfter([]);
        const withScratch = await shapeAfter([{ id: 'scratch', directory }]);
        expect(coreColumnsChanged(core, withScratch)).toEqual([
          'workspaces.scratch_flag boolean YES ',
        ]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    MIGRATING_MS,
  );
});
