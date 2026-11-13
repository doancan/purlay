/** The directory token response is decoded here; callers must never persist it in Query data. */
import {
  WorkspaceDirectory,
  WorkspaceDirectoryPage,
  IssuedDirectoryCredential,
} from '@purlay/types/workspace-directory';
import type { Http } from '../http';
import type { WorkspaceDirectoryApi } from './workspace-directory';
import { at, options } from './request';
const root = (workspaceId: string): string => `/api/workspaces/${at(workspaceId)}/directories`;
export const createWorkspaceDirectoryRequests = (http: Http): WorkspaceDirectoryApi => ({
  workspaceDirectories: (workspaceId, query = {}, signal) =>
    http.request('GET', root(workspaceId), WorkspaceDirectoryPage, options({ query }, signal)),
  createWorkspaceDirectory: (workspaceId, input) =>
    http.request('POST', root(workspaceId), WorkspaceDirectory, options({ body: input })),
  updateWorkspaceDirectory: (workspaceId, directoryId, input) =>
    http.request(
      'PATCH',
      `${root(workspaceId)}/${at(directoryId)}`,
      WorkspaceDirectory,
      options({ body: input }),
    ),
  deleteWorkspaceDirectory: (workspaceId, directoryId, input) =>
    http.send('DELETE', `${root(workspaceId)}/${at(directoryId)}`, options({ body: input })),
  rotateDirectoryCredential: (workspaceId, directoryId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/${at(directoryId)}/credentials`,
      IssuedDirectoryCredential,
      options({ body: input }),
    ),
  revokeDirectoryCredential: (workspaceId, directoryId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/${at(directoryId)}/credentials/revoke`,
      WorkspaceDirectory,
      options({ body: input }),
    ),
});
