/**
 * A statement that locks a whole table does not belong in a rolled-back transaction on the shared integration
 * database: `drop table`, `alter table`, `truncate`, `lock table` and `create index` hold an exclusive lock until the
 * rollback, and every other file running beside it (`--parallel`, D-228) that touches the table waits on it or
 * deadlocks (`40P01`, seen in `table-exists.integration.test.ts`). Such a test runs on a clone of its own
 * (`cloneIntegrationDatabase`, handed to `withRollback` as its second argument), as `announcement-channels` does.
 * A file below may do it on the shared database only for the reason given.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../..');
const ALLOWED: Readonly<Record<string, string>> = {};

/**
 * Each `withRollback` with one argument — the shared database — as the text from its first line to its closing, at its
 * indent. A call that names a database (`}, own.db);`) closes the same way and is read, and left out, so that it does not
 * run on into the next call.
 */
const onSharedDatabase = (text: string): readonly string[] =>
  [
    ...text.matchAll(
      /^([ \t]*)await withRollback\(async \(\w+\) => \{\n[\s\S]*?\n\1\}(, [\w.]+)?\);$/gm,
    ),
  ]
    .filter((match) => match[2] === undefined)
    .map((match) => match[0]);

/** A statement of the kinds that take a table's exclusive lock, written as SQL and not quoted as text. */
const LOCKS_A_TABLE =
  /sql(?:\.raw)?`[^`]*\b(?:drop\s+(?:table|index|column)|alter\s+table|truncate|lock\s+table|create\s+(?:unique\s+)?index)\b/i;

const integrationFiles = (): readonly string[] =>
  Bun.spawnSync(['git', 'ls-files', '*.integration.test.ts'], { cwd: ROOT })
    .stdout.toString()
    .split('\n')
    .filter((line) => line !== '');

describe('a statement that locks a table runs on a clone, not on the shared database', () => {
  test('the reader tells the shared database from a clone, and DDL from text that mentions it', () => {
    const shared =
      'await withRollback(async (db) => {\n  await sql`drop table issues`.execute(db);\n});';
    const own =
      'await withRollback(async (db) => {\n  await sql`drop table issues`.execute(db);\n}, own.db);';
    const quoted =
      'await withRollback(async (db) => {\n  await find(db, "\'; DROP TABLE users; --");\n});';
    const harmless = 'await withRollback(async (db) => {\n  await sql`select 1`.execute(db);\n});';
    const guilty = (text: string): boolean =>
      onSharedDatabase(text).some((body) => LOCKS_A_TABLE.test(body));
    expect([guilty(shared), guilty(own), guilty(quoted), guilty(harmless)]).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  test('in every integration test file', () => {
    const files = integrationFiles();
    expect(files.length).toBeGreaterThan(50);
    const locking = files.filter(
      (file) =>
        !(file in ALLOWED) &&
        onSharedDatabase(readFileSync(join(ROOT, file), 'utf8')).some((body) =>
          LOCKS_A_TABLE.test(body),
        ),
    );
    expect(locking).toEqual([]);
  });
});
