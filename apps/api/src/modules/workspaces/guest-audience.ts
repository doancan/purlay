/** Membership invalidation reaches its guest and the current administrators of this workspace alone. */
import type { Executor } from '@purlay/db';
import type { WorkspaceContext } from '../../platform/tenancy';

export const guestAccessRecipients = async (
  executor: Executor,
  context: WorkspaceContext,
  userId: string,
): Promise<readonly string[]> => {
  const administrators = await executor
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', context.workspaceId)
    .where('role', 'in', ['owner', 'admin'])
    .execute();
  return [...new Set([userId, ...administrators.map((row) => row.user_id)])];
};
