/** Workspace-owned enrollment and challenge creation; global MFA stays on the native authentication flow. */
import {
  WORKSPACE_MFA_PENDING_SECONDS,
  type MyWorkspaceMfa,
  type StartWorkspaceMfaChallengeRequest,
  type StartWorkspaceMfaEnrollmentRequest,
  type WorkspaceMfaChallenge,
  type WorkspaceMfaEnrollment,
} from '@purlay/types/workspace-security';
import { AppError } from '../../../platform/errors';
import { atomicallyOn } from '../../../platform/transactions';
import { createWorkspaceTotp } from '../../auth/workspace-totp';
import { workspaceAccessStatus } from './access';
import { workspaceMfaInventory } from './mfa-inventory';
import {
  lockWorkspaceSecurityActor,
  mfaInvalid,
  mfaLocked,
  mfaMissing,
  requireFreshSecurityPrimary,
  securityChanged,
  type WorkspaceSecurityActor,
  type WorkspaceSecurityDependencies,
} from './authority';
import {
  checkMfaChallenge,
  createMfaChallenge,
  factorView,
  lockMfaFactors,
  lockMfaPolicy,
  lockMfaPolicyTest,
  readMfaChallenge,
  workspaceFactorBinding,
} from './mfa-state';

export { verifyWorkspaceMfa, useWorkspaceMfaRecovery } from './mfa-verification';
export { revokeWorkspaceMfa, rotateWorkspaceMfaRecoveryCodes } from './mfa-operations';

export const myWorkspaceMfa = async (
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
): Promise<MyWorkspaceMfa> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const locked = await lockWorkspaceSecurityActor(transaction, dependencies, actor, 'self');
    await lockMfaPolicy(transaction, locked);
    return await workspaceMfaInventory(transaction, dependencies, actor, locked);
  });

export const startWorkspaceMfaEnrollment = async (
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
  request: StartWorkspaceMfaEnrollmentRequest,
): Promise<WorkspaceMfaEnrollment> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const locked = await lockWorkspaceSecurityActor(transaction, dependencies, actor, 'self');
    requireFreshSecurityPrimary(dependencies, locked);
    const policy = await lockMfaPolicy(transaction, locked, request.policyRevision);
    const factors = await lockMfaFactors(transaction, locked);
    const active = factors.find((row) => row.state === 'verified');
    if ((active?.revision ?? null) !== request.factorRevision) throw securityChanged();
    const now = dependencies.clock.now();
    if (active !== undefined) {
      if (request.authorizationChallengeId === undefined) throw mfaInvalid();
      const receipt = await readMfaChallenge(
        transaction,
        locked,
        request.authorizationChallengeId,
        true,
      );
      checkMfaChallenge(receipt, locked, policy, now);
      if (
        receipt.purpose !== 'rotate' ||
        receipt.factor_id !== active.id ||
        receipt.factor_revision !== active.revision ||
        receipt.consumed_at === null ||
        receipt.completed_at !== null
      )
        throw securityChanged();
      await transaction
        .updateTable('workspace_mfa_challenges')
        .set({ completed_at: now })
        .where('id', '=', receipt.id)
        .execute();
    } else if (request.authorizationChallengeId !== undefined) throw securityChanged();
    // An abandoned/lost setup is replaced, never decrypted for a later readback.
    await transaction
      .deleteFrom('workspace_mfa_factors')
      .where('workspace_id', '=', locked.context.workspaceId)
      .where('user_id', '=', locked.context.userId)
      .where('state', '=', 'pending')
      .execute();
    const id = crypto.randomUUID();
    const setup = createWorkspaceTotp(`${locked.context.workspaceId}:${locked.user.email}`);
    const sealed = await dependencies.cipher.seal(
      Buffer.from(setup.secret).toString('base64url'),
      workspaceFactorBinding(locked.context.workspaceId, locked.context.userId, id),
    );
    const factor = await transaction
      .insertInto('workspace_mfa_factors')
      .values({
        id,
        workspace_id: locked.context.workspaceId,
        user_id: locked.context.userId,
        secret_encrypted: Buffer.from(sealed),
        state: 'pending',
        pending_expires_at: new Date(now.getTime() + WORKSPACE_MFA_PENDING_SECONDS * 1_000),
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const challenge = await createMfaChallenge(transaction, locked, policy, factor, 'enroll', now);
    return { factor: factorView(factor), challenge, totpURI: setup.uri };
  });

export const startWorkspaceMfaChallenge = async (
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
  request: StartWorkspaceMfaChallengeRequest,
): Promise<WorkspaceMfaChallenge> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const locked = await lockWorkspaceSecurityActor(
      transaction,
      dependencies,
      actor,
      request.purpose === 'policy_test' ? 'owner' : 'self',
    );
    const policy = await lockMfaPolicy(transaction, locked, request.policyRevision);
    if (
      request.purpose === 'enroll' ||
      (request.purpose === 'policy_test') !== (request.testId !== undefined)
    )
      throw mfaInvalid();
    if (request.purpose !== 'step_up') requireFreshSecurityPrimary(dependencies, locked);
    const now = dependencies.clock.now();
    if (request.testId !== undefined)
      await lockMfaPolicyTest(transaction, locked, request.testId, policy, now);
    const factor = (await lockMfaFactors(transaction, locked)).find(
      (row) => row.state === 'verified',
    );
    if (factor === undefined) throw mfaMissing();
    if (factor.locked_until !== null && new Date(factor.locked_until).getTime() > now.getTime())
      throw mfaLocked(Math.ceil((new Date(factor.locked_until).getTime() - now.getTime()) / 1_000));
    const challenge = await createMfaChallenge(
      transaction,
      locked,
      policy,
      factor,
      request.purpose,
      now,
      request.testId,
    );
    const status = await workspaceAccessStatus({ ...dependencies, database: transaction }, actor);
    if (status.state === 'sign_in_required' || status.state === 'expired')
      throw new AppError({
        code: 'REAUTHENTICATION_REQUIRED',
        message: 'Sign in again before workspace verification.',
      });
    return challenge;
  });
