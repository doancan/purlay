/**
 * The probe `testing-preload.integration.test.ts` runs in a `bun test` of its own, against a database
 * that was never migrated. In an ordinary run it does nothing: it is only meaningful there.
 */
import { afterAll, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { setsNamedBy } from './migrator';
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

test.skipIf(process.env['PURLAY_PRELOAD_PROBE'] !== '1')(
  'the sets applied are those MODULES names, on the database the run was pointed at',
  async () => {
    const running = setsNamedBy(process.env['MODULES']).map((set) => set.id);
    await withRollback(async (db) => {
      const recorded = await sql<{
        name: string;
      }>`select name from kysely_migration where name like '%/%'`.execute(db);
      const applied = new Set(recorded.rows.map((row) => row.name.slice(0, row.name.indexOf('/'))));
      expect([...applied].toSorted()).toEqual(running.toSorted());
    });
  },
);
