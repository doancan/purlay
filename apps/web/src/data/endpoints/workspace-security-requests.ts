/** Runtime response decoders and security requests stay in the feature chunk. */
import {
  MyWorkspaceMfa,
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
import type { WorkspaceSecurityApi } from './workspace-security';
import { at, options } from './request';

const root = (id: string): string => `/api/workspaces/${at(id)}/security`;

export const createWorkspaceSecurityRequests = (http: Http): WorkspaceSecurityApi => ({
  workspaceSecurityEntry: (workspace, signal) =>
    http.request(
      'GET',
      '/api/workspace-security',
      WorkspaceSecurityEntry,
      options({ query: { workspace } }, signal),
    ),
  workspaceAccess: (workspaceId, signal) =>
    http.request('GET', `${root(workspaceId)}/access`, WorkspaceAccessStatus, options({}, signal)),
  workspacePolicy: (workspaceId, signal) =>
    http.request('GET', `${root(workspaceId)}/policy`, WorkspaceAccessPolicy, options({}, signal)),
  previewWorkspacePolicy: (workspaceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/policy/preview`,
      WorkspacePolicyPreview,
      options({ body: input }),
    ),
  testWorkspacePolicy: (workspaceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/policy/test`,
      WorkspacePolicyTest,
      options({ body: input }),
    ),
  updateWorkspacePolicy: (workspaceId, input) =>
    http.request(
      'PUT',
      `${root(workspaceId)}/policy`,
      WorkspaceAccessPolicy,
      options({ body: input }),
    ),
  createWorkspacePolicyRecovery: (workspaceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/recovery`,
      WorkspacePolicyRecovery,
      options({ body: input }),
    ),
  recoverWorkspacePolicy: (workspaceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/recover`,
      WorkspaceAccessPolicy,
      options({ body: input }),
    ),
  myWorkspaceMfa: (workspaceId, signal) =>
    http.request('GET', `${root(workspaceId)}/mfa`, MyWorkspaceMfa, options({}, signal)),
  startWorkspaceMfaEnrollment: (workspaceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/mfa/enrollment`,
      WorkspaceMfaEnrollment,
      options({ body: input }),
    ),
  startWorkspaceMfaChallenge: (workspaceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/mfa/challenges`,
      WorkspaceMfaChallenge,
      options({ body: input }),
    ),
  verifyWorkspaceMfa: (workspaceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/mfa/verify`,
      WorkspaceMfaVerified,
      options({ body: input }),
    ),
  recoverWorkspaceMfa: (workspaceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/mfa/recovery`,
      WorkspaceMfaVerified,
      options({ body: input }),
    ),
  disableWorkspaceMfa: (workspaceId, input) =>
    http.request('DELETE', `${root(workspaceId)}/mfa`, MyWorkspaceMfa, options({ body: input })),
  newWorkspaceMfaRecoveryCodes: (workspaceId, input) =>
    http.request(
      'POST',
      `${root(workspaceId)}/mfa/recovery-codes`,
      WorkspaceMfaRecoveryCodes,
      options({ body: input }),
    ),
});
