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

/** True when the position is at or past the message: the person has read beyond it. */
const isBehind = (position: string | null, messageId: string): boolean =>
  position !== null && position.toLowerCase() >= messageId.toLowerCase();

/** One person's numbers in the channel after the message, ready to be told to them. */
export interface ChannelStateUpdate {
  readonly userId: string;
  readonly state: ChannelState;
  /** The row's `state_version` the numbers were read at: the order the client applies them in. */
  readonly version: number;
}

/**
 * The people a body names who can see the channel, as user ids.
 *
 * Case-insensitively, inside the workspace only, and for a private channel or a DM
 * only among its members: naming somebody who cannot see the conversation would
 * tell them it exists. The sender is never a recipient of their own message.
 */
/**
 * How many earlier repliers a reply tells, besides the root's author (D-99 §2, amended
 * 2026-10-10). A thread nobody has to read to the end has no use for telling all of ten
 * thousand people at once: the most recent repliers are the ones in the conversation, and the
 * set — not the thread — is what one reply writes a row for.
 */
export const THREAD_PARTICIPANTS_MAX = 50;

/**
 * Of these people, the ones who can see the channel *now*: still a workspace member, not
 * deleted, and — for a private channel or a DM — still in it (D-34). Somebody who replied
 * yesterday and was removed today is told nothing: a notification row names a conversation.
 */
export const stillSeeing = async (
  executor: Executor,
  context: ChannelContext,
  userIds: readonly string[],
): Promise<ReadonlySet<string>> => {
  if (userIds.length === 0) return new Set();
  let query = executor
    .selectFrom('users')
    .innerJoin('workspace_members', (join) =>
      join
        .onRef('workspace_members.user_id', '=', 'users.id')
        .on('workspace_members.workspace_id', '=', context.workspaceId),
    )
    .select('users.id')
    .where('users.id', 'in', userIds)
    .where('users.deleted_at', 'is', null);
  if (context.channelType !== 'public') {
    query = query.innerJoin('channel_members', (join) =>
      join
        .onRef('channel_members.user_id', '=', 'users.id')
        .on('channel_members.channel_id', '=', context.channelId),
    );
  }
  return new Set((await query.execute()).map((row) => row.id));
};

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

/** Who is told about a message, and why: the strongest reason each person has. */
type Reasons = ReadonlyMap<string, Reason>;

/**
 * Writes the notifications for `reasons` and returns the people told **for the first time** —
 * one already holding a notification of that kind for this message is not told again.
 *
 * A membership that has muted the channel is told nothing, and the author never. Somebody who
 * has read past the message is told for the inbox, already read; so is somebody who joined the
 * channel after it was written (`writtenAt`), for whom it was never counted unread.
 */
const notify = async (
  executor: Executor,
  context: ChannelContext,
  messageId: string,
  reasons: Reasons,
  writtenAt?: Date,
): Promise<readonly string[]> => {
  const candidates = [...reasons.keys()].filter((userId) => userId !== context.userId);
  if (candidates.length === 0) return [];
  const muted = new Set<string>();
  const alreadyRead = new Set<string>();
  const levels = await executor
    .selectFrom('channel_members')
    .select(['user_id', 'notification_level', 'last_read_message_id', 'joined_at'])
    .where('channel_id', '=', context.channelId)
    .where('user_id', 'in', candidates)
    .execute();
  for (const row of levels) {
    if (row.notification_level === 'none') muted.add(row.user_id);
    if (isBehind(row.last_read_message_id, messageId)) alreadyRead.add(row.user_id);
    if (writtenAt !== undefined && new Date(row.joined_at) > writtenAt)
      alreadyRead.add(row.user_id);
  }
  const notified = candidates.filter((userId) => !muted.has(userId));
  if (notified.length === 0) return [];
  const inserted = await executor
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
                // Behind the person's position: it exists for the inbox and needs nothing.
                ...(alreadyRead.has(userId) ? { read_at: sql<Date>`now()` } : {}),
              },
            ];
      }),
    )
    .onConflict((conflict) => conflict.columns(['user_id', 'message_id', 'type']).doNothing())
    .returning('user_id')
    .execute();
  return inserted.map((row) => row.user_id);
};

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
    // The most recent repliers over `idx_messages_thread`, one row per person, newest first and
    // bounded: one indexed scan per reply (D-29), and a bound on what one reply can write.
    const answered = await executor
      .selectFrom('messages')
      .select('sender_id')
      .where('parent_id', '=', thread.rootId)
      .where('deleted_at', 'is', null)
      .where('id', '<>', messageId)
      .groupBy('sender_id')
      .orderBy(sql`max(id::text)`, 'desc')
      .limit(THREAD_PARTICIPANTS_MAX)
      .execute();
    const participants = [thread.rootAuthorId, ...answered.map((row) => row.sender_id)];
    const seeing = await stillSeeing(executor, context, participants);
    for (const userId of participants) if (seeing.has(userId)) consider(userId, 'thread_reply');
  }

  const notified = await notify(executor, context, messageId, reasons);

  // Counted only for a member whose position is before this message. One whose position is
  // at or past it has read beyond it, and the read recount (`id > position`) would not find it:
  // counting it here left the stored number above the recount, and a badge `PUT /read` could
  // not clear because it is a no-op for a position that does not move (H-API 1).
  const ahead = sql<boolean>`(last_read_message_id is null or last_read_message_id < ${messageId}::uuid)`;
  const changed = await executor
    .updateTable('channel_members')
    .set({
      unread_count: sql<number>`unread_count + case when ${ahead} then 1 else 0 end`,
      unread_mention_count: sql<number>`unread_mention_count + case when ${ahead} and user_id = any(${notified}::uuid[]) then 1 else 0 end`,
      // Counted with the numbers it describes, in the one statement, under the row lock it
      // takes: the order of versions is the order of commits (0015).
      state_version: sql<number>`state_version + 1`,
    })
    .where('channel_id', '=', context.channelId)
    .where('user_id', '<>', sender)
    .returning([
      'user_id',
      'last_read_message_id',
      'unread_count',
      'unread_mention_count',
      'state_version',
    ])
    .execute();

  return changed.map((row) => ({
    userId: row.user_id,
    state: {
      lastReadMessageId: row.last_read_message_id,
      unreadCount: row.unread_count,
      unreadMentionCount: row.unread_mention_count,
    },
    version: row.state_version,
  }));
};

/**
 * The channel's other members' numbers as the rows hold them now — what a retried send tells
 * again. Counts nothing, writes nothing.
 */
export const currentStates = async (
  executor: Executor,
  context: ChannelContext,
): Promise<readonly ChannelStateUpdate[]> =>
  (
    await executor
      .selectFrom('channel_members')
      .select([
        'user_id',
        'last_read_message_id',
        'unread_count',
        'unread_mention_count',
        'state_version',
      ])
      .where('channel_id', '=', context.channelId)
      .where('user_id', '<>', context.userId)
      .execute()
  ).map((row) => ({
    userId: row.user_id,
    state: {
      lastReadMessageId: row.last_read_message_id,
      unreadCount: row.unread_count,
      unreadMentionCount: row.unread_mention_count,
    },
    version: row.state_version,
  }));
