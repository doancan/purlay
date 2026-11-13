/** Keyset pages of actual native proof candidates; proposals consume the shared access evaluator. */
import { sql, type Executor } from '@purlay/db';
import { liveCompanySessionProof } from './company-session';
import { snapshotOn } from './transactions';
import type { WorkspaceAccessFacts, WorkspaceAccessLifetime } from './workspace-access-facts';

export interface WorkspacePolicyPreviewCursor {
  readonly userId: string;
  readonly sessionId: string | null;
}
export interface WorkspacePolicyPreviewRead {
  readonly workspaceId: string;
  readonly after?: WorkspacePolicyPreviewCursor;
  readonly limit: number;
  readonly now: Date;
  readonly lifetime: WorkspaceAccessLifetime;
  /** Exact durable native candidates for a delivery cohort; absent for administrative previews. */
  readonly sessionIds?: readonly string[];
}
interface WorkspacePolicyPreviewFactRow {
  readonly userId: string;
  readonly displayName: string;
  readonly accessKind: string;
  readonly sessionId: string | null;
  readonly facts: WorkspaceAccessFacts;
}
export interface WorkspacePolicyPreviewFactPage {
  readonly rows: readonly WorkspacePolicyPreviewFactRow[];
  readonly next: WorkspacePolicyPreviewCursor | null;
}
const ZERO = '00000000-0000-0000-0000-000000000000';

