/**
 * A channel's own settings, and leaving it (D-123): rename it or set what it is for, archive it,
 * leave it, see who is in it.
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
import type { Channel, ChannelMember, UpdateChannelRequest } from '@purlay/types';
import { recordAudit } from '../audit/audit';
import type { Clock } from '../../platform/clock';
import { channelNotFound, type ChannelContext } from '../../platform/channels';
import { AppError } from '../../platform/errors';
import { channelFor } from './channels';

/** The roles that archive a channel (`ARCHITECTURE.md` §7.4, D-123). */
const ARCHIVERS: readonly string[] = ['owner', 'admin'];

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

const isMember = async (executor: Executor, context: ChannelContext): Promise<boolean> =>
  (await executor
    .selectFrom('channel_members')
    .select('user_id')
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .executeTakeFirst()) !== undefined;

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
  if (!(await isMember(executor, context))) {
    throw new AppError({ code: 'FORBIDDEN', message: 'Join the channel to change it.' });
  }
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
  const role = await executor
    .selectFrom('workspace_members')
    .select('role')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .executeTakeFirst();
  if (role === undefined || !ARCHIVERS.includes(role.role)) {
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
  await lockNamed(executor, context);
  if (context.channelType === 'private') {
    const members = await executor
      .selectFrom('channel_members')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('channel_id', '=', context.channelId)
      .executeTakeFirstOrThrow();
    if (Number(members.count) <= 1 && (await isMember(executor, context))) {
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
