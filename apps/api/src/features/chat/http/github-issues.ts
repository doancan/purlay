/**
 * GitHub issues from a thread over HTTP (D-246 §2, `API.md` §7): the repositories a person may choose and the
 * creation of an issue. Each route takes the session, validates, calls one function of
 * `features/chat/integrations/github-issues.ts` and says which of the four outcomes it came to.
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ChatRouteDependencies } from './dependencies';
import type { GitHubWiring } from './wiring';
import {
  CreateGitHubIssueRequest,
  LinkGitHubWorkRequest,
  type GitHubWorkLink,
  type GitHubIssueOutcome,
  type GitHubRepositoryList,
} from '@purlay/types';
import {
  allowedRepositories,
  createIssue,
  linkWork,
  type GitHubIssueDependencies,
} from '../integrations/github-issues';
import type { SessionAuth } from '../../../modules/auth/sessions';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { requireSession } from '../../../ingress/http/session';
import { validated } from '../../../ingress/http/validate';

export interface GitHubIssueRouteDependencies extends GitHubIssueDependencies {
  readonly auth: SessionAuth;
}

/** `GET /api/workspaces/:workspaceId/github-repositories` — any member: what they may choose, never more. */
const readGitHubRepositories = async (
  dependencies: GitHubIssueRouteDependencies,
  request: Request,
  workspaceId: string,
): Promise<GitHubRepositoryList> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(dependencies.database, userId, workspaceId);
  return {
    repositories: [...(await allowedRepositories(dependencies, context.workspaceId, userId))],
  };
};

/** What status each outcome is answered with: made is `201`, being made or not known `202`, refused `200`. */
const STATUS_OF_OUTCOME: Readonly<Record<GitHubIssueOutcome['status'], 200 | 201 | 202>> = {
  created: 201,
  pending: 202,
  unknown: 202,
  refused: 200,
};

/** `POST /api/messages/:messageId/github-issue` — a member of the channel, with a request id that is theirs. */
const makeGitHubIssue = async (
  dependencies: GitHubIssueRouteDependencies,
  request: Request,
  messageId: string,
  body: unknown,
): Promise<GitHubIssueOutcome> => {
  const { userId } = await requireSession(dependencies.auth, request);
  return await createIssue(
    dependencies,
    userId,
    messageId,
    validated(CreateGitHubIssueRequest, body),
  );
};

/** `POST /api/messages/:messageId/github-link` — a member of the channel, pointing at work that exists. */
const linkGitHubWork = async (
  dependencies: GitHubIssueRouteDependencies,
  request: Request,
  messageId: string,
  body: unknown,
): Promise<{ readonly link: GitHubWorkLink; readonly created: boolean }> => {
  const { userId } = await requireSession(dependencies.auth, request);
  return await linkWork(dependencies, userId, messageId, validated(LinkGitHubWorkRequest, body));
};

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const githubIssueRoutes = (
  context: ChatRouteDependencies,
  wiring: GitHubWiring,
): AnyElysia =>
  new Elysia()
    .get(
      '/api/workspaces/:workspaceId/github-repositories',
      async ({ request, params }) =>
        await readGitHubRepositories(wiring.githubIssues(), request, params.workspaceId),
    )
    .post('/api/messages/:messageId/github-link', async ({ request, params, body, set }) => {
      const { link, created } = await linkGitHubWork(
        wiring.githubIssues(),
        request,
        params.messageId,
        body,
      );
      set.status = created ? 201 : 200;
      return link;
    })
    .post('/api/messages/:messageId/github-issue', async ({ request, params, body, set }) => {
      const outcome = await makeGitHubIssue(wiring.githubIssues(), request, params.messageId, body);
      set.status = STATUS_OF_OUTCOME[outcome.status];
      return outcome;
    });
