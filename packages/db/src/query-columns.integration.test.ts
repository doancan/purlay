/**
 * A statement filters, orders or joins by something an index can answer (#901, `docs/MODULES.md` §9).
 *
 * The schema test holds that every foreign key is indexed; this holds the other side, the columns the
 * source asks about. The source is read by `query-columns.ts` and the indexes by the migrated
 * database's catalogue, so a table or a query added next year is held without anyone listing it.
 *
 * The unit is a statement and a table, not a column: `where workspace_id = $1 and status = $2` is
 * answered by the index on `workspace_id` and `status` filters what it found, so asking for an index on
 * every column would hold 98 columns of which most are post-filters. What the rule refuses is a statement
 * whose every column on a table is one no index starts with: that one reads the table.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import { relevantToSchema, resolveReference, scanSource } from './query-columns';
import { TABLE_OWNERS } from './table-owners';
import { closeIntegrationDatabase, integrationDatabase } from './testing';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const REPOSITORY = join(import.meta.dir, '..', '..', '..');
const SOURCE_ROOTS = ['apps/api/src/**/*.ts', 'packages/db/src/**/*.ts'];
const NOT_QUERIES = /\.test\.ts$|\.d\.ts$|\/testing\/|\/schema\.ts$/;

const sourceFiles = async (): Promise<string[]> => {
  const files: string[] = [];
  for (const pattern of SOURCE_ROOTS) {
    for await (const file of new Glob(pattern).scan({ cwd: REPOSITORY })) {
      if (!NOT_QUERIES.test(file)) files.push(file);
    }
  }
  return files.sort();
};

/**
 * `table(columns)` a statement reads with no index that starts with any of them, each with why. It may
 * only shrink: a table that grows with use does not belong here but under an index in its module's
 * migration set.
 */
const UNINDEXED: Readonly<Record<string, string>> = {
  'admin_email_verification(issued_at)':
    'one row by construction (the key is a boolean held to TRUE); the daily sweep reads that row',
  'server_settings(password_sign_in)':
    'one row by construction (`server_settings_one_row`); the update reads that row',
  'server_settings(setup_completed_at)':
    'one row by construction (`server_settings_one_row`); the check reads that row',
  'missed_mail_letters(sent_at)':
    'the delete of letters past the stop link’s 30 days: at most one letter an hour for a person, so the scan is of a month of letters',
  'rate_limits(last_request)':
    'the sweep of counters older than a day: the table holds a day of keys, and the scan runs with the daily sweep',
  'verifications(expires_at)':
    'the sweep of links older than a day: the table holds a day of links, and the scan runs with the daily sweep',
  'workspaces(deleted_at, purge_started_at)':
    'the purge’s claim reads the workspaces of one server, which number in the dozens; only a deleted one matches',
};
const MAX_UNINDEXED = 7;

describe('integration: the columns the source queries by', () => {
  test('every statement reads each table through a column an index starts with, or is in the short list of those that do not', async () => {
    const db = integrationDatabase();
    const columns = new Map<string, Set<string>>();
    const { rows: columnRows } = await sql<{ table: string; column: string }>`
      select table_name as "table", column_name as "column"
      from information_schema.columns where table_schema = 'public'`.execute(db);
    for (const row of columnRows) {
      const known = columns.get(row.table) ?? new Set<string>();
      known.add(row.column);
      columns.set(row.table, known);
    }
    // The first key column of every valid index, the primary and unique keys among them.
    const { rows: indexRows } = await sql<{ table: string; column: string }>`
      select i.indrelid::regclass::text as "table",
             (select a.attname from pg_attribute a
               where a.attrelid = i.indrelid and a.attnum = i.indkey[0]) as "column"
      from pg_index i
      join pg_class c on c.oid = i.indrelid
      where c.relnamespace = 'public'::regnamespace and i.indisvalid and i.indkey[0] <> 0`.execute(
      db,
    );
    const led = new Set(indexRows.map((row) => `${row.table}.${row.column}`));

    const statements = new Map<string, { table: string; columns: Set<string>; where: string }>();
    let references = 0;
    let unresolved = 0;
    for (const file of await sourceFiles()) {
      const scan = scanSource(file, readFileSync(join(REPOSITORY, file), 'utf8'));
      for (const reference of scan.references) {
        if (!relevantToSchema(reference, columns, TABLE_OWNERS)) continue;
        references += 1;
        const resolved = resolveReference(reference, columns);
        if (resolved === undefined) {
          unresolved += 1;
          continue;
        }
        const key = `${reference.query}|${resolved.table}`;
        const statement = statements.get(key) ?? {
          table: resolved.table,
          columns: new Set<string>(),
          where: `${reference.file}:${String(reference.line)}`,
        };
        statement.columns.add(resolved.column);
        statements.set(key, statement);
      }
    }
    // The scan could have found nothing and passed: it reads the real source and resolves most of it.
    expect(statements.size).toBeGreaterThan(300);
    expect(unresolved).toBeLessThan(references / 10);

    const uncovered = [...statements.values()]
      .filter(
        (statement) =>
          ![...statement.columns].some((column) => led.has(`${statement.table}.${column}`)),
      )
      .map((statement) => ({
        key: `${statement.table}(${[...statement.columns].sort().join(', ')})`,
        where: statement.where,
      }));
    expect(
      uncovered.filter(({ key }) => !(key in UNINDEXED)),
      'A statement whose every column on a table is one no index starts with reads the whole table. Add an index that starts with one of them, in the migration set of the module that owns the table; the short list is for a table that stays small, with why.',
    ).toEqual([]);
    // An entry for a statement that is gone, or that an index now answers, is a line to delete.
    const found = new Set(uncovered.map(({ key }) => key));
    expect(Object.keys(UNINDEXED).filter((key) => !found.has(key))).toEqual([]);
    expect(Object.keys(UNINDEXED).length).toBeLessThanOrEqual(MAX_UNINDEXED);
  });
});
