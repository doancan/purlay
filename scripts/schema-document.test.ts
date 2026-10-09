/**
 * SCHEMA.md's DDL describes the tables the migrations create — bound, not trusted.
 *
 * The migrations are the schema; SCHEMA.md explains it, and for that it repeats
 * each table's DDL beside the reasoning. A copy nothing compares is a copy that
 * drifts: the audit that found it (#201) found the document already claiming a
 * column a later migration would add, when an earlier one had. So for every table
 * a migration creates, the document's columns, constraints and indexes must be
 * exactly the migrations' — names, in both directions. Tables the document plans
 * and no migration has created yet are not compared; the day one is, it is.
 *
 * Names rather than whole statements: the document keeps its own comments and
 * layout, which is what makes it worth reading, and a renamed, added or dropped
 * column, constraint or index — the drift that misleads — still fails here.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface TableShape {
  readonly columns: ReadonlySet<string>;
  readonly constraints: ReadonlySet<string>;
}

/** Lines that are not columns inside a `CREATE TABLE` body. */
const NOT_A_COLUMN = /^(CONSTRAINT|UNIQUE|PRIMARY|CHECK|FOREIGN|EXCLUDE|\(|\)|OR|AND)\b/;

const withoutComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');

/** Every `CREATE TABLE name ( … );` in some SQL, by table. */
const tablesIn = (sql: string): Map<string, TableShape> => {
  const tables = new Map<string, TableShape>();
  for (const match of withoutComments(sql).matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
    const [, name = '', body = ''] = match;
    const columns = new Set<string>();
    const constraints = new Set<string>();
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      const constraint = /^CONSTRAINT (\w+)/.exec(line);
      if (constraint?.[1] !== undefined) constraints.add(constraint[1]);
      const column = /^([a-z_][a-z0-9_]*)\s+[A-Za-z]/.exec(line);
      if (column?.[1] !== undefined && !NOT_A_COLUMN.test(line)) columns.add(column[1]);
    }
    tables.set(name, { columns, constraints });
  }
  return tables;
};

/**
 * What later migrations do to constraints, in order: `ADD CONSTRAINT`, `DROP
 * CONSTRAINT [IF EXISTS]` and `RENAME CONSTRAINT a TO b`. Only the net result is
 * what the document must describe, so a constraint a migration replaces (0011) is
 * replayed rather than counted twice, and the re-runnable `DROP ... IF EXISTS` of
 * a name never added changes nothing.
 */
type ConstraintChange =
  | { readonly table: string; readonly add: string }
  | { readonly table: string; readonly drop: string }
  | { readonly table: string; readonly rename: string; readonly to: string };

const constraintChanges = (sql: string): ConstraintChange[] => {
  const statement =
    /ALTER TABLE (\w+)\s+(?:ADD CONSTRAINT (\w+)|DROP CONSTRAINT (?:IF EXISTS )?(\w+)|RENAME CONSTRAINT (\w+) TO (\w+))/g;
  return [...withoutComments(sql).matchAll(statement)].flatMap((match): ConstraintChange[] => {
    const [, table = '', added, dropped, renamed, renamedTo] = match;
    if (added !== undefined) return [{ table, add: added }];
    if (dropped !== undefined) return [{ table, drop: dropped }];
    if (renamed !== undefined && renamedTo !== undefined)
      return [{ table, rename: renamed, to: renamedTo }];
    return [];
  });
};

/**
 * The indexes that exist after the SQL has run, by table.
 *
 * Replayed in order, because a migration may build an index CONCURRENTLY, drop
 * one, or rename the replacement over it (0008), and only the net result is what
 * the document must describe. A `DROP INDEX IF EXISTS` of a name never created is
 * the re-runnable form of a migration and changes nothing.
 */
const indexesIn = (sql: string): Map<string, Set<string>> => {
  const owner = new Map<string, string>();
  const statements =
    /CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(\w+)\s+ON (\w+)|DROP INDEX (?:CONCURRENTLY )?(?:IF EXISTS )?(\w+)|ALTER INDEX (\w+) RENAME TO (\w+)|(?:UNIQUE|PRIMARY KEY) USING INDEX (\w+)/g;
  for (const match of withoutComments(sql).matchAll(statements)) {
    const [, created, table, dropped, renamed, renamedTo, attached] = match;
    if (created !== undefined && table !== undefined) owner.set(created, table);
    else if (dropped !== undefined) owner.delete(dropped);
    // An index attached as a constraint is a constraint from then on, and the document lists it as one.
    else if (attached !== undefined) owner.delete(attached);
    else if (renamed !== undefined && renamedTo !== undefined) {
      const was = owner.get(renamed);
      if (was === undefined)
        throw new Error(`a migration renames ${renamed}, which does not exist`);
      owner.delete(renamed);
      owner.set(renamedTo, was);
    }
  }
  const indexes = new Map<string, Set<string>>();
  for (const [index, table] of owner)
    indexes.set(table, (indexes.get(table) ?? new Set()).add(index));
  return indexes;
};

const MIGRATIONS = 'packages/db/migrations';
const migrationsSql = readdirSync(MIGRATIONS)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(join(MIGRATIONS, file), 'utf8'))
  .join('\n');
const documentSql = [...readFileSync('docs/SCHEMA.md', 'utf8').matchAll(/```sql\n([\s\S]*?)```/g)]
  .map((match) => match[1] ?? '')
  .join('\n');

const applied = tablesIn(migrationsSql);
for (const change of constraintChanges(migrationsSql)) {
  const constraints = applied.get(change.table)?.constraints as Set<string> | undefined;
  if (constraints === undefined) continue;
  if ('add' in change) constraints.add(change.add);
  else if ('drop' in change) constraints.delete(change.drop);
  else if (constraints.delete(change.rename)) constraints.add(change.to);
  else throw new Error(`a migration renames ${change.rename}, which does not exist`);
}
const documented = tablesIn(documentSql);
const appliedIndexes = indexesIn(migrationsSql);
const documentedIndexes = indexesIn(documentSql);

const sorted = (values: ReadonlySet<string> | undefined): string[] => [...(values ?? [])].sort();

describe('SCHEMA.md describes the applied tables exactly', () => {
  test('both sides were read, so the comparisons below are not of nothing', () => {
    expect(applied.size).toBeGreaterThan(5);
    expect(documented.size).toBeGreaterThanOrEqual(applied.size);
    expect(sorted(applied.get('messages')?.columns)).toContain('content');
  });

  for (const [table, shape] of applied) {
    test(`${table}: the document has it, with the same columns`, () => {
      expect({ table, columns: sorted(documented.get(table)?.columns) }).toEqual({
        table,
        columns: sorted(shape.columns),
      });
    });

    test(`${table}: the same named constraints`, () => {
      expect({ table, constraints: sorted(documented.get(table)?.constraints) }).toEqual({
        table,
        constraints: sorted(shape.constraints),
      });
    });

    test(`${table}: the same indexes`, () => {
      expect({ table, indexes: sorted(documentedIndexes.get(table)) }).toEqual({
        table,
        indexes: sorted(appliedIndexes.get(table)),
      });
    });
  }
});
