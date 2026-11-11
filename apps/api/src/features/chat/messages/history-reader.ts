/** History traversal may carry an earlier thread container, never its content or sidecars. */
import { sql } from '@purlay/db';
import type { Message } from '@purlay/types';
import type { ChatDb } from '../schema';
import { visibleChannels } from '../channels/guard';
import { guestMessageHistoryFor } from '../channels/history-access';
import { buildMessages, type MessageRow } from './reader';

export interface HistoryMessageRow extends MessageRow {
  readonly content_visible: boolean;
}

export const buildHistoryMessages = async (
  executor: ChatDb,
  rows: readonly HistoryMessageRow[],
  userId: string,
): Promise<Message[]> => {
  const readable = rows.filter((row) => row.content_visible);
  // Earlier root IDs never reach attachments, reactions, people, knowledge or integration readers.
  const built = await buildMessages(executor, readable, userId);
  const messages = new Map(built.map((message) => [message.id, message]));
  const hiddenIds = rows
    .filter((row) => !row.content_visible && row.parent_id === null)
    .map((row) => row.id);
  if (hiddenIds.length > 0) {
    const summaries = await visibleChannels(executor, userId)
      .innerJoin('messages as history_root', 'history_root.channel_id', 'channels.id')
      .innerJoin('messages as history_reply', (join) =>
        join
          .onRef('history_reply.parent_id', '=', 'history_root.id')
          .onRef('history_reply.channel_id', '=', 'history_root.channel_id'),
      )
      .select(['history_root.id as root_id', 'history_root.channel_id'])
      .select([
        sql<boolean>`history_root.deleted_at is null`.as('reply_allowed'),
        sql<number>`count(history_reply.id)::int`.as('reply_count'),
        sql<Date>`min(history_reply.created_at)`.as('first_at'),
        sql<Date>`max(history_reply.created_at)`.as('last_at'),
      ])
      .where('history_root.id', 'in', hiddenIds)
      .where('history_root.parent_id', 'is', null)
      .where(guestMessageHistoryFor('history_reply'))
      .groupBy(['history_root.id', 'history_root.channel_id', 'history_root.deleted_at'])
      .execute();
    for (const row of summaries) {
      messages.set(row.root_id, {
        id: row.root_id,
        channelId: row.channel_id,
        historyHidden: true,
        replyAllowed: row.reply_allowed,
        sender: null,
        githubEvent: null,
        content: '',
        editedAt: null,
        deletedAt: null,
        createdAt: new Date(row.first_at).toISOString(),
        parentId: null,
        thread: {
          replyCount: row.reply_count,
          lastReplyAt: new Date(row.last_at).toISOString(),
          resolvedAt: null,
          resolvedBy: null,
        },
        attachments: [],
        reactions: [],
        mentions: [],
      });
    }
  }
  return rows.flatMap((row) => {
    const message = messages.get(row.id);
    return message === undefined ? [] : [message];
  });
};
