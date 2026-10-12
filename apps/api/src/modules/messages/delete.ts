/**
 * Deleting a message (D-103 §7, D-9): the content becomes the tombstone, and nothing else is
 * erased — not the row, not its thread, not its reactions, not what people were told. What it
 * added to the people it was counted for is taken back.
 *
 * `removeMessage` is the rule, inside the caller's transaction; `deleteMessage` is the one way in,
 * which commits and then tells the people whose numbers moved (D-35).
 */
import { sql, type Executor } from '@purlay/db';
import { AppError } from '../../platform/errors';
import { requireMessageById, type ChannelContext } from '../../platform/channels';
import type { Clock } from '../../platform/clock';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishChannelState,
  type EventBus,
} from '../../platform/events';
import type { Logger } from '../../platform/logging';
import type { Atomically } from '../../platform/transactions';
import { requireLiveSession } from '../auth/sessions';
import type { ChannelStateUpdate } from './delivery';

/** The notifications that made the message count as one needing the person (D-99 §1). */
const NEEDS_YOU = ['mention', 'direct_message', 'thread_reply'] as const;

/** Who may delete somebody else's message: the people who run the workspace (D-103 §7). */
const MODERATORS: readonly string[] = ['owner', 'admin'];

export interface Removed {
  /** False when it was deleted already: nothing was written, and that is the same answer. */
  readonly removed: boolean;
  readonly channelId: string;
  /** The members whose counters came down. */
  readonly recipients: readonly ChannelStateUpdate[];
}

/**
 * Deletes a message the caller may delete, in the caller's transaction.
 *
 * Not there for the caller (`404`, both axes, D-34); there and neither theirs nor theirs to
 * moderate, `403`. Already deleted is the same answer as deleting it, so a retry after a lost
 * response is not an error. The row is locked first, so a delete and an edit take turns.
 */
export const removeMessage = async (
  executor: Executor,
  clock: Clock,
  userId: string,
  messageId: string,
): Promise<Removed> => {
  const { context } = await requireMessageById(executor, userId, messageId, {
    deleted: 'include',
  });

  const row = await executor
    .selectFrom('messages')
    .select(['sender_id', 'deleted_at', 'created_at'])
    .where('id', '=', messageId)
    .forUpdate()
    .executeTakeFirstOrThrow();

  if (row.sender_id !== userId) {
    const role = await executor
      .selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', context.workspaceId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (role === undefined || !MODERATORS.includes(role.role)) {
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'Only the author or a workspace admin can delete a message.',
      });
    }
  }

  if (row.deleted_at !== null) {
    return { removed: false, channelId: context.channelId, recipients: [] };
  }

  const now = clock.now();
  await executor
    .updateTable('messages')
    .set({
      deleted_at: now,
      updated_at: now,
      // The tombstone: the client draws the words, in the reader's language (D-41).
      content: '',
      metadata: {},
      state_version: sql<number>`state_version + 1`,
    })
    .where('id', '=', messageId)
    .execute();
  // Nobody is named by a message that says nothing.
  await executor.deleteFrom('mentions').where('message_id', '=', messageId).execute();

  // What needed the person no longer does: kept for the inbox, read, and its count given back.
  const waiting = await executor
    .updateTable('notifications')
    .set({ read_at: now })
    .where('message_id', '=', messageId)
    .where('read_at', 'is', null)
    .where('type', 'in', NEEDS_YOU)
    .returning('user_id')
    .execute();

  const recipients = await uncount(
    executor,
    context,
    messageId,
    row.sender_id,
    new Date(row.created_at),
    waiting.map((notification) => notification.user_id),
  );
  return { removed: true, channelId: context.channelId, recipients };
};

/**
 * Takes back what the message added: one unread for each member it was counted for — not its
 * author, in the channel when it was written, with their position before it — and one unread
 * mention for each of them it was waiting on. Exactly what the send added, so the stored numbers
 * stay what a read would recount them to.
 *
 * Never below zero, and the mentions never above the unread (I-6): a message written before the
 * counters existed (0013) was never counted, and taking it back would make an author's own
 * delete a refusal by a check. The next read recounts from the rows and is exact again.
 */
const uncount = async (
  executor: Executor,
  context: ChannelContext,
  messageId: string,
  senderId: string,
  writtenAt: Date,
  waitedOn: readonly string[],
): Promise<readonly ChannelStateUpdate[]> => {
  const changed = await executor
    .updateTable('channel_members')
    .set({
      unread_count: sql<number>`greatest(unread_count - 1, 0)`,
      unread_mention_count: sql<number>`least(
        greatest(unread_mention_count - case when user_id = any(${waitedOn}::uuid[]) then 1 else 0 end, 0),
        greatest(unread_count - 1, 0)
      )`,
      state_version: sql<number>`state_version + 1`,
    })
    .where('channel_id', '=', context.channelId)
    .where('user_id', '<>', senderId)
    .where('joined_at', '<=', writtenAt)
    .where((eb) =>
      eb.or([eb('last_read_message_id', 'is', null), eb('last_read_message_id', '<', messageId)]),
    )
    .returning([
      'user_id',
      'last_read_message_id',
      'unread_count',
      'unread_mention_count',
      'state_version',
    ])
    .execute();
  return changed.map((member) => ({
    userId: member.user_id,
    state: {
      lastReadMessageId: member.last_read_message_id,
      unreadCount: member.unread_count,
      unreadMentionCount: member.unread_mention_count,
    },
    version: member.state_version,
  }));
};

export interface DeleteDependencies {
  readonly atomically: Atomically;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly log?: Logger;
}

/**
 * Deletes a message: the one way in. Commits, then tells each person whose numbers came down
 * (D-35). The room hears the tombstone with #333; until then a client sees it on its next read.
 */
export const deleteMessage = async (
  dependencies: DeleteDependencies,
  caller: { readonly userId: string; readonly sessionId: string },
  messageId: string,
): Promise<void> => {
  const { atomically, clock, bus, log = NO_LOG } = dependencies;
  const outcome = await atomically(async (transaction) => {
    // The session the caller authenticated with, held live for this transaction (D-85).
    await requireLiveSession(transaction, clock, caller.sessionId);
    return await removeMessage(transaction, clock, caller.userId, messageId);
  });
  await publishAfterCommit(log, [
    outcome.recipients.map((recipient) =>
      publication('CHANNEL_STATE', () =>
        publishChannelState(
          bus,
          clock,
          recipient.userId,
          outcome.channelId,
          recipient.state,
          recipient.version,
        ),
      ),
    ),
  ]);
};
