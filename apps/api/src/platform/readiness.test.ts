/**
 * The columns readiness checks are the columns the migrations collate — bound,
 * because a running process cannot read its migrations' text (#108).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLATED_COLUMNS } from './readiness';

const MIGRATIONS = 'packages/db/migrations';

/** `(table, column)` for every column a migration declares `COLLATE "C"`. */
const collatedInMigrations = (): string[] => {
  const found: string[] = [];
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const table of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
      for (const column of (table[2] ?? '').matchAll(/^\s*(\w+)\s+[^\n]*COLLATE "C"/gm)) {
        found.push(`${table[1] ?? ''}.${column[1] ?? ''}`);
      }
    }
  }
  return found.sort();
};

describe('the columns readiness checks', () => {
  test('are exactly the ones the migrations declare COLLATE "C"', () => {
    const declared = collatedInMigrations();
    expect(declared.length).toBeGreaterThan(0);
    expect(COLLATED_COLUMNS.map(([table, column]) => `${table}.${column}`).sort()).toEqual(
      declared,
    );
  });
});
