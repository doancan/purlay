/** Administrative policy test/save and offline recovery run over real native sources and SQL receipts. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { attempt } from '../../../testing/attempt';
import { companyWorkspaceMfaActor, securityOutcome } from './mfa.testing';
import { workspaceAccessStatus } from './access';
import {
  createWorkspacePolicyRecovery,
  previewWorkspacePolicy,
  readWorkspacePolicy,
  recoverWorkspacePolicy,
  testWorkspacePolicy,
  updateWorkspacePolicy,
} from './policy';
import { defaultWorkspacePolicy } from './policy-state';
import { enforcedPolicy, freshPolicyActor, workspacePolicyFixture } from './policy.testing';

afterAll(closeIntegrationDatabase);

describe('integration: workspace policy administration', () => {
  test('test receipts reject another native session, recovery replacement, role demotion and expiry', async () => {
    await withRollback(async (db) => {
      const f = await workspacePolicyFixture(db);
      await createWorkspacePolicyRecovery(f.dependencies, f.actor, { policyRevision: null });
      const settings = enforcedPolicy();
      const stale = await testWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: settings,
      });
      await createWorkspacePolicyRecovery(f.dependencies, f.actor, { policyRevision: null });
      expect(
        await attempt(
          db,
          async () =>
            await updateWorkspacePolicy(f.dependencies, f.actor, {
              revision: null,
              policy: settings,
              testId: stale.testId,
              testToken: stale.testToken,
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      const tested = await testWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: settings,
      });
      const input = {
        revision: null,
        policy: settings,
        testId: tested.testId,
        testToken: tested.testToken,
      };
      const another = await freshPolicyActor(f);
      expect(
        await attempt(db, async () => await updateWorkspacePolicy(f.dependencies, another, input)),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      await db
        .updateTable('workspace_members')
        .set({ role: 'admin' })
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('user_id', '=', f.actor.context.userId)
        .execute();
      expect(
        await attempt(db, async () => await updateWorkspacePolicy(f.dependencies, f.actor, input)),
      ).toBe('FORBIDDEN');
      await db
        .updateTable('workspace_members')
        .set({ role: 'owner' })
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('user_id', '=', f.actor.context.userId)
        .execute();
      await db
        .updateTable('workspace_access_policy_tests')
        .set({ expires_at: new Date(f.dependencies.clock.now().getTime() + 500) })
        .where('id', '=', tested.testId)
        .execute();
      f.move(1_000);
      expect(
        await attempt(db, async () => await updateWorkspacePolicy(f.dependencies, f.actor, input)),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      expect((await readWorkspacePolicy(f.dependencies, f.actor)).epoch).toBe('0');
    });
  });

  test('current full roles and exact one-time tests fence save, while canonical provider order does not', async () => {
    await withRollback(async (db) => {
      const f = await workspacePolicyFixture(db);
      expect((await readWorkspacePolicy(f.dependencies, f.actor)).epoch).toBe('0');
      expect(
        await securityOutcome(async () => await readWorkspacePolicy(f.dependencies, f.member)),
      ).toBe('FORBIDDEN');
      const recovery = await createWorkspacePolicyRecovery(f.dependencies, f.actor, {
        policyRevision: null,
      });
      const a = await companyWorkspaceMfaActor(f.dependencies, f.actor);
      const b = await companyWorkspaceMfaActor(f.dependencies, f.actor);
      const settings = enforcedPolicy({ allowedConnectionIds: [a.connectionId, b.connectionId] });
      const tested = await testWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: settings,
      });
      expect(tested.status.state).toBe('allowed');
      expect(
        await attempt(
          db,
          async () =>
            await updateWorkspacePolicy(f.dependencies, f.actor, {
              revision: null,
              policy: settings,
              testId: tested.testId,
              testToken: 'B'.repeat(43),
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      expect(
        await attempt(
          db,
          async () =>
            await updateWorkspacePolicy(f.dependencies, f.actor, {
              revision: null,
              policy: { ...settings, maxAgeHours: 2 },
              testId: tested.testId,
              testToken: tested.testToken,
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      const saved = await updateWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: { ...settings, allowedConnectionIds: [...settings.allowedConnectionIds].reverse() },
        testId: tested.testId,
        testToken: tested.testToken,
      });
      expect(saved.mode).toBe('enforced');
      expect(saved.epoch).toBe('1');
      expect(saved.allowedConnectionIds).toEqual([...settings.allowedConnectionIds].sort());
      expect(
        await securityOutcome(
          async () =>
            await updateWorkspacePolicy(f.dependencies, f.actor, {
              revision: saved.revision,
              policy: defaultWorkspacePolicy(),
              testId: tested.testId,
              testToken: tested.testToken,
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .execute();
      expect(JSON.stringify(audit)).not.toContain(tested.testToken);
      expect(JSON.stringify(audit)).not.toContain(recovery.recoveryCode);
      expect((await readWorkspacePolicy(f.dependencies, f.actor)).revision).toBe(saved.revision);
    });
  });

  test('reader attestation fails closed for enforcement but explicit offline disable remains operable', async () => {
    await withRollback(async (db) => {
      const f = await workspacePolicyFixture(db);
      const recovery = await createWorkspacePolicyRecovery(f.dependencies, f.actor, {
        policyRevision: null,
      });
      const settings = enforcedPolicy();
      const tested = await testWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: settings,
      });
      const request = {
        revision: null,
        policy: settings,
        testId: tested.testId,
        testToken: tested.testToken,
      };
      for (const policyReadersReady of [
        (): Promise<boolean> => Promise.resolve(false),
        (): Promise<boolean> => Promise.reject(new Error('registry unavailable')),
      ])
        expect(
          await securityOutcome(
            async () =>
              await updateWorkspacePolicy(
                { ...f.dependencies, policyReadersReady },
                f.actor,
                request,
              ),
          ),
        ).toBe('PEERS_BEHIND');
      const saved = await updateWorkspacePolicy(f.dependencies, f.actor, request);
      const sessionsBefore = await db
        .selectFrom('sessions')
        .selectAll()
        .where('user_id', '=', f.actor.context.userId)
        .orderBy('id')
        .execute();
      const recovered = await recoverWorkspacePolicy(
        { ...f.dependencies, policyReadersReady: (): Promise<boolean> => Promise.resolve(false) },
        f.actor,
        recovery,
      );
      expect(recovered.mode).toBe('off');
      expect(
        await db
          .selectFrom('workspace_mfa_recovery_codes')
          .select('id')
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .where('user_id', '=', f.actor.context.userId)
          .where('purpose', '=', 'policy')
          .execute(),
      ).toEqual([]);
      expect(BigInt(recovered.epoch)).toBe(BigInt(saved.epoch) + 1n);
      expect(
        await db
          .selectFrom('sessions')
          .selectAll()
          .where('user_id', '=', f.actor.context.userId)
          .orderBy('id')
          .execute(),
      ).toEqual(sessionsBefore);
      expect(
        await securityOutcome(
          async () => await recoverWorkspacePolicy(f.dependencies, f.actor, recovery),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      expect((await readWorkspacePolicy(f.dependencies, f.actor)).revision).toBe(
        recovered.revision,
      );
    });
  });

  test('company-only enforcement requires a tested nonempty provider and genuine current company source', async () => {
    await withRollback(async (db) => {
      const f = await workspacePolicyFixture(db);
      const recovery = await createWorkspacePolicyRecovery(f.dependencies, f.actor, {
        policyRevision: null,
      });
      const company = await companyWorkspaceMfaActor(f.dependencies, f.actor);
      expect(
        await securityOutcome(
          async () =>
            await testWorkspacePolicy(f.dependencies, f.actor, {
              revision: null,
              policy: enforcedPolicy({ signIn: 'company' }),
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_NOT_READY');
      const settings = enforcedPolicy({
        signIn: 'company',
        allowedConnectionIds: [company.connectionId],
      });
      const wrongSource = await testWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: settings,
      });
      expect(wrongSource.status.state).toBe('sign_in_required');
      expect(
        await attempt(
          db,
          async () =>
            await updateWorkspacePolicy(f.dependencies, f.actor, {
              revision: null,
              policy: settings,
              testId: wrongSource.testId,
              testToken: wrongSource.testToken,
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_NOT_READY');
      const tested = await testWorkspacePolicy(f.dependencies, company.actor, {
        revision: null,
        policy: settings,
      });
      const saved = await updateWorkspacePolicy(f.dependencies, company.actor, {
        revision: null,
        policy: settings,
        testId: tested.testId,
        testToken: tested.testToken,
      });
      expect(
        await securityOutcome(async () => await readWorkspacePolicy(f.dependencies, f.actor)),
      ).toBe('WORKSPACE_ACCESS_REQUIRED');
      expect(
        await attempt(
          db,
          async () =>
            await testWorkspacePolicy(f.dependencies, f.actor, {
              revision: saved.revision,
              policy: defaultWorkspacePolicy(),
            }),
        ),
      ).toBe('WORKSPACE_ACCESS_REQUIRED');
      expect(
        await securityOutcome(
          async () =>
            await createWorkspacePolicyRecovery(f.dependencies, f.actor, {
              policyRevision: saved.revision,
            }),
        ),
      ).toBe('WORKSPACE_ACCESS_REQUIRED');
      expect((await recoverWorkspacePolicy(f.dependencies, f.actor, recovery)).mode).toBe('off');
    });
  });

  test('inactive expired deadlines remain capped after a later permissive policy', async () => {
    await withRollback(async (db) => {
      const f = await workspacePolicyFixture(db);
      await createWorkspacePolicyRecovery(f.dependencies, f.actor, { policyRevision: null });
      await workspaceAccessStatus(f.dependencies, f.member);
      const inactive = await freshPolicyActor(f, f.member);
      f.move(4 * 60_000);
      const settings = enforcedPolicy({ idleMinutes: 5 });
      const tested = await testWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: settings,
      });
      const saved = await updateWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: settings,
        testId: tested.testId,
        testToken: tested.testToken,
      });
      const cap = await db
        .selectFrom('workspace_session_assurances')
        .select('expires_at')
        .where('session_id', '=', f.member.sessionId)
        .executeTakeFirstOrThrow();
      expect(new Date(cap.expires_at).getTime()).toBe(
        f.dependencies.clock.now().getTime() + 60_000,
      );
      const unmaterializedCap = await db
        .selectFrom('workspace_session_assurances')
        .select('expires_at')
        .where('session_id', '=', inactive.sessionId)
        .executeTakeFirst();
      expect(unmaterializedCap).toBeDefined();
      expect(new Date(unmaterializedCap?.expires_at ?? 0).getTime()).toBe(
        f.dependencies.clock.now().getTime() + 5 * 60_000,
      );
      f.move(6 * 60_000);
      const fresh = await freshPolicyActor(f);
      const relaxed = await testWorkspacePolicy(f.dependencies, fresh, {
        revision: saved.revision,
        policy: defaultWorkspacePolicy(),
      });
      await updateWorkspacePolicy(f.dependencies, fresh, {
        revision: saved.revision,
        policy: defaultWorkspacePolicy(),
        testId: relaxed.testId,
        testToken: relaxed.testToken,
      });
      expect((await workspaceAccessStatus(f.dependencies, f.member)).state).toBe('expired');
      expect((await workspaceAccessStatus(f.dependencies, inactive)).state).toBe('expired');
      expect(
        (
          await previewWorkspacePolicy(f.dependencies, fresh, {
            revision: (await readWorkspacePolicy(f.dependencies, fresh)).revision,
            policy: defaultWorkspacePolicy(),
            limit: 1,
          })
        ).affectedMemberCount,
      ).toBeGreaterThan(0);
    });
  });
});
