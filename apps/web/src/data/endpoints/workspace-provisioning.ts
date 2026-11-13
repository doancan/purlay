/** Source-aware access requests and validators stay outside the initial conversation bundle. */
import type {
  AddManualWorkspaceAccessRequest,
  AssignWorkspaceAccessGrantRequest,
  ConfirmWorkspaceOffboardingRequest,
  CreateWorkspaceAccessGroupRequest,
  CreateWorkspaceAccessRoleRequest,
  PreviewWorkspaceOffboardingRequest,
  ProvisioningRevisionRequest,
  ReadmitWorkspaceMemberRequest,
  RevokeWorkspaceAccessSourceRequest,
  UpdateWorkspaceAccessGroupRequest,
  UpdateWorkspaceAccessRoleRequest,
  UpdateWorkspaceGroupMembersRequest,
  WorkspaceAccessGrant,
  WorkspaceAccessGrantPage,
  WorkspaceAccessGrantQuery,
  WorkspaceAccessGroup,
  WorkspaceAccessGroupCandidatePage,
  WorkspaceAccessGroupCandidateQuery,
  WorkspaceAccessGroupMemberPage,
  WorkspaceAccessGroupPage,
  WorkspaceAccessListQuery,
  WorkspaceAccessPeoplePage,
  WorkspaceAccessPeopleQuery,
  WorkspaceAccessRole,
  WorkspaceAccessRolePage,
  WorkspaceMemberAccess,
  WorkspaceOffboardingPreview,
} from '@purlay/types/workspace-provisioning';
import type { Http } from '../http';

export interface WorkspaceProvisioningApi {
  readonly workspaceAccessPeople: (
    workspaceId: string,
    query?: WorkspaceAccessPeopleQuery,
    signal?: AbortSignal,
  ) => Promise<WorkspaceAccessPeoplePage>;
  readonly workspaceMemberAccess: (
    workspaceId: string,
    userId: string,
    signal?: AbortSignal,
  ) => Promise<WorkspaceMemberAccess>;
  readonly workspaceAccessRoles: (
    workspaceId: string,
    query?: WorkspaceAccessListQuery,
    signal?: AbortSignal,
  ) => Promise<WorkspaceAccessRolePage>;
  readonly createWorkspaceAccessRole: (
    workspaceId: string,
    input: CreateWorkspaceAccessRoleRequest,
  ) => Promise<WorkspaceAccessRole>;
  readonly updateWorkspaceAccessRole: (
    workspaceId: string,
    roleId: string,
    input: UpdateWorkspaceAccessRoleRequest,
  ) => Promise<WorkspaceAccessRole>;
  readonly retireWorkspaceAccessRole: (
    workspaceId: string,
    roleId: string,
    input: ProvisioningRevisionRequest,
  ) => Promise<void>;
  readonly workspaceAccessGroups: (
    workspaceId: string,
    query?: WorkspaceAccessListQuery,
    signal?: AbortSignal,
  ) => Promise<WorkspaceAccessGroupPage>;
  readonly createWorkspaceAccessGroup: (
    workspaceId: string,
    input: CreateWorkspaceAccessGroupRequest,
  ) => Promise<WorkspaceAccessGroup>;
  readonly updateWorkspaceAccessGroup: (
    workspaceId: string,
    groupId: string,
    input: UpdateWorkspaceAccessGroupRequest,
  ) => Promise<WorkspaceAccessGroup>;
  readonly retireWorkspaceAccessGroup: (
    workspaceId: string,
    groupId: string,
    input: ProvisioningRevisionRequest,
  ) => Promise<void>;
  readonly workspaceAccessGroupMembers: (
    workspaceId: string,
    groupId: string,
    query?: WorkspaceAccessListQuery,
    signal?: AbortSignal,
  ) => Promise<WorkspaceAccessGroupMemberPage>;
  readonly workspaceAccessGroupCandidates: (
    workspaceId: string,
    groupId: string,
    query?: WorkspaceAccessGroupCandidateQuery,
    signal?: AbortSignal,
  ) => Promise<WorkspaceAccessGroupCandidatePage>;
  readonly updateWorkspaceAccessGroupMembers: (
    workspaceId: string,
    groupId: string,
    input: UpdateWorkspaceGroupMembersRequest,
  ) => Promise<WorkspaceAccessGroup>;
  readonly workspaceAccessGrants: (
    workspaceId: string,
    query?: WorkspaceAccessGrantQuery,
    signal?: AbortSignal,
  ) => Promise<WorkspaceAccessGrantPage>;
  readonly assignWorkspaceAccessGrant: (
    workspaceId: string,
    input: AssignWorkspaceAccessGrantRequest,
  ) => Promise<WorkspaceAccessGrant>;
  readonly revokeWorkspaceAccessGrant: (
    workspaceId: string,
    grantId: string,
    input: ProvisioningRevisionRequest,
  ) => Promise<void>;
  readonly addManualWorkspaceAccess: (
    workspaceId: string,
    userId: string,
    input: AddManualWorkspaceAccessRequest,
  ) => Promise<WorkspaceMemberAccess>;
  readonly revokeWorkspaceAccessSource: (
    workspaceId: string,
    userId: string,
    sourceId: string,
    input: RevokeWorkspaceAccessSourceRequest,
  ) => Promise<WorkspaceMemberAccess>;
  readonly previewWorkspaceOffboarding: (
    workspaceId: string,
    userId: string,
    input: PreviewWorkspaceOffboardingRequest,
  ) => Promise<WorkspaceOffboardingPreview>;
  readonly confirmWorkspaceOffboarding: (
    workspaceId: string,
    userId: string,
    input: ConfirmWorkspaceOffboardingRequest,
  ) => Promise<WorkspaceMemberAccess>;
  readonly readmitWorkspaceMember: (
    workspaceId: string,
    userId: string,
    input: ReadmitWorkspaceMemberRequest,
  ) => Promise<WorkspaceMemberAccess>;
}

