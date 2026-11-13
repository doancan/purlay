/** Narrow remediation authority, re-read under canonical native locks before each security operation. */
import { sql, type Database, type Executor, type Selectable, type Transaction } from '@purlay/db';
import { WORKSPACE_SECURITY_FRESH_SECONDS } from '@purlay/types/workspace-security';
import type { Clock } from '../../../platform/clock';
import { liveCompanySessionProof } from '../../../platform/company-session';
import type { CredentialCipher } from '../../../platform/crypto';
import { AppError } from '../../../platform/errors';
import {
  assertSecurityMinted,
  requireFullMembership,
  requireWorkspaceSecurityMembership,
  workspaceNotFound,
  type WorkspaceSecurityContext,
} from '../../../platform/tenancy';
import { lapsed, type SessionLifetime } from '../../auth/session-lifetime';

export interface WorkspaceSecurityActor {
  readonly context: WorkspaceSecurityContext;
  readonly sessionId: string;
}

export interface WorkspaceSecurityDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly cipher: CredentialCipher;
  readonly lifetime: () => SessionLifetime;
}

type WorkspaceSecuritySession = Selectable<Database['sessions']>;
type WorkspaceSecurityWorkspace = Selectable<Database['workspaces']>;
type WorkspaceSecurityUser = Selectable<Database['users']>;
type WorkspaceAuthenticationEvidence = Selectable<Database['session_authentication_evidence']>;

export interface LockedWorkspaceSecurityActor {
  readonly context: WorkspaceSecurityContext;
  readonly session: WorkspaceSecuritySession;
  readonly workspace: WorkspaceSecurityWorkspace;
  readonly user: WorkspaceSecurityUser;
  readonly evidence: WorkspaceAuthenticationEvidence | undefined;
}

export const securityChanged = (): AppError =>
  new AppError({
    code: 'WORKSPACE_SECURITY_CHANGED',
    message: 'Workspace security changed. Reload before trying again.',
  });
export const securityNotReady = (message: string): AppError =>
  new AppError({ code: 'WORKSPACE_SECURITY_NOT_READY', message });
export const mfaMissing = (): AppError =>
  new AppError({ code: 'WORKSPACE_MFA_NOT_FOUND', message: 'Workspace verification not found.' });
export const mfaInvalid = (): AppError =>
  new AppError({
    code: 'WORKSPACE_MFA_INVALID',
    message: 'The verification code is invalid or expired.',
  });
export const mfaLocked = (seconds: number): AppError =>
  new AppError(
    { code: 'WORKSPACE_MFA_LOCKED', message: 'Too many verification attempts. Try again later.' },
    { retryAfterSeconds: seconds },
  );

/** Source session → workspace → canonical person/member; evidence is immutable and deliberately not row-locked. */
export const lockWorkspaceSecurityActor = async (
  transaction: Transaction,
  dependencies: Pick<WorkspaceSecurityDependencies, 'clock' | 'lifetime'>,
  actor: WorkspaceSecurityActor,
  reach: 'self' | 'administrator' | 'owner',
): Promise<LockedWorkspaceSecurityActor> => {
  assertSecurityMinted(actor.context);
  const session = await transaction
    .selectFrom('sessions')
    .selectAll()
    .where('id', '=', actor.sessionId)
    .where('user_id', '=', actor.context.userId)
    .forShare()
    .executeTakeFirst();
  const now = dependencies.clock.now();
  if (
    session?.revoked_at !== null ||
    new Date(session.expires_at).getTime() <= now.getTime() ||
    lapsed(
      dependencies.lifetime(),
      { createdAt: new Date(session.created_at), lastUsedAt: new Date(session.last_used_at) },
      now,
    )
  )
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in again to continue.' });
  if (
    session.company_workspace_id !== null &&
    session.company_workspace_id !== actor.context.workspaceId
  )
    throw workspaceNotFound();
  const workspace = await transaction
    .selectFrom('workspaces')
    .selectAll()
    .where('id', '=', actor.context.workspaceId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (workspace === undefined) throw workspaceNotFound();
  const user = await transaction
    .selectFrom('users')
    .selectAll()
    .where('id', '=', actor.context.userId)
    .where('deleted_at', 'is', null)
    .where('suspended_at', 'is', null)
    .where('admission_state', '=', 'approved')
    .where((expression) =>
      expression.or([
        expression('admission_requires_verified_email', '=', false),
        expression('email_verified', '=', true),
      ]),
    )
    .forShare()
    .executeTakeFirst();
  if (user === undefined)
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'This account cannot continue.' });
  const member = await transaction
    .selectFrom('workspace_members')
    .select('id')
    .where('workspace_id', '=', workspace.id)
    .where('user_id', '=', user.id)
    .forShare()
    .executeTakeFirst();
  if (member === undefined) throw workspaceNotFound();
  const context = await requireWorkspaceSecurityMembership(transaction, user.id, workspace.id);
  if (session.company_workspace_id !== null) {
    const proof = await transaction
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', session.id)
      .where(
        liveCompanySessionProof(
          sql.ref<string>('sessions.id'),
          sql.ref<string>('sessions.company_workspace_id'),
          sql.ref<string>('sessions.user_id'),
        ),
      )
      .executeTakeFirst();
    if (proof === undefined)
      throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in again to continue.' });
  }
  if (reach !== 'self') {
    requireFullMembership(context, 'Only full workspace members manage security.');
    if (context.role === 'member' || (reach === 'owner' && context.role !== 'owner'))
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'A workspace owner is required for this action.',
      });
  }
  const evidence = await transaction
    .selectFrom('session_authentication_evidence')
    .selectAll()
    .where('session_id', '=', session.id)
    .where('user_id', '=', user.id)
    .executeTakeFirst();
  return { context, session, workspace, user, evidence };
};

/** Freshness comes from the observed authentication event, never session issuance or a provider claim. */
export const requireFreshSecurityPrimary = (
  dependencies: Pick<WorkspaceSecurityDependencies, 'clock'>,
  locked: LockedWorkspaceSecurityActor,
  options: { readonly independent?: boolean } = {},
): void => {
  const proof = locked.evidence;
  const authenticated =
    proof?.authenticated_at === null || proof?.authenticated_at === undefined
      ? NaN
      : new Date(proof.authenticated_at).getTime();
  const age = dependencies.clock.now().getTime() - authenticated;
  const company = locked.session.company_workspace_id;
  const method = proof?.method ?? null;
  const origin = proof?.company_workspace_id;
  const consistent =
    method !== null &&
    (company === null
      ? method !== 'company_oidc' && origin === null
      : method === 'company_oidc' && origin === company);
  if (
    !consistent ||
    !Number.isFinite(age) ||
    age < 0 ||
    age >= WORKSPACE_SECURITY_FRESH_SECONDS * 1_000 ||
    (options.independent === true && company !== null)
  )
    throw new AppError({
      code: 'REAUTHENTICATION_REQUIRED',
      message: 'Sign in again to change workspace security.',
    });
};
