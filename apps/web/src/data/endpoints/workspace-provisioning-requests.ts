/** Access administration is loaded on demand, including all runtime response decoders. */
import {
  WorkspaceAccessGrant,
  WorkspaceAccessGrantPage,
  WorkspaceAccessGroup,
  WorkspaceAccessGroupCandidatePage,
  WorkspaceAccessGroupMemberPage,
  WorkspaceAccessGroupPage,
  WorkspaceAccessPeoplePage,
  WorkspaceAccessRole,
  WorkspaceAccessRolePage,
  WorkspaceMemberAccess,
  WorkspaceOffboardingPreview,
} from '@purlay/types/workspace-provisioning';
import type { Http } from '../http';
import type { WorkspaceProvisioningApi } from './workspace-provisioning';
import { at, options } from './request';

const root = (workspaceId: string): string => `/api/workspaces/${at(workspaceId)}/access`;

export const createWorkspaceProvisioningRequests = (http: Http): WorkspaceProvisioningApi => ({
  workspaceAccessPeople: (workspaceId, query = {}, signal) =>
    http.request(
      'GET',
      `${root(workspaceId)}/people`,
      WorkspaceAccessPeoplePage,
      options({ query }, signal),
    ),
  workspaceMemberAccess: (workspaceId, userId, signal) =>
    http.request(
      'GET',
      `${root(workspaceId)}/people/${at(userId)}`,
      WorkspaceMemberAccess,
      options({}, signal),
    ),
  workspaceAccessRoles: (workspaceId, query = {}, signal) =>
    http.request(
      'GET',
      `${root(workspaceId)}/roles`,
      WorkspaceAccessRolePage,
      options({ query }, signal),
    ),
  workspaceAccessGroups: (workspaceId, query = {}, signal) =>
    http.request(
      'GET',
      `${root(workspaceId)}/groups`,
      WorkspaceAccessGroupPage,
      options({ query }, signal),
    ),
  workspaceAccessGroupMembers: (workspaceId, groupId, query = {}, signal) =>
    http.request(
      'GET',
      `${root(workspaceId)}/groups/${at(groupId)}/members`,
      WorkspaceAccessGroupMemberPage,
      options({ query }, signal),
    ),
  workspaceAccessGroupCandidates: (workspaceId, groupId, query = {}, signal) =>
    http.request(
      'GET',
      `${root(workspaceId)}/groups/${at(groupId)}/candidates`,
      WorkspaceAccessGroupCandidatePage,
      options({ query }, signal),
    ),
  workspaceAccessGrants: (workspaceId, query = {}, signal) =>
    http.request(
      'GET',
      `${root(workspaceId)}/grants`,
      WorkspaceAccessGrantPage,
      options({ query }, signal),
    ),
  createWorkspaceAccessRole: (workspaceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/roles`,
      WorkspaceAccessRole,
      options({ body: input }),
    ),
  updateWorkspaceAccessRole: (workspaceId, roleId, input) =>
    http.request(
      'PATCH',
      `${root(workspaceId)}/roles/${at(roleId)}`,
      WorkspaceAccessRole,
      options({ body: input }),
    ),
  retireWorkspaceAccessRole: (workspaceId, roleId, input) =>
    http.send('DELETE', `${root(workspaceId)}/roles/${at(roleId)}`, options({ body: input })),
  createWorkspaceAccessGroup: (workspaceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/groups`,
      WorkspaceAccessGroup,
      options({ body: input }),
    ),
  updateWorkspaceAccessGroup: (workspaceId, groupId, input) =>
    http.request(
      'PATCH',
      `${root(workspaceId)}/groups/${at(groupId)}`,
      WorkspaceAccessGroup,
      options({ body: input }),
    ),
  retireWorkspaceAccessGroup: (workspaceId, groupId, input) =>
    http.send('DELETE', `${root(workspaceId)}/groups/${at(groupId)}`, options({ body: input })),
  updateWorkspaceAccessGroupMembers: (workspaceId, groupId, input) =>
    http.request(
      'PATCH',
      `${root(workspaceId)}/groups/${at(groupId)}/members`,
      WorkspaceAccessGroup,
      options({ body: input }),
    ),
  assignWorkspaceAccessGrant: (workspaceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/grants`,
      WorkspaceAccessGrant,
      options({ body: input }),
    ),
  revokeWorkspaceAccessGrant: (workspaceId, grantId, input) =>
    http.send('DELETE', `${root(workspaceId)}/grants/${at(grantId)}`, options({ body: input })),
  addManualWorkspaceAccess: (workspaceId, userId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/people/${at(userId)}/manual`,
      WorkspaceMemberAccess,
      options({ body: input }),
    ),
  revokeWorkspaceAccessSource: (workspaceId, userId, sourceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/people/${at(userId)}/sources/${at(sourceId)}/revoke`,
      WorkspaceMemberAccess,
      options({ body: input }),
    ),
  previewWorkspaceOffboarding: (workspaceId, userId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/people/${at(userId)}/offboarding/preview`,
      WorkspaceOffboardingPreview,
      options({ body: input }),
    ),
  confirmWorkspaceOffboarding: (workspaceId, userId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/people/${at(userId)}/offboarding`,
      WorkspaceMemberAccess,
      options({ body: input }),
    ),
  readmitWorkspaceMember: (workspaceId, userId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/people/${at(userId)}/readmission`,
      WorkspaceMemberAccess,
      options({ body: input }),
    ),
});
