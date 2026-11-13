/** Storage operations shared by workspace MFA: native/global factors remain outside this service. */
import { type Database, type Selectable, type Transaction } from '@purlay/db';
import {
  WORKSPACE_MFA_CHALLENGE_SECONDS,
  WORKSPACE_MFA_RECOVERY_CODES_COUNT,
  type WorkspaceMfaChallenge,
  type WorkspaceMfaFactor,
  type WorkspaceMfaPurpose,
  type WorkspaceMfaRecoveryCodes,
} from '@purlay/types/workspace-security';
import { tokenDigest } from '../../../platform/tokens';
import {
  mfaInvalid,
  mfaMissing,
  securityChanged,
  securityNotReady,
  type LockedWorkspaceSecurityActor,
} from './authority';

export type WorkspaceFactorRow = Selectable<Database['workspace_mfa_factors']>;
export type WorkspaceChallengeRow = Selectable<Database['workspace_mfa_challenges']>;
export type WorkspacePolicyRow = Selectable<Database['workspace_access_policies']>;

export const factorView = (row: WorkspaceFactorRow): WorkspaceMfaFactor => {
  if (row.state !== 'pending' && row.state !== 'verified' && row.state !== 'revoked')
    throw securityNotReady('Workspace factor state is unknown.');
  return {
    id: row.id,
    revision: row.revision,
    state: row.state,
    createdAt: new Date(row.created_at).toISOString(),
    verifiedAt: row.verified_at === null ? null : new Date(row.verified_at).toISOString(),
    pendingExpiresAt:
      row.pending_expires_at === null ? null : new Date(row.pending_expires_at).toISOString(),
  };
};

export const workspaceFactorBinding = (
  workspaceId: string,
  userId: string,
  factorId: string,
): string => `purlay:workspace-mfa:v1:${workspaceId}:${userId}:${factorId}`;

const mfaToken = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const challengeDigest = async (token: string): Promise<Buffer> =>
  Buffer.from(await tokenDigest(`purlay:workspace-mfa-challenge:v1:${token}`), 'hex');
export const recoveryDigest = async (
  workspaceId: string,
  userId: string,
  code: string,
): Promise<Buffer> =>
  Buffer.from(
    await tokenDigest(`purlay:workspace-mfa-recovery:v1:${workspaceId}:${userId}:${code}`),
    'hex',
  );

export const lockMfaPolicy = async (
  transaction: Transaction,
  locked: LockedWorkspaceSecurityActor,
  expectedRevision?: string | null,
): Promise<WorkspacePolicyRow | undefined> => {
  const row = await transaction
    .selectFrom('workspace_access_policies')
    .selectAll()
    .where('workspace_id', '=', locked.context.workspaceId)
    .forUpdate()
    .executeTakeFirst();
  const epoch = locked.workspace.access_policy_epoch;
  if ((row === undefined && epoch !== '0') || (row !== undefined && row.epoch !== epoch))
    throw securityNotReady(
      'Workspace policy state is incomplete. Sign in again after it is repaired.',
    );
  if (expectedRevision !== undefined && (row?.revision ?? null) !== expectedRevision)
    throw securityChanged();
  return row;
};

export const lockMfaFactors = async (
  transaction: Transaction,
  locked: LockedWorkspaceSecurityActor,
): Promise<readonly WorkspaceFactorRow[]> =>
  await transaction
    .selectFrom('workspace_mfa_factors')
    .selectAll()
    .where('workspace_id', '=', locked.context.workspaceId)
    .where('user_id', '=', locked.context.userId)
    .where('state', 'in', ['pending', 'verified'])
    .orderBy('id')
    .forUpdate()
    .execute();

export const cancelMfaChallenges = async (
  transaction: Transaction,
  locked: LockedWorkspaceSecurityActor,
  now: Date,
  purpose?: WorkspaceMfaPurpose,
): Promise<void> => {
  let query = transaction
    .updateTable('workspace_mfa_challenges')
    .set({ consumed_at: now, failed_attempts: 5 })
    .where('workspace_id', '=', locked.context.workspaceId)
    .where('user_id', '=', locked.context.userId)
    .where('session_id', '=', locked.session.id)
    .where('consumed_at', 'is', null);
  if (purpose !== undefined) query = query.where('purpose', '=', purpose);
  await query.execute();
};

