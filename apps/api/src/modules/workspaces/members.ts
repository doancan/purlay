/**
 * Managing a workspace's members (`ARCHITECTURE.md` §7.4, invariant I-2, D-22).
 *
 * - **Who may.** An owner, anything; an admin, members and admins — making somebody an owner is
 *   transferring ownership, and an owner's row is an owner's to change; a member, nobody. A refusal
 *   for what the caller is is `403` (`API.md`), after the caller's own membership has made the
 *   workspace exist for them.
 * - **The last owner stays.** Every change takes the workspace row's lock first, then reads the
 *   roles — the caller's too, as they are now and not as they were when the request began — so two
 *   owners stepping down at once cannot leave none: the one that waited finds it is no longer an
 *   owner, or that it is the last.
 * - **A removed member loses the workspace's channels**: their memberships go, and the channels
 *   they could see are answered, for the caller to tell their sockets after the commit (D-85).
 * - **Anybody may leave** (D-152): the same going as being removed, chosen by the person — except the
 *   last owner, who hands the workspace on first (I-2).
 */
import { sql, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { Uuid, type UserRole, type WorkspaceMember } from '@purlay/types';
import { visibleChannelIds } from '../../platform/channels';
import type { Clock } from '../../platform/clock';
import { recordAudit } from '../audit/audit';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { asProfile, PROFILE_COLUMNS } from '../users/profile';

/** Whether a caller of this role may move a member from one role to another, or remove them (`to` absent). */
const mayManage = (caller: UserRole, from: UserRole, to?: UserRole): boolean =>
  caller === 'owner' || (caller === 'admin' && from !== 'owner' && to !== 'owner');

const forbidden = (): AppError =>
  new AppError({ code: 'FORBIDDEN', message: 'Only an owner or an admin manages members.' });

const notFound = (): AppError =>
  new AppError({ code: 'USER_NOT_FOUND', message: 'That person is not in this workspace.' });

/** Takes the workspace row's lock, which every change to its members waits on. */
const lockWorkspace = async (executor: Executor, context: WorkspaceContext): Promise<void> => {
  await executor
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', context.workspaceId)
    .forUpdate()
    .execute();
};

/** The caller's and the target's roles as they are under the workspace's lock. */
const rolesUnderLock = async (
  executor: Executor,
  context: WorkspaceContext,
  userId: string,
): Promise<{ caller: UserRole; target: UserRole }> => {
  await lockWorkspace(executor, context);
  const rows = await executor
    .selectFrom('workspace_members')
    .select(['user_id', 'role'])
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', 'in', [context.userId, userId])
    .execute();
  const caller = rows.find((row) => row.user_id === context.userId)?.role;
  if (caller === undefined || caller === 'member') throw forbidden();
  const target = rows.find((row) => row.user_id === userId)?.role;
  if (target === undefined) throw notFound();
  return { caller, target };
};

/**
 * Refuses a change that would leave the workspace without a live owner (I-2): an erased owner's row
 * stays, and counts for nothing (D-139 §6).
 */
const keepAnOwner = async (executor: Executor, context: WorkspaceContext): Promise<void> => {
  const { owners } = await executor
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select(sql<string>`count(*)`.as('owners'))
    .where('workspace_members.workspace_id', '=', context.workspaceId)
    .where('workspace_members.role', '=', 'owner')
    .where('users.deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  if (Number(owners) <= 1) {
    throw new AppError({
      code: 'LAST_OWNER',
      message: 'A workspace keeps at least one owner: make somebody else an owner first.',
    });
  }
};

/** Inside the caller's transaction. Answers the member as the members list shows them. */
export const changeRole = async (
  executor: Executor,
  clock: Clock,
  context: WorkspaceContext,
  userId: string,
  role: UserRole,
): Promise<WorkspaceMember> => {
  if (context.role === 'member') throw forbidden();
  if (!Value.Check(Uuid, userId)) throw notFound();
  const { caller, target } = await rolesUnderLock(executor, context, userId);
  if (!mayManage(caller, target, role)) throw forbidden();
  if (target === 'owner' && role !== 'owner') await keepAnOwner(executor, context);
  // The same role again changes nothing, and records nothing.
  if (target !== role) {
    await recordAudit(executor, clock, {
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'member.role_changed',
      targetType: 'user',
      targetId: userId,
      metadata: { from: target, to: role },
    });
  }
  const row = await executor
    .updateTable('workspace_members')
    .set({ role })
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', userId)
    .returning(['role', 'joined_at'])
    .executeTakeFirstOrThrow();
  const user = await executor
    .selectFrom('users')
    .select(['id', 'username', 'display_name', 'avatar_url', ...PROFILE_COLUMNS])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
    },
    role: row.role,
    joinedAt: new Date(row.joined_at).toISOString(),
    profile: asProfile(user),
  };
};

/**
 * Takes a person out of the workspace and every channel in it, and answers the channels they could
 * see — read by the one visibility rule before it stops being theirs.
 */
const takeOut = async (
  executor: Executor,
  workspaceId: string,
  userId: string,
): Promise<readonly string[]> => {
  const theirs = await requireWorkspaceMembership(executor, userId, workspaceId);
  const channelIds = await visibleChannelIds(executor, theirs);
  await executor
    .deleteFrom('channel_members')
    .where('user_id', '=', userId)
    .where('channel_id', 'in', (eb) =>
      eb.selectFrom('channels').select('id').where('workspace_id', '=', workspaceId),
    )
    .execute();
  await executor
    .deleteFrom('workspace_members')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .execute();
  return channelIds;
};

/** Inside the caller's transaction. Answers the channels the removed member could see. */
export const removeMember = async (
  executor: Executor,
  clock: Clock,
  context: WorkspaceContext,
  userId: string,
): Promise<{ readonly channelIds: readonly string[] }> => {
  if (context.role === 'member') throw forbidden();
  if (!Value.Check(Uuid, userId)) throw notFound();
  const { caller, target } = await rolesUnderLock(executor, context, userId);
  if (!mayManage(caller, target)) throw forbidden();
  if (target === 'owner') await keepAnOwner(executor, context);
  const channelIds = await takeOut(executor, context.workspaceId, userId);
  await recordAudit(executor, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'member.removed',
    targetType: 'user',
    targetId: userId,
    metadata: { role: target },
  });
  return { channelIds };
};

/**
 * Inside the caller's transaction: the caller leaves (D-152). Their role is read under the
 * workspace's lock, as every change here reads it, so two owners leaving at once cannot leave none.
 * Answers the channels they could see, for their own sockets to be told after the commit.
 */
export const leaveWorkspace = async (
  executor: Executor,
  clock: Clock,
  context: WorkspaceContext,
): Promise<{ readonly channelIds: readonly string[] }> => {
  await lockWorkspace(executor, context);
  const row = await executor
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .executeTakeFirstOrThrow();
  if (row.role === 'owner') await keepAnOwner(executor, context);
  const channelIds = await takeOut(executor, context.workspaceId, context.userId);
  await recordAudit(executor, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'member.left',
    targetType: 'user',
    targetId: context.userId,
    metadata: { role: row.role },
  });
  return { channelIds };
};
