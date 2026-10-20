/**
 * A channel's own settings, and leaving it (D-123): rename it or set what it is for, archive it,
 * leave it, take somebody else out of it (D-172), see who is in it.
 *
 * Each takes the `ChannelContext` the guard minted, so a channel the caller cannot see is the
 * stranger's `404` before anything here runs (D-34). **A direct message has none of these**: it has
 * no name, it is the two people it was opened for (I-5), and it is answered as join answers it —
 * not found, the same as a stranger is told.
 *
 * Each write takes the channel row's lock first, so two renames, a rename and an archive, or the
 * last two members of a private channel leaving at once, take turns rather than both deciding on
 * what the other is about to change.
 */
import type { Executor, Transaction } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import {
  Uuid,
  type Channel,
  type ChannelMember,
  type UpdateChannelRequest,
  type UserRole,
} from '@purlay/types';
import { recordAudit } from '../audit/audit';
import type { Clock } from '../../platform/clock';
import {
  channelNotFound,
  isChannelMember,
  requireChannelMember,
  type ChannelContext,
} from '../../platform/channels';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { channelFor } from './channels';

/** The channel row, locked for the change about to be made; a direct message is not one to change. */
const lockNamed = async (
  executor: Transaction,
  context: ChannelContext,
): Promise<{ readonly name: string; readonly topic: string | null }> => {
  if (context.channelType === 'direct_message') throw channelNotFound();
  const row = await executor
    .selectFrom('channels')
    .select(['name', 'topic'])
    .where('id', '=', context.channelId)
    .where('deleted_at', 'is', null)
    // NO KEY UPDATE: what the UPDATE takes anyway, and a message pointing here is not made to wait.
    .forNoKeyUpdate()
    .executeTakeFirst();
  // Archived between the guard's read and this lock: gone, as the guard would now say.
  if (row?.name == null) throw channelNotFound();
  return { name: row.name, topic: row.topic };
};

/** What a rename tells the room; null when nothing changed and nobody is told. */
interface ChannelUpdate {
  readonly channelId: string;
  readonly name: string;
  readonly topic: string | null;
  readonly version: number;
}

export interface Updated {
  readonly channel: Channel;
  readonly update: ChannelUpdate | null;
}

/**
 * Renames the channel, or sets what it is for, or both. A member of the channel may: seeing a
 * public channel is not being in it (`403`), as for bringing people in (D-104).
 *
 * The name is checked against the workspace's live channels before the write, so a taken one is a
 * `409` a person can act on; the unique index is still the authority, and losing the race to it is
 * the same answer (D-78). Asking for what is already there changes nothing and tells nobody.
 */
export const updateChannel = async (
  executor: Transaction,
  clock: Clock,
  context: ChannelContext,
  input: UpdateChannelRequest,
): Promise<Updated> => {
  const current = await lockNamed(executor, context);
  await requireChannelMember(executor, context, 'Join the channel to change it.');
  const name = input.name ?? current.name;
  const topic = input.topic === undefined ? current.topic : input.topic;
  if (name === current.name && topic === current.topic) {
    return { channel: await channelFor(executor, context.userId, context.channelId), update: null };
  }

  if (name.toLowerCase() !== current.name.toLowerCase()) {
    const taken = await executor
      .selectFrom('channels')
      .select('id')
      .where('workspace_id', '=', context.workspaceId)
      .where((eb) => eb(eb.fn('lower', ['name']), '=', name.toLowerCase()))
      .where('type', '!=', 'direct_message')
      .where('deleted_at', 'is', null)
      .where('id', '!=', context.channelId)
      .executeTakeFirst();
    if (taken !== undefined) {
      throw new AppError({
        code: 'CHANNEL_NAME_TAKEN',
        message: 'A channel with that name already exists here.',
      });
    }
  }

  const written = await executor
    .updateTable('channels')
    .set((eb) => ({
      name,
      topic,
      updated_at: clock.now(),
      state_version: eb('state_version', '+', 1),
    }))
    .where('id', '=', context.channelId)
    .returning('state_version')
    .executeTakeFirstOrThrow();

  if (name !== current.name) {
    // A name is what everybody finds the channel by: a workspace-visible act (D-26, D-123). A
    // topic is a line somebody wrote, and is not copied into the trail.
    await recordAudit(executor, clock, {
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'channel.renamed',
      targetType: 'channel',
      targetId: context.channelId,
      metadata: { from: current.name, to: name },
    });
  }

  return {
    channel: await channelFor(executor, context.userId, context.channelId),
    update: { channelId: context.channelId, name, topic, version: written.state_version },
  };
};

