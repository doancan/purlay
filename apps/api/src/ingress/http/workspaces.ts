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
  SetDeepWorkRequest,
  UpdateMemberRoleRequest,
  type DeepWorkResponse,
  type MeResponse,
  type Membership,
  type Workspace,
  type WorkspaceMember,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import {
  createWorkspace,
  meOf,
  membersIn,
  membershipsOf,
  workspaceIn,
} from '../../modules/workspaces/workspaces';
import { setDeepWork } from '../../modules/workspaces/deep-work';
import { changeRole, removeMember } from '../../modules/workspaces/members';
import {
  NO_LOG,
  publication,
  publishAccessRevoked,
  publishAfterCommit,
  type EventBus,
} from '../../platform/events';
import type { Logger } from '../../platform/logging';
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
  return await meOf(database, clock, userId);
};

export const listMyWorkspaces = async (
  dependencies: WorkspaceDependencies,
  request: Request,
): Promise<readonly Membership[]> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  return await membershipsOf(database, clock, userId);
};

export const createMyWorkspace = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  body: unknown,
): Promise<Workspace> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const input = validated(CreateWorkspaceRequest, body);
  return await atomicallyOn(database)(
    async (transaction) => await createWorkspace(transaction, clock, userId, input),
  );
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

/**
 * `PUT /api/workspaces/:workspaceId/deep-work` — the caller's own Deep Work here (D-108): started
 * until an instant, or ended. A workspace they are not in is the stranger's `404`.
 */
export const setMyDeepWork = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<DeepWorkResponse> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const input = validated(SetDeepWorkRequest, body);
  return await setDeepWork(database, clock, context, input);
};

export interface MemberWriteDependencies extends WorkspaceDependencies {
  readonly bus: EventBus;
  readonly log?: Logger;
}

/** `PATCH /api/workspaces/:workspaceId/members/:userId` — a member's new role (§7.4, I-2). */
export const updateMemberRole = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
  userId: string,
  body: unknown,
): Promise<WorkspaceMember> => {
  const { database, clock } = dependencies;
  const caller = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, caller.userId, workspaceId);
  const { role } = validated(UpdateMemberRoleRequest, body);
  return await atomicallyOn(database)(
    async (transaction) => await changeRole(transaction, clock, context, userId, role),
  );
};

/**
 * `DELETE /api/workspaces/:workspaceId/members/:userId` — out of the workspace and its channels;
 * their sockets are told after the commit, and stop receiving every channel they could see (D-85).
 */
export const removeWorkspaceMember = async (
  dependencies: MemberWriteDependencies,
  request: Request,
  workspaceId: string,
  userId: string,
): Promise<void> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const caller = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, caller.userId, workspaceId);
  const { channelIds } = await atomicallyOn(database)(
    async (transaction) => await removeMember(transaction, clock, context, userId),
  );
  await publishAfterCommit(log, [
    [publication('ACCESS_REVOKED', () => publishAccessRevoked(bus, clock, userId, channelIds))],
  ]);
};
