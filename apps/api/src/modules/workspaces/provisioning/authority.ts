/** Native caller/session locks precede the workspace mutex and every source mutation. */
import { sql, type Database, type Executor, type Selectable, type Transaction } from '@purlay/db';
import type { WorkspaceAccessAction } from '@purlay/types/workspace-provisioning';
import type { Clock } from '../../../platform/clock';
import type { EventBus } from '../../../platform/events';
import type { Logger } from '../../../platform/logging';
import { companySessionAllowsWorkspace } from '../../../platform/company-session';
import { AppError } from '../../../platform/errors';
import { evaluateWorkspaceAccess } from '../../../platform/workspace-access';
import { readWorkspaceAccessFacts } from '../../../platform/workspace-access-facts';
import { workspaceAccessRequired } from '../../../platform/workspace-content-access';
import {
  assertMinted,
  requireFullMembership,
  requireWorkspaceMembership,
  workspaceNotFound,
  type WorkspaceContext,
} from '../../../platform/tenancy';
import { lapsed, type SessionLifetime } from '../../auth/session-lifetime';
import type { WorkspaceChannels } from '../channels-port';

export interface WorkspaceProvisioningActor {
  readonly context: WorkspaceContext;
  readonly sessionId: string;
}

export interface WorkspaceProvisioningDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly lifetime: () => SessionLifetime;
  readonly channels: WorkspaceChannels;
  readonly readersReady: () => Promise<boolean>;
  readonly bus: EventBus;
  readonly log?: Logger;
  /** A caller joining its transaction owns the actual commit; it must register, never run, this effect. */
  readonly afterCommit?: (transaction: Transaction, effect: () => Promise<void>) => void;
}

type NativeSession = Selectable<Database['sessions']>;

export interface LockedWorkspaceProvisioningActor {
  readonly context: WorkspaceContext;
  readonly session: NativeSession;
}

export const provisioningChanged = (): AppError =>
  new AppError({
    code: 'WORKSPACE_PROVISIONING_CHANGED',
    message: 'Workspace access changed. Reload before trying again.',
  });

export const provisioningNotReady = (): AppError =>
  new AppError({
    code: 'WORKSPACE_PROVISIONING_NOT_READY',
    message: 'Workspace access administration is not ready on every reader.',
  });

export const managedMembership = (): AppError =>
  new AppError({
    code: 'WORKSPACE_MEMBERSHIP_MANAGED',
    message: 'This membership is managed by its sources. Add manual access explicitly first.',
  });

export const sourceNotFound = (): AppError =>
  new AppError({ code: 'WORKSPACE_ACCESS_SOURCE_NOT_FOUND', message: 'Access source not found.' });

export const roleNotFound = (): AppError =>
  new AppError({ code: 'WORKSPACE_ACCESS_ROLE_NOT_FOUND', message: 'Access role not found.' });

export const groupNotFound = (): AppError =>
  new AppError({ code: 'WORKSPACE_ACCESS_GROUP_NOT_FOUND', message: 'Access group not found.' });

export const provisioningForbidden = (): AppError =>
  new AppError({ code: 'FORBIDDEN', message: 'This workspace action is not allowed.' });

export const requireProvisioningReady = async (
  dependencies: Pick<WorkspaceProvisioningDependencies, 'readersReady'>,
): Promise<void> => {
  let ready = false;
  try {
    ready = await dependencies.readersReady();
  } catch {
    throw provisioningNotReady();
  }
  if (!ready) throw provisioningNotReady();
};

export const requireProvisioningSessionLive = (
  dependencies: Pick<WorkspaceProvisioningDependencies, 'clock' | 'lifetime'>,
  session: NativeSession | undefined,
): void => {
  const now = dependencies.clock.now();
  if (
    session?.revoked_at !== null ||
    new Date(session.expires_at).getTime() <= now.getTime() ||
    lapsed(
      dependencies.lifetime(),
      { createdAt: new Date(session.created_at), lastUsedAt: new Date(session.last_used_at) },
      now,
    )
  ) {
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in again to continue.' });
  }
};

