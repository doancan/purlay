/** Bounded read-only canonical facts for foreground and deferred workspace admission. */
import { type Database, type Executor, type Selectable } from '@purlay/db';
import { liveCompanySessionProof } from './company-session';
import { snapshotOn } from './transactions';
export {
  readWorkspacePolicyPreviewPage,
  type WorkspacePolicyPreviewCursor,
} from './workspace-policy-preview';

export interface WorkspaceAccessLifetime {
  readonly sessionIdleTimeoutHours: number | null;
  readonly sessionMaxAgeDays: number | null;
}
export interface WorkspaceAccessRead {
  readonly sessionId: string;
  readonly userId: string;
  readonly workspaceIds: readonly string[];
  readonly now: Date;
  readonly lifetime: WorkspaceAccessLifetime;
}
type WorkspaceAccessSession = Selectable<Database['sessions']>;
type WorkspaceAccessEvidence = Selectable<Database['session_authentication_evidence']>;
type WorkspaceAccessPolicyRow = Selectable<Database['workspace_access_policies']>;
export type WorkspaceAccessAssurance = Selectable<Database['workspace_session_assurances']>;
type WorkspaceAccessFactor = Pick<
  Selectable<Database['workspace_mfa_factors']>,
  'id' | 'revision' | 'verified_at'
>;
type WorkspaceAccessGlobalFactor = Pick<
  Selectable<Database['two_factors']>,
  'id' | 'assurance_revision' | 'last_assurance_counter'
>;
interface WorkspaceAccessMembership {
  readonly workspaceId: string;
  readonly epoch: string;
  readonly accessKind: string;
  readonly guestSince: Date | null;
  readonly guestExpiresAt: Date | null;
}
interface WorkspaceAccessCompanyProof {
  readonly connection_id: string;
  readonly authentication_revision: string;
  readonly authenticated_at: Date;
  readonly live: boolean;
}
export interface WorkspaceAccessFacts {
  readonly session: WorkspaceAccessSession | undefined;
  readonly evidence: WorkspaceAccessEvidence | undefined;
  readonly membership: WorkspaceAccessMembership | undefined;
  readonly policy: WorkspaceAccessPolicyRow | undefined;
  readonly assurance: WorkspaceAccessAssurance | undefined;
  readonly workspaceFactor: WorkspaceAccessFactor | undefined;
  readonly globalFactor: WorkspaceAccessGlobalFactor | undefined;
  readonly companyProof: WorkspaceAccessCompanyProof | undefined;
}

/** Never writes, touches activity, creates assurance or infers a proof from registered credentials. */
export const readWorkspaceAccessFacts = async (
  executor: Executor,
  input: WorkspaceAccessRead,
): Promise<ReadonlyMap<string, WorkspaceAccessFacts>> => {
  const ids = [...new Set(input.workspaceIds)];
  if (ids.length === 0) return new Map();
  return await snapshotOn(executor)(async (transaction) => {
    const session = await transaction
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .selectAll('sessions')
      .where('sessions.id', '=', input.sessionId)
      .where('sessions.user_id', '=', input.userId)
      .where('users.deleted_at', 'is', null)
      .where('users.suspended_at', 'is', null)
      .where('users.admission_state', '=', 'approved')
      .where((eb) =>
        eb.or([
          eb('users.admission_requires_verified_email', '=', false),
          eb('users.email_verified', '=', true),
        ]),
      )
      .executeTakeFirst();
    const [evidence, memberships, policies, assurances, factors] = await Promise.all([
      transaction
        .selectFrom('session_authentication_evidence')
        .selectAll()
        .where('session_id', '=', input.sessionId)
        .where('user_id', '=', input.userId)
        .executeTakeFirst(),
      transaction
        .selectFrom('workspaces')
        .innerJoin('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
        .select([
          'workspaces.id as workspaceId',
          'workspaces.access_policy_epoch as epoch',
          'workspace_members.access_kind as accessKind',
          'workspace_members.guest_since as guestSince',
          'workspace_members.guest_expires_at as guestExpiresAt',
        ])
        .where('workspaces.id', 'in', ids)
        .where('workspaces.deleted_at', 'is', null)
        .where('workspace_members.user_id', '=', input.userId)
        .execute(),
      transaction
        .selectFrom('workspace_access_policies')
        .selectAll()
        .where('workspace_id', 'in', ids)
        .execute(),
      transaction
        .selectFrom('workspace_session_assurances')
        .selectAll()
        .where('workspace_id', 'in', ids)
        .where('session_id', '=', input.sessionId)
        .where('user_id', '=', input.userId)
        .execute(),
      transaction
        .selectFrom('workspace_mfa_factors')
        .select(['workspace_id', 'id', 'revision', 'verified_at'])
        .where('workspace_id', 'in', ids)
        .where('user_id', '=', input.userId)
        .where('state', '=', 'verified')
        .where('revoked_at', 'is', null)
        .execute(),
    ]);
    // Company sessions never query native/global credential inventory, even when its user also has one.
    const globalFactor =
      session?.company_workspace_id === null
        ? await transaction
            .selectFrom('two_factors')
            .select(['id', 'assurance_revision', 'last_assurance_counter'])
            .where('user_id', '=', input.userId)
            .where('verified', '=', true)
            .executeTakeFirst()
        : undefined;
    const companyProof =
      session?.company_workspace_id === null || session === undefined
        ? undefined
        : await transaction
            .selectFrom('workspace_identity_sessions')
            .select([
              'connection_id',
              'authentication_revision',
              'authenticated_at',
              liveCompanySessionProof(
                input.sessionId,
                session.company_workspace_id,
                input.userId,
              ).as('live'),
            ])
            .where('session_id', '=', input.sessionId)
            .where('workspace_id', '=', session.company_workspace_id)
            .executeTakeFirst();
    const members = new Map(memberships.map((row) => [row.workspaceId, row]));
    const policyById = new Map(policies.map((row) => [row.workspace_id, row]));
    const assuranceById = new Map(assurances.map((row) => [row.workspace_id, row]));
    const factorById = new Map(factors.map((row) => [row.workspace_id, row]));
    return new Map(
      ids.map((id) => [
        id,
        {
          session,
          evidence,
          membership: members.get(id),
          policy: policyById.get(id),
          assurance: assuranceById.get(id),
          workspaceFactor: factorById.get(id),
          globalFactor,
          companyProof,
        },
      ]),
    );
  });
};
