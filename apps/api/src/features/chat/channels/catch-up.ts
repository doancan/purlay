import { loadReadScope } from './read-scope';
/** Oldest unread roots and independently waiting threads, without moving a read position (D-282). */
import { sql } from '@purlay/db';
import { CATCH_UP_PAGE, type CatchUpQuery, type ChannelCatchUp } from '@purlay/types';
import type { ChatDb } from '../schema';
import { channelNotFound, withinMessageHistory, type ChannelContext } from './guard';
import { unreadCondition, type ReadScope } from './unread';
import { notHiddenBy } from '../messages/hidden';
import { buildMessages, MESSAGE_COLUMNS } from '../messages/reader';
import { limitOf } from '../../../platform/pagination';

export const catchUpIn = async (
  executor: ChatDb,
  context: ChannelContext,
  query: CatchUpQuery = {},
): Promise<ChannelCatchUp> => {
  const member = await executor
    .selectFrom('channel_members')
    .select(['last_read_message_id'])
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .executeTakeFirst();
  if (member === undefined) throw channelNotFound();
  const stored = await loadReadScope(executor, context.channelId, context.userId);
  const scope: ReadScope = {
    userId: context.userId,
    position: member.last_read_message_id,
    since: stored.unread_since,
    historyFloor: stored.history_floor,
    historyFrom: stored.unread_history_from,
    threadBaseline:
      stored.unread_since === null ? member.last_read_message_id : stored.thread_read_baseline_id,
  };
  const limit = limitOf({ limit: query.limit ?? CATCH_UP_PAGE });
  const roots = await executor
    .selectFrom('messages')
    .leftJoin('users', 'users.id', 'messages.sender_id')
    .select(MESSAGE_COLUMNS)
    .where('messages.channel_id', '=', context.channelId)
    .where(withinMessageHistory(executor, context))
    .where('messages.parent_id', 'is', null)
    .where('messages.deleted_at', 'is', null)
    .where(notHiddenBy(context.userId))
    .where(sql<boolean>`messages.sender_id is distinct from ${context.userId}`)
    .where(unreadCondition(scope, 'messages'))
    .orderBy('messages.id', 'asc')
    .limit(limit + 1)
    .execute();

  let waiting = executor
    .selectFrom('messages')
    .select([
      sql<string>`messages.parent_id`.as('root_id'),
      sql<string>`min(messages.id::text)::uuid`.as('first_unread_message_id'),
      sql<number>`count(*)::int`.as('unread_count'),
    ])
    .where('messages.channel_id', '=', context.channelId)
    .where('messages.parent_id', 'is not', null)
    .where(withinMessageHistory(executor, context))
    .where('messages.deleted_at', 'is', null)
    .where(notHiddenBy(context.userId))
    .where(sql<boolean>`messages.sender_id is distinct from ${context.userId}`)
    .where(unreadCondition(scope, 'messages'))
    .groupBy('messages.parent_id')
    .orderBy('messages.parent_id', 'asc')
    .limit(limit + 1);
  if (query.afterThread !== undefined)
    waiting = waiting.where('messages.parent_id', '>', query.afterThread);
  const groups = await waiting.execute();
  const rootPage = roots.slice(0, limit);
  const threadPage = groups.slice(0, limit);
  const threadRoots =
    threadPage.length === 0
      ? []
      : await executor
          .selectFrom('messages')
          .leftJoin('users', 'users.id', 'messages.sender_id')
          .select(MESSAGE_COLUMNS)
          .where('messages.channel_id', '=', context.channelId)
          .where(withinMessageHistory(executor, context))
          .where('messages.parent_id', 'is', null)
          .where(
            'messages.id',
            'in',
            threadPage.map((thread) => thread.root_id),
          )
          .execute();
  const rows = new Map([...rootPage, ...threadRoots].map((row) => [row.id, row]));
  const messages = await buildMessages(executor, [...rows.values()], context.userId);
  const byId = new Map(messages.map((message) => [message.id, message]));
  const rootIds = new Set(rootPage.map((row) => row.id));
  return {
    roots: {
      data: messages.filter((message) => rootIds.has(message.id)),
      nextCursor: roots.length > limit ? (rootPage.at(-1)?.id ?? null) : null,
    },
    threads: threadPage.flatMap((thread) => {
      // Retention can remove a root between the two reads; it no longer waits.
      const root = byId.get(thread.root_id);
      return root === undefined
        ? []
        : [
            {
              root,
              firstUnreadMessageId: thread.first_unread_message_id,
              unreadCount: thread.unread_count,
            },
          ];
    }),
    nextThreadCursor: groups.length > limit ? (threadPage.at(-1)?.root_id ?? null) : null,
  };
};
