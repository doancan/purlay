/** Shared native administration boundary; source/group/role management is never delegated. */
import { isTransaction, type Transaction } from '@purlay/db';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishAccessRevoked,
  publishSessionsEnded,
  publishWorkspaceUpdated,
} from '../../../platform/events';
import { atomicallyOn } from '../../../platform/transactions';
import type { WorkspaceContext } from '../../../platform/tenancy';
import {
  lockWorkspaceProvisioningActor,
  requireProvisioningReady,
  requireProvisioningSessionLive,
  type WorkspaceProvisioningActor,
  type WorkspaceProvisioningDependencies,
} from './authority';
import {
  lockWorkspaceProjectionScope,
  workspaceAccessOutcome,
  type WorkspaceProjectionScope,
} from './scope';

/** Caller invokes this only through its real commit owner; no transaction or authority is captured. */
export const publishWorkspaceAccessOutcome = async (
  dependencies: Pick<WorkspaceProvisioningDependencies, 'bus' | 'clock' | 'log'>,
  outcome: ReturnType<typeof workspaceAccessOutcome>,
  recipients: readonly string[],
): Promise<void> => {
  if (!outcome.changed) return;
  await publishAfterCommit(dependencies.log ?? NO_LOG, [
    outcome.revoked.map((revoked) =>
      publication('ACCESS_REVOKED', () =>
        publishAccessRevoked(
          dependencies.bus,
          dependencies.clock,
          revoked.userId,
          revoked.channelIds,
        ),
      ),
    ),
    [
      publication('WORKSPACE_UPDATED', () =>
        publishWorkspaceUpdated(
          dependencies.bus,
          dependencies.clock,
          recipients,
          outcome.workspaceId,
        ),
      ),
    ],
    [
      publication('SESSION_ENDED', () =>
        publishSessionsEnded(dependencies.bus, dependencies.clock, outcome.endedCompanySessionIds),
      ),
    ],
  ]);
};

export const administerWorkspaceAccess = async <T>(
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  mode: 'read' | 'grant' | 'revoke',
  body: (
    transaction: Transaction,
    scope: WorkspaceProjectionScope,
    context: WorkspaceContext,
  ) => Promise<T>,
): Promise<T> => {
  if (mode === 'grant') await requireProvisioningReady(dependencies);
  const joined = isTransaction(dependencies.database);
  const publisher = {
    bus: dependencies.bus,
    clock: dependencies.clock,
    ...(dependencies.log === undefined ? {} : { log: dependencies.log }),
  };
  if (joined && mode !== 'read' && dependencies.afterCommit === undefined)
    throw new Error('A joined workspace mutation requires its owner’s after-commit registrar.');
  const completed = await atomicallyOn(dependencies.database)(async (transaction) => {
    const locked = await lockWorkspaceProvisioningActor(
      transaction,
      dependencies,
      actor,
      'administrator',
    );
    const scope = await lockWorkspaceProjectionScope(transaction, locked.context.workspaceId);
    const result = await body(transaction, scope, locked.context);
    requireProvisioningSessionLive(dependencies, locked.session);
    const outcome = workspaceAccessOutcome(transaction, scope);
    const administrators = outcome.changed
      ? await transaction
          .selectFrom('workspace_members')
          .select('user_id')
          .where('workspace_id', '=', scope.workspaceId)
          .where('role', 'in', ['owner', 'admin'])
          .where('access_kind', '=', 'member')
          .execute()
      : [];
    const recipients = [
      ...new Set([...administrators.map((row) => row.user_id), ...outcome.userIds]),
    ];
    const effect = async (): Promise<void> => {
      await publishWorkspaceAccessOutcome(publisher, outcome, recipients);
    };
    if (joined && outcome.changed) dependencies.afterCommit?.(transaction, effect);
    return { result, effect };
  });
  if (!joined) await completed.effect();
  return completed.result;
};
