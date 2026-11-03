/**
 * Every table has one owner, and a foreign key does not cross owners except where the list says (D-250).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { closeIntegrationDatabase, integrationDatabase } from './testing';
import { CROSS_OWNER_FOREIGN_KEYS, TABLE_OWNERS, type TableOwner } from './table-owners';

/** The list, asked about the tables the database names: strings, not the schema's own. */
const owners: Readonly<Record<string, TableOwner>> = TABLE_OWNERS;

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration: who owns each table', () => {
  test('the list names every table of the database, and only those', async () => {
    const { rows } = await sql<{ name: string }>`
      select table_name as name from information_schema.tables
      where table_schema = current_schema() and table_type = 'BASE TABLE'
        and table_name not like 'kysely\_%'
      order by 1`.execute(integrationDatabase());
    expect(Object.keys(TABLE_OWNERS).sort()).toEqual(rows.map((row) => row.name));
  });

  test('a foreign key goes from a module to the core or within its owner, and the exceptions only shrink', async () => {
    const { rows } = await sql<{ child: string; parent: string }>`
      select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
      from pg_constraint c
      where c.contype = 'f' and c.connamespace = current_schema()::regnamespace`.execute(
      integrationDatabase(),
    );
    const crossing = rows
      .filter(({ child, parent }) => {
        const from = owners[child];
        const to = owners[parent];
        // Within an owner, or from a module to the core, is the rule; anything else is a crossing.
        return from !== to && to !== 'core';
      })
      .map(({ child, parent }) => `${child} -> ${parent}`);
    expect([...new Set(crossing)].sort()).toEqual([...CROSS_OWNER_FOREIGN_KEYS].sort());
  });
});
