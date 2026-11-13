/** Critical factor changes consume a fresh, purpose-bound workspace MFA receipt exactly once. */
import type { Transaction } from '@purlay/db';
import type {
  ChangeWorkspaceMfaRequest,
  MyWorkspaceMfa,
  WorkspaceMfaRecoveryCodes,
} from '@purlay/types/workspace-security';
import { atomicallyOn } from '../../../platform/transactions';
import { recordAudit } from '../../audit/audit';
import {
  lockWorkspaceSecurityActor,
  requireFreshSecurityPrimary,
  securityChanged,
  type LockedWorkspaceSecurityActor,
  type WorkspaceSecurityActor,
  type WorkspaceSecurityDependencies,
} from './authority';
import { workspaceMfaInventory } from './mfa-inventory';
import {
  cancelMfaChallenges,
  checkMfaChallenge,
  lockMfaFactors,
  lockMfaPolicy,
  readMfaChallenge,
  replaceMfaRecoveryCodes,
  type WorkspaceChallengeRow,
  type WorkspaceFactorRow,
} from './mfa-state';

interface AuthorizedFactorChange {
  readonly locked: LockedWorkspaceSecurityActor;
  readonly factor: WorkspaceFactorRow | undefined;
  readonly receipt: WorkspaceChallengeRow;
}

const authorize = async (
  transaction: Transaction,
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
  request: ChangeWorkspaceMfaRequest,
  purpose: 'disable' | 'recovery_codes',
): Promise<AuthorizedFactorChange> => {
  const locked = await lockWorkspaceSecurityActor(transaction, dependencies, actor, 'self');
  requireFreshSecurityPrimary(dependencies, locked);
  const policy = await lockMfaPolicy(transaction, locked, request.policyRevision);
  const factors = await lockMfaFactors(transaction, locked);
  const receipt = await readMfaChallenge(
    transaction,
    locked,
    request.authorizationChallengeId,
    true,
  );
  checkMfaChallenge(receipt, locked, policy, dependencies.clock.now());
  if (
    receipt.purpose !== purpose ||
    receipt.factor_revision !== request.factorRevision ||
    receipt.consumed_at === null
  )
    throw securityChanged();
  const factor = factors.find(
    (row) =>
      row.id === receipt.factor_id &&
      row.revision === receipt.factor_revision &&
      row.state === 'verified',
  );
  if (receipt.completed_at === null && factor === undefined) throw securityChanged();
  return { locked, factor, receipt };
};

export const revokeWorkspaceMfa = async (
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
  request: ChangeWorkspaceMfaRequest,
): Promise<MyWorkspaceMfa> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const { locked, factor, receipt } = await authorize(
      transaction,
      dependencies,
      actor,
      request,
      'disable',
    );
    // A lost-response retry observes current state; it cannot revoke a subsequently enrolled factor.
    if (receipt.completed_at !== null)
      return await workspaceMfaInventory(transaction, dependencies, actor, locked);
    if (factor === undefined) throw securityChanged();
    const now = dependencies.clock.now();
    await transaction
      .updateTable('workspace_mfa_challenges')
      .set({ completed_at: now })
      .where('id', '=', receipt.id)
      .execute();
    await transaction
      .updateTable('workspace_mfa_factors')
      .set({ state: 'revoked', revoked_at: now, updated_at: now })
      .where('workspace_id', '=', locked.context.workspaceId)
      .where('user_id', '=', locked.context.userId)
      .where('state', 'in', ['pending', 'verified'])
      .execute();
    await transaction
      .deleteFrom('workspace_mfa_recovery_codes')
      .where('workspace_id', '=', locked.context.workspaceId)
      .where('user_id', '=', locked.context.userId)
      .where('purpose', '=', 'factor')
      .execute();
    await cancelMfaChallenges(transaction, locked, now);
    await transaction
      .updateTable('workspace_session_assurances')
      .set({ ended_at: now, end_reason: 'factor_revoked', updated_at: now })
      .where('workspace_id', '=', locked.context.workspaceId)
      .where('user_id', '=', locked.context.userId)
      .where('factor_scope', '=', 'workspace')
      .where('factor_id', '=', factor.id)
      .where('ended_at', 'is', null)
      .execute();
    await transaction
      .deleteFrom('workspace_mfa_factors')
      .where('workspace_id', '=', locked.context.workspaceId)
      .where('user_id', '=', locked.context.userId)
      .execute();
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: locked.context.workspaceId,
      actorUserId: locked.context.userId,
      action: 'workspace.mfa.revoked',
      targetType: 'user',
      targetId: locked.context.userId,
      metadata: { factorId: factor.id, factorRevision: factor.revision },
    });
    return await workspaceMfaInventory(transaction, dependencies, actor, locked);
  });

export const rotateWorkspaceMfaRecoveryCodes = async (
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
  request: ChangeWorkspaceMfaRequest,
): Promise<WorkspaceMfaRecoveryCodes> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const { locked, factor, receipt } = await authorize(
      transaction,
      dependencies,
      actor,
      request,
      'recovery_codes',
    );
    // Hash-only storage cannot replay a committed plaintext batch. A fresh proof explicitly replaces it.
    if (receipt.completed_at !== null || factor === undefined) throw securityChanged();
    const now = dependencies.clock.now();
    const result = await replaceMfaRecoveryCodes(transaction, locked, factor, now);
    await transaction
      .updateTable('workspace_mfa_challenges')
      .set({ completed_at: now })
      .where('id', '=', receipt.id)
      .execute();
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: locked.context.workspaceId,
      actorUserId: locked.context.userId,
      action: 'workspace.mfa.recovery_codes_rotated',
      targetType: 'user',
      targetId: locked.context.userId,
      metadata: {
        factorId: factor.id,
        factorRevision: factor.revision,
        recoveryRevision: result.revision,
      },
    });
    return result;
  });
