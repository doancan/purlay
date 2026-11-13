/** Immutable primary authentication facts, separate from session issuance and retained MFA updates. */
import { sql, type Executor } from '@purlay/db';
import type { SessionAuthenticationMethod } from '@purlay/types/workspace-security';
import { tokenDigest } from '../../platform/tokens';

export type PrimaryAuthenticationProof =
  | {
      readonly method: Exclude<SessionAuthenticationMethod, 'company_oidc'>;
      readonly authenticatedAt: Date;
    }
  | {
      readonly method: 'company_oidc';
      readonly authenticatedAt: Date;
      readonly companyWorkspaceId: string;
      readonly companyConnectionId: string;
      readonly companyAuthenticationRevision: string;
    };

/** A conflict never upgrades an old unknown session or changes its original authentication. */
export const recordPrimaryAuthentication = async (
  executor: Executor,
  sessionId: string,
  userId: string,
  proof: PrimaryAuthenticationProof,
): Promise<void> => {
  if (!Number.isFinite(proof.authenticatedAt.getTime()))
    throw new Error('Invalid authentication time');
  const inserted = await executor
    .insertInto('session_authentication_evidence')
    .values({
      session_id: sessionId,
      user_id: userId,
      method: proof.method,
      authenticated_at: proof.authenticatedAt,
      ...(proof.method === 'company_oidc'
        ? {
            company_workspace_id: proof.companyWorkspaceId,
            company_connection_id: proof.companyConnectionId,
            company_authentication_revision: proof.companyAuthenticationRevision,
          }
        : {}),
    })
    .onConflict((conflict) => conflict.column('session_id').doNothing())
    .returning('user_id')
    .executeTakeFirst();
  if (inserted !== undefined) return;
  const retained = await executor
    .selectFrom('session_authentication_evidence')
    .select('user_id')
    .where('session_id', '=', sessionId)
    .executeTakeFirst();
  if (retained?.user_id !== userId) throw new Error('Authentication evidence owner changed');
};

/** Retained-session MFA can add its own proof while leaving legacy primary authentication unknown. */
export const retainUnknownAuthentication = async (
  executor: Executor,
  sessionId: string,
  userId: string,
): Promise<void> => {
  await executor
    .insertInto('session_authentication_evidence')
    .values({ session_id: sessionId, user_id: userId })
    .onConflict((conflict) => conflict.column('session_id').doNothing())
    .execute();
};

/** A handoff preserves its original authentication event and MFA times; it never authenticates anew. */
export const copyAuthenticationEvidence = async (
  executor: Executor,
  sourceSessionId: string,
  targetSessionId: string,
  userId: string,
): Promise<void> => {
  await executor
    .insertInto('session_authentication_evidence')
    .columns([
      'session_id',
      'user_id',
      'revision',
      'method',
      'authenticated_at',
      'company_workspace_id',
      'company_connection_id',
      'company_authentication_revision',
      'global_mfa_factor_id',
      'global_mfa_factor_revision',
      'global_mfa_method',
      'global_mfa_counter',
      'global_mfa_verified_at',
    ])
    .expression((expression) =>
      expression
        .selectFrom('session_authentication_evidence')
        .select([
          sql<string>`${targetSessionId}`.as('session_id'),
          'user_id',
          'revision',
          'method',
          'authenticated_at',
          'company_workspace_id',
          'company_connection_id',
          'company_authentication_revision',
          'global_mfa_factor_id',
          'global_mfa_factor_revision',
          'global_mfa_method',
          'global_mfa_counter',
          'global_mfa_verified_at',
        ])
        .where('session_id', '=', sourceSessionId)
        .where('user_id', '=', userId),
    )
    .execute();
};

/** Even ended/expired workspace rows survive handoff, so a new native SID cannot restart idle age. */
export const copyWorkspaceAuthenticationAssurances = async (
  executor: Executor,
  sourceSessionId: string,
  targetSessionId: string,
  userId: string,
  companyWorkspaceId: string | null,
): Promise<void> => {
  await executor
    .insertInto('workspace_session_assurances')
    .columns([
      'workspace_id',
      'session_id',
      'user_id',
      'authentication_revision',
      'policy_revision',
      'policy_epoch',
      'factor_scope',
      'factor_id',
      'factor_revision',
      'mfa_verified_at',
      'mfa_expires_at',
      'last_used_at',
      'expires_at',
      'ended_at',
      'end_reason',
      'created_at',
      'updated_at',
    ])
    .expression((expression) => {
      let source = expression
        .selectFrom('workspace_session_assurances')
        .select([
          'workspace_id',
          sql<string>`${targetSessionId}`.as('session_id'),
          'user_id',
          'authentication_revision',
          'policy_revision',
          'policy_epoch',
          'factor_scope',
          'factor_id',
          'factor_revision',
          'mfa_verified_at',
          'mfa_expires_at',
          'last_used_at',
          'expires_at',
          'ended_at',
          'end_reason',
          'created_at',
          'updated_at',
        ])
        .where('session_id', '=', sourceSessionId)
        .where('user_id', '=', userId);
      if (companyWorkspaceId !== null)
        source = source.where('workspace_id', '=', companyWorkspaceId);
      return source;
    })
    .execute();
};

const primaryChallengeKey = async (identifier: string): Promise<string> =>
  `native-primary-2fa:${await tokenDigest(identifier)}`;

/** Native verification.value remains its user ID; primary proof has its own hashed, expiring record. */
export const rememberSecondFactorPrimary = async (
  executor: Executor,
  identifier: string,
  userId: string,
  authenticatedAt: Date,
  expiresAt: Date,
): Promise<void> => {
  await executor
    .insertInto('verifications')
    .values({
      id: crypto.randomUUID(),
      identifier: await primaryChallengeKey(identifier),
      value: JSON.stringify({
        method: 'password',
        userId,
        authenticatedAt: authenticatedAt.toISOString(),
      }),
      expires_at: expiresAt,
    })
    .execute();
};

/** Only successful native second-step session creation spends this proof, in the same transaction. */
export const consumeSecondFactorPrimary = async (
  executor: Executor,
  identifier: string,
  userId: string,
  now: Date,
): Promise<PrimaryAuthenticationProof | undefined> => {
  const rows = await executor
    .deleteFrom('verifications')
    .where('identifier', '=', await primaryChallengeKey(identifier))
    .where('expires_at', '>', now)
    .returning('value')
    .execute();
  if (rows.length !== 1) return undefined;
  const encoded = rows[0]?.value;
  if (encoded === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('method' in value) ||
    value.method !== 'password' ||
    !('userId' in value) ||
    value.userId !== userId ||
    !('authenticatedAt' in value) ||
    typeof value.authenticatedAt !== 'string'
  )
    return undefined;
  const authenticatedAt = new Date(value.authenticatedAt);
  if (!Number.isFinite(authenticatedAt.getTime())) return undefined;
  return { method: 'password', authenticatedAt };
};
