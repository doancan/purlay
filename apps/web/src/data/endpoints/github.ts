// The GitHub integration, the GitHub App and the channel hooks that bring events in.
import {
  CreatedGitHubFeed,
  CreatedIncomingWebhook,
  GitHubAppRedirect,
  GitHubAppStatus,
  GitHubFeedList,
  GitHubIntegration,
  GitHubIssueOutcome,
  GitHubRepositoryList,
  GitHubWorkLink,
  IncomingWebhookList,
  IncomingWebhookAnswer,
  UnfurlResponse,
  WebLinkPreviewResponse,
  type CreateGitHubFeedRequest,
  type CreateGitHubIssueRequest,
  type CreateIncomingWebhookRequest,
  type LinkGitHubWorkRequest,
} from '@purlay/types';
import type { Http } from '../http';
import { at, options } from './request';

export interface GitHubApi {
  /** An owner's or an admin's: whether the workspace has a GitHub token, never the token (D-23). */
  readonly githubIntegration: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<GitHubIntegration>;
  readonly setGitHubToken: (workspaceId: string, token: string) => Promise<GitHubIntegration>;
  readonly removeGitHubToken: (workspaceId: string) => Promise<GitHubIntegration>;
  /** An owner's or an admin's: the repositories a channel hears from, never their secrets (D-134). */
  readonly githubFeeds: (channelId: string, signal?: AbortSignal) => Promise<GitHubFeedList>;
  /** Connects a repository: the feed, the address and the secret GitHub needs — once. */
  readonly connectGitHubFeed: (
    channelId: string,
    input: CreateGitHubFeedRequest,
  ) => Promise<CreatedGitHubFeed>;
  /** A new secret for the feed, same address; the old one stops working at once. Shown once (#884). */
  readonly regenerateGitHubFeedSecret: (
    channelId: string,
    feedId: string,
  ) => Promise<CreatedGitHubFeed>;
  readonly disconnectGitHubFeed: (channelId: string, feedId: string) => Promise<void>;
  /** A pull request's or an issue's card, read with the workspace's token (D-23, D-112); null for none. */
  readonly unfurl: (
    workspaceId: string,
    url: string,
    signal?: AbortSignal,
  ) => Promise<UnfurlResponse>;
  readonly previewMessageLink: (
    messageId: string,
    url: string,
    signal?: AbortSignal,
  ) => Promise<WebLinkPreviewResponse>;
  /** The GitHub App in a workspace: whether the server has one, its installation, the caller's own authorization (D-246). */
  readonly githubApp: (workspaceId: string, signal?: AbortSignal) => Promise<GitHubAppStatus>;
  /** What the caller may choose when making an issue: the repositories both they and the App reach (D-246 §2). */
  readonly githubRepositories: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<GitHubRepositoryList>;
  /** Makes an issue from a thread, or says what became of the request with this id (D-246 §2, §4). */
  readonly createGitHubIssue: (
    messageId: string,
    input: CreateGitHubIssueRequest,
  ) => Promise<GitHubIssueOutcome>;
  /** Points a thread at an issue or pull request that exists (D-246 §3). */
  readonly linkGitHubWork: (
    messageId: string,
    input: LinkGitHubWorkRequest,
  ) => Promise<GitHubWorkLink>;
  /** An owner: where GitHub's installation screen is. */
  readonly startGitHubInstallation: (workspaceId: string) => Promise<GitHubAppRedirect>;
  readonly removeGitHubInstallation: (workspaceId: string) => Promise<void>;
  /** The caller, to GitHub's screen for letting Purlay write as them, coming back to `returnTo`. */
  readonly startGitHubAuthorization: (returnTo: string) => Promise<GitHubAppRedirect>;
  readonly forgetGitHubAuthorization: () => Promise<void>;
  /** An owner's or an admin's: the incoming webhooks a channel has, never their secrets (D-245). */
  readonly incomingWebhooks: (
    channelId: string,
    signal?: AbortSignal,
  ) => Promise<IncomingWebhookList>;
  /** Makes an incoming webhook: the hook, and the path with its secret — once. */
  readonly createIncomingWebhook: (
    channelId: string,
    input: CreateIncomingWebhookRequest,
  ) => Promise<CreatedIncomingWebhook>;
  readonly postIncomingWebhook: (
    path: CreatedIncomingWebhook['path'],
    text: string,
  ) => Promise<IncomingWebhookAnswer>;
  readonly revokeIncomingWebhook: (channelId: string, webhookId: string) => Promise<void>;
}

