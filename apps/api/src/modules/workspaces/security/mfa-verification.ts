/** Consume actual workspace proof and counter in the same transaction as its purpose-bound receipt. */
import type { Transaction } from '@purlay/db';
import {
  WORKSPACE_MFA_SECRET_BYTES,
  type UseWorkspaceMfaRecoveryRequest,
  type VerifyWorkspaceMfaRequest,
  type WorkspaceMfaRecoveryCodes,
  type WorkspaceMfaVerified,
} from '@purlay/types/workspace-security';
import { AppError } from '../../../platform/errors';
import { atomicallyOn } from '../../../platform/transactions';
import { recordAudit } from '../../audit/audit';
import { matchingWorkspaceTotpCounter } from '../../auth/workspace-totp';
import { recordWorkspaceMfaVerification, workspaceAccessStatus } from './access';
import {
  lockWorkspaceSecurityActor,
  mfaInvalid,
  mfaLocked,
  requireFreshSecurityPrimary,
  securityChanged,
  securityNotReady,
  type LockedWorkspaceSecurityActor,
  type WorkspaceSecurityActor,
  type WorkspaceSecurityDependencies,
} from './authority';
import {
  checkMfaChallenge,
  factorView,
  lockMfaFactors,
  lockMfaPolicy,
  lockMfaPolicyTest,
  readMfaChallenge,
  recoveryDigest,
  replaceMfaRecoveryCodes,
  workspaceFactorBinding,
  type WorkspaceChallengeRow,
  type WorkspaceFactorRow,
} from './mfa-state';

const LOCK_SECONDS = 15 * 60;
const FACTOR_FAILURES = 10;

/** Return the error from the transaction so durable limiter writes commit before the caller receives it. */
const failedProof = async (
  transaction: Transaction,
  factor: WorkspaceFactorRow,
  challenge: WorkspaceChallengeRow,
  now: Date,
): Promise<AppError> => {
  const previousLock = factor.locked_until;
  const count =
    (previousLock !== null && new Date(previousLock).getTime() <= now.getTime()
      ? 0
      : factor.failed_verification_count) + 1;
  const attempts = challenge.failed_attempts + 1;
  await transaction
    .updateTable('workspace_mfa_factors')
    .set({
      failed_verification_count: count,
      locked_until:
        count >= FACTOR_FAILURES ? new Date(now.getTime() + LOCK_SECONDS * 1_000) : null,
      updated_at: now,
    })
    .where('id', '=', factor.id)
    .execute();
  await transaction
    .updateTable('workspace_mfa_challenges')
    .set({ failed_attempts: attempts, consumed_at: attempts >= 5 ? now : null })
    .where('id', '=', challenge.id)
    .execute();
  return count >= FACTOR_FAILURES ? mfaLocked(LOCK_SECONDS) : mfaInvalid();
};