export const createMfaChallenge = async (
  transaction: Transaction,
  locked: LockedWorkspaceSecurityActor,
  policy: WorkspacePolicyRow | undefined,
  factor: WorkspaceFactorRow,
  purpose: WorkspaceMfaPurpose,
  now: Date,
  testId?: string,
): Promise<WorkspaceMfaChallenge> => {
  if (locked.evidence === undefined)
    throw securityNotReady('Sign in again before verifying workspace security.');
  await cancelMfaChallenges(transaction, locked, now, purpose);
  const token = mfaToken();
  const expires = new Date(
    Math.min(
      now.getTime() + WORKSPACE_MFA_CHALLENGE_SECONDS * 1_000,
      new Date(locked.session.expires_at).getTime(),
      factor.state === 'pending' && factor.pending_expires_at !== null
        ? new Date(factor.pending_expires_at).getTime()
        : Infinity,
    ),
  );
  await transaction
    .insertInto('workspace_mfa_challenges')
    .values({
      token_hash: await challengeDigest(token),
      workspace_id: locked.context.workspaceId,
      session_id: locked.session.id,
      user_id: locked.context.userId,
      authentication_revision: locked.evidence.revision,
      policy_revision: policy?.revision ?? null,
      policy_epoch: locked.workspace.access_policy_epoch,
      factor_scope: 'workspace',
      factor_id: factor.id,
      factor_revision: factor.revision,
      purpose,
      test_id: testId ?? null,
      created_at: now,
      expires_at: expires,
    })
    .execute();
  return {
    challengeId: token,
    policyRevision: policy?.revision ?? null,
    purpose,
    factorScope: 'workspace',
    factorId: factor.id,
    factorRevision: factor.revision,
    expiresAt: expires.toISOString(),
  };
};

export const readMfaChallenge = async (
  transaction: Transaction,
  locked: LockedWorkspaceSecurityActor,
  token: string,
  rowLock: boolean,
): Promise<WorkspaceChallengeRow> => {
  let query = transaction
    .selectFrom('workspace_mfa_challenges')
    .selectAll()
    .where('token_hash', '=', await challengeDigest(token))
    .where('workspace_id', '=', locked.context.workspaceId)
    .where('session_id', '=', locked.session.id)
    .where('user_id', '=', locked.context.userId);
  if (rowLock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) throw mfaMissing();
  return row;
};

export const checkMfaChallenge = (
  row: WorkspaceChallengeRow,
  locked: LockedWorkspaceSecurityActor,
  policy: WorkspacePolicyRow | undefined,
  now: Date,
): void => {
  if (
    row.authentication_revision !== locked.evidence?.revision ||
    row.policy_epoch !== locked.workspace.access_policy_epoch ||
    row.policy_revision !== (policy?.revision ?? null)
  )
    throw securityChanged();
  if (
    row.factor_scope !== 'workspace' ||
    new Date(row.expires_at).getTime() <= now.getTime() ||
    row.failed_attempts >= 5
  )
    throw mfaInvalid();
};

export const lockMfaPolicyTest = async (
  transaction: Transaction,
  locked: LockedWorkspaceSecurityActor,
  id: string,
  policy: WorkspacePolicyRow | undefined,
  now: Date,
): Promise<void> => {
  const test = await transaction
    .selectFrom('workspace_access_policy_tests')
    .selectAll()
    .where('id', '=', id)
    .where('workspace_id', '=', locked.context.workspaceId)
    .where('session_id', '=', locked.session.id)
    .where('user_id', '=', locked.context.userId)
    .forUpdate()
    .executeTakeFirst();
  if (test === undefined) throw mfaMissing();
  if (
    test.authentication_revision !== locked.evidence?.revision ||
    test.policy_epoch !== locked.workspace.access_policy_epoch ||
    test.policy_revision !== (policy?.revision ?? null) ||
    test.consumed_at !== null ||
    new Date(test.expires_at).getTime() <= now.getTime()
  )
    throw securityChanged();
};

/** Only hashes persist; a committed batch is never read back or replayed after a lost response. */
export const replaceMfaRecoveryCodes = async (
  transaction: Transaction,
  locked: LockedWorkspaceSecurityActor,
  factor: WorkspaceFactorRow,
  now: Date,
): Promise<WorkspaceMfaRecoveryCodes> => {
  const revision = crypto.randomUUID();
  const backupCodes = Array.from({ length: WORKSPACE_MFA_RECOVERY_CODES_COUNT }, () =>
    Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
  );
  await transaction
    .deleteFrom('workspace_mfa_recovery_codes')
    .where('workspace_id', '=', locked.context.workspaceId)
    .where('user_id', '=', locked.context.userId)
    .where('purpose', '=', 'factor')
    .execute();
  await transaction
    .insertInto('workspace_mfa_recovery_codes')
    .values(
      await Promise.all(
        backupCodes.map(async (code) => ({
          workspace_id: locked.context.workspaceId,
          user_id: locked.context.userId,
          purpose: 'factor',
          revision,
          factor_id: factor.id,
          factor_revision: factor.revision,
          code_hash: await recoveryDigest(locked.context.workspaceId, locked.context.userId, code),
          created_at: now,
        })),
      ),
    )
    .execute();
  return { revision, backupCodes };
};
