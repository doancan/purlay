/** A bounded personal list of the existing D161 relation, with D282 reply receipts. */
import { sql } from '@purlay/db';
import {
  FOLLOWED_THREADS_PAGE,
  type FollowedThreadsPage,
  type FollowedThreadsQuery,
  type FollowedThreadUnread,
} from '@purlay/types';
import type { WorkspaceContext } from '../../../platform/tenancy';
import { limitOf } from '../../../platform/pagination';
import type { ChatDb } from '../schema';
import {
  visibleChannelIdsQuery,
  withinCurrentMessageHistory,
  withinThreadHistory,
} from '../channels/guard';
import { guestMessageHistoryFor } from '../channels/history-access';
import { memberReadScope } from '../channels/read-scope';
import { unreadCondition } from '../channels/unread';
import { notHiddenBy } from './hidden';
import { MESSAGE_COLUMNS } from './reader';
import { buildHistoryMessages } from './history-reader';

const activity = sql<Date>`case when workspace_members.access_kind = 'member'
  then coalesce(messages.thread_last_reply_at, messages.created_at)
  else coalesce((select max(activity_reply.created_at) from messages as activity_reply
    where activity_reply.parent_id = messages.id and activity_reply.channel_id = messages.channel_id
      and ${guestMessageHistoryFor('activity_reply')}), messages.created_at) end`;
const activityText = sql<string>`to_char(${activity} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const followedThreads = async (
  executor: ChatDb,
  context: WorkspaceContext,
  input: FollowedThreadsQuery = {},
): Promise<FollowedThreadsPage> => {
  const limit = limitOf({ limit: input.limit ?? FOLLOWED_THREADS_PAGE });
  const scope = memberReadScope('channel_members', false);
  let statement = executor
    .selectFrom('messages')
    .leftJoin('users', 'users.id', 'messages.sender_id')
    .leftJoin('thread_follows as preference', (join) =>
      join
        .onRef('preference.message_id', '=', 'messages.id')
        .on('preference.user_id', '=', context.userId),
    )
    .leftJoin('channel_members', (join) =>
      join
        .onRef('channel_members.channel_id', '=', 'messages.channel_id')
        .on('channel_members.user_id', '=', context.userId),
    )
    .innerJoin('workspace_members', (join) =>
      join
        .onRef('workspace_members.workspace_id', '=', 'messages.workspace_id')
        .on('workspace_members.user_id', '=', context.userId),
    )
    .select(MESSAGE_COLUMNS)
    .select(withinCurrentMessageHistory(executor, context).as('content_visible'))
    .select(activityText.as('activity_at'))
    .where('messages.channel_id', 'in', visibleChannelIdsQuery(executor, context))
    .where(withinThreadHistory(executor, context))
    .where('messages.parent_id', 'is', null)
    .where(notHiddenBy(context.userId))
    .where(
      sql<boolean>`(
      preference.following = true or (preference.user_id is null and (
        messages.sender_id = ${context.userId} or exists (
          select 1 from messages participated where participated.parent_id = messages.id
            and participated.sender_id = ${context.userId} and participated.deleted_at is null
        )
      ))
    )`,
    )
    .orderBy(activity, 'desc')
    .orderBy('messages.id', 'desc')
    .limit(limit + 1);
  if ('beforeActivityAt' in input)
    statement = statement.where(sql<boolean>`
    (${activity}, messages.id) < (${input.beforeActivityAt}::timestamptz, ${input.beforeRootId}::uuid)
  `);
  if (input.unreadOnly === true)
    statement = statement.where('channel_members.user_id', 'is not', null)
      .where(sql<boolean>`exists (
      select 1 from messages waiting where waiting.parent_id = messages.id
        and waiting.deleted_at is null and waiting.sender_id is distinct from ${context.userId}
        and ${notHiddenBy(context.userId, sql.ref('waiting.id'))}
        and ${unreadCondition(scope, 'waiting')}
    )`);
  const rows = await statement.execute();
  const selected = rows.slice(0, limit);
  if (selected.length === 0) return { data: [], nextCursor: null };

  // One grouped read for the page, not a query/count per root. A nonmember remains unknown.
  const readRows = await executor
    .selectFrom('messages as roots')
    .leftJoin('channel_members', (join) =>
      join
        .onRef('channel_members.channel_id', '=', 'roots.channel_id')
        .on('channel_members.user_id', '=', context.userId),
    )
    .leftJoin('messages as waiting', (join) =>
      join
        .onRef('waiting.parent_id', '=', 'roots.id')
        .on('waiting.deleted_at', 'is', null)
        .on(sql<boolean>`waiting.sender_id is distinct from ${context.userId}`)
        .on(sql<boolean>`channel_members.user_id is not null`)
        .on(notHiddenBy(context.userId, sql.ref('waiting.id')))
        .on(unreadCondition(scope, 'waiting')),
    )
    .select(['roots.id as root_id', 'channel_members.user_id as member_id'])
    .select([
      sql<number>`count(waiting.id)::int`.as('unread_count'),
      sql<string | null>`min(waiting.id::text)::uuid`.as('first_unread_id'),
    ])
    .where(
      'roots.id',
      'in',
      selected.map((row) => row.id),
    )
    .groupBy(['roots.id', 'channel_members.user_id'])
    .execute();
  const unread = new Map<string, FollowedThreadUnread>(
    readRows.map((row) => [
      row.root_id,
      row.member_id === null
        ? null
        : row.first_unread_id === null
          ? { count: 0, firstUnreadMessageId: null }
          : { count: row.unread_count, firstUnreadMessageId: row.first_unread_id },
    ]),
  );
  const messages = await buildHistoryMessages(executor, selected, context.userId);
  const byId = new Map(messages.map((message) => [message.id, message]));
  const last = selected.at(-1);
  return {
    data: selected.flatMap((row) => {
      const root = byId.get(row.id);
      const state = unread.get(row.id) ?? null;
      if (
        root === undefined ||
        root.hiddenForMe === true ||
        (input.unreadOnly === true && (state?.count ?? 0) === 0)
      )
        return [];
      return [{ root, activityAt: row.activity_at, unread: state }];
    }),
    nextCursor:
      rows.length > limit && last !== undefined
        ? { activityAt: last.activity_at, rootId: last.id }
        : null,
  };
};
