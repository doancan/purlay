/**
 * The one question about a table that may be absent: whether the database has it (`MODULES.md` §5).
 *
 * @needs-modules chat, issues
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { absentTables, tableExists } from './table-exists';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  withRollback,
  type ClonedDatabase,
} from './testing';

// A database of its own (D-228): dropping a table holds its lock until the rollback, and on the shared database
// that deadlocks (40P01) with any file beside it that touches the table.
let own: ClonedDatabase;
beforeAll(async () => {
  own = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await own.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

describe('integration: tables that may not be there', () => {
  test('says whether one table is', async () => {
    await withRollback(async (db) => {
      expect(await tableExists(db, 'issues')).toBe(true);
      await sql`drop table issues`.execute(db);
      expect(await tableExists(db, 'issues')).toBe(false);
      expect(await tableExists(db, 'users')).toBe(true);
    }, own.db);
  });

  test('names those of a list that are not, in the order given', async () => {
    await withRollback(async (db) => {
      expect(await absentTables(db, [])).toEqual([]);
      expect(await absentTables(db, ['issues', 'users'])).toEqual([]);
      await sql`drop table issues`.execute(db);
      await sql`drop table message_reminders`.execute(db);
      expect(
        await absentTables(db, ['message_reminders', 'users', 'issues', 'workspaces']),
      ).toEqual(['message_reminders', 'issues']);
    }, own.db);
  });
});
