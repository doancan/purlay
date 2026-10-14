/**
 * The foreign keys that point at a message, as the database has them, are exactly the ones a refusal
 * names as the message not found (D-139 §2): a key added later is a `500` until it is listed, and this
 * says so before anybody meets it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback } from '@purlay/db';
import { MESSAGE_REFERENCES } from '../../platform/gone-message';

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration: what refers to a message', () => {
  test('every foreign key onto messages is mapped, and every mapped one exists', async () => {
    await withRollback(async (db) => {
      const { rows } = await sql<{ name: string }>`
        select conname as name from pg_constraint
        where contype = 'f' and confrelid = 'messages'::regclass
        order by conname
      `.execute(db);
      expect(rows.map((row) => row.name)).toEqual([...MESSAGE_REFERENCES].sort());
    });
  });
});
