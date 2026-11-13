/** Called only after canonical workspace/resource visibility; the hint never confirms a foreign resource. */
import type { Executor } from '@purlay/db';
import { AppError } from './errors';
import { currentRequest } from './logging';

export const workspaceAccessRequired = (workspaceId: string): AppError =>
  new AppError({
    code: 'WORKSPACE_ACCESS_REQUIRED',
    message: 'Verify workspace access before continuing.',
    details: { workspaceId },
  });

export const requireWorkspaceContentAccess = async (
  executor: Executor,
  userId: string,
  workspaceId: string,
  epoch: string,
): Promise<void> => {
  if (epoch === '0') return;
  const authorize = currentRequest()?.workspaceAccess;
  if (authorize === undefined) throw workspaceAccessRequired(workspaceId);
  await authorize(executor, userId, workspaceId);
};
