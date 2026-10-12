/**
 * What a soft-deleted user or workspace is to the reads that list them (D-9).
 *
 * `deleted_at` is a tombstone, not a delete: the row stays for the audit and for the
 * foreign keys that point at it. Every read that lists people or places has to leave
 * the tombstones out, and a read that forgets one shows a deleted account in the
 * member list, or a deleted workspace in `/api/me` for a client to try to open. The
 * mutation run found all four filters removable without a test noticing.
 *
 * Inside a transaction that is rolled back (D-46).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { createWorkspace, membersIn, membershipsOf, meOf, workspaceIn } from './workspaces';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const DELETED = '2026-09-01T00:00:00.000Z';

const fails = async (attempt: Promise<unknown>): Promise<boolean> =>
  await attempt.then(
    () => false,
    () => true,
  );

const aWorkspaceOf = async (
  db: Transaction,
  owner: string,
  name: string,
): Promise<{ id: string; name: string }> => {
  const workspace = await createWorkspace(db, clock, owner, { name, slug: aUniqueSlug('ws') });
  return { id: workspace.id, name };
};

describe('integration: tombstones are not listed', () => {
  test('a deleted user is not in the member list, and the others still are', async () => {
    await withRollback(async (db) => {
      const owner = await aUserRow(db, 'owner');
      const gone = await aUserRow(db, 'gone');
      const workspace = await aWorkspaceOf(db, owner.userId, 'Members');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: workspace.id, user_id: gone.userId, role: 'member' })
        .execute();
      const context = await requireWorkspaceMembership(db, owner.userId, workspace.id);

      // The control: before the tombstone, both are listed.
      expect((await membersIn(db, context)).map((m) => m.user.id).sort()).toEqual(
        [owner.userId, gone.userId].sort(),
      );

      await db
        .updateTable('users')
        .set({ deleted_at: DELETED })
        .where('id', '=', gone.userId)
        .execute();
      expect((await membersIn(db, context)).map((m) => m.user.id)).toEqual([owner.userId]);
    });
  });

  test('a deleted workspace is not among the memberships, and /me still answers', async () => {
    await withRollback(async (db) => {
      const user = await aUserRow(db, 'member');
      const kept = await aWorkspaceOf(db, user.userId, 'Kept');
      const gone = await aWorkspaceOf(db, user.userId, 'Gone');

      expect(
        (await membershipsOf(db, clock, user.userId)).map((m) => m.workspace.id).sort(),
      ).toEqual([kept.id, gone.id].sort());

      await db
        .updateTable('workspaces')
        .set({ deleted_at: DELETED })
        .where('id', '=', gone.id)
        .execute();
      expect((await membershipsOf(db, clock, user.userId)).map((m) => m.workspace.id)).toEqual([
        kept.id,
      ]);
      expect((await meOf(db, clock, user.userId)).memberships.map((m) => m.workspace.id)).toEqual([
        kept.id,
      ]);
    });
  });

  test('a deleted user has no /me', async () => {
    await withRollback(async (db) => {
      const user = await aUserRow(db, 'leaving');
      expect((await meOf(db, clock, user.userId)).user.id).toBe(user.userId);
      await db
        .updateTable('users')
        .set({ deleted_at: DELETED })
        .where('id', '=', user.userId)
        .execute();
      expect(await fails(meOf(db, clock, user.userId))).toBe(true);
    });
  });

  test('a workspace deleted after its context was minted is not read through it', async () => {
    await withRollback(async (db) => {
      const user = await aUserRow(db, 'reader');
      const workspace = await aWorkspaceOf(db, user.userId, 'Doomed');
      const context = await requireWorkspaceMembership(db, user.userId, workspace.id);
      expect((await workspaceIn(db, context)).id).toBe(workspace.id);

      await db
        .updateTable('workspaces')
        .set({ deleted_at: DELETED })
        .where('id', '=', workspace.id)
        .execute();
      expect(await fails(workspaceIn(db, context))).toBe(true);
    });
  });
});
