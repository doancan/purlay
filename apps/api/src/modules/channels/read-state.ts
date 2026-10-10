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
 */
import { sql, type Transaction } from '@purlay/db';
import type { ChannelState } from '@purlay/types';
import { AppError } from '../../platform/errors';
import type { Clock } from '../../platform/clock';
import type { ChannelContext } from '../../platform/channels';

/**
 * The notifications that make a message one that needs the person (D-99 §1). A
 * resolution is told and not counted: it is not a message, so counting it would put
 * the two numbers in disagreement the first time they are recomputed.
 */
const NEEDS_YOU = ['mention', 'direct_message', 'thread_reply'] as const;

export interface ReadOutcome {
  readonly state: ChannelState;
  /** False when the position was at or behind where it already was. */
  readonly moved: boolean;
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
    .select(['last_read_message_id', 'unread_count', 'unread_mention_count'])
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
      state: {
        lastReadMessageId: current,
        unreadCount: member.unread_count,
        unreadMentionCount: member.unread_mention_count,
      },
    };
  }

  await executor
    .updateTable('notifications')
    .set({ read_at: clock.now() })
    .where('user_id', '=', context.userId)
    .where('channel_id', '=', context.channelId)
    .where('read_at', 'is', null)
    .where('message_id', '<=', messageId)
    .execute();

  const updated = await executor
    .updateTable('channel_members')
    .set({
      last_read_message_id: messageId,
      unread_count: sql<number>`(
        select count(*)::int from messages
        where channel_id = ${context.channelId} and id > ${messageId}
          and sender_id <> ${context.userId} and deleted_at is null
      )`,
      // The lesser of the two, because a message that needs you is, first, one you
      // have not read (I-6). The notifications still unread are the ones past the
      // position: the update above read everything at or behind it.
      unread_mention_count: sql<number>`least(
        (
          select count(*)::int from messages
          where channel_id = ${context.channelId} and id > ${messageId}
            and sender_id <> ${context.userId} and deleted_at is null
        ),
        (
          select count(*)::int from notifications
          where user_id = ${context.userId} and channel_id = ${context.channelId}
            and read_at is null and type in (${sql.join(NEEDS_YOU)})
        )
      )`,
    })
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .returning(['last_read_message_id', 'unread_count', 'unread_mention_count'])
    .executeTakeFirstOrThrow();

  return {
    moved: true,
    state: {
      lastReadMessageId: updated.last_read_message_id,
      unreadCount: updated.unread_count,
      unreadMentionCount: updated.unread_mention_count,
    },
  };
};
