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
import { erasedPerson } from '@purlay/types';
import { recordAudit } from '../audit/audit';
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
  readonly notification_level: Channel['notificationLevel'];
  readonly starred_at: Date | string | null;
  /** Its open incident's, when one is open (D-137): the partial unique index finds it. */
  readonly incident_severity: number | null;
  readonly incident_status: string | null;
  readonly peer_id: string | null;
  readonly peer_username: string | null;
  readonly peer_display_name: string | null;
  readonly peer_avatar_url: string | null;
  readonly peer_deleted_at: Date | string | null;
  /** Everybody in a direct message's key, in its order; empty for a channel. */
  readonly key_people: readonly KeyPerson[];
  /** Its live members (D-167); null when nobody is in it, which the grouped join cannot say. */
  readonly member_count: string | number | null;
}

interface KeyPerson {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly erased: boolean;
}

/** Erased (I-11): the conversation stays and so does the id a client keys on, and nothing else. */
const shown = (person: KeyPerson): Channel['peers'][number] =>
  person.erased
    ? erasedPerson(person.id)
    : {
        id: person.id,
        username: person.username,
        displayName: person.displayName,
        avatarUrl: person.avatarUrl,
      };

/** The people besides the caller; the caller alone for a note to self (D-127). */
const peersOf = (row: ChannelRow, userId: string): Channel['peers'] => {
  const others = row.key_people.filter((person) => person.id !== userId);
  const people = others.length > 0 ? others : row.key_people.slice(0, 1);
  return people.map(shown);
};

/** The open incident's mark, read as the contract says it can be, or loudly not. */
const incidentOf = (row: ChannelRow): Channel['incident'] => {
  if (row.incident_severity === null) return null;
  const severity = row.incident_severity;
  const status = row.incident_status;
  if (
    (severity !== 1 && severity !== 2 && severity !== 3 && severity !== 4) ||
    (status !== 'investigating' && status !== 'mitigating')
  ) {
    // The table's CHECKs and the open index say this cannot be: a row that does is a defect.
    throw new Error(`incident of ${row.id} is ${String(severity)}/${String(status)}`);
  }
  return { severity, status };
};

const asChannel = (row: ChannelRow, userId: string): Channel => ({
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
  notificationLevel: row.member_user_id === null ? null : row.notification_level,
  starred: row.member_user_id !== null && row.starred_at !== null,
  peer:
    row.peer_id === null
      ? null
      : row.peer_deleted_at !== null
        ? // Erased (I-11): the conversation stays and so does the id a client keys on, and
          // nothing the account held is handed out.
          erasedPerson(row.peer_id)
        : {
            id: row.peer_id,
            username: row.peer_username ?? '',
            displayName: row.peer_display_name ?? '',
            avatarUrl: row.peer_avatar_url,
          },
  peers: peersOf(row, userId),
  memberCount: Number(row.member_count ?? 0),
  incident: incidentOf(row),
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
  // How many live people each listed channel holds (D-167): one aggregate over the same channels,
  // grouped once and joined, so a hundred channels are one scan of their memberships, not a count
  // each. Narrowed by the same ids as the outer query, never counted across the whole table.
  let counted = executor
    .selectFrom('channel_members as counted')
    .innerJoin('users as counted_user', 'counted_user.id', 'counted.user_id')
    .where('counted_user.deleted_at', 'is', null)
    .select(['counted.channel_id', sql<string>`count(*)`.as('member_count')])
    .groupBy('counted.channel_id');
  if (only.ids !== undefined) counted = counted.where('counted.channel_id', 'in', only.ids);
  if (only.id !== undefined) counted = counted.where('counted.channel_id', '=', only.id);
  let query = executor
    .selectFrom('channels')
    .leftJoin(counted.as('member_counts'), 'member_counts.channel_id', 'channels.id')
    .leftJoin('channel_members', (join) =>
      join
        .onRef('channel_members.channel_id', '=', 'channels.id')
        .on('channel_members.user_id', '=', userId),
    )
    // At most one open incident a channel (`idx_incidents_one_open`): a join, never a row more.
    .leftJoin('incidents', (join) =>
      join
        .onRef('incidents.channel_id', '=', 'channels.id')
        .on('incidents.resolved_at', 'is', null),
    )
    .leftJoin('users', (join) =>
      join.on(
        // A conversation of two only: a group has no one other person (D-127).
        sql<boolean>`channels.type = 'direct_message'
          and cardinality(string_to_array(channels.dm_key, ':')) = 2
          and users.id = (case
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
      'channel_members.notification_level as notification_level',
      'channel_members.starred_at as starred_at',
      'incidents.severity as incident_severity',
      'incidents.status as incident_status',
      'users.id as peer_id',
      'users.username as peer_username',
      'users.display_name as peer_display_name',
      'users.avatar_url as peer_avatar_url',
      'users.deleted_at as peer_deleted_at',
      'member_counts.member_count as member_count',
      // Its key's people in its order, in this one query: the key is its identity (D-127), and a
      // group of ten is ten primary-key reads, not a query per channel.
      sql<readonly KeyPerson[]>`coalesce((
        select json_agg(json_build_object(
          'id', person.id, 'username', person.username, 'displayName', person.display_name,
          'avatarUrl', person.avatar_url, 'erased', person.deleted_at is not null
        ) order by key_part.place)
        from unnest(string_to_array(channels.dm_key, ':')) with ordinality as key_part(id, place)
        join users as person on person.id = key_part.id::uuid
      ), '[]'::json)`.as('key_people'),
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
  return asChannel(row, userId);
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

  await recordAudit(executor, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'channel.created',
    targetType: 'channel',
    targetId: row.id,
    metadata: { type: input.type ?? 'public' },
  });

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

  return (await readChannels(executor, context.userId, { ids: visible })).map((row) =>
    asChannel(row, context.userId),
  );
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
/** Joins a public channel; answers whether this call is what joined it — a second is a no-op. */
export const joinChannel = async (
  executor: Executor,
  clock: Clock,
  context: ChannelContext,
): Promise<boolean> => {
  if (context.channelType !== 'public') {
    // Reachable: a member of a private channel or a DM is *in* it, so the guard
    // hands them a context. The endpoint is *public only*, so it refuses them with
    // the answer a stranger gets (`channel-visibility.integration.test.ts`).
    throw new AppError({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found.' });
  }
  const joined = await executor
    .insertInto('channel_members')
    .values({ channel_id: context.channelId, user_id: context.userId, joined_at: clock.now() })
    .onConflict((conflict) => conflict.columns(['channel_id', 'user_id']).doNothing())
    .returning('channel_id')
    .executeTakeFirst();
  return joined !== undefined;
};
