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

  /**
   * Deleting a parent row asks the child table for rows that point at it, and a
   * cascade asks for every one. Without an index on the referencing column that is
   * a scan of the whole child table per parent row: 4.9 s to delete 100 of 1,000,000
   * messages (D-89). Read from the catalogue, so a table added next year cannot
   * forget one.
   *
   * "Usable" means the planner can answer `where col = $1` from it: a valid btree
   * whose first column is the foreign key's first column, and which is either whole
   * or partial only on `col IS NOT NULL`, which an equality implies. The
   * `idx_messages_*` partial indexes filter on `deleted_at` and `parent_id` and so
   * serve the feed and the thread, not the foreign key.
   */
  test('every foreign key column leads an index the planner can use for it', async () => {
    const db = integrationDatabase();
    const keys = await sql<{ table: string; name: string; column: string }>`
      select c.conrelid::regclass::text as "table", c.conname as name,
             (select a.attname from pg_attribute a
               where a.attrelid = c.conrelid and a.attnum = c.conkey[1]) as "column"
      from pg_constraint c
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace`.execute(db);
    const indexes = await sql<{
      table: string;
      name: string;
      column: string;
      predicate: string | null;
    }>`
      select i.indrelid::regclass::text as "table", ic.relname as name,
             (select a.attname from pg_attribute a
               where a.attrelid = i.indrelid and a.attnum = i.indkey[0]) as "column",
             pg_get_expr(i.indpred, i.indrelid) as predicate
      from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_am am on am.oid = ic.relam
      where ic.relnamespace = 'public'::regnamespace and am.amname = 'btree'
        and i.indisvalid and i.indisready and i.indkey[0] <> 0`.execute(db);

    expect(keys.rows.length).toBeGreaterThan(10);
    const unindexed = keys.rows
      .filter(
        (key) =>
          !indexes.rows.some(
            (index) =>
              index.table === key.table &&
              index.column === key.column &&
              (index.predicate === null || index.predicate === `(${key.column} IS NOT NULL)`),
          ),
      )
      .map((key) => `${key.table}.${key.column} (${key.name})`);
    expect(unindexed).toEqual([]);
  });

  /**
   * An index whose keys are the leading keys of another, whole index answers nothing
   * the other cannot, and every write to the table pays for both. `idx_workspaces_slug`
   * was one: a partial index on the column the UNIQUE constraint already indexes. A
   * unique or primary-key index is never the redundant one, since it enforces something.
   */
  test('no index is a prefix of another whole index on its table', async () => {
    const { rows } = await sql<{ redundant: string; covered_by: string }>`
      select xc.relname as redundant, yc.relname as covered_by
      from pg_index x
      join pg_class xc on xc.oid = x.indexrelid
      join pg_index y on y.indrelid = x.indrelid and y.indexrelid <> x.indexrelid
      join pg_class yc on yc.oid = y.indexrelid
      where xc.relnamespace = 'public'::regnamespace
        and not x.indisunique and not x.indisprimary
        and x.indexprs is null and y.indexprs is null
        and y.indpred is null and y.indisvalid
        and xc.relam = yc.relam
        and y.indnkeyatts >= x.indnkeyatts
        and (string_to_array(y.indkey::text, ' '))[1:x.indnkeyatts]
          = (string_to_array(x.indkey::text, ' '))[1:x.indnkeyatts]
        and (string_to_array(y.indclass::text, ' '))[1:x.indnkeyatts]
          = (string_to_array(x.indclass::text, ' '))[1:x.indnkeyatts]
        and (string_to_array(y.indoption::text, ' '))[1:x.indnkeyatts]
          = (string_to_array(x.indoption::text, ' '))[1:x.indnkeyatts]
        and (y.indnkeyatts > x.indnkeyatts or x.indpred is not null or x.indexrelid > y.indexrelid)
      order by 1, 2`.execute(integrationDatabase());
    expect(rows).toEqual([]);
  });

  /** Dropping what duplicates a constraint's index must not reach the indexes that answer the product's queries. */
  test('the message indexes that answer the feed, the thread, the search and the open questions stay', async () => {
    const { rows } = await sql<{ name: string }>`
      select indexname as name from pg_indexes
      where schemaname = 'public' and tablename = 'messages' and indexname like 'idx\_messages\_%'
      order by indexname`.execute(integrationDatabase());
    const names = rows.map((row) => row.name);
    for (const kept of [
      'idx_messages_channel_feed',
      'idx_messages_search',
      'idx_messages_sender',
      'idx_messages_thread',
      'idx_messages_unresolved',
    ]) {
      expect(names).toContain(kept);
    }
  });
});
