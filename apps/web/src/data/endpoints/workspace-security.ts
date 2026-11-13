/** Workspace security is optional at startup: its runtime contracts are loaded on use. */
import type {
  ChangeWorkspaceMfaRequest,
  CreateWorkspacePolicyRecoveryRequest,
  MyWorkspaceMfa,
  PreviewWorkspacePolicyRequest,
  RecoverWorkspacePolicyRequest,
  StartWorkspaceMfaChallengeRequest,
  StartWorkspaceMfaEnrollmentRequest,
  TestWorkspacePolicyRequest,
  UpdateWorkspacePolicyRequest,
  UseWorkspaceMfaRecoveryRequest,
  VerifyWorkspaceMfaRequest,
  WorkspaceAccessPolicy,
  WorkspaceAccessStatus,
  WorkspaceMfaChallenge,
  WorkspaceMfaEnrollment,
  WorkspaceMfaRecoveryCodes,
  WorkspaceMfaVerified,
  WorkspacePolicyPreview,
  WorkspacePolicyRecovery,
  WorkspacePolicyTest,
  WorkspaceSecurityEntry,
} from '@purlay/types/workspace-security';
import type { Http } from '../http';

export interface WorkspaceSecurityApi {
  readonly workspaceSecurityEntry: (
    workspace: string,
    signal?: AbortSignal,
  ) => Promise<WorkspaceSecurityEntry>;
  readonly workspaceAccess: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<WorkspaceAccessStatus>;
  readonly workspacePolicy: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<WorkspaceAccessPolicy>;
  readonly previewWorkspacePolicy: (
    workspaceId: string,
    input: PreviewWorkspacePolicyRequest,
  ) => Promise<WorkspacePolicyPreview>;
  readonly testWorkspacePolicy: (
    workspaceId: string,
    input: TestWorkspacePolicyRequest,
  ) => Promise<WorkspacePolicyTest>;
  readonly updateWorkspacePolicy: (
    workspaceId: string,
    input: UpdateWorkspacePolicyRequest,
  ) => Promise<WorkspaceAccessPolicy>;
  readonly createWorkspacePolicyRecovery: (
    workspaceId: string,
    input: CreateWorkspacePolicyRecoveryRequest,
  ) => Promise<WorkspacePolicyRecovery>;
  readonly recoverWorkspacePolicy: (
    workspaceId: string,
    input: RecoverWorkspacePolicyRequest,
  ) => Promise<WorkspaceAccessPolicy>;
  readonly myWorkspaceMfa: (workspaceId: string, signal?: AbortSignal) => Promise<MyWorkspaceMfa>;
  readonly startWorkspaceMfaEnrollment: (
    workspaceId: string,
    input: StartWorkspaceMfaEnrollmentRequest,
  ) => Promise<WorkspaceMfaEnrollment>;
  readonly startWorkspaceMfaChallenge: (
    workspaceId: string,
    input: StartWorkspaceMfaChallengeRequest,
  ) => Promise<WorkspaceMfaChallenge>;
  readonly verifyWorkspaceMfa: (
    workspaceId: string,
    input: VerifyWorkspaceMfaRequest,
  ) => Promise<WorkspaceMfaVerified>;
  readonly recoverWorkspaceMfa: (
    workspaceId: string,
    input: UseWorkspaceMfaRecoveryRequest,
  ) => Promise<WorkspaceMfaVerified>;
  readonly disableWorkspaceMfa: (
    workspaceId: string,
    input: ChangeWorkspaceMfaRequest,
  ) => Promise<MyWorkspaceMfa>;
  readonly newWorkspaceMfaRecoveryCodes: (
    workspaceId: string,
    input: ChangeWorkspaceMfaRequest,
  ) => Promise<WorkspaceMfaRecoveryCodes>;
}

export const createWorkspaceSecurityApi = (http: Http): WorkspaceSecurityApi => {
  const lazy =
    <A extends unknown[], T>(
      select: (api: WorkspaceSecurityApi) => (...input: A) => Promise<T>,
    ): ((...args: A) => Promise<T>) =>
    async (...args) =>
      await select(
        (await import('./workspace-security-requests')).createWorkspaceSecurityRequests(http),
      )(...args);
  return {
    workspaceSecurityEntry: lazy((api) => api.workspaceSecurityEntry),
    workspaceAccess: lazy((api) => api.workspaceAccess),
    workspacePolicy: lazy((api) => api.workspacePolicy),
    previewWorkspacePolicy: lazy((api) => api.previewWorkspacePolicy),
    testWorkspacePolicy: lazy((api) => api.testWorkspacePolicy),
    updateWorkspacePolicy: lazy((api) => api.updateWorkspacePolicy),
    createWorkspacePolicyRecovery: lazy((api) => api.createWorkspacePolicyRecovery),
    recoverWorkspacePolicy: lazy((api) => api.recoverWorkspacePolicy),
    myWorkspaceMfa: lazy((api) => api.myWorkspaceMfa),
    startWorkspaceMfaEnrollment: lazy((api) => api.startWorkspaceMfaEnrollment),
    startWorkspaceMfaChallenge: lazy((api) => api.startWorkspaceMfaChallenge),
    verifyWorkspaceMfa: lazy((api) => api.verifyWorkspaceMfa),
    recoverWorkspaceMfa: lazy((api) => api.recoverWorkspaceMfa),
    disableWorkspaceMfa: lazy((api) => api.disableWorkspaceMfa),
    newWorkspaceMfaRecoveryCodes: lazy((api) => api.newWorkspaceMfaRecoveryCodes),
  };
};
