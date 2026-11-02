/**
 * GitHub issues from a thread over HTTP (D-246 §2, `API.md` §7): the repositories a person may choose and the
 * creation of an issue. Each route takes the session, validates, calls one function of
 * `modules/integrations/github-issues.ts` and says which of the four outcomes it came to.
 */
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
} from '../../modules/integrations/github-issues';
import type { Auth } from '../../modules/auth/better-auth';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { requireSession } from './session';
import { validated } from './validate';

export interface GitHubIssueRouteDependencies extends GitHubIssueDependencies {
  readonly auth: Auth;
}

/** `GET /api/workspaces/:workspaceId/github-repositories` — any member: what they may choose, never more. */
export const readGitHubRepositories = async (
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
export const STATUS_OF_OUTCOME: Readonly<Record<GitHubIssueOutcome['status'], 200 | 201 | 202>> = {
  created: 201,
  pending: 202,
  unknown: 202,
  refused: 200,
};

/** `POST /api/messages/:messageId/github-issue` — a member of the channel, with a request id that is theirs. */
export const makeGitHubIssue = async (
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
export const linkGitHubWork = async (
  dependencies: GitHubIssueRouteDependencies,
  request: Request,
  messageId: string,
  body: unknown,
): Promise<{ readonly link: GitHubWorkLink; readonly created: boolean }> => {
  const { userId } = await requireSession(dependencies.auth, request);
  return await linkWork(dependencies, userId, messageId, validated(LinkGitHubWorkRequest, body));
};
