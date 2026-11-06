/**
 * What chat's GitHub-facing routes share, made once for the module's plugin (D-280): the limiters of GitHub's deliveries and of
 * calls to GitHub, the workspaces GitHub told to wait, the count of deliveries being handled, and the dependencies of the App's
 * routes as each request reads them. The application hands over what it also uses itself (the cipher, the App's API and
 * settings) and the limiter factory; nothing here is the core's, so no other route reads it.
 */
import type { GitHubAppRouteDependencies } from './github-app';
import type { GitHubIssueRouteDependencies } from './github-issues';
import type { ModuleRouteDependencies, RouteLimiter } from '../../../ingress/http/module-routes';
import {
  GITHUB_CALL_BUDGET,
  INCOMING_WEBHOOK_BUDGET,
  WEBHOOK_BUDGET,
  WEBHOOK_FEED_BUDGET,
} from '../../../ingress/http/rate-limit';
import {
  githubApi,
  inProcessPauses,
  type GitHubApi,
  type GitHubPauses,
} from '../integrations/unfurl';

export interface GitHubWiring {
  readonly github: GitHubApi;
  readonly githubApp: () => GitHubAppRouteDependencies;
  readonly githubIssues: () => GitHubIssueRouteDependencies;
  readonly githubCalls: RouteLimiter;
  readonly githubPauses: GitHubPauses;
  readonly knocks: RouteLimiter;
  readonly feedPosts: RouteLimiter;
  readonly hookPosts: RouteLimiter;
  readonly delivering: { count: number };
}

export const githubWiring = (context: ModuleRouteDependencies): GitHubWiring => {
  // GitHub's API at the address the sign-in uses (D-23, amended), unless a test hands its own.
  const github =
    context.githubApi ??
    githubApi(context.config.GITHUB_API_URL, () => context.clock.now().getTime());
  const githubApp = (): GitHubAppRouteDependencies => ({
    auth: context.auth,
    database: context.database,
    clock: context.clock,
    log: context.log,
    cipher: context.cipher,
    app: context.githubAppSettings(),
    api: context.githubAppApi,
    urls: context.githubUrls,
    appUrl: context.config.APP_URL,
  });
  const githubIssues = (): GitHubIssueRouteDependencies => ({
    ...githubApp(),
    bus: context.bus,
  });
  return {
    github,
    githubApp,
    githubIssues,
    // One bucket per workspace for calls to GitHub, so one member cannot spend the workspace's token.
    githubCalls: context.limiterFor('github-calls', GITHUB_CALL_BUDGET),
    // Workspaces GitHub told to wait.
    githubPauses: inProcessPauses(),
    // GitHub's deliveries: every address before the signature, each feed after it (D-134 §4).
    knocks: context.limiterFor('webhook-knocks', WEBHOOK_BUDGET),
    feedPosts: context.limiterFor('webhook-feeds', WEBHOOK_FEED_BUDGET),
    // Each incoming webhook's posts, once its secret held; before it, the address's knocks (D-245).
    hookPosts: context.limiterFor('incoming-webhooks', INCOMING_WEBHOOK_BUDGET),
    delivering: { count: 0 },
  };
};
