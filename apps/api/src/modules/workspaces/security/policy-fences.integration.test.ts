/** Current policy is checked before proposals, and final tests re-read actual provider/MFA sources. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { attempt } from '../../../testing/attempt';
import { codeAt, keyOf } from '../../../testing/totp';
import { companyWorkspaceMfaActor, securityOutcome } from './mfa.testing';
import { startWorkspaceMfaChallenge, startWorkspaceMfaEnrollment, verifyWorkspaceMfa } from './mfa';
import {
  createWorkspacePolicyRecovery,
  readWorkspacePolicy,
  recoverWorkspacePolicy,
  testWorkspacePolicy,
  updateWorkspacePolicy,
} from './policy';
import { defaultWorkspacePolicy } from './policy-state';
import { enforcedPolicy, freshPolicyActor, workspacePolicyFixture } from './policy.testing';

afterAll(closeIntegrationDatabase);

describe('integration: policy test source fences', () => {
  test('MFA policy tests explicitly resume after an accepted real challenge; a fresh primary cannot weaken old MFA', async () => {
    await withRollback(async (db) => {
      const f = await workspacePolicyFixture(db);
      const oldRecovery = await createWorkspacePolicyRecovery(f.dependencies, f.actor, {
        policyRevision: null,
      });
      const settings = enforcedPolicy({ requireMfa: true, mfaMaxAgeMinutes: 5 });
      const pending = await testWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: settings,
      });
      expect(pending.status.state).toBe('mfa_enrollment_required');
      const setup = await startWorkspaceMfaEnrollment(f.dependencies, f.actor, {
        policyRevision: null,
        factorRevision: null,
      });
      const key = keyOf(setup.totpURI);
      await verifyWorkspaceMfa(f.dependencies, f.actor, {
        challengeId: setup.challenge.challengeId,
        code: codeAt(key, f.dependencies.clock.now().getTime()),
      });
      f.move(30_000);
      const challenge = await startWorkspaceMfaChallenge(f.dependencies, f.actor, {
        policyRevision: null,
        factorScope: 'workspace',
        purpose: 'policy_test',
        testId: pending.testId,
      });
      await verifyWorkspaceMfa(f.dependencies, f.actor, {
        challengeId: challenge.challengeId,
        code: codeAt(key, f.dependencies.clock.now().getTime()),
      });
      expect(
        (
          await db
            .selectFrom('workspace_access_policy_tests')
            .select('tested_at')
            .where('id', '=', pending.testId)
            .executeTakeFirstOrThrow()
        ).tested_at,
      ).toBeNull();
      const tested = await testWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: settings,
        testId: pending.testId,
        testToken: pending.testToken,
      });
      expect(tested.testId).toBe(pending.testId);
      expect(tested.status.state).toBe('allowed');
      const saved = await updateWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: settings,
        testId: tested.testId,
        testToken: tested.testToken,
      });
      f.move(5 * 60_000 + 1);
      const fresh = await freshPolicyActor(f);
      expect(
        await attempt(
          db,
          async () =>
            await testWorkspacePolicy(f.dependencies, fresh, {
              revision: saved.revision,
              policy: defaultWorkspacePolicy(),
            }),
        ),
      ).toBe('WORKSPACE_ACCESS_REQUIRED');
      expect(
        await attempt(
          db,
          async () =>
            await createWorkspacePolicyRecovery(f.dependencies, fresh, {
              policyRevision: saved.revision,
            }),
        ),
      ).toBe('WORKSPACE_ACCESS_REQUIRED');
      const off = await recoverWorkspacePolicy(f.dependencies, fresh, oldRecovery);
      const nextRecovery = await createWorkspacePolicyRecovery(f.dependencies, fresh, {
        policyRevision: off.revision,
      });
      const step = await startWorkspaceMfaChallenge(f.dependencies, fresh, {
        policyRevision: off.revision,
        factorScope: 'workspace',
        purpose: 'step_up',
      });
      await verifyWorkspaceMfa(f.dependencies, fresh, {
        challengeId: step.challengeId,
        code: codeAt(key, f.dependencies.clock.now().getTime()),
      });
      const nextTest = await testWorkspacePolicy(f.dependencies, fresh, {
        revision: off.revision,
        policy: settings,
      });
      const again = await updateWorkspacePolicy(f.dependencies, fresh, {
        revision: off.revision,
        policy: settings,
        testId: nextTest.testId,
        testToken: nextTest.testToken,
      });
      expect(
        await securityOutcome(
          async () => await recoverWorkspacePolicy(f.dependencies, fresh, oldRecovery),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      expect((await readWorkspacePolicy(f.dependencies, fresh)).revision).toBe(again.revision);
      expect(
        await db
          .selectFrom('workspace_mfa_recovery_codes')
          .select('revision')
          .where('workspace_id', '=', fresh.context.workspaceId)
          .where('purpose', '=', 'policy')
          .execute(),
      ).toEqual([{ revision: nextRecovery.revision }]);
    });
  });

  test('provider replacement requires overlap and a source currently allowed by the old policy', async () => {
    await withRollback(async (db) => {
      const f = await workspacePolicyFixture(db);
      await createWorkspacePolicyRecovery(f.dependencies, f.actor, { policyRevision: null });
      const old = await companyWorkspaceMfaActor(f.dependencies, f.actor);
      const first = enforcedPolicy({ signIn: 'company', allowedConnectionIds: [old.connectionId] });
      const firstTest = await testWorkspacePolicy(f.dependencies, old.actor, {
        revision: null,
        policy: first,
      });
      let saved = await updateWorkspacePolicy(f.dependencies, old.actor, {
        revision: null,
        policy: first,
        testId: firstTest.testId,
        testToken: firstTest.testToken,
      });
      const next = await companyWorkspaceMfaActor(f.dependencies, f.actor);
      const onlyNew = { ...first, allowedConnectionIds: [next.connectionId] };
      expect(
        await attempt(
          db,
          async () =>
            await testWorkspacePolicy(f.dependencies, next.actor, {
              revision: saved.revision,
              policy: onlyNew,
            }),
        ),
      ).toBe('WORKSPACE_ACCESS_REQUIRED');
      const overlap = { ...first, allowedConnectionIds: [old.connectionId, next.connectionId] };
      const overlapTest = await testWorkspacePolicy(f.dependencies, old.actor, {
        revision: saved.revision,
        policy: overlap,
      });
      saved = await updateWorkspacePolicy(f.dependencies, old.actor, {
        revision: saved.revision,
        policy: overlap,
        testId: overlapTest.testId,
        testToken: overlapTest.testToken,
      });
      const newTest = await testWorkspacePolicy(f.dependencies, next.actor, {
        revision: saved.revision,
        policy: onlyNew,
      });
      saved = await updateWorkspacePolicy(f.dependencies, next.actor, {
        revision: saved.revision,
        policy: onlyNew,
        testId: newTest.testId,
        testToken: newTest.testToken,
      });
      expect(
        await attempt(
          db,
          async () =>
            await testWorkspacePolicy(f.dependencies, old.actor, {
              revision: saved.revision,
              policy: first,
            }),
        ),
      ).toBe('WORKSPACE_ACCESS_REQUIRED');
      const changed = { ...onlyNew, maxAgeHours: 2 };
      const stale = await testWorkspacePolicy(f.dependencies, next.actor, {
        revision: saved.revision,
        policy: changed,
      });
      await db
        .updateTable('workspace_identity_connections')
        .set({ revision: crypto.randomUUID() })
        .where('id', '=', next.connectionId)
        .execute();
      expect(
        await attempt(
          db,
          async () =>
            await updateWorkspacePolicy(f.dependencies, next.actor, {
              revision: saved.revision,
              policy: changed,
              testId: stale.testId,
              testToken: stale.testToken,
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      expect((await readWorkspacePolicy(f.dependencies, next.actor)).revision).toBe(saved.revision);
    });
  });
});
