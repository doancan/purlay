/** Directory management and secret-bearing decoders load only when administration is used. */
import type { OlderPageQuery } from '@purlay/types';
import type {
  WorkspaceDirectory,
  WorkspaceDirectoryPage,
  CreateWorkspaceDirectoryRequest,
  UpdateWorkspaceDirectoryRequest,
  DirectoryRevisionRequest,
  RotateDirectoryCredentialRequest,
  RevokeDirectoryCredentialRequest,
  IssuedDirectoryCredential,
} from '@purlay/types/workspace-directory';
import type { Http } from '../http';

export interface WorkspaceDirectoryApi {
  readonly workspaceDirectories: (
    workspaceId: string,
    query?: OlderPageQuery,
    signal?: AbortSignal,
  ) => Promise<WorkspaceDirectoryPage>;
  readonly createWorkspaceDirectory: (
    workspaceId: string,
    input: CreateWorkspaceDirectoryRequest,
  ) => Promise<WorkspaceDirectory>;
  readonly updateWorkspaceDirectory: (
    workspaceId: string,
    directoryId: string,
    input: UpdateWorkspaceDirectoryRequest,
  ) => Promise<WorkspaceDirectory>;
  readonly deleteWorkspaceDirectory: (
    workspaceId: string,
    directoryId: string,
    input: DirectoryRevisionRequest,
  ) => Promise<void>;
  readonly rotateDirectoryCredential: (
    workspaceId: string,
    directoryId: string,
    input: RotateDirectoryCredentialRequest,
  ) => Promise<IssuedDirectoryCredential>;
  readonly revokeDirectoryCredential: (
    workspaceId: string,
    directoryId: string,
    input: RevokeDirectoryCredentialRequest,
  ) => Promise<WorkspaceDirectory>;
}

export const createWorkspaceDirectoryApi = (http: Http): WorkspaceDirectoryApi => {
  const lazy =
    <A extends unknown[], T>(
      select: (api: WorkspaceDirectoryApi) => (...input: A) => Promise<T>,
    ): ((...args: A) => Promise<T>) =>
    async (...args) =>
      await select(
        (await import('./workspace-directory-requests')).createWorkspaceDirectoryRequests(http),
      )(...args);
  return {
    workspaceDirectories: lazy((api) => api.workspaceDirectories),
    createWorkspaceDirectory: lazy((api) => api.createWorkspaceDirectory),
    updateWorkspaceDirectory: lazy((api) => api.updateWorkspaceDirectory),
    deleteWorkspaceDirectory: lazy((api) => api.deleteWorkspaceDirectory),
    rotateDirectoryCredential: lazy((api) => api.rotateDirectoryCredential),
    revokeDirectoryCredential: lazy((api) => api.revokeDirectoryCredential),
  };
};
