/** Enforced-company recovery regeneration requires both the live allowed source and a fresh independent native session. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { attempt } from '../../../testing/attempt';
import { companyWorkspaceMfaActor, securityOutcome } from './mfa.testing';
import {
  createWorkspacePolicyRecovery,
  readWorkspacePolicy,
  recoverWorkspacePolicy,
  testWorkspacePolicy,
  updateWorkspacePolicy,
} from './policy';
import { enforcedPolicy, freshPolicyActor, workspacePolicyFixture } from './policy.testing';

afterAll(closeIntegrationDatabase);

describe('integration: independent owner recovery', () => {
  test('regeneration needs the exact recovery_setup purpose and both native sources; no permissive window is introduced', async () => {
    await withRollback(async (db) => {
      const f = await workspacePolicyFixture(db);
      const old = await createWorkspacePolicyRecovery(f.dependencies, f.actor, {
        policyRevision: null,
      });
      const company = await companyWorkspaceMfaActor(f.dependencies, f.actor);
      const settings = enforcedPolicy({
        signIn: 'company',
        allowedConnectionIds: [company.connectionId],
      });
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
        await attempt(
          db,
          async () => await recoverWorkspacePolicy(f.dependencies, company.actor, old),
        ),
      ).toBe('REAUTHENTICATION_REQUIRED');
      const setup = await testWorkspacePolicy(f.dependencies, company.actor, {
        revision: saved.revision,
        policy: settings,
        purpose: 'recovery_setup',
      });
      expect(
        await attempt(
          db,
          async () =>
            await updateWorkspacePolicy(f.dependencies, company.actor, {
              revision: saved.revision,
              policy: settings,
              testId: setup.testId,
              testToken: setup.testToken,
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      const independent = await freshPolicyActor(f);
      expect(
        await attempt(
          db,
          async () =>
            await createWorkspacePolicyRecovery(f.dependencies, independent, {
              policyRevision: saved.revision,
            }),
        ),
      ).toBe('WORKSPACE_ACCESS_REQUIRED');
      const sourceBefore = await db
        .selectFrom('sessions')
        .selectAll()
        .where('user_id', '=', independent.context.userId)
        .orderBy('id')
        .execute();
      const replacement = await createWorkspacePolicyRecovery(f.dependencies, independent, {
        policyRevision: saved.revision,
        testId: setup.testId,
        testToken: setup.testToken,
      });
      expect(replacement.revision).not.toBe(old.revision);
      expect(replacement.recoveryCode).toHaveLength(43);
      expect((await readWorkspacePolicy(f.dependencies, company.actor)).mode).toBe('enforced');
      expect(
        await attempt(
          db,
          async () =>
            await createWorkspacePolicyRecovery(f.dependencies, independent, {
              policyRevision: saved.revision,
              testId: setup.testId,
              testToken: setup.testToken,
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      expect(
        await securityOutcome(
          async () => await recoverWorkspacePolicy(f.dependencies, independent, old),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      const recovered = await recoverWorkspacePolicy(
        { ...f.dependencies, policyReadersReady: () => Promise.resolve(false) },
        independent,
        replacement,
      );
      expect(recovered.mode).toBe('off');
      expect(
        await db
          .selectFrom('sessions')
          .selectAll()
          .where('user_id', '=', independent.context.userId)
          .orderBy('id')
          .execute(),
      ).toEqual(sourceBefore);
      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('workspace_id', '=', independent.context.workspaceId)
        .execute();
      for (const secret of [old.recoveryCode, replacement.recoveryCode, setup.testToken])
        expect(JSON.stringify(audit)).not.toContain(secret);
    });
  });

  test('old company retirement, fresh-role changes and disabled independent methods preserve the existing offline code', async () => {
    await withRollback(async (db) => {
      const f = await workspacePolicyFixture(db);
      const old = await createWorkspacePolicyRecovery(f.dependencies, f.actor, {
        policyRevision: null,
      });
      const company = await companyWorkspaceMfaActor(f.dependencies, f.actor);
      const settings = enforcedPolicy({
        signIn: 'company',
        allowedConnectionIds: [company.connectionId],
      });
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
      const setup = await testWorkspacePolicy(f.dependencies, company.actor, {
        revision: saved.revision,
        policy: settings,
        purpose: 'recovery_setup',
      });
      const independent = await freshPolicyActor(f);
      const input = {
        policyRevision: saved.revision,
        testId: setup.testId,
        testToken: setup.testToken,
      };
      await db
        .updateTable('workspace_identity_connections')
        .set({ enabled: false })
        .where('id', '=', company.connectionId)
        .execute();
      expect(
        await attempt(
          db,
          async () => await createWorkspacePolicyRecovery(f.dependencies, independent, input),
        ),
      ).toBe('UNAUTHENTICATED');
      await db
        .updateTable('workspace_identity_connections')
        .set({ enabled: true })
        .where('id', '=', company.connectionId)
        .execute();
      await db
        .updateTable('workspace_members')
        .set({ role: 'admin' })
        .where('workspace_id', '=', independent.context.workspaceId)
        .where('user_id', '=', independent.context.userId)
        .execute();
      expect(
        await attempt(
          db,
          async () => await createWorkspacePolicyRecovery(f.dependencies, independent, input),
        ),
      ).toBe('FORBIDDEN');
      await db
        .updateTable('workspace_members')
        .set({ role: 'owner' })
        .where('workspace_id', '=', independent.context.workspaceId)
        .where('user_id', '=', independent.context.userId)
        .execute();
      const disabled = {
        ...f.dependencies,
        signInMethods: (): ReturnType<typeof f.dependencies.signInMethods> => ({
          ...f.dependencies.signInMethods(),
          password: false,
          email: false,
        }),
      };
      expect(
        await attempt(db, async () => await recoverWorkspacePolicy(disabled, independent, old)),
      ).toBe('WORKSPACE_SECURITY_NOT_READY');
      expect(
        await db
          .selectFrom('workspace_mfa_recovery_codes')
          .select('revision')
          .where('workspace_id', '=', independent.context.workspaceId)
          .where('user_id', '=', independent.context.userId)
          .where('purpose', '=', 'policy')
          .execute(),
      ).toEqual([{ revision: old.revision }]);
      expect((await readWorkspacePolicy(f.dependencies, company.actor)).revision).toBe(
        saved.revision,
      );
    });
  });

  test('regeneration deletes only this owner/workspace policy hash and preserves factor recovery and other owners', async () => {
    await withRollback(async (db) => {
      const f = await workspacePolicyFixture(db);
      const first = await createWorkspacePolicyRecovery(f.dependencies, f.actor, {
        policyRevision: null,
      });
      await db
        .updateTable('workspace_members')
        .set({ role: 'owner' })
        .where('workspace_id', '=', f.member.context.workspaceId)
        .where('user_id', '=', f.member.context.userId)
        .execute();
      const otherOwner = await createWorkspacePolicyRecovery(f.dependencies, f.member, {
        policyRevision: null,
      });
      const workspace = await db
        .insertInto('workspaces')
        .values({ name: 'Other', slug: crypto.randomUUID() })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: workspace.id, user_id: f.actor.context.userId, role: 'owner' })
        .execute();
      const otherWorkspace = await db
        .insertInto('workspace_mfa_recovery_codes')
        .values({
          workspace_id: workspace.id,
          user_id: f.actor.context.userId,
          purpose: 'policy',
          revision: crypto.randomUUID(),
          code_hash: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const factor = await db
        .insertInto('workspace_mfa_factors')
        .values({
          workspace_id: f.actor.context.workspaceId,
          user_id: f.actor.context.userId,
          state: 'verified',
          verified_at: f.dependencies.clock.now(),
          secret_encrypted: Buffer.from('control-sealed-factor'),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const factorCode = await db
        .insertInto('workspace_mfa_recovery_codes')
        .values({
          workspace_id: f.actor.context.workspaceId,
          user_id: f.actor.context.userId,
          purpose: 'factor',
          revision: crypto.randomUUID(),
          factor_id: factor.id,
          factor_revision: factor.revision,
          code_hash: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const replacement = await createWorkspacePolicyRecovery(f.dependencies, f.actor, {
        policyRevision: null,
      });
      expect(replacement.revision).not.toBe(first.revision);
      expect(
        await db
          .selectFrom('workspace_mfa_recovery_codes')
          .selectAll()
          .where('id', '=', otherWorkspace.id)
          .executeTakeFirst(),
      ).toEqual(otherWorkspace);
      expect(
        await db
          .selectFrom('workspace_mfa_recovery_codes')
          .selectAll()
          .where('id', '=', factorCode.id)
          .executeTakeFirst(),
      ).toEqual(factorCode);
      expect(
        await db
          .selectFrom('workspace_mfa_recovery_codes')
          .select('revision')
          .where('workspace_id', '=', f.member.context.workspaceId)
          .where('user_id', '=', f.member.context.userId)
          .where('purpose', '=', 'policy')
          .execute(),
      ).toEqual([{ revision: otherOwner.revision }]);
      expect(
        await db
          .selectFrom('workspace_mfa_recovery_codes')
          .select('id')
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .where('user_id', '=', f.actor.context.userId)
          .where('purpose', '=', 'policy')
          .execute(),
      ).toHaveLength(1);
    });
  });
});
