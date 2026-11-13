/** Offline recovery changes policy metadata only; code regeneration never bypasses currently enforced policy. */
import type { Transaction } from '@purlay/db';
import type {
  CreateWorkspacePolicyRecoveryRequest,
  RecoverWorkspacePolicyRequest,
  WorkspaceAccessPolicy,
  WorkspacePolicyRecovery,
} from '@purlay/types/workspace-security';
import { AppError } from '../../../platform/errors';
import { assertSecurityMinted } from '../../../platform/tenancy';
import { atomicallyOn } from '../../../platform/transactions';
import { recordAudit } from '../../audit/audit';
import {
  lockWorkspaceSecurityActor,
  requireFreshSecurityPrimary,
  securityChanged,
  type WorkspaceSecurityActor,
} from './authority';
import {
  lockPolicyActorFactors,
  requireCurrentPolicyAccess,
  type WorkspacePolicyDependencies,
} from './policy-authority';
import {
  defaultWorkspacePolicy,
  lockPolicyRow,
  policySettings,
  policyTestDigest,
  policyTestToken,
  storeWorkspacePolicy,
  workspacePolicyView,
  type PolicyTestRow,
} from './policy-state';
import {
  consumePolicyTest,
  lockPolicyTest,
  requireTestMfaCurrent,
  validatePolicyTest,
} from './policy-tests';
import {
  lockOwnPolicyRecoveryRows,
  policyRecoveryDigest,
  requireIndependentRecoveryMethod,
} from './recovery-state';

/** The observation grants nothing: both source IDs are then locked in sorted order before any workspace/user row. */
const recoverySetupSource = async (
  transaction: Transaction,
  actor: WorkspaceSecurityActor,
  request: CreateWorkspacePolicyRecoveryRequest,
): Promise<string | undefined> => {
  assertSecurityMinted(actor.context);
  if (!('testId' in request)) return undefined;
  const observed = await transaction
    .selectFrom('workspace_access_policy_tests')
    .select('session_id')
    .where('id', '=', request.testId)
    .where('token_hash', '=', await policyTestDigest(request.testToken))
    .where('workspace_id', '=', actor.context.workspaceId)
    .where('user_id', '=', actor.context.userId)
    .executeTakeFirst();
  if (observed === undefined || observed.session_id === actor.sessionId) throw securityChanged();
  const ids = [observed.session_id, actor.sessionId].sort();
  const sessions = await transaction
    .selectFrom('sessions')
    .select('id')
    .where('id', 'in', ids)
    .where('user_id', '=', actor.context.userId)
    .orderBy('id')
    .forShare()
    .execute();
  if (sessions.length !== 2) throw securityChanged();
  return observed.session_id;
};

