/**
 * The routes of issues (D-254, D-280): the plugin `createApp` uses for this module, at the paths its manifest lists. The
 * statuses are the handlers' own, set here as the application sets any: `201` for a made issue, `204` for a deleted one.
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import type { IssuesDb } from '../schema';
import { listIssues, patchIssue, postIssue, removeIssue } from './handlers';

export const issuesRoutes = (context: ModuleRouteDependencies<IssuesDb>): AnyElysia =>
  new Elysia()
    .get(
      '/api/workspaces/:workspaceId/issues',
      async ({ request, params }) => await listIssues(context, request, params.workspaceId),
    )
    .post('/api/workspaces/:workspaceId/issues', async ({ request, params, body, set }) => {
      const issue = await postIssue(context, request, params.workspaceId, body);
      set.status = 201;
      return issue;
    })
    .patch(
      '/api/workspaces/:workspaceId/issues/:issueId',
      async ({ request, params, body }) =>
        await patchIssue(context, request, params.workspaceId, params.issueId, body),
    )
    .delete('/api/workspaces/:workspaceId/issues/:issueId', async ({ request, params, set }) => {
      await removeIssue(context, request, params.workspaceId, params.issueId);
      set.status = 204;
      return null;
    });
