/**
 * The workspace's GitHub token (`API.md`, D-11, D-39 §6): who set one is told, never the token, and an owner or an admin sets
 * or removes it. The path is under the workspace's, and chat's by its manifest: it is the token chat's integrations read.
 */
import { Elysia, type AnyElysia } from 'elysia';
import { SetGitHubTokenRequest, type GitHubIntegration } from '@purlay/types';
import type { ChatRouteDependencies } from './dependencies';
import { requireSession } from '../../../ingress/http/session';
import { validated } from '../../../ingress/http/validate';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { atomicallyOn } from '../../../platform/transactions';
import {
  githubIntegrationOf,
  mayConfigure,
  removeGitHubToken,
  setGitHubToken,
} from '../integrations/github';
import { verifiedToken, type GitHubApi } from '../integrations/unfurl';
import type { GitHubWiring } from './wiring';

/** `GET /api/workspaces/:workspaceId/integrations/github` — whether a token is set. Never the token. */
const readGitHubIntegration = async (
  dependencies: Pick<ChatRouteDependencies, 'auth' | 'database'>,
  request: Request,
  workspaceId: string,
): Promise<GitHubIntegration> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await githubIntegrationOf(database, context);
};

/**
 * `PUT` sets the workspace's token, sealed; `DELETE` removes it (D-11, D-39 §6). A token is asked of
 * GitHub first, outside the transaction (no row is locked across a call to another server) and only
 * after the caller's role is known, so a member cannot spend a request of this server's on a stranger's
 * token.
 */
const changeGitHubToken = async (
  dependencies: Pick<ChatRouteDependencies, 'auth' | 'database' | 'clock' | 'cipher' | 'log'> & {
    readonly githubApi: GitHubApi;
  },
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<GitHubIntegration> => {
  const { database, clock, cipher } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  mayConfigure(context);
  const replacement = request.method === 'DELETE' ? null : validated(SetGitHubTokenRequest, body);
  // No workspace lock is held while the remote provider checks the token.
  const checked =
    replacement === null
      ? null
      : {
          token: replacement.token,
          ...(await verifiedToken(dependencies.githubApi, dependencies.log, replacement.token)),
        };
  return await atomicallyOn(database)(async (transaction) => {
    // Member changes and workspace deletion take this same lock. Re-read the caller only
    // after acquiring it: the initial role may have been revoked during the remote check.
    await transaction
      .selectFrom('workspaces')
      .select('id')
      .where('id', '=', context.workspaceId)
      .forUpdate()
      .executeTakeFirst();
    const current = await requireWorkspaceMembership(transaction, userId, context.workspaceId);
    mayConfigure(current);
    if (checked === null) await removeGitHubToken(transaction, clock, current);
    else await setGitHubToken(transaction, clock, cipher, current, checked.token, checked.scopes);
    return await githubIntegrationOf(transaction, current);
  });
};

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const githubIntegrationRoutes = (
  context: ChatRouteDependencies,
  wiring: GitHubWiring,
): AnyElysia =>
  new Elysia()
    .get(
      '/api/workspaces/:workspaceId/integrations/github',
      async ({ request, params }) =>
        await readGitHubIntegration(context, request, params.workspaceId),
    )
    .put(
      '/api/workspaces/:workspaceId/integrations/github',
      async ({ request, params, body }) =>
        await changeGitHubToken(
          { ...context, githubApi: wiring.github },
          request,
          params.workspaceId,
          body,
        ),
    )
    .delete(
      '/api/workspaces/:workspaceId/integrations/github',
      async ({ request, params }) =>
        await changeGitHubToken(
          { ...context, githubApi: wiring.github },
          request,
          params.workspaceId,
          undefined,
        ),
    );