export const createWorkspacePolicyRecovery = async (
  dependencies: WorkspacePolicyDependencies,
  actor: WorkspaceSecurityActor,
  request: CreateWorkspacePolicyRecoveryRequest,
): Promise<WorkspacePolicyRecovery> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const sourceId = await recoverySetupSource(transaction, actor, request);
    const locked = await lockWorkspaceSecurityActor(transaction, dependencies, actor, 'owner');
    requireFreshSecurityPrimary(dependencies, locked, { independent: true });
    const current = await lockPolicyRow(transaction, locked, request.policyRevision);
    let sourceActor = actor;
    let setup: PolicyTestRow | undefined;
    if (sourceId !== undefined && 'testId' in request) {
      sourceActor = { context: locked.context, sessionId: sourceId };
      // Re-entrant source lock: recoverySetupSource already holds BOTH native IDs before workspace/user locks.
      const source = await lockWorkspaceSecurityActor(
        transaction,
        dependencies,
        sourceActor,
        'owner',
      );
      requireFreshSecurityPrimary(dependencies, source);
      setup = await lockPolicyTest(transaction, source, request.testId, request.testToken);
      await validatePolicyTest(
        transaction,
        dependencies,
        source,
        current,
        setup,
        policySettings(current),
        'recovery_setup',
      );
      if (setup.tested_at === null) throw securityChanged();
      await lockPolicyActorFactors(transaction, source);
    } else await lockPolicyActorFactors(transaction, locked);
    await lockOwnPolicyRecoveryRows(transaction, locked);
    await requireCurrentPolicyAccess(transaction, dependencies, sourceActor);
    if (setup !== undefined)
      await requireTestMfaCurrent(transaction, dependencies, sourceActor, setup);
    await requireIndependentRecoveryMethod(transaction, dependencies, locked);
    requireFreshSecurityPrimary(dependencies, locked, { independent: true });
    const now = dependencies.clock.now();
    if (setup !== undefined) {
      if (new Date(setup.expires_at).getTime() <= now.getTime()) throw securityChanged();
      await consumePolicyTest(transaction, setup, now);
    }
    const revision = crypto.randomUUID();
    const recoveryCode = policyTestToken();
    await transaction
      .deleteFrom('workspace_mfa_recovery_codes')
      .where('workspace_id', '=', locked.context.workspaceId)
      .where('user_id', '=', locked.context.userId)
      .where('purpose', '=', 'policy')
      .execute();
    await transaction
      .insertInto('workspace_mfa_recovery_codes')
      .values({
        workspace_id: locked.context.workspaceId,
        user_id: locked.context.userId,
        purpose: 'policy',
        revision,
        code_hash: await policyRecoveryDigest(
          locked.context.workspaceId,
          locked.context.userId,
          revision,
          recoveryCode,
        ),
        created_at: now,
      })
      .execute();
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: locked.context.workspaceId,
      actorUserId: locked.context.userId,
      action: 'workspace.security.recovery_created',
      targetType: 'workspace',
      targetId: locked.context.workspaceId,
      metadata: { revision },
    });
    return { revision, recoveryCode };
  });

export const recoverWorkspacePolicy = async (
  dependencies: WorkspacePolicyDependencies,
  actor: WorkspaceSecurityActor,
  request: RecoverWorkspacePolicyRequest,
): Promise<WorkspaceAccessPolicy> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const locked = await lockWorkspaceSecurityActor(transaction, dependencies, actor, 'owner');
    requireFreshSecurityPrimary(dependencies, locked, { independent: true });
    // Explicit offline recovery may repair a missing governed row; normal policy and MFA readers still fail closed.
    await transaction
      .selectFrom('workspace_access_policies')
      .select('workspace_id')
      .where('workspace_id', '=', locked.context.workspaceId)
      .forUpdate()
      .execute();
    await lockPolicyActorFactors(transaction, locked);
    const code = await transaction
      .selectFrom('workspace_mfa_recovery_codes')
      .select('id')
      .where('workspace_id', '=', locked.context.workspaceId)
      .where('user_id', '=', locked.context.userId)
      .where('purpose', '=', 'policy')
      .where('revision', '=', request.revision)
      .where(
        'code_hash',
        '=',
        await policyRecoveryDigest(
          locked.context.workspaceId,
          locked.context.userId,
          request.revision,
          request.recoveryCode,
        ),
      )
      .where('spent_at', 'is', null)
      .where('revoked_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (code === undefined) throw securityChanged();
    await requireIndependentRecoveryMethod(transaction, dependencies, locked);
    requireFreshSecurityPrimary(dependencies, locked, { independent: true });
    const now = dependencies.clock.now();
    if (new Date(locked.session.expires_at).getTime() <= now.getTime())
      throw new AppError({
        code: 'UNAUTHENTICATED',
        message: 'Sign in again to recover workspace policy.',
      });
    const spent = await transaction
      .updateTable('workspace_mfa_recovery_codes')
      .set({ spent_at: now })
      .where('id', '=', code.id)
      .where('spent_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (spent === undefined) throw securityChanged();
    const saved = await storeWorkspacePolicy(
      transaction,
      dependencies,
      locked,
      defaultWorkspacePolicy(),
      now,
    );
    await transaction
      .deleteFrom('workspace_mfa_recovery_codes')
      .where('id', '=', code.id)
      .execute();
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: locked.context.workspaceId,
      actorUserId: locked.context.userId,
      action: 'workspace.security.policy_recovered',
      targetType: 'workspace',
      targetId: locked.context.workspaceId,
      metadata: { revision: saved.revision, recoveryRevision: request.revision },
    });
    return workspacePolicyView(saved, saved.epoch);
  });