/**
 * Archives the channel: an owner's or an admin's (`ARCHITECTURE.md` §7.4). Soft deletion that does
 * not cascade (D-9): the row, its messages and its memberships stay, it stops being visible to
 * anybody, and its name is free again (`idx_channels_unique_name` holds only live channels).
 * Archived already is the guard's `404`, as for anything gone.
 */
export const archiveChannel = async (
  executor: Transaction,
  clock: Clock,
  context: ChannelContext,
): Promise<void> => {
  const current = await lockNamed(executor, context);
  // The role is read again inside the transaction, through the guard, so a demotion that committed
  // first is the answer here; and it is this workspace's role, never another membership's.
  const { role } = await requireWorkspaceMembership(executor, context.userId, context.workspaceId);
  if (role === 'member') {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only an owner or an admin archives a channel.',
    });
  }
  const now = clock.now();
  await executor
    .updateTable('channels')
    .set({ deleted_at: now, updated_at: now })
    .where('id', '=', context.channelId)
    .execute();
  await recordAudit(executor, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'channel.archived',
    targetType: 'channel',
    targetId: context.channelId,
    // Named, because the channel is no longer listed for the trail to find it by.
    metadata: { name: current.name },
  });
};

/**
 * Leaves the channel. Not being in it is the same answer — the outcome asked for is already true —
 * and returns false, so nobody is told.
 *
 * **The last member of a private channel is refused** (`409 LAST_CHANNEL_MEMBER`): only a member
 * brings people into one (D-104), so with nobody left it could never be reached again. They bring
 * somebody in first, or an admin archives it (D-123). A public channel is anybody's to join, and
 * may be left empty.
 */
export const leaveChannel = async (
  executor: Transaction,
  context: ChannelContext,
): Promise<boolean> => {
  // The membership before the channel row (#669): a send holds the memberships it counts and then
  // takes the channel row, so a leave that took them the other way round deadlocked beside it.
  await executor
    .selectFrom('channel_members')
    .select('user_id')
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .forUpdate()
    .execute();
  await lockNamed(executor, context);
  if (context.channelType === 'private') {
    const members = await executor
      .selectFrom('channel_members')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('channel_id', '=', context.channelId)
      .executeTakeFirstOrThrow();
    if (Number(members.count) <= 1 && (await isChannelMember(executor, context))) {
      throw new AppError({
        code: 'LAST_CHANNEL_MEMBER',
        message: 'Nobody else is in this private channel. Bring somebody in first.',
      });
    }
  }
  const left = await executor
    .deleteFrom('channel_members')
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .returning('user_id')
    .executeTakeFirst();
  return left !== undefined;
};

/** What a removal did, for the caller to tell the person's sockets after the commit; null: nothing. */
export type Removal = 'left' | 'removed' | null;

/**
 * Takes somebody else out of the channel (D-172). Their messages stay (D-9); their sockets are told
 * by the caller after the commit (D-85).
 *
 * - **Who may.** An owner or an admin, from any channel they can see — and, as for the workspace
 *   (D-111), an owner is an owner's to take out. A member of a **private** channel takes out another
 *   member of it whose workspace role is `member`: they brought people in (D-104), and a private
 *   channel is reached no other way. In a public channel a member takes out nobody — anybody can join
 *   it again. Anybody else is `403 FORBIDDEN`, for what the caller is.
 * - **Yourself is leaving**, the same act by another door (`leaveChannel`), with the same last-member
 *   refusal and the same `left` told to your sockets.
 * - **A direct message or a group has none** (D-127): the stranger's `404`, as leaving answers — the
 *   channel row's lock refuses one, as it does for every act here.
 * - **Not in it** is `204` again and tells nobody; somebody not in the workspace `404 USER_NOT_FOUND`.
 * - **The last member of a private channel stays**, as leaving keeps them (`409 LAST_CHANNEL_MEMBER`).
 *
 * The locks are taken in the order every other path takes them: the workspace row (shared, so a role
 * change waits and the roles read here are the ones that hold at the commit; D-111 §2), then the
 * person's membership, then the channel row (#669).
 */
