/** The one question about a table that may be absent: whether the database has it (`MODULES.md` §5).
 *
 * @needs-modules chat, issues
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { absentTables, tableExists } from './table-exists';
import { closeIntegrationDatabase, withRollback } from './testing';

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration: tables that may not be there', () => {
  test('says whether one table is', async () => {
    await withRollback(async (db) => {
      expect(await tableExists(db, 'issues')).toBe(true);
      await sql`drop table issues`.execute(db);
      expect(await tableExists(db, 'issues')).toBe(false);
      expect(await tableExists(db, 'users')).toBe(true);
    });
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
    });
  });
});
