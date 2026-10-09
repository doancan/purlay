/**
 * The shape of the migrated database, read from its catalogue.
 *
 * What a migration file says and what the database holds are two things; these
 * ask the database, so a rule here is a rule about what exists and not about how
 * it was written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { closeIntegrationDatabase, integrationDatabase } from './testing';

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration: the migrated schema', () => {
  /**
   * `channels.last_message_at` is written on every send. A column that is part of an
   * index — as a key, an INCLUDE column, or in a partial index's predicate — cannot
   * be changed by a heap-only update, so each send would rewrite the row's index
   * entries (D-88). The expression is looked at as well as the key columns, since a
   * predicate or `lower(...)` hides a column from `indkey`.
   */
  test('no index on channels mentions the column every send writes', async () => {
    const { rows } = await sql<{ index: string; definition: string }>`
      select indexname as index, indexdef as definition
      from pg_indexes
      where schemaname = 'public' and tablename = 'channels'`.execute(integrationDatabase());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.definition.includes('last_message_at'))).toEqual([]);
  });
});
