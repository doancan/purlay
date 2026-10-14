/**
 * `GET /api/workspaces/:workspaceId/presence` (#480, D-136): who among the workspace's members is
 * online now, for a member of it. Validate, call one service, answer.
 */
import type { PresenceSnapshot } from '@purlay/types';
import { workspacePresence, type OnlineReader } from '../../modules/presence/presence';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import type { ChannelDependencies } from './channels';
import { requireSession } from './session';

export const readPresence = async (
  { database, clock }: ChannelDependencies,
  request: Request,
  workspaceId: string,
  online: OnlineReader,
): Promise<PresenceSnapshot> => {
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await workspacePresence(database, context, online);
};