/** The administrative caller owns authorization; this read primitive mints no content capability. */
export const readWorkspacePolicyPreviewPage = async (
  executor: Executor,
  input: WorkspacePolicyPreviewRead,
): Promise<WorkspacePolicyPreviewFactPage> => {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new Error('Workspace preview page limit must be between 1 and 100');
  if (input.sessionIds?.length === 0) return { rows: [], next: null };
  return await snapshotOn(executor)(async (transaction) => {
    let anchors = transaction
      .selectFrom('workspace_members')
      .innerJoin('users', 'users.id', 'workspace_members.user_id')
      .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
      .leftJoin('sessions', (join) =>
        join
          .onRef('sessions.user_id', '=', 'users.id')
          .on('sessions.expires_at', '>', input.now)
          .on('sessions.revoked_at', 'is', null)
          .on((eb) =>
            eb.or([
              eb('sessions.company_workspace_id', 'is', null),
              eb('sessions.company_workspace_id', '=', input.workspaceId),
            ]),
          ),
      )
      .select([
        'users.id as userId',
        'users.display_name as displayName',
        'workspace_members.access_kind as accessKind',
        'workspace_members.guest_since as guestSince',
        'workspace_members.guest_expires_at as guestExpiresAt',
        'workspaces.access_policy_epoch as epoch',
        'sessions.id as sessionId',
      ])
      .where('workspace_members.workspace_id', '=', input.workspaceId)
      .where('workspaces.deleted_at', 'is', null)
      .where('users.deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('workspace_members.access_kind', '=', 'member'),
          eb.and([
            eb('workspace_members.access_kind', '=', 'guest'),
            eb('workspace_members.guest_since', '<=', input.now),
            eb.or([
              eb('workspace_members.guest_expires_at', 'is', null),
              eb('workspace_members.guest_expires_at', '>', input.now),
            ]),
          ]),
        ]),
      )
      .orderBy('users.id')
      .orderBy('sessions.id')
      .limit(input.limit + 1);
    if (input.after !== undefined)
      anchors = anchors.where(
        sql<boolean>`(users.id,coalesce(sessions.id,${ZERO}::uuid)) > (${input.after.userId}::uuid,${input.after.sessionId ?? ZERO}::uuid)`,
      );
    if (input.sessionIds !== undefined)
      anchors = anchors.where('sessions.id', 'in', input.sessionIds);
    const found = await anchors.execute();
    const page = found.slice(0, input.limit);
    const ids = page.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId]));
    const users = [...new Set(page.map((row) => row.userId))];
    const [policy, sessions, evidence, assurances, factors] = await Promise.all([
      transaction
        .selectFrom('workspace_access_policies')
        .selectAll()
        .where('workspace_id', '=', input.workspaceId)
        .executeTakeFirst(),
      ids.length === 0
        ? Promise.resolve([])
        : transaction
            .selectFrom('sessions')
            .innerJoin('users', 'users.id', 'sessions.user_id')
            .selectAll('sessions')
            .where('sessions.id', 'in', ids)
            .where('users.deleted_at', 'is', null)
            .where('users.suspended_at', 'is', null)
            .where('users.admission_state', '=', 'approved')
            .where((eb) =>
              eb.or([
                eb('users.admission_requires_verified_email', '=', false),
                eb('users.email_verified', '=', true),
              ]),
            )
            .execute(),
      ids.length === 0
        ? Promise.resolve([])
        : transaction
            .selectFrom('session_authentication_evidence')
            .selectAll()
            .where('session_id', 'in', ids)
            .execute(),
      ids.length === 0
        ? Promise.resolve([])
        : transaction
            .selectFrom('workspace_session_assurances')
            .selectAll()
            .where('workspace_id', '=', input.workspaceId)
            .where('session_id', 'in', ids)
            .execute(),
      users.length === 0
        ? Promise.resolve([])
        : transaction
            .selectFrom('workspace_mfa_factors')
            .select(['user_id', 'id', 'revision', 'verified_at'])
            .where('workspace_id', '=', input.workspaceId)
            .where('user_id', 'in', users)
            .where('state', '=', 'verified')
            .where('revoked_at', 'is', null)
            .execute(),
    ]);
    const independentUsers = [
      ...new Set(
        sessions.filter((row) => row.company_workspace_id === null).map((row) => row.user_id),
      ),
    ];
    const companyIds = sessions
      .filter((row) => row.company_workspace_id === input.workspaceId)
      .map((row) => row.id);
    const [global, company] = await Promise.all([
      independentUsers.length === 0
        ? Promise.resolve([])
        : transaction
            .selectFrom('two_factors')
            .select(['user_id', 'id', 'assurance_revision', 'last_assurance_counter'])
            .where('user_id', 'in', independentUsers)
            .where('verified', '=', true)
            .execute(),
      companyIds.length === 0
        ? Promise.resolve([])
        : transaction
            .selectFrom('workspace_identity_sessions')
            .innerJoin(
              'sessions as preview_source',
              'preview_source.id',
              'workspace_identity_sessions.session_id',
            )
            .select([
              'workspace_identity_sessions.session_id',
              'connection_id',
              'authentication_revision',
              'authenticated_at',
              liveCompanySessionProof(
                sql.ref<string>('workspace_identity_sessions.session_id'),
                input.workspaceId,
                sql.ref<string>('preview_source.user_id'),
              ).as('live'),
            ])
            .where('workspace_identity_sessions.workspace_id', '=', input.workspaceId)
            .where('workspace_identity_sessions.session_id', 'in', companyIds)
            .execute(),
    ]);
    const bySession = new Map(sessions.map((row) => [row.id, row]));
    const byEvidence = new Map(evidence.map((row) => [row.session_id, row]));
    const byAssurance = new Map(assurances.map((row) => [row.session_id, row]));
    const byFactor = new Map(factors.map((row) => [row.user_id, row]));
    const byGlobal = new Map(global.map((row) => [row.user_id, row]));
    const byCompany = new Map(company.map((row) => [row.session_id, row]));
    const rows = page.map((row) => {
      const session = row.sessionId === null ? undefined : bySession.get(row.sessionId);
      return {
        userId: row.userId,
        displayName: row.displayName,
        accessKind: row.accessKind,
        sessionId: row.sessionId,
        facts: {
          session,
          evidence: row.sessionId === null ? undefined : byEvidence.get(row.sessionId),
          membership: {
            workspaceId: input.workspaceId,
            epoch: row.epoch,
            accessKind: row.accessKind,
            guestSince: row.guestSince,
            guestExpiresAt: row.guestExpiresAt,
          },
          policy,
          assurance: row.sessionId === null ? undefined : byAssurance.get(row.sessionId),
          workspaceFactor: byFactor.get(row.userId),
          globalFactor:
            session?.company_workspace_id === null ? byGlobal.get(row.userId) : undefined,
          companyProof: row.sessionId === null ? undefined : byCompany.get(row.sessionId),
        },
      };
    });
    const last = page.at(-1);
    return {
      rows,
      next:
        found.length > input.limit && last !== undefined
          ? { userId: last.userId, sessionId: last.sessionId }
          : null,
    };
  });
};