/** The actual native membership and its projection revision are read again for every action. */
export const requireWorkspaceCapabilityNow = async (
  executor: Executor,
  context: WorkspaceContext,
  capability: WorkspaceAccessAction,
): Promise<void> => {
  assertMinted(context);
  requireFullMembership(context, 'Only full members can manage workspace access.');
  const member = await executor
    .selectFrom('workspace_members')
    .select(['role', 'access_kind'])
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .executeTakeFirst();
  if (member === undefined) throw workspaceNotFound();
  if (member.access_kind !== 'member') throw provisioningForbidden();
  if (member.role === 'owner' || member.role === 'admin') return;
  const allowed = await sql<{ readonly user_id: string }>`
    select capability.user_id
    from workspace_member_capabilities as capability
    join workspace_admission_controls as admission
      on admission.workspace_id = capability.workspace_id
      and admission.user_id = capability.user_id
      and admission.revision = capability.projection_revision
    where capability.workspace_id = ${context.workspaceId}
      and capability.user_id = ${context.userId}
      and capability.capability = ${capability}
      and admission.blocked_at is null
  `.execute(executor);
  if (allowed.rows.length !== 1) throw provisioningForbidden();
};

/** Existing native writers take their actual caller SID before any channel/workspace mutex. */
export const lockWorkspaceProvisioningSession = async (
  transaction: Transaction,
  dependencies: Pick<WorkspaceProvisioningDependencies, 'clock' | 'lifetime'>,
  actor: WorkspaceProvisioningActor,
): Promise<void> => {
  assertMinted(actor.context);
  const session = await transaction
    .selectFrom('sessions as live')
    .selectAll('live')
    .where('live.id', '=', actor.sessionId)
    .where('live.user_id', '=', actor.context.userId)
    .where(companySessionAllowsWorkspace('live', actor.context.workspaceId))
    .forShare('live')
    .executeTakeFirst();
  requireProvisioningSessionLive(dependencies, session);
};

/** All new administration entrypoints use this; legacy helpers never acquire a session late. */
export const lockWorkspaceProvisioningActor = async (
  transaction: Transaction,
  dependencies: Pick<WorkspaceProvisioningDependencies, 'clock' | 'lifetime'>,
  actor: WorkspaceProvisioningActor,
  reach: 'administrator' | WorkspaceAccessAction,
): Promise<LockedWorkspaceProvisioningActor> => {
  assertMinted(actor.context);
  const session = await transaction
    .selectFrom('sessions as live')
    .selectAll('live')
    .where('live.id', '=', actor.sessionId)
    .where('live.user_id', '=', actor.context.userId)
    .where(companySessionAllowsWorkspace('live', actor.context.workspaceId))
    .forShare('live')
    .executeTakeFirst();
  requireProvisioningSessionLive(dependencies, session);
  if (session === undefined) throw workspaceNotFound();
  const workspace = await transaction
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', actor.context.workspaceId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (workspace === undefined) throw workspaceNotFound();
  const person = await transaction
    .selectFrom('users')
    .select('id')
    .where('id', '=', actor.context.userId)
    .where('deleted_at', 'is', null)
    .where('suspended_at', 'is', null)
    .where('admission_state', '=', 'approved')
    .forShare()
    .executeTakeFirst();
  if (person === undefined)
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in again to continue.' });
  const context = await requireWorkspaceMembership(
    transaction,
    actor.context.userId,
    actor.context.workspaceId,
  );
  requireFullMembership(context, 'Only full members can manage workspace access.');
  // The shared evaluator uses this operation's actual SID, including after a workspace-lock wait.
  // Another session in request-local context cannot stand in for a revoked/expired company source.
  const input = {
    sessionId: actor.sessionId,
    userId: context.userId,
    workspaceIds: [context.workspaceId],
    now: dependencies.clock.now(),
    lifetime: dependencies.lifetime(),
  };
  const facts = (await readWorkspaceAccessFacts(transaction, input)).get(context.workspaceId);
  if (facts === undefined) throw workspaceAccessRequired(context.workspaceId);
  if (
    !evaluateWorkspaceAccess(
      { ...input, now: dependencies.clock.now(), lifetime: dependencies.lifetime() },
      context.workspaceId,
      facts,
    ).allowed
  )
    throw workspaceAccessRequired(context.workspaceId);
  if (reach === 'administrator') {
    if (context.role !== 'owner' && context.role !== 'admin') throw provisioningForbidden();
  } else {
    await requireWorkspaceCapabilityNow(transaction, context, reach);
  }
  requireProvisioningSessionLive(dependencies, session);
  return { context, session };
};
