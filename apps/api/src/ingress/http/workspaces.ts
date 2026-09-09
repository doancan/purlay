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
  type MeResponse,
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

/**
 * `GET /api/me` — who the caller is, and what they belong to.
 *
 * The only shape that carries an email address, and only ever to its owner
 * (`models.ts`). The client cannot render anything until it knows this, which is
 * why it is Phase 0 and why nothing else can stand in for it.
 */
export const readMe = async (
  dependencies: WorkspaceDependencies,
  request: Request,
): Promise<MeResponse> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const user = await database
    .selectFrom('users')
    .select(['id', 'username', 'display_name', 'avatar_url', 'email'])
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();

  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      email: user.email,
    },
    memberships: [...(await membershipsOf(database, userId))],
  };
};

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
