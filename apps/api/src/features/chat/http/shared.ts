/** Shared uses chat's current source authority; no administrator bypass or independent storage. */
import { Elysia, type AnyElysia } from 'elysia';
import { SharedQuery, type SharedPage } from '@purlay/types';
import { requireSession } from '../../../ingress/http/session';
import { queryOf, validated } from '../../../ingress/http/validate';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import type { ChatRouteDependencies } from './dependencies';
import { sharedIn } from '../shared/shared';

const readShared = async (
  dependencies: ChatRouteDependencies,
  request: Request,
  workspaceId: string,
): Promise<SharedPage> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(dependencies.database, userId, workspaceId);
  const query = validated(SharedQuery, {
    view: 'files',
    ...queryOf(new URL(request.url), { numbers: ['limit'] }),
  });
  return await sharedIn(dependencies.database, context, query);
};
export const sharedRoutes = (context: ChatRouteDependencies): AnyElysia =>
  new Elysia().get(
    '/api/workspaces/:workspaceId/shared',
    async ({ request, params }) => await readShared(context, request, params.workspaceId),
  );