export const removeChannelMember = async (
  executor: Transaction,
  clock: Clock,
  context: ChannelContext,
  userId: string,
): Promise<Removal> => {
  if (userId === context.userId) return (await leaveChannel(executor, context)) ? 'left' : null;
  if (!Value.Check(Uuid, userId)) throw personNotFound();

  await executor
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', context.workspaceId)
    .forShare()
    .execute();
  const { role: caller } = await requireWorkspaceMembership(
    executor,
    context.userId,
    context.workspaceId,
  );
  const target = await executor
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (target === undefined) throw personNotFound();

  const theirs = await executor
    .selectFrom('channel_members')
    .select('user_id')
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  await lockNamed(executor, context);

  if (!(await mayRemove(executor, context, caller, target.role))) {
    throw new AppError({
      code: 'FORBIDDEN',
      message:
        context.channelType === 'private'
          ? 'Only an owner or an admin takes an owner or an admin out of a channel.'
          : 'Only an owner or an admin takes somebody out of a public channel.',
    });
  }
  if (theirs === undefined) return null;
  if (context.channelType === 'private') {
    const members = await executor
      .selectFrom('channel_members')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('channel_id', '=', context.channelId)
      .executeTakeFirstOrThrow();
    if (Number(members.count) <= 1) {
      throw new AppError({
        code: 'LAST_CHANNEL_MEMBER',
        message: 'Nobody else is in this private channel. Bring somebody in first.',
      });
    }
  }

  await executor
    .deleteFrom('channel_members')
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', userId)
    .execute();
  // Somebody's access taken by another hand: a workspace-visible act (D-26). The channel is named by
  // id only, so the trail names it to a reader who can see it and to nobody else (#691).
  await recordAudit(executor, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'channel.member_removed',
    targetType: 'user',
    targetId: userId,
    metadata: { channelId: context.channelId },
  });
  return 'removed';
};

const personNotFound = (): AppError =>
  new AppError({ code: 'USER_NOT_FOUND', message: 'That person is not in this workspace.' });

/** Whether a caller of this role may take a person of that role out of this channel (D-172). */
const mayRemove = async (
  executor: Executor,
  context: ChannelContext,
  caller: UserRole,
  target: UserRole,
): Promise<boolean> => {
  if (caller === 'owner') return true;
  if (caller === 'admin') return target !== 'owner';
  return (
    context.channelType === 'private' &&
    target === 'member' &&
    (await isChannelMember(executor, context))
  );
};

/**
 * Who is in the channel, first to join first, never an erased account. Anybody who can see the
 * channel may ask: a public channel's members are no secret to its workspace, and a private one is
 * seen only by them (D-34). Not paged — at most the workspace's own members, whose list is not.
 */
export const channelMembers = async (
  executor: Executor,
  context: ChannelContext,
): Promise<readonly ChannelMember[]> => {
  const rows = await executor
    .selectFrom('channel_members')
    .innerJoin('users', 'users.id', 'channel_members.user_id')
    .select([
      'users.id',
      'users.username',
      'users.display_name',
      'users.avatar_url',
      'channel_members.joined_at',
    ])
    .where('channel_members.channel_id', '=', context.channelId)
    .where('users.deleted_at', 'is', null)
    .orderBy('channel_members.joined_at', 'asc')
    .orderBy('users.username', 'asc')
    .execute();
  return rows.map((row) => ({
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    },
    joinedAt: new Date(row.joined_at).toISOString(),
  }));
};
