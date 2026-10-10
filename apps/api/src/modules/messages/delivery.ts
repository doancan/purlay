/**
 * What a new message does to the people it is for (D-99 §1–§3).
 *
 * Called from inside the send's transaction, after the message row exists, and in
 * the order D-35 gives: the mentions are written, the notifications are written, and
 * the counters move — all in the same commit, so a notification never exists for a
 * message that rolled back and a badge never counts one that did not arrive.
 *
 * **"Needs you" is decided here and nowhere else.** A person is *notified* when the
 * message names them, is in a direct message to them, or is a reply in a thread they
 * started or have already answered. One row per person per message, the strongest
 * reason winning — a mention beats a direct message beats a reply — so the inbox
 * says why they were told, once. A membership at `notification_level = 'none'` is
 * told nothing; a person who is not in the channel but can see it (a public
 * channel, a mention) gets the notification and has no counter to move.
 *
 * **The counters move in one statement** for the whole channel (D-35): every other
 * member's `unread_count` goes up by one, and `unread_mention_count` by one for
 * those who were notified. It returns the rows it changed, which is what lets the
 * caller tell each of them their new numbers without a query per person.
 */
import { sql, type Executor } from '@purlay/db';
import type { ChannelState } from '@purlay/types';
import type { ChannelContext } from '../../platform/channels';

/** Strongest first — the order a person's one notification for a message is chosen in. */
type Reason = 'mention' | 'direct_message' | 'thread_reply';

const STRENGTH: Readonly<Record<Reason, number>> = {
  mention: 3,
  direct_message: 2,
  thread_reply: 1,
};

/** One person's numbers in the channel after the message, ready to be told to them. */
export interface ChannelStateUpdate {
  readonly userId: string;
  readonly state: ChannelState;
}

/**
 * The people a body names who can see the channel, as user ids.
 *
 * Case-insensitively, inside the workspace only, and for a private channel or a DM
 * only among its members: naming somebody who cannot see the conversation would
 * tell them it exists. The sender is never a recipient of their own message.
 */
export const resolveMentions = async (
  executor: Executor,
  context: ChannelContext,
  names: readonly string[],
): Promise<readonly string[]> => {
  if (names.length === 0) return [];
  let query = executor
    .selectFrom('users')
    .innerJoin('workspace_members', (join) =>
      join
        .onRef('workspace_members.user_id', '=', 'users.id')
        .on('workspace_members.workspace_id', '=', context.workspaceId),
    )
    .select('users.id')
    .where(
      sql<string>`lower(users.username)`,
      'in',
      names.map((name) => name.toLowerCase()),
    )
    .where('users.id', '<>', context.userId)
    .where('users.deleted_at', 'is', null);
  if (context.channelType !== 'public') {
    query = query.innerJoin('channel_members', (join) =>
      join
        .onRef('channel_members.user_id', '=', 'users.id')
        .on('channel_members.channel_id', '=', context.channelId),
    );
  }
  return (await query.execute()).map((row) => row.id);
};

export interface Delivery {
  readonly context: ChannelContext;
  readonly messageId: string;
  /** Who the message names, already resolved. */
  readonly mentioned: readonly string[];
  /** The root a reply answers, and who wrote it; null for a root. */
  readonly thread: { readonly rootId: string; readonly rootAuthorId: string } | null;
}

/**
 * Writes the mentions and notifications for a new message and moves the counters,
 * returning the channel members whose numbers changed.
 */
export const recordDelivery = async (
  executor: Executor,
  delivery: Delivery,
): Promise<readonly ChannelStateUpdate[]> => {
  const { context, messageId, mentioned, thread } = delivery;
  const sender = context.userId;

  if (mentioned.length > 0) {
    await executor
      .insertInto('mentions')
      .values(
        mentioned.map((userId) => ({
          workspace_id: context.workspaceId,
          channel_id: context.channelId,
          message_id: messageId,
          mentioned_user_id: userId,
        })),
      )
      .onConflict((conflict) => conflict.columns(['message_id', 'mentioned_user_id']).doNothing())
      .execute();
  }

  const reasons = new Map<string, Reason>();
  const consider = (userId: string, reason: Reason): void => {
    if (userId === sender) return;
    const known = reasons.get(userId);
    if (known === undefined || STRENGTH[reason] > STRENGTH[known]) reasons.set(userId, reason);
  };

  for (const userId of mentioned) consider(userId, 'mention');

  if (context.channelType === 'direct_message') {
    const others = await executor
      .selectFrom('channel_members')
      .select('user_id')
      .where('channel_id', '=', context.channelId)
      .where('user_id', '<>', sender)
      .execute();
    for (const row of others) consider(row.user_id, 'direct_message');
  }

  if (thread !== null) {
    consider(thread.rootAuthorId, 'thread_reply');
    // A bounded `DISTINCT` over `idx_messages_thread`: one indexed lookup per reply (D-29).
    const answered = await executor
      .selectFrom('messages')
      .select('sender_id')
      .distinct()
      .where('parent_id', '=', thread.rootId)
      .where('deleted_at', 'is', null)
      .where('id', '<>', messageId)
      .execute();
    for (const row of answered) consider(row.sender_id, 'thread_reply');
  }

  // A membership that has muted the channel is told nothing.
  const candidates = [...reasons.keys()];
  const muted = new Set<string>();
  if (candidates.length > 0) {
    const levels = await executor
      .selectFrom('channel_members')
      .select(['user_id', 'notification_level'])
      .where('channel_id', '=', context.channelId)
      .where('user_id', 'in', candidates)
      .execute();
    for (const row of levels) if (row.notification_level === 'none') muted.add(row.user_id);
  }
  const notified = candidates.filter((userId) => !muted.has(userId));

  if (notified.length > 0) {
    await executor
      .insertInto('notifications')
      .values(
        notified.flatMap((userId) => {
          const type = reasons.get(userId);
          return type === undefined
            ? []
            : [
                {
                  user_id: userId,
                  workspace_id: context.workspaceId,
                  channel_id: context.channelId,
                  message_id: messageId,
                  type,
                },
              ];
        }),
      )
      .onConflict((conflict) => conflict.columns(['user_id', 'message_id', 'type']).doNothing())
      .execute();
  }

  const changed = await executor
    .updateTable('channel_members')
    .set({
      unread_count: sql<number>`unread_count + 1`,
      unread_mention_count: sql<number>`unread_mention_count + case when user_id = any(${notified}::uuid[]) then 1 else 0 end`,
    })
    .where('channel_id', '=', context.channelId)
    .where('user_id', '<>', sender)
    .returning(['user_id', 'last_read_message_id', 'unread_count', 'unread_mention_count'])
    .execute();

  return changed.map((row) => ({
    userId: row.user_id,
    state: {
      lastReadMessageId: row.last_read_message_id,
      unreadCount: row.unread_count,
      unreadMentionCount: row.unread_mention_count,
    },
  }));
};
