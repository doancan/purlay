/**
 * The migrations, bound to the document that describes them.
 *
 * The migrations are the single source for the data model and the types are
 * generated from them (D-45). `SCHEMA.md` stays the readable description of what
 * is stored — which makes it a place the two can disagree, so they are compared
 * rather than trusted.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

const schemaDoc = readFileSync('docs/SCHEMA.md', 'utf8');
const generated = readFileSync('packages/db/src/schema.ts', 'utf8');
const files = readdirSync('packages/db/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort();

/**
 * What would lock `messages` for writers if it ran on a table with rows in it.
 *
 * A migration that creates the table is exempt, since there is nothing to lock. Any
 * other that builds an index on it must do so CONCURRENTLY, which PostgreSQL allows
 * only outside a transaction, so the file must also say it leaves its own (D-86). The
 * problems come back as sentences, so the test can show it catches what it claims to.
 */
const unsafeOnLargeTable = (text: string, table: string): string[] => {
  const code = text.replace(/--[^\n]*/g, '');
  if (new RegExp(`CREATE TABLE ${table}\\b`).test(code)) return [];
  const problems: string[] = [];
  const builds = [
    ...code.matchAll(
      new RegExp(`CREATE (?:UNIQUE )?INDEX (CONCURRENTLY )?[^;]*?\\bON ${table}\\b`, 'g'),
    ),
  ];
  for (const build of builds) {
    if (build[1] === undefined) problems.push(`builds an index on ${table} without CONCURRENTLY`);
  }
  if (builds.length > 0 && !/^--\s*purlay:\s*no-transaction\s*$/m.test(text)) {
    problems.push(`builds an index on ${table} inside the migrator's transaction`);
  }
  return problems;
};

describe('migrations', () => {
  test('an index on messages is built CONCURRENTLY, outside a transaction, or the table is being created', () => {
    for (const file of files) {
      const text = readFileSync(`packages/db/migrations/${file}`, 'utf8');
      expect({ file, problems: unsafeOnLargeTable(text, 'messages') }).toEqual({
        file,
        problems: [],
      });
    }
  });

  test('...and that check does catch each way of getting it wrong', () => {
    const plain = 'CREATE INDEX idx_x ON messages (sender_id);';
    expect(unsafeOnLargeTable(plain, 'messages')).toHaveLength(2);
    const concurrentlyInTransaction = 'CREATE INDEX CONCURRENTLY idx_x ON messages (sender_id);';
    expect(unsafeOnLargeTable(concurrentlyInTransaction, 'messages')).toEqual([
      "builds an index on messages inside the migrator's transaction",
    ]);
    const outOfTransactionNotConcurrent =
      '-- purlay: no-transaction\nCREATE UNIQUE INDEX idx_x ON messages (sender_id);';
    expect(unsafeOnLargeTable(outOfTransactionNotConcurrent, 'messages')).toEqual([
      'builds an index on messages without CONCURRENTLY',
    ]);
    const right =
      '-- purlay: no-transaction\nCREATE INDEX CONCURRENTLY idx_x ON messages (sender_id);';
    expect(unsafeOnLargeTable(right, 'messages')).toEqual([]);
    expect(
      unsafeOnLargeTable(
        'CREATE TABLE messages (id int);\nCREATE INDEX i ON messages (id);',
        'messages',
      ),
    ).toEqual([]);
  });

  test('are numbered from 0001 without a gap', () => {
    expect(files.length).toBeGreaterThan(0);
    files.forEach((file, index) => {
      expect(file).toMatch(/^\d{4}_[a-z_]+\.sql$/);
      expect(file.slice(0, 4)).toBe(String(index + 1).padStart(4, '0'));
    });
  });

  test('each one appears in the migration order the document publishes', () => {
    for (const file of files) {
      expect(schemaDoc).toContain(file);
    }
  });

  /**
   * `messages.id` has no default so that an insert which forgets the
   * application-generated UUIDv7 fails loudly instead of silently creating an
   * unorderable row. (D-8)
   */
  test('messages.id is declared without a default', () => {
    const messages = readFileSync('packages/db/migrations/0005_messages.sql', 'utf8');
    expect(messages).toMatch(/id\s+UUID PRIMARY KEY,/);
    expect(messages).not.toMatch(/id\s+UUID PRIMARY KEY DEFAULT/);
  });

  /**
   * Identifier uniqueness must not depend on the locale the server was
   * provisioned with: under a Turkish locale `lower('İ')` is not `i`. (D-40)
   */
  test('identifier columns declare an explicit collation', () => {
    const sql = files.map((f) => readFileSync(`packages/db/migrations/${f}`, 'utf8')).join('\n');
    for (const column of ['username', 'email', 'slug']) {
      expect(sql).toMatch(new RegExp(`${column}\\s+[A-Z()0-9]+ COLLATE "C"`));
    }
    expect(sql).toContain('name         VARCHAR(64) COLLATE "C"');
  });

  test('`citext` is not created — it lowercases with the database locale (D-40)', () => {
    // The word appears in comments explaining its absence, which is the point.
    // What must not exist is the extension.
    const sql = files.map((f) => readFileSync(`packages/db/migrations/${f}`, 'utf8')).join('\n');
    expect(sql).not.toMatch(/CREATE EXTENSION[^;]*citext/i);
  });
});

describe('generated types', () => {
  test('are marked as generated, so nobody edits them by hand (D-45)', () => {
    expect(generated).toContain('generated by kysely-codegen');
    expect(generated).toContain('do not edit it manually');
  });

  /**
   * The document may describe tables that later migrations will add — it
   * publishes the whole data model, while the migrations applied so far are the
   * current phase. The check runs one way: nothing exists in the database that
   * the document does not describe.
   */
  test('every generated table is described in SCHEMA.md', () => {
    const root = /export interface DB \{([\s\S]*?)\n\}/.exec(generated)?.[1] ?? '';
    const tables = [...root.matchAll(/^\s+(\w+):/gm)].map((m) => m[1] ?? '');
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(schemaDoc).toContain(`CREATE TABLE ${table}`);
    }
  });
});
