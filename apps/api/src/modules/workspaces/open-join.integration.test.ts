/**
 * Open join against a real database (D-37).
 *
 * The case that matters most is the one that writes nothing: the owner signing
 * in again must stay the owner. A join written as an upsert would demote them,
 * and with one owner that breaks I-2 from an endpoint that is not about roles.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { createWorkspace } from './workspaces';
import { joinOpenWorkspace } from './open-join';
import { aUniqueSlug, aUserRow } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

/** Unique per run: a developer's own workspace with one of these slugs must not fail a test. */
const OPEN = aUniqueSlug('oj-open');
const AGAIN = aUniqueSlug('oj-again');
const NOT_CREATED_YET = aUniqueSlug('oj-not-created-yet');
const DELETED = aUniqueSlug('oj-deleted');

const aUser = async (db: Executor, name: string): Promise<string> =>
  (await aUserRow(db, name)).userId;

const roleOf = async (
  db: Executor,
  workspaceId: string,
  userId: string,
): Promise<string | undefined> =>
  (
    await db
      .selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .executeTakeFirst()
  )?.role;

describe('integration: open join', () => {
  test('a user who is not in the open workspace joins it as a member', async () => {
    await withRollback(async (db) => {
      const owner = await aUser(db, 'oj-owner');
      const newcomer = await aUser(db, 'oj-newcomer');
      const workspace = await createWorkspace(db, clock, owner, { name: 'Open', slug: OPEN });

      expect(await roleOf(db, workspace.id, newcomer)).toBeUndefined();
      expect(await joinOpenWorkspace(db, clock, OPEN, newcomer)).toBe('joined');
      expect(await roleOf(db, workspace.id, newcomer)).toBe('member');
    });
  });

  test('signing in again changes nothing, and the owner stays the owner', async () => {
    await withRollback(async (db) => {
      const owner = await aUser(db, 'oj-again-owner');
      const newcomer = await aUser(db, 'oj-again-newcomer');
      const workspace = await createWorkspace(db, clock, owner, {
        name: 'Open',
        slug: AGAIN,
      });

      expect(await joinOpenWorkspace(db, clock, AGAIN, owner)).toBe('already a member');
      expect(await roleOf(db, workspace.id, owner)).toBe('owner');

      await joinOpenWorkspace(db, clock, AGAIN, newcomer);
      expect(await joinOpenWorkspace(db, clock, AGAIN, newcomer)).toBe('already a member');
      const rows = await db
        .selectFrom('workspace_members')
        .select('id')
        .where('workspace_id', '=', workspace.id)
        .where('user_id', '=', newcomer)
        .execute();
      expect(rows).toHaveLength(1);
    });
  });

  test('a slug with no workspace yet writes nothing and does not refuse', async () => {
    await withRollback(async (db) => {
      const user = await aUser(db, 'oj-early');
      expect(await joinOpenWorkspace(db, clock, NOT_CREATED_YET, user)).toBe('no such workspace');
      const rows = await db
        .selectFrom('workspace_members')
        .select('id')
        .where('user_id', '=', user)
        .execute();
      expect(rows).toEqual([]);
    });
  });

  test('a deleted workspace is not open, whatever its slug', async () => {
    await withRollback(async (db) => {
      const owner = await aUser(db, 'oj-deleted-owner');
      const newcomer = await aUser(db, 'oj-deleted-newcomer');
      const workspace = await createWorkspace(db, clock, owner, {
        name: 'Gone',
        slug: DELETED,
      });
      await db
        .updateTable('workspaces')
        .set({ deleted_at: clock.now() })
        .where('id', '=', workspace.id)
        .execute();

      expect(await joinOpenWorkspace(db, clock, DELETED, newcomer)).toBe('no such workspace');
      expect(await roleOf(db, workspace.id, newcomer)).toBeUndefined();
    });
  });
});
