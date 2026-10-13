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
import { NEEDS_YOU } from './delivery';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishChannelState,
  publishMessageRevised,
  type EventBus,
  type Revision,
} from '../../platform/events';
import type { Logger } from '../../platform/logging';
import type { Atomically } from '../../platform/transactions';
import { requireLiveSession } from '../auth/sessions';
import type { ChannelStateUpdate } from './delivery';
import { recordAudit } from '../audit/audit';

/** Who may delete somebody else's message: the people who run the workspace (D-103 §7). */
const MODERATORS: readonly string[] = ['owner', 'admin'];

export interface Removed {
  /** False when it was deleted already: nothing was written, and that is the same answer. */
  readonly removed: boolean;
  readonly channelId: string;
  /** What the room is told when it was removed now: the tombstone, at its version. */
  readonly revision: { readonly revision: Revision; readonly version: number } | null;
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
    // NO KEY UPDATE: what the UPDATE below takes anyway. Edits, deletes and resolutions of this row
    // take turns on it, and a row that only points here (a reply, a reaction, a read position) is
    // not made to wait — FOR UPDATE would, and a reader holding its membership deadlocks on it.
    .forNoKeyUpdate()
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
    return { removed: false, channelId: context.channelId, revision: null, recipients: [] };
  }

  const now = clock.now();
  const tombstone = await executor
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
    .returning(['state_version', 'parent_id', 'edited_at'])
    .executeTakeFirstOrThrow();
  // Nobody is named by a message that says nothing.
  await executor.deleteFrom('mentions').where('message_id', '=', messageId).execute();
  // Nor is it kept at hand for the channel: its pin goes with its words (D-130).
  await executor.deleteFrom('pinned_messages').where('message_id', '=', messageId).execute();
  // Somebody else's message removed is moderation, and on the trail: who, which message and whose —
  // never what it said, which is gone from the row as well (D-26).
  if (row.sender_id !== userId) {
    await recordAudit(executor, clock, {
      workspaceId: context.workspaceId,
      actorUserId: userId,
      action: 'message.removed_by_moderator',
      targetType: 'message',
      targetId: messageId,
      metadata: { authorId: row.sender_id },
    });
  }

  // The memberships before the notifications, in one order: reading a channel or the inbox takes
  // them in that order too, and a delete taking them the other way round deadlocks with a person
  // reading at that moment (D-106 §3).
  await executor
    .selectFrom('channel_members')
    .select('user_id')
    .where('channel_id', '=', context.channelId)
    .orderBy('user_id')
    .forUpdate()
    .execute();

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
  return {
    removed: true,
    channelId: context.channelId,
    revision: {
      revision: {
        channelId: context.channelId,
        messageId,
        parentId: tombstone.parent_id,
        content: '',
        editedAt: tombstone.edited_at === null ? null : new Date(tombstone.edited_at).toISOString(),
        deletedAt: now.toISOString(),
        mentions: [],
      },
      version: tombstone.state_version,
    },
    recipients,
  };
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
 * Deletes a message: the one way in. Commits, then tells the room it is a tombstone and each
 * person whose numbers came down (D-35).
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
  const { revision } = outcome;
  // The room first — the message is a tombstone now — then each person's own numbers (D-99 §2).
  await publishAfterCommit(log, [
    revision === null
      ? []
      : [
          publication('MESSAGE_REVISED', () =>
            publishMessageRevised(bus, clock, revision.revision, revision.version),
          ),
        ],
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
