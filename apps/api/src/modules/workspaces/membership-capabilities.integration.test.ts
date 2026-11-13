/** A projection displayed by /me must still belong to this exact admission and caller. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, DROP_HOOK_MS, withRollback } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { aUserRow } from '../../testing/users';
import { membershipsOf } from './workspaces';

afterAll(closeIntegrationDatabase, DROP_HOOK_MS);
const now = new Date('2026-11-12T18:00:00Z');

describe('integration: membership capabilities', () => {
  test('only current, unblocked, same-user workspace projections reach membership hydration', async () => {
    await withRollback(async (db) => {
      const person = await aUserRow(db, 'cap-person');
      const stranger = await aUserRow(db, 'cap-stranger');
      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      const [active, stale, blocked] = ids;
      if (active === undefined || stale === undefined || blocked === undefined)
        throw new Error('The fixture needs three workspaces');
      const revision = crypto.randomUUID();
      await db
        .insertInto('workspaces')
        .values(ids.map((id) => ({ id, name: id, slug: id })))
        .execute();
      await db
        .insertInto('workspace_members')
        .values([
          ...ids.map((id) => ({
            workspace_id: id,
            user_id: person.userId,
            role: 'member' as const,
          })),
          { workspace_id: active, user_id: stranger.userId, role: 'member' },
        ])
        .execute();
      await db
        .insertInto('workspace_admission_controls')
        .values([
          ...ids.map((id) => ({
            workspace_id: id,
            user_id: person.userId,
            revision,
            initialized_at: now,
            updated_at: now,
            last_builtin_role: 'member' as const,
            last_access_kind: 'member',
            blocked_at: id === blocked ? now : null,
          })),
          {
            workspace_id: active,
            user_id: stranger.userId,
            revision,
            initialized_at: now,
            updated_at: now,
            last_builtin_role: 'member',
            last_access_kind: 'member',
          },
        ])
        .execute();
      await db
        .insertInto('workspace_member_capabilities')
        .values([
          ...ids.map((id) => ({
            workspace_id: id,
            user_id: person.userId,
            capability: 'audit.read',
            projection_revision: id === stale ? crypto.randomUUID() : revision,
          })),
          {
            workspace_id: active,
            user_id: stranger.userId,
            capability: 'members.invite',
            projection_revision: revision,
          },
        ])
        .execute();
      const memberships = await membershipsOf(db, fixedClock(now), person.userId);
      const byId = new Map(memberships.map((member) => [member.workspace.id, member]));
      expect(memberships).toHaveLength(3);
      expect(byId.get(active)?.workspaceCapabilities).toEqual(['audit.read']);
      expect(byId.get(stale)?.workspaceCapabilities).toEqual([]);
      expect(byId.get(blocked)?.workspaceCapabilities).toEqual([]);
      const activeMembership = byId.get(active);
      if (activeMembership === undefined) throw new Error('Missing active fixture membership');
      expect(await membershipsOf(db, fixedClock(now), person.userId, active)).toEqual([
        activeMembership,
      ]);
      expect(
        (await membershipsOf(db, fixedClock(now), stranger.userId))[0]?.workspaceCapabilities,
      ).toEqual(['members.invite']);
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', active)
        .where('user_id', '=', person.userId)
        .execute();
      expect(
        (await membershipsOf(db, fixedClock(now), person.userId)).map(
          (member) => member.workspace.id,
        ),
      ).not.toContain(active);
    });
  });
});