const acceptedCode = async (
  transaction: Transaction,
  dependencies: WorkspaceSecurityDependencies,
  locked: LockedWorkspaceSecurityActor,
  factor: WorkspaceFactorRow,
  code: string,
  method: 'totp' | 'recovery',
  now: Date,
): Promise<number | 'recovery' | null> => {
  if (method === 'recovery') {
    if (factor.state !== 'verified' || code.length !== 22 || /[^A-Za-z0-9_-]/u.test(code))
      return null;
    const recovery = await transaction
      .selectFrom('workspace_mfa_recovery_codes')
      .select('id')
      .where('workspace_id', '=', locked.context.workspaceId)
      .where('user_id', '=', locked.context.userId)
      .where('purpose', '=', 'factor')
      .where('factor_id', '=', factor.id)
      .where('factor_revision', '=', factor.revision)
      .where(
        'code_hash',
        '=',
        await recoveryDigest(locked.context.workspaceId, locked.context.userId, code),
      )
      .where('spent_at', 'is', null)
      .where('revoked_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (recovery === undefined) return null;
    await transaction
      .updateTable('workspace_mfa_recovery_codes')
      .set({ spent_at: now })
      .where('id', '=', recovery.id)
      .execute();
    return 'recovery';
  }
  const encoded = await dependencies.cipher.open(
    factor.secret_encrypted,
    workspaceFactorBinding(locked.context.workspaceId, locked.context.userId, factor.id),
  );
  const secret = Buffer.from(encoded, 'base64url');
  if (secret.length !== WORKSPACE_MFA_SECRET_BYTES || secret.toString('base64url') !== encoded)
    throw securityNotReady('The workspace authenticator could not be read.');
  const counter = await matchingWorkspaceTotpCounter(secret, code, now);
  return counter === null ||
    (factor.last_accepted_counter !== null &&
      BigInt(counter) <= BigInt(factor.last_accepted_counter))
    ? null
    : counter;
};

const verify = async (
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
  request: VerifyWorkspaceMfaRequest | UseWorkspaceMfaRecoveryRequest,
  method: 'totp' | 'recovery',
): Promise<WorkspaceMfaVerified> => {
  const outcome = await atomicallyOn(dependencies.database)(
    async (transaction): Promise<WorkspaceMfaVerified | AppError> => {
      const locked = await lockWorkspaceSecurityActor(transaction, dependencies, actor, 'self');
      // This first read identifies the test before factor locks; it grants nothing and is re-read FOR UPDATE below.
      const observed = await readMfaChallenge(transaction, locked, request.challengeId, false);
      const policy = await lockMfaPolicy(transaction, locked);
      const now = dependencies.clock.now();
      if (observed.test_id !== null) {
        if (locked.context.role !== 'owner' || locked.context.guest !== undefined)
          throw new AppError({
            code: 'FORBIDDEN',
            message: 'A workspace owner is required for this action.',
          });
        await lockMfaPolicyTest(transaction, locked, observed.test_id, policy, now);
      }
      const factors = await lockMfaFactors(transaction, locked);
      let factor = factors.find((row) => row.id === observed.factor_id);
      const challenge = await readMfaChallenge(transaction, locked, request.challengeId, true);
      checkMfaChallenge(challenge, locked, policy, now);
      if (factor?.revision !== challenge.factor_revision) throw securityChanged();
      if (challenge.purpose === 'enroll') {
        requireFreshSecurityPrimary(dependencies, locked);
        if (
          method === 'recovery' ||
          (challenge.consumed_at === null &&
            (factor.state !== 'pending' ||
              factor.pending_expires_at === null ||
              new Date(factor.pending_expires_at).getTime() <= now.getTime()))
        )
          throw mfaInvalid();
      } else if (factor.state !== 'verified') throw securityChanged();
      if (challenge.consumed_at !== null) {
        // Lost-response retry: no new counter consumption, MFA time, plaintext batch or critical operation.
        return {
          factor: factorView(factor),
          status: await workspaceAccessStatus({ ...dependencies, database: transaction }, actor),
        };
      }
      if (factor.locked_until !== null && new Date(factor.locked_until).getTime() > now.getTime())
        return mfaLocked(
          Math.ceil((new Date(factor.locked_until).getTime() - now.getTime()) / 1_000),
        );
      const accepted = await acceptedCode(
        transaction,
        dependencies,
        locked,
        factor,
        request.code,
        method,
        now,
      );
      if (accepted === null) return await failedProof(transaction, factor, challenge, now);
      const old =
        challenge.purpose === 'enroll'
          ? factors.find((row) => row.state === 'verified')
          : undefined;
      if (old !== undefined)
        await transaction
          .updateTable('workspace_mfa_factors')
          .set({ state: 'revoked', revoked_at: now, updated_at: now })
          .where('id', '=', old.id)
          .execute();
      const updated = await transaction
        .updateTable('workspace_mfa_factors')
        .set({
          ...(challenge.purpose === 'enroll' ? { state: 'verified', verified_at: now } : {}),
          ...(accepted === 'recovery' ? {} : { last_accepted_counter: String(accepted) }),
          failed_verification_count: 0,
          locked_until: null,
          updated_at: now,
        })
        .where('id', '=', factor.id)
        .where('revision', '=', factor.revision)
        .where((expression) =>
          accepted === 'recovery'
            ? expression.val(true)
            : expression.or([
                expression('last_accepted_counter', 'is', null),
                expression('last_accepted_counter', '<', String(accepted)),
              ]),
        )
        .returningAll()
        .executeTakeFirst();
      if (updated === undefined) throw securityChanged();
      factor = updated; // Pending → verified changes revision in SQL; the old revision is no authority.
      const critical = ['rotate', 'disable', 'recovery_codes'].includes(challenge.purpose);
      await transaction
        .updateTable('workspace_mfa_challenges')
        .set({
          consumed_at: now,
          completed_at: critical ? null : now,
          failed_attempts: 0,
          factor_revision: factor.revision,
        })
        .where('id', '=', challenge.id)
        .execute();
      let recoveryCodes: WorkspaceMfaRecoveryCodes | undefined;
      if (challenge.purpose === 'enroll')
        recoveryCodes = await replaceMfaRecoveryCodes(transaction, locked, factor, now);
      await recordWorkspaceMfaVerification(transaction, dependencies, actor, {
        factorId: factor.id,
        factorRevision: factor.revision,
        verifiedAt: now,
      });
      if (old !== undefined)
        await transaction
          .updateTable('workspace_session_assurances')
          .set({ ended_at: now, end_reason: 'factor_revoked', updated_at: now })
          .where('workspace_id', '=', locked.context.workspaceId)
          .where('user_id', '=', locked.context.userId)
          .where('factor_scope', '=', 'workspace')
          .where('factor_id', '=', old.id)
          .where('ended_at', 'is', null)
          .execute();
      if (old !== undefined)
        await transaction
          .deleteFrom('workspace_mfa_factors')
          .where('id', '=', old.id)
          .where('workspace_id', '=', locked.context.workspaceId)
          .where('user_id', '=', locked.context.userId)
          .execute();
      if (challenge.test_id !== null)
        await transaction
          .updateTable('workspace_access_policy_tests')
          .set({
            factor_scope: 'workspace',
            factor_id: factor.id,
            factor_revision: factor.revision,
            mfa_verified_at: now,
          })
          .where('id', '=', challenge.test_id)
          .execute();
      if (challenge.purpose === 'enroll' || method === 'recovery')
        await recordAudit(transaction, dependencies.clock, {
          workspaceId: locked.context.workspaceId,
          actorUserId: locked.context.userId,
          ...(challenge.purpose === 'enroll'
            ? old === undefined
              ? { action: 'workspace.mfa.enrolled' as const }
              : { action: 'workspace.mfa.rotated' as const }
            : { action: 'workspace.mfa.recovery_used' as const }),
          targetType: 'user',
          targetId: locked.context.userId,
          metadata: {
            factorId: factor.id,
            factorRevision: factor.revision,
            ...(old === undefined
              ? {}
              : { previousFactorId: old.id, previousFactorRevision: old.revision }),
          },
        });
      return {
        factor: factorView(factor),
        status: await workspaceAccessStatus({ ...dependencies, database: transaction }, actor),
        ...(recoveryCodes === undefined ? {} : { recoveryCodes }),
      };
    },
  );
  if (outcome instanceof AppError) throw outcome;
  return outcome;
};

export const verifyWorkspaceMfa = async (
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
  request: VerifyWorkspaceMfaRequest,
): Promise<WorkspaceMfaVerified> => await verify(dependencies, actor, request, 'totp');

export const useWorkspaceMfaRecovery = async (
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
  request: UseWorkspaceMfaRecoveryRequest,
): Promise<WorkspaceMfaVerified> => await verify(dependencies, actor, request, 'recovery');
