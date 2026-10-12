/**
 * Channels: create a public one, join it, list what you can see.
 *
 * Every function takes a context rather than an id — a `WorkspaceContext` for
 * what belongs to the workspace, a `ChannelContext` for what belongs to one
 * channel. A caller cannot hold either without having been checked, so an
 * unscoped query does not compile (D-21, D-34).
 *
 * **Only public channels are created here.** Private channels have no endpoint yet, and
 * a direct message is opened by `direct-messages.ts`; the *visibility rule* that
 * governs all three is already written and enforced by the guard.
 *
 * Every channel is shown as one person sees it: their read position and counters
 * (null when they can see it and have not joined) and, for a direct message, the
 * other person (D-98, D-99).
 */
import { sql, type Executor, type Transaction } from '@purlay/db';
import type { Channel } from '@purlay/types';
import { AppError } from '../../platform/errors';
import type { Clock } from '../../platform/clock';
import type { ChannelContext } from '../../platform/channels';
import { visibleChannelIds } from '../../platform/channels';
import type { WorkspaceContext } from '../../platform/tenancy';

interface ChannelRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string | null;
  readonly topic: string | null;
  readonly type: Channel['type'];
  readonly last_message_at: Date | string | null;
  /** Null when the caller is not a member: they can see the channel, not read it. */
  readonly member_user_id: string | null;
  readonly last_read_message_id: string | null;
  readonly unread_count: number | null;
  readonly unread_mention_count: number | null;
  readonly peer_id: string | null;
  readonly peer_username: string | null;
  readonly peer_display_name: string | null;
  readonly peer_avatar_url: string | null;
  readonly peer_deleted_at: Date | string | null;
}

const asChannel = (row: ChannelRow): Channel => ({
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  topic: row.topic,
  type: row.type,
  lastMessageAt: row.last_message_at === null ? null : new Date(row.last_message_at).toISOString(),
  state:
    row.member_user_id === null
      ? null
      : {
          lastReadMessageId: row.last_read_message_id,
          unreadCount: row.unread_count ?? 0,
          unreadMentionCount: row.unread_mention_count ?? 0,
        },
  peer:
    row.peer_id === null
      ? null
      : row.peer_deleted_at !== null
        ? // Erased (I-11): the conversation stays and so does the id a client keys on, and
          // nothing the account held is handed out.
          { id: row.peer_id, username: 'deleted', displayName: 'Deleted user', avatarUrl: null }
        : {
            id: row.peer_id,
            username: row.peer_username ?? '',
            displayName: row.peer_display_name ?? '',
            avatarUrl: row.peer_avatar_url,
          },
});

/**
 * The channels a person is shown, with everything that is true *for them*.
 *
 * One query however many channels there are: the membership (their read position
 * and counters) and, for a direct message, the other person are joins, not a lookup
 * per row — the sidebar renders on every load, and a query per channel is the N+1 the
 * project rules forbid (D-13). The other person is found from `dm_key`, the sorted
 * pair, rather than from `channel_members`: it is already on the row, and for a note
 * to self the pair is the same id twice, so the caller is their own peer (D-6, I-5).
 */
const readChannels = async (
  executor: Executor,
  userId: string,
  only: { readonly ids?: readonly string[]; readonly id?: string },
): Promise<readonly ChannelRow[]> => {
  let query = executor
    .selectFrom('channels')
    .leftJoin('channel_members', (join) =>
      join
        .onRef('channel_members.channel_id', '=', 'channels.id')
        .on('channel_members.user_id', '=', userId),
    )
    .leftJoin('users', (join) =>
      join.on(
        sql<boolean>`channels.type = 'direct_message' and users.id = (case
          when split_part(channels.dm_key, ':', 1) = ${userId} then split_part(channels.dm_key, ':', 2)
          else split_part(channels.dm_key, ':', 1) end)::uuid`,
      ),
    )
    .select([
      'channels.id as id',
      'channels.workspace_id as workspace_id',
      'channels.name as name',
      'channels.topic as topic',
      'channels.type as type',
      'channels.last_message_at as last_message_at',
      'channel_members.user_id as member_user_id',
      'channel_members.last_read_message_id as last_read_message_id',
      'channel_members.unread_count as unread_count',
      'channel_members.unread_mention_count as unread_mention_count',
      'users.id as peer_id',
      'users.username as peer_username',
      'users.display_name as peer_display_name',
      'users.avatar_url as peer_avatar_url',
      'users.deleted_at as peer_deleted_at',
    ]);
  if (only.ids !== undefined) query = query.where('channels.id', 'in', only.ids);
  if (only.id !== undefined) query = query.where('channels.id', '=', only.id);
  return await query
    // `NULLS LAST` because PostgreSQL sorts nulls *first* under `DESC`: without
    // it a channel nobody has written in yet ranks above every active one, which
    // is the opposite of what `UX.md` §4 asks the sidebar to show.
    .orderBy('channels.last_message_at', (order) => order.desc().nullsLast())
    .orderBy('channels.name', 'asc')
    .execute();
};

