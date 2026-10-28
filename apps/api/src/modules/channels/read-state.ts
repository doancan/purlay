/**
 * Where a person has read to in a channel, and what is waiting beyond it
 * (D-99 §4, I-3, I-6).
 *
 * **Recomputed, not patched.** Moving the position sets both counters from the
 * rows past it. A decrement could underflow under a race, and two devices reading
 * at once would each subtract; a recount from rows cannot disagree with them. It
 * is bounded by what the person had not read, and the membership row is locked for
 * the transaction so two reads of one channel by one person take turns.
 *
 * **Forward only.** A position at or behind the current one is not an error — a
 * second device that is further behind is simply stale — and changes nothing, so
 * it also publishes nothing.
 *
 * **The position reads the feed, not the threads** (D-147). It reads the notifications of the
 * roots at or behind it; a reply's is read in its thread or in the inbox, so an answer the person
 * has not opened keeps waiting — and keeps counting as unread — however far the feed is read.
 */
import { notHiddenBy } from '../messages/hidden';
import { sql, type RawBuilder, type Transaction } from '@purlay/db';
import { NEEDS_YOU, type ChannelState } from '@purlay/types';
import { AppError } from '../../platform/errors';
import type { Clock } from '../../platform/clock';
import type { ChannelContext } from '../../platform/channels';

/**
 * The notifications still waiting for a person in one channel, of the kinds that need them: what
 * `unread_mention_count` is bounded by. One expression, for the read position and the inbox alike,
 * so the badge cannot be counted two ways (D-99 §4, D-106).
 */
export const waitingNotifications = (
  userId: string,
  /** A channel's id, or a reference to the row's own column when counting for many at once. */
  channelId: string | RawBuilder<unknown>,
): RawBuilder<number> => sql<number>`(
  select count(*)::int from notifications n
  join messages m on m.id = n.message_id and m.deleted_at is null
  where n.user_id = ${userId} and n.channel_id = ${channelId}
    and n.read_at is null and n.type in (${sql.join(NEEDS_YOU)})
    and ${notHiddenBy(userId, sql.ref('m.id'))}
)`;

/**
 * The replies at or behind a read position whose notification still waits for the person: unread
 * though the feed has been read past them (D-147).
 */
const waitingRepliesBehind = (
  userId: string,
  channelId: string,
  position: string,
): RawBuilder<number> => sql<number>`(
  select count(*)::int from notifications n
  join messages m on m.id = n.message_id and m.deleted_at is null and m.parent_id is not null
  where n.user_id = ${userId} and n.channel_id = ${channelId}
    and n.read_at is null and n.type in (${sql.join(NEEDS_YOU)})
    and ${notHiddenBy(userId, sql.ref('m.id'))}
    and n.message_id <= ${position}
)`;

/**
 * What is unread for a person in one channel, counted from the rows (D-99 §4, D-147): every message
 * by somebody else past the read position, and every reply at or behind it whose notification is
 * still waiting — the feed has been read past it, the thread has not. The second term is what keeps
 * `unread_mention_count` within `unread_count` (I-6) for an answer read past in the feed. Bounded,
 * as the recount was: the first by the unread messages, the second by the waiting notifications.
 */
const unreadMessages = (
  userId: string,
  channelId: string,
  position: string,
): RawBuilder<number> => sql<number>`(
  (
    select count(*)::int from messages
    where channel_id = ${channelId} and id > ${position}
      and sender_id is distinct from ${userId} and deleted_at is null
      and ${notHiddenBy(userId)}
  ) + ${waitingRepliesBehind(userId, channelId, position)}
)`;

export interface ReadOutcome {
  readonly state: ChannelState;
  /** False when the position was at or behind where it already was. */
  readonly moved: boolean;
  /** The row's `state_version` the state was read at (0015). */
  readonly version: number;
}

/**
 * Records that `context.userId` has read up to `messageId` in this channel.
 *
 * A channel the person can see but has not joined has no position to move, and is
 * refused with the answer a stranger gets: a read position is meaningless without
 * a membership, and a second code would only add a fact to learn. A message that is
 * not in this channel — another channel's, another workspace's, or none — is
 * `MESSAGE_NOT_FOUND` whichever it was (I-3, D-34).
 */
export const markRead = async (
  executor: Transaction,
  clock: Clock,
  context: ChannelContext,
  messageId: string,
): Promise<ReadOutcome> => {
  const member = await executor
    .selectFrom('channel_members')
    .select(['last_read_message_id', 'unread_count', 'unread_mention_count', 'state_version'])
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    // Held to the end of the transaction: two reads of one channel by one person
    // (two devices, two tabs) run one after the other.
    .forUpdate()
    .executeTakeFirst();
  if (member === undefined) {
    throw new AppError({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found.' });
  }

  const target = await executor
    .selectFrom('messages')
    .select('id')
    .where('id', '=', messageId)
    .where('channel_id', '=', context.channelId)
    .executeTakeFirst();
  if (target === undefined) {
    throw new AppError({ code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' });
  }

  const current = member.last_read_message_id;
  // A UUIDv7 sorts by time and the text form is lower-case hex of fixed width, so
  // comparing strings is comparing positions (`SCHEMA.md` §6.3).
  if (current !== null && messageId <= current) {
    return {
      moved: false,
      version: member.state_version,
      state: {
        lastReadMessageId: current,
        unreadCount: member.unread_count,
        unreadMentionCount: member.unread_mention_count,
      },
    };
  }

  // The roots at or behind the position: what is in the feed. A reply's notification is the
  // thread's to read (D-147).
  await executor
    .updateTable('notifications')
    .set({ read_at: clock.now() })
    .where('user_id', '=', context.userId)
    .where('channel_id', '=', context.channelId)
    .where('read_at', 'is', null)
    .where('message_id', '<=', messageId)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('messages')
          .select('messages.id')
          .whereRef('messages.id', '=', 'notifications.message_id')
          .where('messages.parent_id', 'is', null),
      ),
    )
    .execute();

  const unread = unreadMessages(context.userId, context.channelId, messageId);
  const updated = await executor
    .updateTable('channel_members')
    .set({
      last_read_message_id: messageId,
      state_version: sql<number>`state_version + 1`,
      unread_count: unread,
      // The lesser of the two, because a message that needs you is, first, one you
      // have not read (I-6). The notifications still unread are the ones past the
      // position and the replies behind it, which `unread` counts too.
      unread_mention_count: sql<number>`least(
        ${unread},
        ${waitingNotifications(context.userId, context.channelId)}
      )`,
    })
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .returning(['last_read_message_id', 'unread_count', 'unread_mention_count', 'state_version'])
    .executeTakeFirstOrThrow();

  return {
    moved: true,
    version: updated.state_version,
    state: {
      lastReadMessageId: updated.last_read_message_id,
      unreadCount: updated.unread_count,
      unreadMentionCount: updated.unread_mention_count,
    },
  };
};
