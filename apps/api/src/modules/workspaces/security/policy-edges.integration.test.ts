/** Actual policy retries, unchanged saves and recovery-path loss remain bounded and fail closed. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { attempt } from '../../../testing/attempt';
import { codeAt, keyOf } from '../../../testing/totp';
import { companyWorkspaceMfaActor } from './mfa.testing';
import { startWorkspaceMfaChallenge, startWorkspaceMfaEnrollment, verifyWorkspaceMfa } from './mfa';
import {
  createWorkspacePolicyRecovery,
  previewWorkspacePolicy,
  readWorkspacePolicy,
  recoverWorkspacePolicy,
  testWorkspacePolicy,
  updateWorkspacePolicy,
} from './policy';
import { defaultWorkspacePolicy } from './policy-state';
import { enforcedPolicy, workspacePolicyFixture } from './policy.testing';
import { workspaceRecoveryReadiness } from './recovery-state';

afterAll(closeIntegrationDatabase);

describe('integration: policy state edges', () => {
  test('a pending MFA test resumes the same receipt without certifying or saving it', async () => {
    await withRollback(async (db) => {
      const f = await workspacePolicyFixture(db);
      await createWorkspacePolicyRecovery(f.dependencies, f.actor, { policyRevision: null });
      const settings = enforcedPolicy({ requireMfa: true });
      expect(
        await attempt(
          db,
          async () =>
            await testWorkspacePolicy(f.dependencies, f.actor, {
              revision: null,
              policy: settings,
              purpose: 'recovery_setup',
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      const pending = await testWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: settings,
      });
      expect(pending.status.state).toBe('mfa_enrollment_required');
      const resumed = await testWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: settings,
        testId: pending.testId,
        testToken: pending.testToken,
      });
      expect(resumed).toEqual(pending);
      expect(
        await attempt(
          db,
          async () =>
            await updateWorkspacePolicy(f.dependencies, f.actor, {
              revision: null,
              policy: settings,
              testId: resumed.testId,
              testToken: resumed.testToken,
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_NOT_READY');
      expect(
        await db
          .selectFrom('workspace_access_policy_tests')
          .select(['tested_at', 'consumed_at'])
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .execute(),
      ).toEqual([{ tested_at: null, consumed_at: null }]);
      expect((await readWorkspacePolicy(f.dependencies, f.actor)).epoch).toBe('0');
    });
  });

  test('a newer actual MFA event makes an older optional-MFA policy test stale', async () => {
    await withRollback(async (db) => {
      const f = await workspacePolicyFixture(db);
      await createWorkspacePolicyRecovery(f.dependencies, f.actor, { policyRevision: null });
      const setup = await startWorkspaceMfaEnrollment(f.dependencies, f.actor, {
        policyRevision: null,
        factorRevision: null,
      });
      const key = keyOf(setup.totpURI);
      await verifyWorkspaceMfa(f.dependencies, f.actor, {
        challengeId: setup.challenge.challengeId,
        code: codeAt(key, f.dependencies.clock.now().getTime()),
      });
      const settings = enforcedPolicy();
      const tested = await testWorkspacePolicy(f.dependencies, f.actor, {
        revision: null,
        policy: settings,
      });
      const before = await db
        .selectFrom('workspace_access_policy_tests')
        .select(['factor_scope', 'mfa_verified_at'])
        .where('id', '=', tested.testId)
        .executeTakeFirstOrThrow();
      expect(before.factor_scope).toBe('workspace');
      f.move(30_000);
      const challenge = await startWorkspaceMfaChallenge(f.dependencies, f.actor, {
        policyRevision: null,
        purpose: 'step_up',
        factorScope: 'workspace',
      });
      const verified = await verifyWorkspaceMfa(f.dependencies, f.actor, {
        challengeId: challenge.challengeId,
        code: codeAt(key, f.dependencies.clock.now().getTime()),
      });
      expect(verified.status.mfaVerifiedAt).not.toBe(
        before.mfa_verified_at === null ? null : new Date(before.mfa_verified_at).toISOString(),
      );
      expect(
        await attempt(
          db,
          async () =>
            await updateWorkspacePolicy(f.dependencies, f.actor, {
              revision: null,
              policy: settings,
              testId: tested.testId,
              testToken: tested.testToken,
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      expect(
        (
          await db
            .selectFrom('workspace_access_policy_tests')
            .select('consumed_at')
            .where('id', '=', tested.testId)
            .executeTakeFirstOrThrow()
        ).consumed_at,
      ).toBeNull();
      expect((await readWorkspacePolicy(f.dependencies, f.actor)).epoch).toBe('0');
    });
  });

  test('saving the same off settings consumes its real test without changing retained authority', async () => {
    for (const governed of [false, true])
      await withRollback(async (db) => {
        const f = await workspacePolicyFixture(db);
        if (governed) {
          const code = await createWorkspacePolicyRecovery(f.dependencies, f.actor, {
            policyRevision: null,
          });
          await recoverWorkspacePolicy(f.dependencies, f.actor, code);
        }
        const current = await readWorkspacePolicy(f.dependencies, f.actor);
        const settings = defaultWorkspacePolicy();
        const tested = await testWorkspacePolicy(f.dependencies, f.actor, {
          revision: current.revision,
          policy: settings,
        });
        expect(
          await updateWorkspacePolicy(f.dependencies, f.actor, {
            revision: current.revision,
            policy: settings,
            testId: tested.testId,
            testToken: tested.testToken,
          }),
        ).toEqual(current);
        expect(
          (
            await db
              .selectFrom('workspace_access_policy_tests')
              .select('consumed_at')
              .where('id', '=', tested.testId)
              .executeTakeFirstOrThrow()
          ).consumed_at,
        ).not.toBeNull();
        expect(
          await db
            .selectFrom('audit_log')
            .select('id')
            .where('workspace_id', '=', f.actor.context.workspaceId)
            .where('action', '=', 'workspace.security.policy_updated')
            .execute(),
        ).toEqual([]);
      });
  });

  test('preview rejects an invalid cursor and an unready selected company provider', async () => {
    await withRollback(async (db) => {
      const f = await workspacePolicyFixture(db);
      expect(
        await attempt(
          db,
          async () =>
            await previewWorkspacePolicy(f.dependencies, f.actor, {
              revision: null,
              policy: defaultWorkspacePolicy(),
              before: 'not-a-uuid',
            }),
        ),
      ).toBe('VALIDATION_FAILED');
      const company = await companyWorkspaceMfaActor(f.dependencies, f.actor);
      await db
        .updateTable('workspace_identity_connections')
        .set({ enabled: false })
        .where('id', '=', company.connectionId)
        .execute();
      expect(
        await attempt(
          db,
          async () =>
            await previewWorkspacePolicy(f.dependencies, f.actor, {
              revision: null,
              policy: enforcedPolicy({
                signIn: 'company',
                allowedConnectionIds: [company.connectionId],
              }),
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_NOT_READY');
      expect((await readWorkspacePolicy(f.dependencies, f.actor)).epoch).toBe('0');
    });
  });

  test('recovery readiness pages beyond100 owners whose independent credentials were unlinked', async () => {
    await withRollback(async (db) => {
      const f = await workspacePolicyFixture(db);
      const prefix = crypto.randomUUID().slice(0, 24);
      const owners = Array.from({ length: 101 }, (_, index) => ({
        id: `${prefix}${String(index + 1).padStart(12, '0')}`,
        revision: crypto.randomUUID(),
      }));
      await db
        .insertInto('users')
        .values(
          owners.map((owner) => ({
            id: owner.id,
            email: `${owner.id}@recovery.test`,
            username: owner.id,
            display_name: 'Prior recovery owner',
          })),
        )
        .execute();
      await db
        .insertInto('workspace_members')
        .values(
          owners.map((owner) => ({
            workspace_id: f.actor.context.workspaceId,
            user_id: owner.id,
            role: 'owner',
          })),
        )
        .execute();
      // Issued codes remain metadata after unlinking; their presence alone is never an independent recovery path.
      await db
        .insertInto('workspace_mfa_recovery_codes')
        .values(
          owners.map((owner) => ({
            workspace_id: f.actor.context.workspaceId,
            user_id: owner.id,
            purpose: 'policy',
            revision: owner.revision,
            code_hash: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
          })),
        )
        .execute();
      const last = owners.at(-1);
      if (last === undefined) throw new Error('Missing final recovery owner');
      await db
        .insertInto('accounts')
        .values({
          user_id: last.id,
          provider_id: 'credential',
          account_id: last.id,
          password: 'opaque-existing-native-credential',
        })
        .execute();
      const queries = { count: 0 };
      const counted = db.withPlugin({
        transformQuery(args) {
          queries.count += 1;
          return args.node;
        },
        transformResult(args) {
          return Promise.resolve(args.result);
        },
      });
      const dependencies = {
        ...f.dependencies,
        signInMethods: (): ReturnType<typeof f.dependencies.signInMethods> => ({
          password: true,
          email: false,
          github: false,
          google: false,
          oidc: null,
          signUp: 'invite-only',
        }),
      };
      expect(
        await workspaceRecoveryReadiness(counted, dependencies, f.actor.context.workspaceId),
      ).toEqual({ ready: true, ownerId: last.id, revision: last.revision });
      expect(queries.count).toBe(4);
      await db.deleteFrom('accounts').where('user_id', '=', last.id).execute();
      queries.count = 0;
      expect(
        await workspaceRecoveryReadiness(counted, dependencies, f.actor.context.workspaceId),
      ).toMatchObject({ ready: false, ownerId: null });
      expect(queries.count).toBe(4);
    });
  });
});