/** One channel as one person sees it — what a create, a join and a direct message answer with. */
export const channelFor = async (
  executor: Executor,
  userId: string,
  channelId: string,
): Promise<Channel> => {
  const [row] = await readChannels(executor, userId, { id: channelId });
  if (row === undefined)
    throw new AppError({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found.' });
  return asChannel(row);
};

export interface NewChannel {
  readonly name: string;
  readonly topic?: string | undefined;
  /** Public unless asked: a private channel is seen by its members only (D-104). */
  readonly type?: 'public' | 'private' | undefined;
}

/**
 * Creates a channel — public, or private when asked — and puts its creator in it.
 *
 * The name is checked before the insert so a duplicate is a `409` a person can
 * act on rather than a unique-violation surfacing as a `500`. The index is still
 * the authority — this check races, and losing the race is what the constraint is
 * for.
 */
export const createChannel = async (
  executor: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  input: NewChannel,
): Promise<Channel> => {
  const taken = await executor
    .selectFrom('channels')
    .select('id')
    .where('workspace_id', '=', context.workspaceId)
    .where((eb) => eb(eb.fn('lower', ['name']), '=', input.name.toLowerCase()))
    .where('type', '!=', 'direct_message')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (taken !== undefined) {
    throw new AppError({
      code: 'CHANNEL_NAME_TAKEN',
      message: 'A channel with that name already exists here.',
    });
  }

  const row = await executor
    .insertInto('channels')
    .values({
      workspace_id: context.workspaceId,
      name: input.name,
      ...(input.topic === undefined ? {} : { topic: input.topic }),
      type: input.type ?? 'public',
      created_by: context.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await executor
    .insertInto('channel_members')
    .values({ channel_id: row.id, user_id: context.userId, joined_at: clock.now() })
    .execute();

  return await channelFor(executor, context.userId, row.id);
};

/**
 * The channels this user can see, newest activity first.
 *
 * Narrowed by `id = ANY(…)` from the visibility guard rather than filtered after
 * the fact, which is the shape D-34 requires of every workspace-wide read.
 */
export const channelsVisibleIn = async (
  executor: Executor,
  context: WorkspaceContext,
): Promise<readonly Channel[]> => {
  const visible = await visibleChannelIds(executor, context);
  if (visible.length === 0) return [];

  return (await readChannels(executor, context.userId, { ids: visible })).map(asChannel);
};

/** The channel the context was minted for. There is no other one it could return. */
export const channelIn = async (executor: Executor, context: ChannelContext): Promise<Channel> =>
  await channelFor(executor, context.userId, context.channelId);

/**
 * Joins a channel you can already see.
 *
 * Public only in this phase, and joining twice is not an error: the outcome asked
 * for is already true, and a `409` here would make a retry after a dropped
 * response look like a failure.
 */
export const joinChannel = async (
  executor: Executor,
  clock: Clock,
  context: ChannelContext,
): Promise<void> => {
  if (context.channelType !== 'public') {
    // Reachable: a member of a private channel or a DM is *in* it, so the guard
    // hands them a context. The endpoint is *public only*, so it refuses them with
    // the answer a stranger gets (`channel-visibility.integration.test.ts`).
    throw new AppError({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found.' });
  }
  await executor
    .insertInto('channel_members')
    .values({ channel_id: context.channelId, user_id: context.userId, joined_at: clock.now() })
    .onConflict((conflict) => conflict.columns(['channel_id', 'user_id']).doNothing())
    .execute();
};
