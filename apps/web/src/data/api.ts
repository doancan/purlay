/**
 * Every endpoint the client calls, typed by the contract and spelled once.
 *
 * `API.md` is the list and `@purlay/types` the shapes; the files in `endpoints/` join them to a path, one
 * for each domain, so a path that is wrong is wrong in one place and a shape the server changes fails the
 * response check there, not three screens away. Each method returns what the contract says and throws an
 * `ApiError` — it never returns half of a response. This file is the one door the rest of the client uses.
 */
import type { Http } from './http';
import {
  createWorkspaceDirectoryApi,
  type WorkspaceDirectoryApi,
} from './endpoints/workspace-directory';
import {
  createWorkspaceProvisioningApi,
  type WorkspaceProvisioningApi,
} from './endpoints/workspace-provisioning';
import {
  createWorkspaceSecurityApi,
  type WorkspaceSecurityApi,
} from './endpoints/workspace-security';
import { createServerApi, type ServerApi } from './endpoints/server';
import { createWorkspacesApi, type WorkspacesApi } from './endpoints/workspaces';
import { createInvitationsApi, type InvitationsApi } from './endpoints/invitations';
import { createChannelsApi, type ChannelsApi } from './endpoints/channels';
import { createMessagesApi, type MessagesApi } from './endpoints/messages';
import { createIncidentsApi, type IncidentsApi } from './endpoints/incidents';
import { createSearchApi, type SearchApi } from './endpoints/search';
import { createIssuesApi, type IssuesApi } from './endpoints/issues';
import { createNotificationsApi, type NotificationsApi } from './endpoints/notifications';
import { createGitHubApi, type GitHubApi } from './endpoints/github';
import { createAccountApi, type AccountApi } from './endpoints/account';
import { createRetentionApi, type RetentionApi } from './endpoints/retention';
import { createCompanyIdentityApi, type CompanyIdentityApi } from './endpoints/company-identity';

export type { SetupStatusAnswer } from './endpoints/server';

export interface Api
  extends
    ServerApi,
    WorkspacesApi,
    InvitationsApi,
    ChannelsApi,
    MessagesApi,
    IncidentsApi,
    SearchApi,
    IssuesApi,
    NotificationsApi,
    GitHubApi,
    AccountApi,
    CompanyIdentityApi,
    RetentionApi,
    WorkspaceSecurityApi,
    WorkspaceProvisioningApi,
    WorkspaceDirectoryApi {}

export const createApi = (http: Http): Api => ({
  ...createServerApi(http),
  ...createWorkspacesApi(http),
  ...createInvitationsApi(http),
  ...createChannelsApi(http),
  ...createMessagesApi(http),
  ...createIncidentsApi(http),
  ...createSearchApi(http),
  ...createIssuesApi(http),
  ...createNotificationsApi(http),
  ...createGitHubApi(http),
  ...createAccountApi(http),
  ...createRetentionApi(http),
  ...createCompanyIdentityApi(http),
  ...createWorkspaceSecurityApi(http),
  ...createWorkspaceProvisioningApi(http),
  ...createWorkspaceDirectoryApi(http),
});