export const createGitHubApi = (http: Http): GitHubApi => ({
  githubIntegration: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/integrations/github`,
      GitHubIntegration,
      options({}, signal),
    ),
  setGitHubToken: (workspaceId, token) =>
    http.request(
      'PUT',
      `/api/workspaces/${at(workspaceId)}/integrations/github`,
      GitHubIntegration,
      options({ body: { token } }),
    ),
  removeGitHubToken: (workspaceId) =>
    http.request(
      'DELETE',
      `/api/workspaces/${at(workspaceId)}/integrations/github`,
      GitHubIntegration,
      options(),
    ),
  githubFeeds: (channelId, signal) =>
    http.request(
      'GET',
      `/api/channels/${at(channelId)}/github-feeds`,
      GitHubFeedList,
      options({}, signal),
    ),
  connectGitHubFeed: (channelId, input) =>
    http.request(
      'POST',
      `/api/channels/${at(channelId)}/github-feeds`,
      CreatedGitHubFeed,
      options({ body: input }),
    ),
  regenerateGitHubFeedSecret: (channelId, feedId) =>
    http.request(
      'POST',
      `/api/channels/${at(channelId)}/github-feeds/${at(feedId)}/secret`,
      CreatedGitHubFeed,
      options(),
    ),
  disconnectGitHubFeed: (channelId, feedId) =>
    http.send('DELETE', `/api/channels/${at(channelId)}/github-feeds/${at(feedId)}`, options()),
  unfurl: (workspaceId, url, signal) =>
    http.request(
      'POST',
      '/api/integrations/github/unfurl',
      UnfurlResponse,
      options({ body: { workspaceId, url } }, signal),
    ),
  previewMessageLink: (messageId, url, signal) =>
    http.request(
      'POST',
      `/api/messages/${at(messageId)}/link-preview`,
      WebLinkPreviewResponse,
      options({ body: { url } }, signal),
    ),
  githubApp: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/github-app`,
      GitHubAppStatus,
      options({}, signal),
    ),
  githubRepositories: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/github-repositories`,
      GitHubRepositoryList,
      options({}, signal),
    ),
  createGitHubIssue: (messageId, input) =>
    http.request(
      'POST',
      `/api/messages/${at(messageId)}/github-issue`,
      GitHubIssueOutcome,
      options({ body: input }),
    ),
  linkGitHubWork: (messageId, input) =>
    http.request(
      'POST',
      `/api/messages/${at(messageId)}/github-link`,
      GitHubWorkLink,
      options({ body: input }),
    ),
  startGitHubInstallation: (workspaceId) =>
    http.request(
      'POST',
      `/api/workspaces/${at(workspaceId)}/github-app/installation`,
      GitHubAppRedirect,
      options(),
    ),
  removeGitHubInstallation: (workspaceId) =>
    http.send('DELETE', `/api/workspaces/${at(workspaceId)}/github-app/installation`, options()),
  startGitHubAuthorization: (returnTo) =>
    http.request(
      'POST',
      '/api/github-app/authorization',
      GitHubAppRedirect,
      options({ body: { returnTo } }),
    ),
  forgetGitHubAuthorization: () => http.send('DELETE', '/api/github-app/authorization', options()),
  incomingWebhooks: (channelId, signal) =>
    http.request(
      'GET',
      `/api/channels/${at(channelId)}/incoming-webhooks`,
      IncomingWebhookList,
      options({}, signal),
    ),
  createIncomingWebhook: (channelId, input) =>
    http.request(
      'POST',
      `/api/channels/${at(channelId)}/incoming-webhooks`,
      CreatedIncomingWebhook,
      options({ body: input }),
    ),
  postIncomingWebhook: (path, text) =>
    http.request('POST', path, IncomingWebhookAnswer, options({ body: { text } })),
  revokeIncomingWebhook: (channelId, webhookId) =>
    http.send(
      'DELETE',
      `/api/channels/${at(channelId)}/incoming-webhooks/${at(webhookId)}`,
      options(),
    ),
});
