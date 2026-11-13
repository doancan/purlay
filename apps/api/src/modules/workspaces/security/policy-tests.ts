/** A policy test is an expiring, source-bound receipt; only explicit finalization certifies its proposal. */
import { isDeepStrictEqual } from 'node:util';
import { Value } from '@sinclair/typebox/value';
import type { Transaction } from '@purlay/db';
import {
  WORKSPACE_SECURITY_FRESH_SECONDS,
  WorkspacePolicySettings,
  type TestWorkspacePolicyRequest,
  type WorkspacePolicyTest,
  type WorkspacePolicyTestPurpose,
} from '@purlay/types/workspace-security';
import { AppError } from '../../../platform/errors';
import { readWorkspaceAccessFacts } from '../../../platform/workspace-access-facts';
import { evaluateWorkspaceAccess } from '../../../platform/workspace-access';
import { atomicallyOn } from '../../../platform/transactions';
import { recordAudit } from '../../audit/audit';
import { workspacePolicyProposalStatus } from './access';
import {
  lockWorkspaceSecurityActor,
  requireFreshSecurityPrimary,
  securityChanged,
  securityNotReady,
  type LockedWorkspaceSecurityActor,
  type WorkspaceSecurityActor,
} from './authority';
import {
  lockPolicyActorFactors,
  requireCurrentPolicyAccess,
  type WorkspacePolicyDependencies,
} from './policy-authority';
import { ownPolicyRecoveryRevision, workspaceRecoveryReadiness } from './recovery-state';
import {
  canonicalWorkspacePolicy,
  lockPolicyRow,
  policyProviderBindings,
  policySettings,
  policyTestDigest,
  policyTestToken,
  workspacePolicyDigest,
  type PolicyRow,
  type PolicyTestRow,
} from './policy-state';

