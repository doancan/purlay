import { loadReadScope } from '../channels/read-scope';
import { sql } from '@purlay/db';
import type { ChatTx } from '../schema';
import type { Message } from '@purlay/types';
import { requireMessageById, messageNotFound } from '../channels/guard';
import type { Clock } from '../../../platform/clock';
import { readNotifications, type Told } from '../notifications/notifications';
import { waitingNotifications } from '../channels/read-state';
import { unreadMessages } from '../channels/unread';
import { readBuilt } from './reader';

export interface Hidden {
  readonly message: Message;
  readonly workspaceId: string;
  readonly at: string;
  readonly states: readonly Told[];
}

/** Only the caller's projection, saves, notifications and pending reminders change. */
export const hideMessage = async (
  tx: ChatTx,
  clock: Clock,
  userId: string,
  messageId: string,
): Promise<Hidden> => {
  const { context } = await requireMessageById(tx, userId, messageId, { deleted: 'include' });
  // Share the global deletion lock order: message first, membership next. Otherwise a global
  // delete waiting on this membership could have read a snapshot from before the private hide.
  const original = await tx
    .selectFrom('messages')
    .select(['sender_id', 'created_at', 'deleted_at'])
    .where('id', '=', messageId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  const member = await tx
    .selectFrom('channel_members')
    .select(['last_read_message_id', 'joined_at'])
    .where('user_id', '=', userId)
    .where('channel_id', '=', context.channelId)
    .forUpdate()
    .executeTakeFirst();
  const scope = await loadReadScope(tx, context.channelId, userId);
  const inserted = await tx
    .insertInto('hidden_messages')
    .values({
      user_id: userId,
      workspace_id: context.workspaceId,
      channel_id: context.channelId,
      message_id: messageId,
      hidden_at: sql<Date>`date_trunc('milliseconds', clock_timestamp())`,
    })
    .onConflict((conflict) => conflict.columns(['user_id', 'message_id']).doNothing())
    .returning('hidden_at')
    .executeTakeFirst();
  const notifications = await tx
    .selectFrom('notifications')
    .select('id')
    .where('user_id', '=', userId)
    .where('message_id', '=', messageId)
    .execute();
  const states =
    notifications.length === 0
      ? []
      : [
          ...(await readNotifications(tx, clock, userId, {
            ids: notifications.map((note) => note.id),
          })),
        ];
  if (
    inserted !== undefined &&
    member !== undefined &&
    original.deleted_at === null &&
    original.sender_id !== userId &&
    (scope.unread_since !== null ||
      (original.created_at >= member.joined_at &&
        (member.last_read_message_id === null || member.last_read_message_id < messageId)))
  ) {
    const unread =
      scope.unread_since === null
        ? sql<number>`greatest(unread_count - 1, 0)`
        : unreadMessages(
            {
              userId,
              position: member.last_read_message_id,
              since: scope.unread_since,
              historyFrom: scope.unread_history_from,
              threadBaseline: scope.thread_read_baseline_id,
            },
            context.channelId,
          );
    const mentions = sql<number>`least(${unread}, ${waitingNotifications(userId, context.channelId)})`;
    const row = await tx
      .updateTable('channel_members')
      .set({
        unread_count: unread,
        unread_mention_count: mentions,
        state_version: sql<number>`state_version + 1`,
      })
      .where('user_id', '=', userId)
      .where('channel_id', '=', context.channelId)
      .where((eb) =>
        eb.or([eb('unread_count', '<>', unread), eb('unread_mention_count', '<>', mentions)]),
      )
      .returning(['last_read_message_id', 'unread_count', 'unread_mention_count', 'state_version'])
      .executeTakeFirst();
    if (row !== undefined)
      states.splice(0, states.length, {
        channelId: context.channelId,
        version: row.state_version,
        state: {
          lastReadMessageId: row.last_read_message_id,
          unreadCount: row.unread_count,
          unreadMentionCount: row.unread_mention_count,
        },
      });
  }
  await tx
    .deleteFrom('saved_messages')
    .where('user_id', '=', userId)
    .where('message_id', '=', messageId)
    .execute();
  await tx
    .deleteFrom('message_reminders')
    .where('user_id', '=', userId)
    .where('message_id', '=', messageId)
    .execute();
  const message = await readBuilt(tx, messageId, userId);
  if (message === undefined) throw messageNotFound();
  const hidden = await tx
    .selectFrom('hidden_messages')
    .select('hidden_at')
    .where('user_id', '=', userId)
    .where('message_id', '=', messageId)
    .executeTakeFirstOrThrow();
  return { message, workspaceId: context.workspaceId, at: hidden.hidden_at.toISOString(), states };
};
