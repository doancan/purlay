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

/** `ALTER TABLE t ADD CONSTRAINT c` — constraints a later migration adds. */
const addedConstraints = (sql: string): [string, string][] =>
  [...withoutComments(sql).matchAll(/ALTER TABLE (\w+)\s+ADD CONSTRAINT (\w+)/g)].map((match) => [
    match[1] ?? '',
    match[2] ?? '',
  ]);

/** `CREATE [UNIQUE] INDEX name ON table`, by table. */
const indexesIn = (sql: string): Map<string, Set<string>> => {
  const indexes = new Map<string, Set<string>>();
  for (const match of withoutComments(sql).matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)\s+ON (\w+)/g)) {
    const [, index = '', table = ''] = match;
    indexes.set(table, (indexes.get(table) ?? new Set()).add(index));
  }
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
for (const [table, constraint] of addedConstraints(migrationsSql)) {
  const shape = applied.get(table);
  if (shape !== undefined) (shape.constraints as Set<string>).add(constraint);
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
