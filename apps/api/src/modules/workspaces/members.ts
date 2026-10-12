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
 */
import { sql, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { Uuid, type UserRole, type WorkspaceMember } from '@purlay/types';
import { visibleChannelIds } from '../../platform/channels';
import type { Clock } from '../../platform/clock';
import { recordAudit } from '../audit/audit';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';

/** Whether a caller of this role may move a member from one role to another, or remove them (`to` absent). */
const mayManage = (caller: UserRole, from: UserRole, to?: UserRole): boolean =>
  caller === 'owner' || (caller === 'admin' && from !== 'owner' && to !== 'owner');

const forbidden = (): AppError =>
  new AppError({ code: 'FORBIDDEN', message: 'Only an owner or an admin manages members.' });

const notFound = (): AppError =>
  new AppError({ code: 'USER_NOT_FOUND', message: 'That person is not in this workspace.' });

/** The caller's and the target's roles as they are under the workspace's lock. */
const rolesUnderLock = async (
  executor: Executor,
  context: WorkspaceContext,
  userId: string,
): Promise<{ caller: UserRole; target: UserRole }> => {
  await executor
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', context.workspaceId)
    .forUpdate()
    .execute();
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

/** Refuses a change that would leave the workspace without an owner (I-2). */
const keepAnOwner = async (executor: Executor, context: WorkspaceContext): Promise<void> => {
  const { owners } = await executor
    .selectFrom('workspace_members')
    .select(sql<string>`count(*)`.as('owners'))
    .where('workspace_id', '=', context.workspaceId)
    .where('role', '=', 'owner')
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
    .select(['id', 'username', 'display_name', 'avatar_url'])
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
  };
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
  // What they could see, by the one rule, before it stops being theirs.
  const theirs = await requireWorkspaceMembership(executor, userId, context.workspaceId);
  const channelIds = await visibleChannelIds(executor, theirs);
  await executor
    .deleteFrom('channel_members')
    .where('user_id', '=', userId)
    .where('channel_id', 'in', (eb) =>
      eb.selectFrom('channels').select('id').where('workspace_id', '=', context.workspaceId),
    )
    .execute();
  await executor
    .deleteFrom('workspace_members')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', userId)
    .execute();
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
