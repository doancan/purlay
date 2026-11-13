import type { Transaction } from '@purlay/db';
import { AppError } from '../../platform/errors';
import { requireWorkspaceCapabilityNow } from './provisioning/authority';
import { workspaceNotFound, type WorkspaceContext } from '../../platform/tenancy';

export const requireInvitationManager = (context: WorkspaceContext): void => {
  if (context.role === 'member')
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only an owner or an admin manages invitations.',
    });
};

/** Recheck the role in the writing transaction, so a committed demotion wins. */
export const requireInvitationManagerNow = async (
  transaction: Transaction,
  context: WorkspaceContext,
): Promise<void> => {
  await transaction
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', context.workspaceId)
    .forShare()
    .executeTakeFirst();
  const row = await transaction
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .forShare()
    .executeTakeFirst();
  if (row === undefined) throw workspaceNotFound();
  await requireWorkspaceCapabilityNow(transaction, context, 'members.invite');
};
