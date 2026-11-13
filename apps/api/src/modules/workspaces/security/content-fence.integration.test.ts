/** A projection repeats captured authority in its own SQL, after a guard has already admitted the request. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import {
  recordPrimaryAuthentication,
  retainUnknownAuthentication,
} from '../../auth/authentication-evidence';
import { workspaceAccessStatus } from './access';
import {
  companyWorkspaceMfaActor,
  workspaceMfaFixture,
  type WorkspaceMfaFixture,
} from './mfa.testing';
import { aMovableClock } from '../../../testing/doubles';
import { aSession } from '../../../testing/signed-in';
import {
  activeWorkspaceMembership,
  requireCapturedWorkspaceAccess,
} from '../../../platform/membership-access';
import { withinRequest, type RequestScope } from '../../../platform/logging';
import {
  currentWorkspaceContentFence,
  requireWorkspaceSessionAccess,
} from '../../../platform/workspace-content-fence';
import type { WorkspaceAccessRead } from '../../../platform/workspace-access';

afterAll(closeIntegrationDatabase);

const fixture = async (db: Executor, known = true): Promise<WorkspaceMfaFixture> => {
  const old = await workspaceMfaFixture(db);
  const clock = aMovableClock(new Date());
  const session = await aSession(db, clock, old.actor.context.userId);
  const actor = { ...old.actor, sessionId: session.sessionId };
  if (known)
    await recordPrimaryAuthentication(db, session.sessionId, actor.context.userId, {
      method: 'password',
      authenticatedAt: clock.now(),
    });
  const f = { ...old, actor, move: clock.advance, dependencies: { ...old.dependencies, clock } };
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
      mode: known ? 'enforced' : 'off',
      sign_in: 'any',
      require_mfa: false,
      idle_minutes: 15,
      max_age_hours: 1,
      mfa_max_age_minutes: 5,
    })
    .execute();
  if (known) expect((await workspaceAccessStatus(f.dependencies, actor)).state).toBe('allowed');
  return f;
};
const input = (
  f: WorkspaceMfaFixture,
): Omit<WorkspaceAccessRead, 'workspaceIds'> & { readonly workspaceId: string } => ({
  sessionId: f.actor.sessionId,
  userId: f.actor.context.userId,
  workspaceId: f.actor.context.workspaceId,
  now: f.dependencies.clock.now(),
  lifetime: f.dependencies.lifetime(),
});
const scopeOf = (f: WorkspaceMfaFixture): RequestScope => ({
  requestId: 'final-workspace-proof',
  startedAt: 0,
  sessionId: f.actor.sessionId,
});
const rows = async (f: WorkspaceMfaFixture): Promise<number> =>
  (
    await f.dependencies.database
      .selectFrom('workspace_members')
      .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
      .select('workspaces.id')
      .where('workspace_members.user_id', '=', f.actor.context.userId)
      .where('workspaces.id', '=', f.actor.context.workspaceId)
      .where(activeWorkspaceMembership())
      .execute()
  ).length;

describe('integration: final workspace content fence', () => {
  test('missing provenance never admits a governed projection; legacy off proof remains exact and copies are refused', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db, false);
      expect(await rows(f)).toBe(0);
      expect(
        await requireWorkspaceSessionAccess(db, input(f)).catch((error: unknown) => error),
      ).toMatchObject({ body: { code: 'WORKSPACE_ACCESS_REQUIRED' } });
      const scope = scopeOf(f);
      expect(
        await requireCapturedWorkspaceAccess(
          db,
          f.actor.context.userId,
          f.actor.context.workspaceId,
        ).catch((error: unknown) => error),
      ).toMatchObject({ body: { code: 'WORKSPACE_ACCESS_REQUIRED' } });
      await withinRequest(scope, async () => {
        await requireWorkspaceSessionAccess(db, input(f));
        expect(await rows(f)).toBe(1);
        await requireCapturedWorkspaceAccess(
          db,
          f.actor.context.userId,
          f.actor.context.workspaceId,
        );
        expect(
          await requireCapturedWorkspaceAccess(
            db,
            f.member.context.userId,
            f.actor.context.workspaceId,
          ).catch((error: unknown) => error),
        ).toMatchObject({ body: { code: 'WORKSPACE_ACCESS_REQUIRED' } });
        await retainUnknownAuthentication(db, f.actor.sessionId, f.actor.context.userId);
        expect(await rows(f)).toBe(0);
        await requireWorkspaceSessionAccess(db, input(f));
        expect(await rows(f)).toBe(1);
        const original = scope.workspaceFences?.get(f.actor.context.workspaceId);
        if (original === undefined) throw new Error('Missing captured fence');
        scope.workspaceFences?.set(f.actor.context.workspaceId, { ...original });
        expect(() => currentWorkspaceContentFence()).toThrow('copied workspace content fence');
      });
    });
  });

  test('retained epoch, current policy row, assurance ending and native revocation fence late projection', async () => {
    for (const change of ['epoch', 'policy', 'assurance', 'session', 'suspended'] as const) {
      await withRollback(async (db) => {
        const f = await fixture(db);
        await withinRequest(scopeOf(f), async () => {
          await requireWorkspaceSessionAccess(db, input(f));
          expect(await rows(f)).toBe(1);
          if (change === 'epoch')
            await db
              .updateTable('workspaces')
              .set({ access_policy_epoch: '2' })
              .where('id', '=', f.actor.context.workspaceId)
              .execute();
          if (change === 'policy')
            await db
              .deleteFrom('workspace_access_policies')
              .where('workspace_id', '=', f.actor.context.workspaceId)
              .execute();
          if (change === 'assurance')
            await db
              .updateTable('workspace_session_assurances')
              .set({ ended_at: f.dependencies.clock.now(), end_reason: 'source_revoked' })
              .where('session_id', '=', f.actor.sessionId)
              .execute();
          if (change === 'session')
            await db
              .updateTable('sessions')
              .set({ revoked_at: f.dependencies.clock.now() })
              .where('id', '=', f.actor.sessionId)
              .execute();
          if (change === 'suspended')
            await db
              .updateTable('users')
              .set({ suspended_at: f.dependencies.clock.now() })
              .where('id', '=', f.actor.context.userId)
              .execute();
          expect(await rows(f)).toBe(0);
        });
      });
    }
  });

  test('a current captured global factor is required again by the final statement', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const factor = await db
        .insertInto('two_factors')
        .values({
          id: crypto.randomUUID(),
          user_id: f.actor.context.userId,
          secret: 'native sealed fixture',
          backup_codes: 'native backups',
          verified: true,
        })
        .returning(['id', 'assurance_revision'])
        .executeTakeFirstOrThrow();
      await db
        .updateTable('two_factors')
        .set({ last_assurance_counter: 42 })
        .where('id', '=', factor.id)
        .execute();
      await db
        .updateTable('session_authentication_evidence')
        .set({
          global_mfa_factor_id: factor.id,
          global_mfa_factor_revision: factor.assurance_revision,
          global_mfa_method: 'totp',
          global_mfa_counter: 42,
          global_mfa_verified_at: f.dependencies.clock.now(),
        })
        .where('session_id', '=', f.actor.sessionId)
        .execute();
      await db
        .updateTable('workspace_access_policies')
        .set({ require_mfa: true })
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .execute();
      expect((await workspaceAccessStatus(f.dependencies, f.actor)).state).toBe('allowed');
      await withinRequest(scopeOf(f), async () => {
        await requireWorkspaceSessionAccess(db, input(f));
        expect(await rows(f)).toBe(1);
        await db
          .updateTable('two_factors')
          .set({ verified: false })
          .where('id', '=', factor.id)
          .execute();
        expect(await rows(f)).toBe(0);
      });
    });
  });

  test('company origin is checked after admission without global credential authority', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const company = await companyWorkspaceMfaActor(f.dependencies, f.actor);
      const source = { ...f, actor: company.actor };
      expect((await workspaceAccessStatus(f.dependencies, company.actor)).state).toBe('allowed');
      await withinRequest(scopeOf(source), async () => {
        await requireWorkspaceSessionAccess(db, input(source));
        expect(await rows(source)).toBe(1);
        await db
          .updateTable('workspace_identity_connections')
          .set({ enabled: false })
          .where('id', '=', company.connectionId)
          .execute();
        expect(await rows(source)).toBe(0);
      });
    });
  });
});
