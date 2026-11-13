import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  withRollback,
  type Selectable,
  type WorkspaceSessionAssurances,
} from '@purlay/db';
import { requireWorkspaceSecurityMembership } from '../../../platform/tenancy';
import { readWorkspaceAccessDecision } from '../../../platform/workspace-access';
import { aUniqueSlug } from '../../../testing/users';
import { recordWorkspaceActivity } from './activity';
import { workspaceAccessStatus } from './access';
import { workspaceMfaFixture, type WorkspaceMfaFixture } from './mfa.testing';
import type { WorkspaceSecurityActor } from './authority';

afterAll(closeIntegrationDatabase);
const MINUTE = 60_000;

const governed = async (
  f: WorkspaceMfaFixture,
  actor: WorkspaceSecurityActor = f.actor,
): Promise<void> => {
  const db = f.dependencies.database;
  await db
    .updateTable('workspaces')
    .set({ access_policy_epoch: '1' })
    .where('id', '=', actor.context.workspaceId)
    .execute();
  await db
    .insertInto('workspace_access_policies')
    .values({
      workspace_id: actor.context.workspaceId,
      epoch: '1',
      mode: 'enforced',
      sign_in: 'any',
      allowed_connection_ids: [],
      require_mfa: false,
      idle_minutes: 15,
      max_age_hours: 1,
      mfa_max_age_minutes: 5,
    })
    .execute();
  expect((await workspaceAccessStatus(f.dependencies, actor)).state).toBe('allowed');
};
const assurance = async (
  f: WorkspaceMfaFixture,
  actor: WorkspaceSecurityActor = f.actor,
): Promise<Selectable<WorkspaceSessionAssurances>> =>
  await f.dependencies.database
    .selectFrom('workspace_session_assurances')
    .selectAll()
    .where('workspace_id', '=', actor.context.workspaceId)
    .where('session_id', '=', actor.sessionId)
    .executeTakeFirstOrThrow();

describe('integration: foreground workspace activity', () => {
  test('A activity renews only A idle time; reads and the global native session do not renew it', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await governed(f);
      const b = await db
        .insertInto('workspaces')
        .values({ name: 'B', slug: aUniqueSlug('idle-b') })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: b.id, user_id: f.actor.context.userId, role: 'owner' })
        .execute();
      const other = {
        ...f.actor,
        context: await requireWorkspaceSecurityMembership(db, f.actor.context.userId, b.id),
      };
      await governed(f, other);
      const beforeA = await assurance(f);
      const beforeB = await assurance(f, other);
      f.move(2 * MINUTE);
      await readWorkspaceAccessDecision(db, {
        sessionId: f.actor.sessionId,
        userId: f.actor.context.userId,
        workspaceId: f.actor.context.workspaceId,
        now: f.dependencies.clock.now(),
        lifetime: f.dependencies.lifetime(),
      });
      expect(await assurance(f)).toEqual(beforeA);
      await recordWorkspaceActivity(f.dependencies, f.actor);
      const afterA = await assurance(f);
      expect(new Date(afterA.last_used_at)).toEqual(f.dependencies.clock.now());
      expect(new Date(afterA.expires_at).getTime()).toBe(
        new Date(beforeA.expires_at).getTime() + 2 * MINUTE,
      );
      expect(afterA.mfa_expires_at).toBe(beforeA.mfa_expires_at);
      expect(await assurance(f, other)).toEqual(beforeB);
      const native = await db
        .selectFrom('sessions')
        .select('last_used_at')
        .where('id', '=', f.actor.sessionId)
        .executeTakeFirstOrThrow();
      expect(new Date(native.last_used_at)).toEqual(new Date(beforeA.last_used_at));
    });
  });

  test('activity never passes the original primary-age cap or revives an expired base', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await governed(f);
      const start = f.dependencies.clock.now().getTime();
      for (let i = 0; i < 4; i += 1) {
        f.move(14 * MINUTE);
        await recordWorkspaceActivity(f.dependencies, f.actor);
      }
      const before = await assurance(f);
      expect(new Date(before.expires_at).getTime()).toBe(start + 60 * MINUTE);
      f.move(5 * MINUTE);
      expect(
        await recordWorkspaceActivity(f.dependencies, f.actor).catch((error: unknown) => error),
      ).toMatchObject({
        body: { code: 'WORKSPACE_ACCESS_REQUIRED' },
      });
      expect(await assurance(f)).toEqual(before);
    });
  });

  test('an earlier retained cap, stale threshold and terminal ending remain intact', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await governed(f);
      const initial = await assurance(f);
      f.move(MINUTE - 1);
      await recordWorkspaceActivity(f.dependencies, f.actor);
      expect(await assurance(f)).toEqual(initial);
      const cap = new Date(f.dependencies.clock.now().getTime() + 4 * MINUTE);
      await db
        .updateTable('workspace_session_assurances')
        .set({ expires_at: cap })
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('session_id', '=', f.actor.sessionId)
        .execute();
      f.move(2 * MINUTE);
      await recordWorkspaceActivity(f.dependencies, f.actor);
      expect(new Date((await assurance(f)).expires_at)).toEqual(cap);
      await db
        .updateTable('workspace_session_assurances')
        .set({ ended_at: f.dependencies.clock.now(), end_reason: 'expired' })
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('session_id', '=', f.actor.sessionId)
        .execute();
      const ended = await assurance(f);
      expect(
        await recordWorkspaceActivity(f.dependencies, f.actor).catch((error: unknown) => error),
      ).toMatchObject({
        body: { code: 'WORKSPACE_ACCESS_REQUIRED' },
      });
      expect(await assurance(f)).toEqual(ended);
    });
  });
});