export const lockPolicyTest = async (
  transaction: Transaction,
  locked: LockedWorkspaceSecurityActor,
  testId: string,
  token: string,
): Promise<PolicyTestRow> => {
  const row = await transaction
    .selectFrom('workspace_access_policy_tests')
    .selectAll()
    .where('id', '=', testId)
    .where('token_hash', '=', await policyTestDigest(token))
    .where('workspace_id', '=', locked.context.workspaceId)
    .where('session_id', '=', locked.session.id)
    .where('user_id', '=', locked.context.userId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw securityChanged();
  return row;
};

export const validatePolicyTest = async (
  transaction: Transaction,
  dependencies: WorkspacePolicyDependencies,
  locked: LockedWorkspaceSecurityActor,
  current: PolicyRow | undefined,
  row: PolicyTestRow,
  settings: WorkspacePolicySettings,
  purpose: WorkspacePolicyTestPurpose,
): Promise<void> => {
  const now = dependencies.clock.now();
  if (
    row.consumed_at !== null ||
    new Date(row.expires_at).getTime() <= now.getTime() ||
    row.authentication_revision !== locked.evidence?.revision ||
    row.policy_epoch !== locked.workspace.access_policy_epoch ||
    row.policy_revision !== (current?.revision ?? null) ||
    !row.proposed_digest.equals(await workspacePolicyDigest(settings)) ||
    !Value.Check(WorkspacePolicySettings, row.proposed_policy) ||
    !isDeepStrictEqual(canonicalWorkspacePolicy(row.proposed_policy), settings)
  )
    throw securityChanged();
  if (
    !isDeepStrictEqual(
      row.provider_revisions,
      await policyProviderBindings(transaction, locked.context.workspaceId, settings, purpose),
    )
  )
    throw securityChanged();
  const recovery =
    purpose === 'recovery_setup'
      ? {
          revision: await ownPolicyRecoveryRevision(
            transaction,
            locked.context.workspaceId,
            locked.context.userId,
          ),
          ready: true,
        }
      : await workspaceRecoveryReadiness(transaction, dependencies, locked.context.workspaceId);
  if (
    row.recovery_revision !== recovery.revision ||
    (settings.mode === 'enforced' && !recovery.ready)
  )
    throw securityChanged();
};

export const requireTestMfaCurrent = async (
  transaction: Transaction,
  dependencies: WorkspacePolicyDependencies,
  actor: WorkspaceSecurityActor,
  row: PolicyTestRow,
): Promise<void> => {
  if (row.factor_scope === null) return;
  const input = {
    sessionId: actor.sessionId,
    userId: actor.context.userId,
    workspaceIds: [actor.context.workspaceId],
    now: dependencies.clock.now(),
    lifetime: dependencies.lifetime(),
  };
  const facts = (await readWorkspaceAccessFacts(transaction, input)).get(actor.context.workspaceId);
  const proof = facts?.assurance;
  if (
    proof?.factor_scope !== row.factor_scope ||
    proof.factor_id !== row.factor_id ||
    proof.factor_revision !== row.factor_revision ||
    proof.mfa_verified_at === null ||
    row.mfa_verified_at === null ||
    new Date(proof.mfa_verified_at).getTime() !== new Date(row.mfa_verified_at).getTime() ||
    facts === undefined ||
    (evaluateWorkspaceAccess(input, actor.context.workspaceId, facts).mfaExpiresAt?.getTime() ??
      0) <= dependencies.clock.now().getTime()
  )
    throw securityChanged();
};

export const consumePolicyTest = async (
  transaction: Transaction,
  row: PolicyTestRow,
  now: Date,
): Promise<void> => {
  if (new Date(row.expires_at).getTime() <= now.getTime()) throw securityChanged();
  const used = await transaction
    .updateTable('workspace_access_policy_tests')
    .set({ consumed_at: now })
    .where('id', '=', row.id)
    .where('consumed_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (used === undefined) throw securityChanged();
};

const testExpiry = (
  dependencies: WorkspacePolicyDependencies,
  locked: LockedWorkspaceSecurityActor,
  currentExpiresAt: string | null,
  proposedExpiresAt: string | null,
): Date => {
  const now = dependencies.clock.now().getTime();
  const at = locked.evidence?.authenticated_at;
  const expires = Math.min(
    now + WORKSPACE_SECURITY_FRESH_SECONDS * 1_000,
    at === undefined || at === null
      ? NaN
      : new Date(at).getTime() + WORKSPACE_SECURITY_FRESH_SECONDS * 1_000,
    new Date(locked.session.expires_at).getTime(),
    currentExpiresAt === null ? Infinity : new Date(currentExpiresAt).getTime(),
    proposedExpiresAt === null ? Infinity : new Date(proposedExpiresAt).getTime(),
  );
  if (!Number.isFinite(expires) || expires <= now)
    throw new AppError({
      code: 'REAUTHENTICATION_REQUIRED',
      message: 'Sign in again before testing workspace policy.',
    });
  return new Date(expires);
};

export const testWorkspacePolicy = async (
  dependencies: WorkspacePolicyDependencies,
  actor: WorkspaceSecurityActor,
  request: TestWorkspacePolicyRequest,
): Promise<WorkspacePolicyTest> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const locked = await lockWorkspaceSecurityActor(transaction, dependencies, actor, 'owner');
    requireFreshSecurityPrimary(dependencies, locked);
    const current = await lockPolicyRow(transaction, locked, request.revision);
    const settings = canonicalWorkspacePolicy(request.policy);
    const purpose = request.purpose ?? 'policy';
    if (purpose === 'recovery_setup' && !isDeepStrictEqual(settings, policySettings(current)))
      throw securityChanged();
    const resume = 'testId' in request ? request : undefined;
    const existing =
      resume === undefined
        ? undefined
        : await lockPolicyTest(transaction, locked, resume.testId, resume.testToken);
    if (existing !== undefined)
      await validatePolicyTest(
        transaction,
        dependencies,
        locked,
        current,
        existing,
        settings,
        purpose,
      );
    await lockPolicyActorFactors(transaction, locked);
    const actual = await requireCurrentPolicyAccess(transaction, dependencies, actor);
    const recovery =
      purpose === 'recovery_setup'
        ? {
            ready: true,
            revision: await ownPolicyRecoveryRevision(
              transaction,
              locked.context.workspaceId,
              locked.context.userId,
            ),
          }
        : await workspaceRecoveryReadiness(transaction, dependencies, locked.context.workspaceId);
    if (settings.mode === 'enforced' && !recovery.ready)
      throw securityNotReady(
        'A current owner must establish independent policy recovery before enforcement.',
      );
    const providers = await policyProviderBindings(
      transaction,
      locked.context.workspaceId,
      settings,
      purpose,
    );
    const proposed = await workspacePolicyProposalStatus(
      { ...dependencies, database: transaction },
      actor,
      settings,
    );
    const input = {
      sessionId: actor.sessionId,
      userId: actor.context.userId,
      workspaceIds: [actor.context.workspaceId],
      now: dependencies.clock.now(),
      lifetime: dependencies.lifetime(),
    };
    const facts = (await readWorkspaceAccessFacts(transaction, input)).get(
      actor.context.workspaceId,
    );
    const assurance = facts?.assurance;
    const liveMfa =
      assurance?.factor_scope !== null &&
      assurance?.factor_scope !== undefined &&
      assurance.mfa_verified_at !== null &&
      facts !== undefined &&
      (evaluateWorkspaceAccess(input, actor.context.workspaceId, facts).mfaExpiresAt?.getTime() ??
        0) > dependencies.clock.now().getTime();
    const expires = testExpiry(
      dependencies,
      locked,
      actual.expiresAt,
      proposed.state === 'allowed' ? proposed.expiresAt : null,
    );
    requireFreshSecurityPrimary(dependencies, locked);
    const now = dependencies.clock.now();
    if (expires.getTime() <= now.getTime()) throw securityChanged();
    if (existing !== undefined && resume !== undefined) {
      await requireTestMfaCurrent(transaction, dependencies, actor, existing);
      if (proposed.state !== 'allowed')
        return {
          testId: existing.id,
          testToken: resume.testToken,
          expiresAt: new Date(existing.expires_at).toISOString(),
          status: proposed,
        };
      const until = new Date(Math.min(expires.getTime(), new Date(existing.expires_at).getTime()));
      await transaction
        .updateTable('workspace_access_policy_tests')
        .set({ tested_at: now, expires_at: until })
        .where('id', '=', existing.id)
        .execute();
      return {
        testId: existing.id,
        testToken: resume.testToken,
        expiresAt: until.toISOString(),
        status: proposed,
      };
    }
    const token = policyTestToken();
    const saved = await transaction
      .insertInto('workspace_access_policy_tests')
      .values({
        workspace_id: locked.context.workspaceId,
        session_id: locked.session.id,
        user_id: locked.context.userId,
        token_hash: await policyTestDigest(token),
        policy_revision: current?.revision ?? null,
        policy_epoch: locked.workspace.access_policy_epoch,
        authentication_revision: locked.evidence?.revision ?? '',
        proposed_policy: JSON.stringify(settings),
        proposed_digest: await workspacePolicyDigest(settings),
        provider_revisions: JSON.stringify(providers),
        recovery_revision: recovery.revision,
        tested_at: proposed.state === 'allowed' ? now : null,
        expires_at: expires,
        created_at: now,
        ...(liveMfa
          ? {
              factor_scope: assurance.factor_scope,
              factor_id: assurance.factor_id,
              factor_revision: assurance.factor_revision,
              mfa_verified_at: assurance.mfa_verified_at,
            }
          : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: locked.context.workspaceId,
      actorUserId: locked.context.userId,
      action: 'workspace.security.policy_tested',
      targetType: 'workspace',
      targetId: locked.context.workspaceId,
      metadata: { purpose, result: proposed.state },
    });
    return {
      testId: saved.id,
      testToken: token,
      expiresAt: expires.toISOString(),
      status: proposed,
    };
  });
