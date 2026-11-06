/**
 * `GET /api/workspaces/:workspaceId/presence` (#480, D-136): who among the workspace's members is
 * online now, for a member of it. Validate, call one service, answer.
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import type { PresenceSnapshot } from '@purlay/types';
import { workspacePresence, type OnlineReader } from '../presence/presence';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import type { ChannelDependencies } from '../../../ingress/http/channels';
import { requireSession } from '../../../ingress/http/session';

const readPresence = async (
  { auth, database }: ChannelDependencies,
  request: Request,
  workspaceId: string,
  online: OnlineReader,
): Promise<PresenceSnapshot> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await workspacePresence(database, context, online);
};

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const presenceRoutes = (context: ModuleRouteDependencies): AnyElysia =>
  new Elysia().get(
    '/api/workspaces/:workspaceId/presence',
    async ({ request, params }) =>
      await readPresence(context, request, params.workspaceId, context.online),
  );
