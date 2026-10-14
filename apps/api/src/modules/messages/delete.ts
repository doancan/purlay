/**
 * Deleting a message (D-103 §7, D-9): the content becomes the tombstone, and nothing else is
 * erased — not the row, not its thread, not its reactions, not what people were told. What it
 * added to the people it was counted for is taken back.
 *
 * `removeMessage` is the rule, inside the caller's transaction; `deleteMessage` is the one way in,
 * which commits and then tells the people whose numbers moved (D-35).
 */
import type { Executor } from '@purlay/db';
import { AppError } from '../../platform/errors';
import { requireMessageById } from '../../platform/channels';
import type { Clock } from '../../platform/clock';
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
import { takeBack, tombstoneRows } from './tombstone';
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
  const [tombstone] = await tombstoneRows(executor, now, [messageId]);
  if (tombstone === undefined) throw new Error('a locked, live message was not tombstoned');
  // Somebody else's message removed is moderation, and on the trail: who, which message and whose —
  // never what it said, which is gone from the row as well (D-26).
  if (row.sender_id !== userId) {
    await recordAudit(executor, clock, {
      workspaceId: context.workspaceId,
      actorUserId: userId,
      action: 'message.removed_by_moderator',
      targetType: 'message',
      targetId: messageId,
      // An event's has no author to name (D-134 §6).
      metadata: row.sender_id === null ? {} : { authorId: row.sender_id },
    });
  }

  const recipients = await takeBack(executor, now, context.channelId, [
    { id: messageId, senderId: row.sender_id, createdAt: new Date(row.created_at) },
  ]);
  return {
    removed: true,
    channelId: context.channelId,
    revision: {
      revision: {
        channelId: context.channelId,
        messageId,
        parentId: tombstone.parentId,
        content: '',
        editedAt: tombstone.editedAt === null ? null : tombstone.editedAt.toISOString(),
        deletedAt: now.toISOString(),
        mentions: [],
      },
      version: tombstone.version,
    },
    recipients,
  };
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
