/**
 * The workspace endpoints Phase 0 serves (`API.md` §3).
 *
 * Framework-neutral, like the sign-in handlers: a request in, a decision out.
 * The routing lives in `app.ts`.
 *
 * **Every handler that names a workspace goes through the membership guard**,
 * which is the only producer of a `WorkspaceContext` — so a repository call that
 * forgot to scope itself would not compile, and a caller outside the workspace
 * gets `404`, never `403` (D-21).
 */
import type { Executor } from '@purlay/db';
import {
  CreateWorkspaceRequest,
  type Membership,
  type Workspace,
  type WorkspaceMember,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import {
  createWorkspace,
  membersIn,
  membershipsOf,
  workspaceIn,
} from '../../modules/workspaces/workspaces';
import { requireSession } from './session';
import { validated } from './validate';

export interface WorkspaceDependencies {
  readonly database: Executor;
  readonly clock: Clock;
}

export const listMyWorkspaces = async (
  dependencies: WorkspaceDependencies,
  request: Request,
): Promise<readonly Membership[]> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  return await membershipsOf(database, userId);
};

export const createMyWorkspace = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  body: unknown,
): Promise<Workspace> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const input = validated(CreateWorkspaceRequest, body);
  return await createWorkspace(database, clock, userId, input);
};

export const readWorkspace = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
): Promise<Workspace> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await workspaceIn(database, context);
};

export const listWorkspaceMembers = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
): Promise<readonly WorkspaceMember[]> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await membersIn(database, context);
};
