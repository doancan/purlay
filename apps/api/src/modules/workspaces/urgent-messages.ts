import type { Transaction } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import {
  requireWorkspaceMembership,
  workspaceNotFound,
  type WorkspaceContext,
} from '../../platform/tenancy';
import { recordAudit } from '../audit/audit';

const managersOnly = (): AppError =>
  new AppError({
    code: 'FORBIDDEN',
    message: 'Only an owner or admin can change urgent messages.',
  });

/** Returns the members to tell after a change, or nobody when the setting was already current. */
export const setUrgentMessages = async (
  transaction: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  enabled: boolean,
): Promise<readonly string[]> => {
  if (context.role === 'member') throw managersOnly();
  // Role changes take this lock first too. FOR UPDATE also conflicts with the KEY SHARE taken
  // by the message's workspace foreign key, so new sends read the setting in commit order.
  const workspace = await transaction
    .selectFrom('workspaces')
    .select('urgent_messages_enabled')
    .where('id', '=', context.workspaceId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (workspace === undefined) throw workspaceNotFound();
  const current = await requireWorkspaceMembership(
    transaction,
    context.userId,
    context.workspaceId,
  );
  if (current.role === 'member') throw managersOnly();
  if (workspace.urgent_messages_enabled === enabled) return [];

  await transaction
    .updateTable('workspaces')
    .set({ urgent_messages_enabled: enabled, updated_at: clock.now() })
    .where('id', '=', context.workspaceId)
    .execute();
  await recordAudit(transaction, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'workspace.urgent_messages_changed',
    targetType: 'workspace',
    targetId: context.workspaceId,
    metadata: { from: String(workspace.urgent_messages_enabled), to: String(enabled) },
  });
  const members = await transaction
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', context.workspaceId)
    .execute();
  return members.map((member) => member.user_id);
};
