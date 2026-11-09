/** The caller's followed conversations, scoped by the current workspace and channel guards. */
import { Elysia, type AnyElysia } from 'elysia';
import { FollowedThreadsQuery, type FollowedThreadsPage } from '@purlay/types';
import type { ChatRouteDependencies } from './dependencies';
import { requireSession } from '../../../ingress/http/session';
import { queryOf, validated } from '../../../ingress/http/validate';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { followedThreads } from '../messages/followed';

const listFollowed = async (
  { auth, database }: ChatRouteDependencies,
  request: Request,
  workspaceId: string,
): Promise<FollowedThreadsPage> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const input = validated(
    FollowedThreadsQuery,
    queryOf(new URL(request.url), {
      numbers: ['limit'],
      booleans: ['unreadOnly'],
    }),
  );
  return await followedThreads(database, context, input);
};

export const followedRoutes = (context: ChatRouteDependencies): AnyElysia =>
  new Elysia().get(
    '/api/workspaces/:workspaceId/followed-threads',
    async ({ request, params }) => await listFollowed(context, request, params.workspaceId),
  );
