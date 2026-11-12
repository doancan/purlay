/** Recheck native authority after external work, in the same transaction as the mutation. */
import type { Executor, Transaction } from '@purlay/db';
import type { Clock } from '../../../platform/clock';
import type { CredentialCipher } from '../../../platform/crypto';
import { AppError } from '../../../platform/errors';
import {
  assertMinted,
  requireFullMembership,
  requireWorkspaceMembership,
  workspaceNotFound,
  type WorkspaceContext,
} from '../../../platform/tenancy';
import { lapsed, type SessionLifetime } from '../../auth/session-lifetime';

export interface CompanyIdentityActor {
  readonly context: WorkspaceContext;
  readonly sessionId: string;
}

export interface CompanyIdentityDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly cipher: CredentialCipher;
  readonly lifetime: () => SessionLifetime;
}

export const identityMissing = (): AppError =>
  new AppError({ code: 'COMPANY_IDENTITY_NOT_FOUND', message: 'Company identity not found.' });

export const identityChanged = (): AppError =>
  new AppError({
    code: 'COMPANY_IDENTITY_CHANGED',
    message: 'Company identity settings changed. Reload them before trying again.',
  });

export const identityNotReady = (message: string): AppError =>
  new AppError({ code: 'COMPANY_IDENTITY_NOT_READY', message });

export const identityInvalid = (field: string, message: string): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    message: 'The request did not match the contract.',
    details: { fields: { [field]: message } },
  });

/** Session → workspace → person, matching account erasure; no external I/O holds these locks. */
export const lockCompanyIdentityActor = async (
  transaction: Transaction,
  dependencies: Pick<CompanyIdentityDependencies, 'clock' | 'lifetime'>,
  actor: CompanyIdentityActor,
  administrator: boolean,
): Promise<WorkspaceContext> => {
  assertMinted(actor.context);
  const session = await transaction
    .selectFrom('sessions')
    .select(['id', 'created_at', 'last_used_at', 'expires_at', 'revoked_at'])
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

  return await lockCompanyIdentityMember(
    transaction,
    actor.context.workspaceId,
    actor.context.userId,
    administrator,
  );
};

/** The canonical person resolved from an exact verified external binding, never an address or client-selected id. */
export const lockCompanyIdentityMember = async (
  transaction: Transaction,
  workspaceId: string,
  userId: string,
  administrator: boolean,
): Promise<WorkspaceContext> => {
  const workspace = await transaction
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', workspaceId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (workspace === undefined) throw workspaceNotFound();
  const person = await transaction
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
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
  if (person === undefined)
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'This account cannot continue.' });
  const current = await requireWorkspaceMembership(transaction, userId, workspaceId);
  requireFullMembership(current, 'Company identity requires full workspace membership.');
  if (administrator && current.role === 'member')
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only an owner or admin manages company identity.',
    });
  return current;
};
