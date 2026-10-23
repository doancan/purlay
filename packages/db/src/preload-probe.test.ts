/**
 * The probe `testing-preload.integration.test.ts` runs in a `bun test` of its own, against a database
 * that was never migrated. In an ordinary run it does nothing: it is only meaningful there.
 */
import { afterAll, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { closeIntegrationDatabase, withRollback } from './testing';

afterAll(async () => {
  await closeIntegrationDatabase();
});

test.skipIf(process.env['PURLAY_PRELOAD_PROBE'] !== '1')(
  'a table the latest migration made is there, on the database the run was pointed at',
  async () => {
    await withRollback(async (db) => {
      const found = await sql<{
        name: string | null;
      }>`select to_regclass('public.server_settings')::text as name`.execute(db);
      expect(found.rows[0]?.name).toBe('server_settings');
    });
  },
);