export const createWorkspaceProvisioningApi = (http: Http): WorkspaceProvisioningApi => {
  const lazy =
    <A extends unknown[], T>(
      select: (api: WorkspaceProvisioningApi) => (...input: A) => Promise<T>,
    ): ((...args: A) => Promise<T>) =>
    async (...args) =>
      await select(
        (await import('./workspace-provisioning-requests')).createWorkspaceProvisioningRequests(
          http,
        ),
      )(...args);
  return {
    workspaceAccessPeople: lazy((api) => api.workspaceAccessPeople),
    workspaceMemberAccess: lazy((api) => api.workspaceMemberAccess),
    workspaceAccessRoles: lazy((api) => api.workspaceAccessRoles),
    createWorkspaceAccessRole: lazy((api) => api.createWorkspaceAccessRole),
    updateWorkspaceAccessRole: lazy((api) => api.updateWorkspaceAccessRole),
    retireWorkspaceAccessRole: lazy((api) => api.retireWorkspaceAccessRole),
    workspaceAccessGroups: lazy((api) => api.workspaceAccessGroups),
    createWorkspaceAccessGroup: lazy((api) => api.createWorkspaceAccessGroup),
    updateWorkspaceAccessGroup: lazy((api) => api.updateWorkspaceAccessGroup),
    retireWorkspaceAccessGroup: lazy((api) => api.retireWorkspaceAccessGroup),
    workspaceAccessGroupMembers: lazy((api) => api.workspaceAccessGroupMembers),
    workspaceAccessGroupCandidates: lazy((api) => api.workspaceAccessGroupCandidates),
    updateWorkspaceAccessGroupMembers: lazy((api) => api.updateWorkspaceAccessGroupMembers),
    workspaceAccessGrants: lazy((api) => api.workspaceAccessGrants),
    assignWorkspaceAccessGrant: lazy((api) => api.assignWorkspaceAccessGrant),
    revokeWorkspaceAccessGrant: lazy((api) => api.revokeWorkspaceAccessGrant),
    addManualWorkspaceAccess: lazy((api) => api.addManualWorkspaceAccess),
    revokeWorkspaceAccessSource: lazy((api) => api.revokeWorkspaceAccessSource),
    previewWorkspaceOffboarding: lazy((api) => api.previewWorkspaceOffboarding),
    confirmWorkspaceOffboarding: lazy((api) => api.confirmWorkspaceOffboarding),
    readmitWorkspaceMember: lazy((api) => api.readmitWorkspaceMember),
  };
};
