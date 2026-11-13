/** Actual SQL workspace MFA lifecycle; only the test authenticator computes an independent RFC code. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import {
  WorkspaceMfaEnrollment,
  type WorkspaceMfaPurpose,
  type WorkspaceMfaVerified,
  type WorkspaceMfaChallenge,
} from '@purlay/types/workspace-security';
import { aWrongCode, codeAt, keyOf } from '../../../testing/totp';
import { attempt } from '../../../testing/attempt';
import { requireWorkspaceSecurityMembership } from '../../../platform/tenancy';
import { recordPrimaryAuthentication } from '../../auth/authentication-evidence';
import {
  companyWorkspaceMfaActor,
  securityOutcome,
  workspaceMfaFixture,
  type WorkspaceMfaFixture,
} from './mfa.testing';
import {
  myWorkspaceMfa,
  revokeWorkspaceMfa,
  rotateWorkspaceMfaRecoveryCodes,
  startWorkspaceMfaChallenge,
  startWorkspaceMfaEnrollment,
  useWorkspaceMfaRecovery,
  verifyWorkspaceMfa,
} from './mfa';

afterAll(closeIntegrationDatabase);

const enroll = async (
  f: WorkspaceMfaFixture,
  policyRevision: string | null = null,
): Promise<{ setup: WorkspaceMfaEnrollment; verified: WorkspaceMfaVerified; key: Buffer }> => {
  const setup = await startWorkspaceMfaEnrollment(f.dependencies, f.actor, {
    policyRevision,
    factorRevision: null,
  });
  const verified = await verifyWorkspaceMfa(f.dependencies, f.actor, {
    challengeId: setup.challenge.challengeId,
    code: codeAt(keyOf(setup.totpURI), f.dependencies.clock.now().getTime()),
  });
  return { setup, verified, key: keyOf(setup.totpURI) };
};

const challenge = async (
  f: WorkspaceMfaFixture,
  purpose: WorkspaceMfaPurpose,
  policyRevision: string | null = null,
): Promise<WorkspaceMfaChallenge> =>
  await startWorkspaceMfaChallenge(f.dependencies, f.actor, {
    policyRevision,
    factorScope: 'workspace',
    purpose,
  });

const policy = async (
  db: Executor,
  f: WorkspaceMfaFixture,
  idleMinutes: number | null = null,
): Promise<string> => {
  const revision = crypto.randomUUID();
  await db
    .updateTable('workspaces')
    .set({ access_policy_epoch: '1' })
    .where('id', '=', f.actor.context.workspaceId)
    .execute();
  await db
    .insertInto('workspace_access_policies')
    .values({
      workspace_id: f.actor.context.workspaceId,
      epoch: '1',
      revision,
      mode: 'enforced',
      sign_in: 'any',
      require_mfa: true,
      idle_minutes: idleMinutes,
      max_age_hours: 1,
      mfa_max_age_minutes: 5,
      tested_at: f.dependencies.clock.now(),
    })
    .execute();
  return revision;
};

describe('integration: workspace-owned MFA', () => {
  test('restricted guests keep independent sign-in and satisfy the same workspace MFA requirement', async () => {
    await withRollback(async (db) => {
      const original = await workspaceMfaFixture(db);
      const provider = await companyWorkspaceMfaActor(original.dependencies, original.actor);
      await db
        .updateTable('workspace_members')
        .set({
          access_kind: 'guest',
          guest_since: original.dependencies.clock.now(),
          guest_modules: ['chat'],
          guest_expires_at: new Date('2027-01-01T00:00:00Z'),
        })
        .where('workspace_id', '=', original.member.context.workspaceId)
        .where('user_id', '=', original.member.context.userId)
        .execute();
      const actor = {
        ...original.member,
        context: await requireWorkspaceSecurityMembership(
          db,
          original.member.context.userId,
          original.member.context.workspaceId,
        ),
      };
      const f = { ...original, actor };
      const revision = await policy(db, f);
      await db
        .updateTable('workspace_access_policies')
        .set({ sign_in: 'company', allowed_connection_ids: [provider.connectionId] })
        .where('workspace_id', '=', actor.context.workspaceId)
        .execute();
      expect((await myWorkspaceMfa(f.dependencies, actor)).status.state).toBe(
        'mfa_enrollment_required',
      );
      const result = await enroll(f, revision);
      expect(result.verified.status.state).toBe('allowed');
      expect(result.verified.status.factorScope).toBe('workspace');
      expect(actor.context.guest?.kind).toBe('guest');
      expect(
        await securityOutcome(
          async () =>
            await startWorkspaceMfaChallenge(f.dependencies, actor, {
              policyRevision: revision,
              purpose: 'policy_test',
              factorScope: 'workspace',
              testId: crypto.randomUUID(),
            }),
        ),
      ).toBe('FORBIDDEN');
    });
  });

  test('a lost enrollment response replaces its secret and cancelled or expired challenges grant nothing', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      const request = { policyRevision: null, factorRevision: null };
      const lost = await startWorkspaceMfaEnrollment(f.dependencies, f.actor, request);
      const replacement = await startWorkspaceMfaEnrollment(f.dependencies, f.actor, request);
      expect(replacement.factor.id).not.toBe(lost.factor.id);
      expect(replacement.totpURI).not.toBe(lost.totpURI);
      expect(
        await securityOutcome(
          async () =>
            await verifyWorkspaceMfa(f.dependencies, f.actor, {
              challengeId: lost.challenge.challengeId,
              code: codeAt(keyOf(lost.totpURI), f.dependencies.clock.now().getTime()),
            }),
        ),
      ).toBe('WORKSPACE_MFA_INVALID');
      f.move(300_000);
      expect(
        await securityOutcome(
          async () =>
            await verifyWorkspaceMfa(f.dependencies, f.actor, {
              challengeId: replacement.challenge.challengeId,
              code: codeAt(keyOf(replacement.totpURI), f.dependencies.clock.now().getTime()),
            }),
        ),
      ).toBe('WORKSPACE_MFA_INVALID');
      expect(
        (
          await db
            .selectFrom('workspace_mfa_factors')
            .select('last_accepted_counter')
            .where('id', '=', replacement.factor.id)
            .executeTakeFirstOrThrow()
        ).last_accepted_counter,
      ).toBeNull();
    });
  });

  test('company enrollment never creates global credentials, and response retries never replay secrets or MFA time', async () => {
    await withRollback(async (db) => {
      const base = await workspaceMfaFixture(db);
      const company = await companyWorkspaceMfaActor(base.dependencies, base.actor);
      const f = { ...base, actor: company.actor };
      const global = await db
        .insertInto('two_factors')
        .values({
          user_id: f.actor.context.userId,
          secret: 'sealed-global-untouched',
          backup_codes: 'sealed-global-backup',
          verified: true,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .updateTable('users')
        .set({ two_factor_enabled: true })
        .where('id', '=', f.actor.context.userId)
        .execute();
      const setup = await startWorkspaceMfaEnrollment(f.dependencies, f.actor, {
        policyRevision: null,
        factorRevision: null,
      });
      expect(Value.Check(WorkspaceMfaEnrollment, setup)).toBe(true);
      const key = keyOf(setup.totpURI);
      const stored = await db
        .selectFrom('workspace_mfa_factors')
        .selectAll()
        .where('id', '=', setup.factor.id)
        .executeTakeFirstOrThrow();
      expect(stored.secret_encrypted.includes(key)).toBe(false);
      expect(stored.last_accepted_counter).toBeNull();
      const request = {
        challengeId: setup.challenge.challengeId,
        code: codeAt(key, f.dependencies.clock.now().getTime()),
      };
      const result = await verifyWorkspaceMfa(f.dependencies, f.actor, request);
      expect(result.factor?.state).toBe('verified');
      expect(result.factor?.revision).not.toBe(setup.factor.revision);
      expect(result.recoveryCodes?.backupCodes).toHaveLength(10);
      const evidence = await db
        .selectFrom('workspace_session_assurances')
        .selectAll()
        .where('session_id', '=', f.actor.sessionId)
        .executeTakeFirstOrThrow();
      f.move(1_000);
      const retried = await verifyWorkspaceMfa(f.dependencies, f.actor, request);
      expect(retried.recoveryCodes).toBeUndefined();
      expect(
        (
          await db
            .selectFrom('workspace_session_assurances')
            .select('mfa_verified_at')
            .where('session_id', '=', f.actor.sessionId)
            .executeTakeFirstOrThrow()
        ).mfa_verified_at,
      ).toEqual(evidence.mfa_verified_at);
      const inventory = await myWorkspaceMfa(f.dependencies, f.actor);
      expect(inventory.globalMfaAvailable).toBe(false);
      expect(inventory.recoveryCodesRemaining).toBe(10);
      expect(JSON.stringify(inventory)).not.toContain(
        new URL(setup.totpURI).searchParams.get('secret') ?? 'unreachable',
      );
      expect(
        await db
          .selectFrom('two_factors')
          .selectAll()
          .where('id', '=', global.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(global);
      expect(
        await db
          .selectFrom('accounts')
          .select('id')
          .where('user_id', '=', f.actor.context.userId)
          .execute(),
      ).toEqual([]);
      const audit = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('workspace_id', '=', f.actor.context.workspaceId)
        .where('action', '=', 'workspace.mfa.enrolled')
        .execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toMatchObject({
        factorId: result.factor?.id,
        factorRevision: result.factor?.revision,
      });
      const codes = await db
        .selectFrom('workspace_mfa_recovery_codes')
        .select('code_hash')
        .where('user_id', '=', f.actor.context.userId)
        .execute();
      for (const code of result.recoveryCodes?.backupCodes ?? []) {
        expect(JSON.stringify(codes)).not.toContain(code);
        expect(JSON.stringify(audit)).not.toContain(code);
      }
    });
  });

  test('accepted counters reject replay across challenges and consume the actual adjacent timestep', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      const enrolled = await enroll(f);
      let next = await challenge(f, 'step_up');
      expect(
        await securityOutcome(
          async () =>
            await verifyWorkspaceMfa(f.dependencies, f.actor, {
              challengeId: next.challengeId,
              code: codeAt(enrolled.key, f.dependencies.clock.now().getTime()),
            }),
        ),
      ).toBe('WORKSPACE_MFA_INVALID');
      const accepted = Math.floor(f.dependencies.clock.now().getTime() / 30_000) + 1;
      await verifyWorkspaceMfa(f.dependencies, f.actor, {
        challengeId: next.challengeId,
        code: codeAt(enrolled.key, f.dependencies.clock.now().getTime(), 1),
      });
      expect(
        (
          await db
            .selectFrom('workspace_mfa_factors')
            .select('last_accepted_counter')
            .where('id', '=', enrolled.setup.factor.id)
            .executeTakeFirstOrThrow()
        ).last_accepted_counter,
      ).toBe(String(accepted));
      f.move(30_000);
      next = await challenge(f, 'step_up');
      expect(
        await securityOutcome(
          async () =>
            await verifyWorkspaceMfa(f.dependencies, f.actor, {
              challengeId: next.challengeId,
              code: codeAt(enrolled.key, f.dependencies.clock.now().getTime()),
            }),
        ),
      ).toBe('WORKSPACE_MFA_INVALID');
    });
  });

  test('wrong-code limiter state commits across errors, new challenges and locked retries', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      const enrolled = await enroll(f);
      f.move(30_000);
      const wrong = aWrongCode(enrolled.key, f.dependencies.clock.now().getTime());
      for (let batch = 0; batch < 2; batch += 1) {
        const next = await challenge(f, 'step_up');
        for (let attempt = 0; attempt < 5; attempt += 1)
          expect(
            await securityOutcome(
              async () =>
                await verifyWorkspaceMfa(f.dependencies, f.actor, {
                  challengeId: next.challengeId,
                  code: wrong,
                }),
            ),
          ).toBe(batch === 1 && attempt === 4 ? 'WORKSPACE_MFA_LOCKED' : 'WORKSPACE_MFA_INVALID');
      }
      const factor = await db
        .selectFrom('workspace_mfa_factors')
        .selectAll()
        .where('id', '=', enrolled.setup.factor.id)
        .executeTakeFirstOrThrow();
      expect(factor.failed_verification_count).toBe(10);
      expect(new Date(factor.locked_until ?? 0).getTime()).toBe(
        f.dependencies.clock.now().getTime() + 15 * 60_000,
      );
      expect(await securityOutcome(async () => await challenge(f, 'step_up'))).toBe(
        'WORKSPACE_MFA_LOCKED',
      );
      expect(factor.last_accepted_counter).toBe(
        String(Math.floor((f.dependencies.clock.now().getTime() - 30_000) / 30_000)),
      );
      f.move(15 * 60_000 + 1);
      const reopened = await challenge(f, 'step_up');
      expect(
        await securityOutcome(
          async () =>
            await verifyWorkspaceMfa(f.dependencies, f.actor, {
              challengeId: reopened.challengeId,
              code: aWrongCode(enrolled.key, f.dependencies.clock.now().getTime()),
            }),
        ),
      ).toBe('WORKSPACE_MFA_INVALID');
      const reset = await db
        .selectFrom('workspace_mfa_factors')
        .select(['failed_verification_count', 'locked_until', 'last_accepted_counter'])
        .where('id', '=', factor.id)
        .executeTakeFirstOrThrow();
      expect(reset.failed_verification_count).toBe(1);
      expect(reset.locked_until).toBeNull();
      expect(reset.last_accepted_counter).toBe(factor.last_accepted_counter);
    });
  });

  test('global factor inventory is available only to independent sessions and registration alone supplies no workspace MFA', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      await policy(db, f);
      const global = await db
        .insertInto('two_factors')
        .values({
          user_id: f.actor.context.userId,
          secret: 'opaque-global-inventory-fixture',
          backup_codes: 'opaque-global-backup-fixture',
          verified: true,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await db
        .updateTable('users')
        .set({ two_factor_enabled: true })
        .where('id', '=', f.actor.context.userId)
        .execute();
      const independent = await myWorkspaceMfa(f.dependencies, f.actor);
      expect(independent.globalMfaAvailable).toBe(true);
      expect(independent.status.state).toBe('mfa_required');
      expect(independent.status.factorScope).toBe('global');
      const company = await companyWorkspaceMfaActor(f.dependencies, f.actor);
      const restricted = await myWorkspaceMfa(f.dependencies, company.actor);
      expect(restricted.globalMfaAvailable).toBe(false);
      expect(restricted.status.state).toBe('mfa_enrollment_required');
      expect(
        await db
          .selectFrom('two_factors')
          .selectAll()
          .where('id', '=', global.id)
          .executeTakeFirst(),
      ).toEqual(global);
    });
  });

  test('only a rotate receipt can replace a verified factor and malformed recovery proof cannot consume a code', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      const enrolled = await enroll(f);
      for (const input of [
        { policyRevision: null, factorScope: 'workspace', purpose: 'enroll' },
        { policyRevision: null, factorScope: 'workspace', purpose: 'policy_test' },
      ] as const)
        expect(
          await attempt(
            db,
            async () => await startWorkspaceMfaChallenge(f.dependencies, f.actor, input),
          ),
        ).toBe('WORKSPACE_MFA_INVALID');
      const malformed = await challenge(f, 'step_up');
      expect(
        await securityOutcome(
          async () =>
            await useWorkspaceMfaRecovery(f.dependencies, f.actor, {
              challengeId: malformed.challengeId,
              code: 'A'.repeat(21) + '\n',
            }),
        ),
      ).toBe('WORKSPACE_MFA_INVALID');
      expect((await myWorkspaceMfa(f.dependencies, f.actor)).recoveryCodesRemaining).toBe(10);
      f.move(30_000);
      const disable = await challenge(f, 'disable');
      const accepted = await verifyWorkspaceMfa(f.dependencies, f.actor, {
        challengeId: disable.challengeId,
        code: codeAt(enrolled.key, f.dependencies.clock.now().getTime()),
      });
      if (accepted.factor === null) throw new Error('Missing accepted factor receipt');
      expect(
        await attempt(
          db,
          async () =>
            await startWorkspaceMfaEnrollment(f.dependencies, f.actor, {
              policyRevision: null,
              factorRevision: accepted.factor?.revision ?? '',
              authorizationChallengeId: disable.challengeId,
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      expect((await myWorkspaceMfa(f.dependencies, f.actor)).pending).toBeNull();
      expect((await myWorkspaceMfa(f.dependencies, f.actor)).factor?.id).toBe(
        enrolled.setup.factor.id,
      );
    });
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      const setup = await startWorkspaceMfaEnrollment(f.dependencies, f.actor, {
        policyRevision: null,
        factorRevision: null,
      });
      expect(
        await attempt(
          db,
          async () =>
            await useWorkspaceMfaRecovery(f.dependencies, f.actor, {
              challengeId: setup.challenge.challengeId,
              code: 'A'.repeat(22),
            }),
        ),
      ).toBe('WORKSPACE_MFA_INVALID');
      expect((await myWorkspaceMfa(f.dependencies, f.actor)).factor).toBeNull();
      expect((await myWorkspaceMfa(f.dependencies, f.actor)).pending?.id).toBe(setup.factor.id);
    });
  });

  test('foreign callers, stale policy and retired company sources cannot complete pending enrollment', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      const setup = await startWorkspaceMfaEnrollment(f.dependencies, f.actor, {
        policyRevision: null,
        factorRevision: null,
      });
      const request = {
        challengeId: setup.challenge.challengeId,
        code: codeAt(keyOf(setup.totpURI), f.dependencies.clock.now().getTime()),
      };
      expect(
        await securityOutcome(
          async () => await verifyWorkspaceMfa(f.dependencies, f.member, request),
        ),
      ).toBe('WORKSPACE_MFA_NOT_FOUND');
      await policy(db, f);
      expect(
        await securityOutcome(
          async () => await verifyWorkspaceMfa(f.dependencies, f.actor, request),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      expect(
        (
          await db
            .selectFrom('workspace_mfa_factors')
            .select('state')
            .where('id', '=', setup.factor.id)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('pending');
      const other = await workspaceMfaFixture(db);
      const company = await companyWorkspaceMfaActor(other.dependencies, other.actor);
      const pending = await startWorkspaceMfaEnrollment(other.dependencies, company.actor, {
        policyRevision: null,
        factorRevision: null,
      });
      await db
        .updateTable('workspace_identity_connections')
        .set({ enabled: false })
        .where('id', '=', company.connectionId)
        .execute();
      expect(
        await securityOutcome(
          async () =>
            await verifyWorkspaceMfa(other.dependencies, company.actor, {
              challengeId: pending.challenge.challengeId,
              code: codeAt(keyOf(pending.totpURI), other.dependencies.clock.now().getTime()),
            }),
        ),
      ).toBe('UNAUTHENTICATED');
      expect(
        (
          await db
            .selectFrom('workspace_mfa_factors')
            .select('last_accepted_counter')
            .where('id', '=', pending.factor.id)
            .executeTakeFirstOrThrow()
        ).last_accepted_counter,
      ).toBeNull();
    });
  });

  test('rotation preserves the current factor until confirmation and recovery batches remain single-use', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      const policyCode = await db
        .insertInto('workspace_mfa_recovery_codes')
        .values({
          workspace_id: f.actor.context.workspaceId,
          user_id: f.actor.context.userId,
          purpose: 'policy',
          revision: crypto.randomUUID(),
          code_hash: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const otherWorkspace = await db
        .insertInto('workspaces')
        .values({ name: 'Other company', slug: crypto.randomUUID() })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: otherWorkspace.id, user_id: f.actor.context.userId, role: 'owner' })
        .execute();
      const otherFactor = await db
        .insertInto('workspace_mfa_factors')
        .values({
          workspace_id: otherWorkspace.id,
          user_id: f.actor.context.userId,
          state: 'verified',
          verified_at: f.dependencies.clock.now(),
          secret_encrypted: Buffer.from('other-company-sealed'),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const otherCode = await db
        .insertInto('workspace_mfa_recovery_codes')
        .values({
          workspace_id: otherWorkspace.id,
          user_id: f.actor.context.userId,
          purpose: 'factor',
          revision: crypto.randomUUID(),
          factor_id: otherFactor.id,
          factor_revision: otherFactor.revision,
          code_hash: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const first = await enroll(f);
      const oldCode = first.verified.recoveryCodes?.backupCodes[0] ?? '';
      f.move(30_000);
      const receipt = await challenge(f, 'rotate');
      await verifyWorkspaceMfa(f.dependencies, f.actor, {
        challengeId: receipt.challengeId,
        code: codeAt(first.key, f.dependencies.clock.now().getTime()),
      });
      expect(
        await securityOutcome(
          async () =>
            await revokeWorkspaceMfa(f.dependencies, f.actor, {
              policyRevision: null,
              factorRevision: first.verified.factor?.revision ?? '',
              authorizationChallengeId: receipt.challengeId,
            }),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      const setup = await startWorkspaceMfaEnrollment(f.dependencies, f.actor, {
        policyRevision: null,
        factorRevision: first.verified.factor?.revision ?? null,
        authorizationChallengeId: receipt.challengeId,
      });
      expect((await myWorkspaceMfa(f.dependencies, f.actor)).factor?.id).toBe(
        first.setup.factor.id,
      );
      const result = await verifyWorkspaceMfa(f.dependencies, f.actor, {
        challengeId: setup.challenge.challengeId,
        code: codeAt(keyOf(setup.totpURI), f.dependencies.clock.now().getTime()),
      });
      expect(result.factor?.id).toBe(setup.factor.id);
      expect(
        await db
          .selectFrom('workspace_mfa_factors')
          .select('id')
          .where('id', '=', first.setup.factor.id)
          .execute(),
      ).toEqual([]);
      const step = await challenge(f, 'step_up');
      expect(
        await securityOutcome(
          async () =>
            await useWorkspaceMfaRecovery(f.dependencies, f.actor, {
              challengeId: step.challengeId,
              code: oldCode,
            }),
        ),
      ).toBe('WORKSPACE_MFA_INVALID');
      const code = result.recoveryCodes?.backupCodes[0] ?? '';
      await useWorkspaceMfaRecovery(f.dependencies, f.actor, {
        challengeId: step.challengeId,
        code,
      });
      const replay = await challenge(f, 'step_up');
      expect(
        await securityOutcome(
          async () =>
            await useWorkspaceMfaRecovery(f.dependencies, f.actor, {
              challengeId: replay.challengeId,
              code,
            }),
        ),
      ).toBe('WORKSPACE_MFA_INVALID');
      expect((await myWorkspaceMfa(f.dependencies, f.actor)).recoveryCodesRemaining).toBe(9);
      const replace = await challenge(f, 'recovery_codes');
      await useWorkspaceMfaRecovery(f.dependencies, f.actor, {
        challengeId: replace.challengeId,
        code: result.recoveryCodes?.backupCodes[1] ?? '',
      });
      const request = {
        policyRevision: null,
        factorRevision: result.factor?.revision ?? '',
        authorizationChallengeId: replace.challengeId,
      };
      const batch = await rotateWorkspaceMfaRecoveryCodes(f.dependencies, f.actor, request);
      expect(batch.backupCodes).toHaveLength(10);
      expect(
        await securityOutcome(
          async () => await rotateWorkspaceMfaRecoveryCodes(f.dependencies, f.actor, request),
        ),
      ).toBe('WORKSPACE_SECURITY_CHANGED');
      expect((await myWorkspaceMfa(f.dependencies, f.actor)).recoveryCodesRemaining).toBe(10);
      const disable = await challenge(f, 'disable');
      await useWorkspaceMfaRecovery(f.dependencies, f.actor, {
        challengeId: disable.challengeId,
        code: batch.backupCodes[0] ?? '',
      });
      const revoke = {
        policyRevision: null,
        factorRevision: result.factor?.revision ?? '',
        authorizationChallengeId: disable.challengeId,
      };
      expect((await revokeWorkspaceMfa(f.dependencies, f.actor, revoke)).factor).toBeNull();
      expect((await revokeWorkspaceMfa(f.dependencies, f.actor, revoke)).factor).toBeNull();
      expect(
        await db
          .selectFrom('workspace_mfa_factors')
          .select('id')
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .where('user_id', '=', f.actor.context.userId)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('workspace_mfa_recovery_codes')
          .select('id')
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .where('user_id', '=', f.actor.context.userId)
          .where('purpose', '=', 'factor')
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('workspace_mfa_recovery_codes')
          .selectAll()
          .where('id', '=', policyCode.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(policyCode);
      expect(
        await db
          .selectFrom('workspace_mfa_factors')
          .selectAll()
          .where('id', '=', otherFactor.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(otherFactor);
      expect(
        await db
          .selectFrom('workspace_mfa_recovery_codes')
          .selectAll()
          .where('id', '=', otherCode.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(otherCode);
      const newSession = await db
        .insertInto('sessions')
        .values({
          user_id: f.actor.context.userId,
          token_hash: crypto.randomUUID(),
          created_at: f.dependencies.clock.now(),
          last_used_at: f.dependencies.clock.now(),
          expires_at: new Date(f.dependencies.clock.now().getTime() + 86_400_000),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await recordPrimaryAuthentication(db, newSession.id, f.actor.context.userId, {
        method: 'password',
        authenticatedAt: f.dependencies.clock.now(),
      });
      const replacementActor = {
        context: await requireWorkspaceSecurityMembership(
          db,
          f.actor.context.userId,
          f.actor.context.workspaceId,
        ),
        sessionId: newSession.id,
      };
      const replacement = await enroll({ ...f, actor: replacementActor });
      expect((await revokeWorkspaceMfa(f.dependencies, f.actor, revoke)).factor?.id).toBe(
        replacement.setup.factor.id,
      );
      expect(
        await db
          .selectFrom('audit_log')
          .select('id')
          .where('workspace_id', '=', f.actor.context.workspaceId)
          .where('action', '=', 'workspace.mfa.revoked')
          .execute(),
      ).toHaveLength(1);
    });
  });

  test('MFA-only expiry accepts genuine step-up while a terminal base deadline cannot be revived', async () => {
    await withRollback(async (db) => {
      const f = await workspaceMfaFixture(db);
      const revision = await policy(db, f, 15);
      const enrolled = await enroll(f, revision);
      f.move(5 * 60_000 + 1);
      const next = await challenge(f, 'step_up', revision);
      const result = await verifyWorkspaceMfa(f.dependencies, f.actor, {
        challengeId: next.challengeId,
        code: codeAt(enrolled.key, f.dependencies.clock.now().getTime()),
      });
      expect(result.status.state).toBe('allowed');
      f.move(8 * 60_000);
      const nearEnd = await challenge(f, 'step_up', revision);
      const before = await db
        .selectFrom('workspace_mfa_factors')
        .select('last_accepted_counter')
        .where('id', '=', enrolled.setup.factor.id)
        .executeTakeFirstOrThrow();
      f.move(3 * 60_000);
      expect(
        await attempt(
          db,
          async () =>
            await verifyWorkspaceMfa(f.dependencies, f.actor, {
              challengeId: nearEnd.challengeId,
              code: codeAt(enrolled.key, f.dependencies.clock.now().getTime()),
            }),
        ),
      ).toBe('REAUTHENTICATION_REQUIRED');
      expect(
        (
          await db
            .selectFrom('workspace_mfa_factors')
            .select('last_accepted_counter')
            .where('id', '=', enrolled.setup.factor.id)
            .executeTakeFirstOrThrow()
        ).last_accepted_counter,
      ).toBe(before.last_accepted_counter);
    });
  });
});
