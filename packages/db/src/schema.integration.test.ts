/**
 * The shape of the migrated database, read from its catalogue.
 *
 * What a migration file says and what the database holds are two things; these
 * ask the database, so a rule here is a rule about what exists and not about how
 * it was written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { closeIntegrationDatabase, integrationDatabase, withRollback } from './testing';

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
      'idx_messages_search_folded',
      'idx_messages_sender',
      'idx_messages_thread',
      'idx_messages_unresolved',
    ]) {
      expect(names).toContain(kept);
    }
  });

  /**
   * 0014: the open-questions index holds only roots that have a reply. Without that predicate
   * it held every unresolved root, and a view that wants the rare ones read them all
   * (a sequential scan of 400,000 messages, 6,975 buffers, against 41).
   */
  test('the open-questions index holds only what the view can show', async () => {
    const { rows } = await sql<{ definition: string }>`
      select indexdef as definition from pg_indexes
      where schemaname = 'public' and indexname = 'idx_messages_unresolved'`.execute(
      integrationDatabase(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.definition).toContain('thread_reply_count > 0');
    expect(rows[0]?.definition).toContain('resolved_at IS NULL');
  });
});

/**
 * 0047: the tables Better Auth keeps its identity in (D-179). The library checks these against what
 * it expects on its first request and refuses to run on any difference, so what is pinned here is
 * the part of the shape that something else depends on: the keys that make a provider's account one
 * row, the cascade that erasure relies on, and the counter an upsert by key must reach.
 */
describe('integration: the identity tables Better Auth reads', () => {
  const columnsOf = async (
    table: string,
  ): Promise<Map<string, { type: string; nullable: boolean }>> => {
    const { rows } = await sql<{ name: string; type: string; nullable: boolean }>`
      select column_name as name, data_type as type, is_nullable = 'YES' as nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = ${table}`.execute(integrationDatabase());
    return new Map(rows.map((row) => [row.name, { type: row.type, nullable: row.nullable }]));
  };

  const aUser = async (db: Parameters<Parameters<typeof withRollback>[0]>[0]): Promise<string> => {
    const { rows } = await sql<{ id: string }>`
      insert into users (email, username, display_name)
      values (${`ba-${crypto.randomUUID()}@example.test`}, ${`ba-${crypto.randomUUID().slice(0, 8)}`}, 'Ba')
      returning id`.execute(db);
    const [row] = rows;
    if (row === undefined) throw new Error('no user made');
    return row.id;
  };

  test('creates accounts and verifications and keeps users.email unique with COLLATE "C"', async () => {
    const accounts = await columnsOf('accounts');
    for (const column of [
      'id',
      'user_id',
      'account_id',
      'provider_id',
      'access_token',
      'refresh_token',
      'id_token',
      'access_token_expires_at',
      'refresh_token_expires_at',
      'scope',
      'password',
      'created_at',
      'updated_at',
    ]) {
      expect(accounts.has(column)).toBe(true);
    }
    expect(accounts.get('user_id')?.nullable).toBe(false);
    expect(accounts.get('password')?.nullable).toBe(true);

    const verifications = await columnsOf('verifications');
    expect([...verifications.keys()].sort()).toEqual([
      'created_at',
      'expires_at',
      'id',
      'identifier',
      'updated_at',
      'value',
    ]);

    const users = await columnsOf('users');
    expect(users.get('email_verified')).toEqual({ type: 'boolean', nullable: false });
    expect(users.get('is_server_admin')).toEqual({ type: 'boolean', nullable: false });

    const { rows } = await sql<{ collation: string | null; unique_index: number }>`
      select (select collname from pg_collation where oid = a.attcollation) as collation,
             (select count(*)::int from pg_index i
               where i.indrelid = a.attrelid and i.indisunique and i.indnkeyatts = 1
                 and i.indkey[0] = a.attnum) as unique_index
      from pg_attribute a
      where a.attrelid = 'public.users'::regclass and a.attname = 'email'`.execute(
      integrationDatabase(),
    );
    expect(rows[0]).toEqual({ collation: 'C', unique_index: 1 });
  });

  test('a new account is neither verified nor the server administrator until something says so', async () => {
    await withRollback(async (db) => {
      const id = await aUser(db);
      const { rows } = await sql<{ email_verified: boolean; is_server_admin: boolean }>`
        select email_verified, is_server_admin from users where id = ${id}`.execute(db);
      expect(rows[0]).toEqual({ email_verified: false, is_server_admin: false });
    });
  });

  test('an account of a provider is one row: the same provider and account id twice is refused', async () => {
    await withRollback(async (db) => {
      const first = await aUser(db);
      const second = await aUser(db);
      await sql`insert into accounts (user_id, provider_id, account_id) values (${first}, 'github', '42')`.execute(
        db,
      );
      await sql`savepoint dup`.execute(db);
      const refusal =
        await sql`insert into accounts (user_id, provider_id, account_id) values (${second}, 'github', '42')`
          .execute(db)
          .then(
            () => 'taken',
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          );
      expect(refusal).toMatch(/accounts_provider_id_account_id_key/);
      await sql`rollback to savepoint dup`.execute(db);
      await sql`insert into accounts (user_id, provider_id, account_id) values (${second}, 'github', '43')`.execute(
        db,
      );
    });
  });

  test('deleting a user takes its accounts with it', async () => {
    await withRollback(async (db) => {
      const id = await aUser(db);
      await sql`insert into accounts (user_id, provider_id, account_id) values (${id}, 'credential', ${id})`.execute(
        db,
      );
      await sql`delete from users where id = ${id}`.execute(db);
      const { rows } = await sql<{
        n: number;
      }>`select count(*)::int as n from accounts where user_id = ${id}`.execute(db);
      expect(rows[0]?.n).toBe(0);
    });
  });

  test('verifications are looked up by identifier through an index', async () => {
    const { rows } = await sql<{ definition: string }>`
      select indexdef as definition from pg_indexes
      where schemaname = 'public' and tablename = 'verifications' and indexdef like '%(identifier)%'`.execute(
      integrationDatabase(),
    );
    expect(rows).toHaveLength(1);
  });

  test('rate_limits takes an upsert by key and keeps one row per key', async () => {
    await withRollback(async (db) => {
      const key = `203.0.113.7|/sign-in/email|${crypto.randomUUID()}`;
      const bump = (count: number, at: number): Promise<unknown> =>
        sql`insert into rate_limits (key, count, last_request) values (${key}, ${count}, ${at})
            on conflict (key) do update set count = excluded.count, last_request = excluded.last_request`.execute(
          db,
        );
      await bump(1, 1_792_582_590_784);
      await bump(2, 1_792_582_590_999);
      const { rows } = await sql<{ count: number; last_request: string }>`
        select count, last_request from rate_limits where key = ${key}`.execute(db);
      expect(rows).toEqual([{ count: 2, last_request: '1792582590999' }]);
    });
  });
});
