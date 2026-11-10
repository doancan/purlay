import { loadReadScope, saveReadScope } from './read-scope';
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
import { sql, type RawBuilder } from '@purlay/db';
import type { ChatTx } from '../schema';
import { NEEDS_YOU, type ChannelState } from '@purlay/types';
import { AppError } from '../../../platform/errors';
import type { Clock } from '../../../platform/clock';
import { visibleChannelsIn, withinMessageHistory, type ChannelContext } from './guard';
import type { WorkspaceContext } from '../../../platform/tenancy';
import { HISTORY_BEGINNING, unreadMessages } from './unread';

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

export interface ReadOutcome {
  readonly state: ChannelState;
  /** False when neither the feed nor the explicitly requested thread baseline advanced. */
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
  executor: ChatTx,
  clock: Clock,
  context: ChannelContext,
  messageId: string,
  options: { readonly includeUnnotifiedReplies?: boolean } = {},
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
  const scope = await loadReadScope(executor, context.channelId, context.userId);

  const target = await executor
    .selectFrom('messages')
    .select('id')
    .where('id', '=', messageId)
    .where('channel_id', '=', context.channelId)
    .where(withinMessageHistory(executor, context))
    .executeTakeFirst();
  if (target === undefined) {
    throw new AppError({ code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' });
  }

  const current = member.last_read_message_id;
  const previousThreadBaseline =
    scope.unread_since === null ? current : scope.thread_read_baseline_id;
  const threadBaseline =
    options.includeUnnotifiedReplies === true &&
    (previousThreadBaseline === null || previousThreadBaseline < messageId)
      ? messageId
      : previousThreadBaseline;
  const position = current !== null && current >= messageId ? current : messageId;
  // A UUIDv7 sorts by time and the text form is lower-case hex of fixed width, so
  // comparing strings is comparing positions (`SCHEMA.md` §6.3).
  if (current !== null && messageId <= current && threadBaseline === previousThreadBaseline) {
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
    .where('message_id', '<=', position)
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

  const since = scope.unread_since ?? HISTORY_BEGINNING;
  await saveReadScope(executor, context.channelId, context.userId, {
    unread_since: since,
    unread_history_from: scope.unread_history_from,
    thread_read_baseline_id: threadBaseline,
  });
  const unread = unreadMessages(
    {
      userId: context.userId,
      position,
      threadBaseline,
      since,
      historyFrom: scope.unread_history_from,
      historyFloor: scope.history_floor,
    },
    context.channelId,
  );
  const updated = await executor
    .updateTable('channel_members')
    .set({
      last_read_message_id: position,
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

/** One channel "mark every channel read" answered for, and what became of it. */
export interface ChannelReadOutcome extends ReadOutcome {
  readonly channelId: string;
}

/**
 * "Mark every channel read" (D-238): each channel of the workspace the caller is in and can see, with
 * anything unread, is read to its newest message — a reply included, since replies count as unread
 * too — by `markRead`, so the notifications it reads and the numbers it counts are a read's, and a
 * reply whose notification still waits stays unread (D-147).
 *
 * **The memberships are locked first, in one order** — by channel, as the inbox's read takes them —
 * so two of these at once, or one beside a read of one channel, take turns instead of each holding a
 * row the other waits for. A channel with nothing unread is not touched and not answered; one whose
 * only unread is a waiting reply is answered as it is, with nothing moved, so the client can put back
 * what it painted.
 */
export const markAllRead = async (
  executor: ChatTx,
  clock: Clock,
  context: WorkspaceContext,
): Promise<readonly ChannelReadOutcome[]> => {
  const visible = new Map(
    (await visibleChannelsIn(executor, context)).map((channel) => [channel.channelId, channel]),
  );
  if (visible.size === 0) return [];
  const waiting = await executor
    .selectFrom('channel_members')
    .select([
      'channel_id',
      'last_read_message_id',
      'unread_count',
      'unread_mention_count',
      'state_version',
    ])
    .where('user_id', '=', context.userId)
    .where('channel_id', 'in', [...visible.keys()])
    // A mention is an unread message first (I-6, held by the table's check), so this is everything.
    .where('unread_count', '>', 0)
    .orderBy('channel_id')
    .forUpdate()
    .execute();

  const outcomes: ChannelReadOutcome[] = [];
  for (const member of waiting) {
    const channel = visible.get(member.channel_id);
    if (channel === undefined) continue;
    const newest = await executor
      .selectFrom('messages')
      .select('id')
      .where('channel_id', '=', member.channel_id)
      .where(withinMessageHistory(executor, channel))
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    // A count with no message left to read past has no position to move to: answered as it is.
    const outcome: ReadOutcome =
      newest === undefined
        ? {
            moved: false,
            version: member.state_version,
            state: {
              lastReadMessageId: member.last_read_message_id,
              unreadCount: member.unread_count,
              unreadMentionCount: member.unread_mention_count,
            },
          }
        : await markRead(executor, clock, channel, newest.id, { includeUnnotifiedReplies: true });
    outcomes.push({ channelId: member.channel_id, ...outcome });
  }
  return outcomes;
};

/**
 * "Mark unread from here" (D-212): the read position moves back to the newest message before this
 * one, so it and everything after it is unread again — the one way the position moves backwards, and
 * only when the person asks. A reply marks its thread's root: the feed is what the position reads
 * (D-147). The counters are recounted from the rows, as a read's are, in the same locked turn.
 *
 * Already unread from here or earlier, nothing moves and nothing is published. Notifications are not
 * touched: what the inbox has read stays read there (D-106), so the badge counts what still waits.
 */
export const markUnread = async (
  executor: ChatTx,
  context: ChannelContext,
  messageId: string,
): Promise<ReadOutcome> => {
  const member = await executor
    .selectFrom('channel_members')
    .select(['last_read_message_id', 'unread_count', 'unread_mention_count', 'state_version'])
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .forUpdate()
    .executeTakeFirst();
  if (member === undefined) {
    throw new AppError({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found.' });
  }
  const scope = await loadReadScope(executor, context.channelId, context.userId);

  const target = await executor
    .selectFrom('messages')
    .select(['id', 'parent_id'])
    .where('id', '=', messageId)
    .where('channel_id', '=', context.channelId)
    .where(withinMessageHistory(executor, context))
    .executeTakeFirst();
  if (target === undefined) {
    throw new AppError({ code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' });
  }
  const from = target.parent_id ?? target.id;

  const unchanged = (): ReadOutcome => ({
    moved: false,
    version: member.state_version,
    state: {
      lastReadMessageId: member.last_read_message_id,
      unreadCount: member.unread_count,
      unreadMentionCount: member.unread_mention_count,
    },
  });
  const behind = member.last_read_message_id === null || member.last_read_message_id < from;
  const includesHistory =
    scope.unread_since === null ||
    scope.unread_since.getTime() === 0 ||
    (scope.unread_history_from !== null && scope.unread_history_from <= from);
  const readReplies = await executor
    .selectFrom('thread_reads')
    .select('root_id')
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .where('last_read_message_id', '>=', from)
    .limit(1)
    .executeTakeFirst();
  if (behind && includesHistory && readReplies === undefined) return unchanged();

  const previous = await executor
    .selectFrom('messages')
    .select('id')
    .where('channel_id', '=', context.channelId)
    .where('id', '<', from)
    .where(withinMessageHistory(executor, context))
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const boundary = previous?.id ?? null;
  const position = behind ? member.last_read_message_id : boundary;
  if (boundary === null) {
    await executor
      .deleteFrom('thread_reads')
      .where('channel_id', '=', context.channelId)
      .where('user_id', '=', context.userId)
      .where('last_read_message_id', '>=', from)
      .execute();
  } else {
    await executor
      .updateTable('thread_reads')
      .set({ last_read_message_id: boundary })
      .where('channel_id', '=', context.channelId)
      .where('user_id', '=', context.userId)
      .where('last_read_message_id', '>=', from)
      .execute();
  }
  const since = scope.unread_since ?? HISTORY_BEGINNING;
  const previousThreadBaseline =
    scope.unread_since === null ? member.last_read_message_id : scope.thread_read_baseline_id;
  const threadBaseline =
    boundary === null
      ? null
      : previousThreadBaseline !== null && previousThreadBaseline > boundary
        ? boundary
        : previousThreadBaseline;
  const historyFrom =
    scope.unread_history_from === null || from < scope.unread_history_from
      ? from
      : scope.unread_history_from;
  await saveReadScope(executor, context.channelId, context.userId, {
    unread_since: since,
    unread_history_from: historyFrom,
    thread_read_baseline_id: threadBaseline,
  });
  const unread = unreadMessages(
    {
      userId: context.userId,
      position,
      threadBaseline,
      since,
      historyFrom,
      historyFloor: scope.history_floor,
    },
    context.channelId,
  );
  const updated = await executor
    .updateTable('channel_members')
    .set({
      last_read_message_id: position,
      state_version: sql<number>`state_version + 1`,
      unread_count: unread,
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
