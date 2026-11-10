/** Private membership read scopes in chat's own migration set (D-282). */
import { sql, type RawBuilder } from '@purlay/db';
import type { ChatDb, ChatTx } from '../schema';
import type { ReadScope } from './unread';

interface StoredScope {
  readonly history_floor: Date | null;
  readonly unread_since: Date | null;
  readonly unread_history_from: string | null;
  readonly thread_read_baseline_id: string | null;
}

/** An absent row is a legacy unknown scope, never an invented join floor. */
export const loadReadScope = async (
  executor: ChatDb,
  channelId: string,
  userId: string,
): Promise<StoredScope> =>
  (await executor
    .selectFrom('channel_members')
    .leftJoin('channel_read_scopes', (join) =>
      join
        .onRef('channel_read_scopes.channel_id', '=', 'channel_members.channel_id')
        .onRef('channel_read_scopes.user_id', '=', 'channel_members.user_id'),
    )
    .select(['unread_since', 'unread_history_from', 'thread_read_baseline_id'])
    .select(guestHistoryFloor('channel_members').as('history_floor'))
    .where('channel_members.channel_id', '=', channelId)
    .where('channel_members.user_id', '=', userId)
    .executeTakeFirst()) ?? {
    unread_since: null,
    history_floor: null,
    unread_history_from: null,
    thread_read_baseline_id: null,
  };

/** Called with the membership locked, so scope changes and counter recounts share one order. */
export const saveReadScope = async (
  executor: ChatTx,
  channelId: string,
  userId: string,
  scope: {
    readonly unread_since: Date | string | null;
    readonly unread_history_from: string | null;
    readonly thread_read_baseline_id: string | null;
  },
): Promise<void> => {
  await executor
    .insertInto('channel_read_scopes')
    .values({ channel_id: channelId, user_id: userId, ...scope })
    .onConflict((conflict) => conflict.columns(['channel_id', 'user_id']).doUpdateSet(scope))
    .execute();
};

/** Only newly inserted memberships: opening an existing DM must not reset its read scope. */
export const beginReadScopes = async (
  executor: ChatTx,
  channelId: string,
  userIds: readonly string[],
  joinedAt: Date,
): Promise<void> => {
  if (userIds.length === 0) return;
  await executor
    .insertInto('channel_read_scopes')
    .values(
      userIds.map((userId) => ({
        channel_id: channelId,
        user_id: userId,
        unread_since: joinedAt,
      })),
    )
    .execute();
};

type MemberAlias = 'channel_members' | 'counted';
type ScopeColumn = 'unread_since' | 'unread_history_from' | 'thread_read_baseline_id';

/** This floor is authority, never a value the read/unread controls can write. */
const guestHistoryFloor = (member: MemberAlias): RawBuilder<Date | null> => sql`(
  select greatest(membership.guest_since, ${sql.ref(`${member}.joined_at`)})
  from workspace_members membership inner join channels granted on granted.workspace_id = membership.workspace_id
  where granted.id = ${sql.ref(`${member}.channel_id`)}
    and membership.user_id = ${sql.ref(`${member}.user_id`)} and membership.access_kind = 'guest'
)`;

/** Correlated to one locked membership; NULL when chat has never activated its legacy scope. */
const scopeValue = (member: MemberAlias, column: ScopeColumn): RawBuilder<unknown> => sql`(
  select ${sql.ref(`read_scope.${column}`)} from channel_read_scopes read_scope
  where read_scope.channel_id = ${sql.ref(`${member}.channel_id`)}
    and read_scope.user_id = ${sql.ref(`${member}.user_id`)}
)`;

/** The common SQL projection for arrivals, late mentions, deletion and inbox/thread recounts. */
export const memberReadScope = (member: MemberAlias, legacyJoinFloor = true): ReadScope => {
  const since = scopeValue(member, 'unread_since');
  const position = sql.ref(`${member}.last_read_message_id`);
  return {
    historyFloor: guestHistoryFloor(member),
    userId: sql.ref(`${member}.user_id`),
    position,
    since: legacyJoinFloor ? sql`coalesce(${since}, ${sql.ref(`${member}.joined_at`)})` : since,
    historyFrom: scopeValue(member, 'unread_history_from'),
    threadBaseline: sql`case when ${since} is null then ${position} else ${scopeValue(member, 'thread_read_baseline_id')} end`,
  };
};
