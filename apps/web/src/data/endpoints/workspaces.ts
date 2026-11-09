// A workspace and the people in it: membership, roles, the audit trail, presence.
import {
  AuditPage,
  DeepWorkResponse,
  Membership,
  PresenceSnapshot,
  SetAwayResponse,
  Workspace,
  WorkspaceMember,
  WorkspaceMemberList,
  type AuditFilter,
  type CreateWorkspaceRequest,
  type SetDeepWorkRequest,
  type UserRole,
} from '@purlay/types';
import { Type } from '@sinclair/typebox';
import type { Http } from '../http';
import { at, options } from './request';

const Memberships = Type.Array(Membership);

export interface WorkspacesApi {
  readonly workspaces: (signal?: AbortSignal) => Promise<Membership[]>;
  readonly createWorkspace: (input: CreateWorkspaceRequest) => Promise<Workspace>;
  /** A new name, an owner's or an admin's; the slug stays (D-124). */
  readonly renameWorkspace: (workspaceId: string, name: string) => Promise<Workspace>;
  readonly members: (workspaceId: string, signal?: AbortSignal) => Promise<WorkspaceMemberList>;
  /** An owner's or an admin's (`ARCHITECTURE.md` §7.4): a member's new role. */
  readonly updateMemberRole: (
    workspaceId: string,
    userId: string,
    role: UserRole,
  ) => Promise<WorkspaceMember>;
  /** Out of the workspace and its channels (D-111). */
  readonly removeMember: (workspaceId: string, userId: string) => Promise<void>;
  /** The caller leaves the workspace and its channels (D-152). */
  readonly leaveWorkspace: (workspaceId: string) => Promise<void>;
  /** An owner's or an admin's: the administrative trail, newest first, narrowed (D-26, D-222). */
  readonly audit: (
    workspaceId: string,
    filter: AuditFilter,
    before?: string,
    signal?: AbortSignal,
  ) => Promise<AuditPage>;
  /** A workspace's members online now, for a member (D-136). */
  readonly presence: (workspaceId: string, signal?: AbortSignal) => Promise<PresenceSnapshot>;
  /** The caller's own Deep Work in a workspace (D-108). */
  readonly setDeepWork: (
    workspaceId: string,
    input: SetDeepWorkRequest,
  ) => Promise<DeepWorkResponse>;
  /** Chooses to appear away, or to appear active again (D-257). */
  readonly setAway: (away: boolean) => Promise<SetAwayResponse>;
}

export const createWorkspacesApi = (http: Http): WorkspacesApi => ({
  workspaces: (signal) => http.request('GET', '/api/workspaces', Memberships, options({}, signal)),
  createWorkspace: (input) =>
    http.request('POST', '/api/workspaces', Workspace, options({ body: input })),
  renameWorkspace: (workspaceId, name) =>
    http.request(
      'PATCH',
      `/api/workspaces/${at(workspaceId)}`,
      Workspace,
      options({ body: { name } }),
    ),
  members: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/members`,
      WorkspaceMemberList,
      options({}, signal),
    ),
  updateMemberRole: (workspaceId, userId, role) =>
    http.request(
      'PATCH',
      `/api/workspaces/${at(workspaceId)}/members/${at(userId)}`,
      WorkspaceMember,
      options({ body: { role } }),
    ),
  removeMember: (workspaceId, userId) =>
    http.send('DELETE', `/api/workspaces/${at(workspaceId)}/members/${at(userId)}`, options()),
  leaveWorkspace: (workspaceId) =>
    http.send('DELETE', `/api/workspaces/${at(workspaceId)}/membership`, options()),
  audit: (workspaceId, filter, before, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/audit`,
      AuditPage,
      options({ query: { ...filter, ...(before === undefined ? {} : { before }) } }, signal),
    ),
  presence: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/presence`,
      PresenceSnapshot,
      options({}, signal),
    ),
  setDeepWork: (workspaceId, input) =>
    http.request(
      'PUT',
      `/api/workspaces/${at(workspaceId)}/deep-work`,
      DeepWorkResponse,
      options({ body: input }),
    ),
  setAway: (away) =>
    http.request('PUT', '/api/me/away', SetAwayResponse, options({ body: { away } })),
});
