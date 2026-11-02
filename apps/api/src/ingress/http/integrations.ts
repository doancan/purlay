/**
 * `POST /api/integrations/github/unfurl` — a GitHub link's card, for a member of the workspace that
 * names it (D-23, #66). The workspace is in the body, asked of the guard before the link is read, so
 * a stranger is told the workspace does not exist whatever else they sent (D-34).
 */
import type { Auth } from '../../modules/auth/better-auth';
import type { Executor } from '@purlay/db';
import { UnfurlRequest, type UnfurlResponse } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { CredentialCipher } from '../../platform/crypto';
import type { Logger } from '../../platform/logging';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { unfurl, type GitHubApi, type GitHubPauses } from '../../modules/integrations/unfurl';
import type { RateLimiter } from '../../realtime/rate-limiter';
import { requireSession } from './session';
import { validated } from './validate';

export const unfurlLink = async (
  dependencies: {
    readonly auth: Auth;
    readonly database: Executor;
    readonly clock: Clock;
    readonly cipher: CredentialCipher;
    readonly githubApi: GitHubApi;
    readonly log: Logger;
    /** One bucket per workspace for calls to GitHub (`GITHUB_CALL_BUDGET`). */
    readonly githubCalls: RateLimiter;
    /** Workspaces GitHub told to wait (`GitHubPauses`). */
    readonly githubPauses: GitHubPauses;
  },
  request: Request,
  body: unknown,
): Promise<UnfurlResponse> => {
  const { database, clock, cipher, githubApi, log, githubCalls, githubPauses } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const workspaceId =
    typeof body === 'object' &&
    body !== null &&
    'workspaceId' in body &&
    typeof body.workspaceId === 'string'
      ? body.workspaceId
      : validated(UnfurlRequest, body).workspaceId;
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const { url } = validated(UnfurlRequest, body);
  return await unfurl(
    {
      database,
      clock,
      cipher,
      github: githubApi,
      log,
      mayCallGitHub: async (id) => await githubCalls.consume(id),
      pauses: githubPauses,
    },
    context,
    url,
  );
};
