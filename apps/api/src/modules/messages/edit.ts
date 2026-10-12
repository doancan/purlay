/**
 * Editing a message (D-103): the author replaces the content; the reading is done again, once,
 * as at write time (D-101); the people the new content names for the first time are told.
 *
 * `reviseMessage` is the rule, inside the caller's transaction; `edit` is the one way in from
 * either door, which commits and then tells the people whose numbers moved (D-35).
 */
import { sql, type Executor } from '@purlay/db';
import type { Message } from '@purlay/types';
import type { Engine, Reading } from '@purlay/markdown';
import { AppError } from '../../platform/errors';
import { messageNotFound, requireMessageById, type ChannelContext } from '../../platform/channels';
import type { Clock } from '../../platform/clock';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishChannelState,
  publishMessageRevised,
  type EventBus,
} from '../../platform/events';
import type { Logger } from '../../platform/logging';
import type { Atomically } from '../../platform/transactions';
import { requireLiveSession } from '../auth/sessions';
import { notify, resolveMentions, type ChannelStateUpdate } from './delivery';
import { readBody } from './body';
import { readBuilt } from './reader';

export interface Revised {
  readonly message: Message;
  /** False when the same words came again: nothing was written, and nothing is told. */
  readonly changed: boolean;
  /** The row's own count of its changes after this one (`0015_state_versions`). */
  readonly version: number;
  /** The members whose counters moved: the newly named, where the message is still unread. */
  readonly recipients: readonly ChannelStateUpdate[];
  /** Why the content is stored as typed, when it is; null when it was read (D-101). */
  readonly unformatted: Extract<Reading, { tree: null }>['reason'] | null;
  readonly engineFailure?: unknown;
}

/** The names in `next` that `previous` did not have. */
const added = (previous: readonly string[], next: readonly string[]): string[] => {
  const before = new Set(previous);
  return [...new Set(next)].filter((userId) => !before.has(userId));
};

/**
 * Replaces the content of the caller's own message, in the caller's transaction.
 *
 * Visible to the caller or not there at all (`404`, both axes, D-34); visible and somebody
 * else's is `403` (D-103 §4). The row is locked before anything is decided, so two edits are
 * taken one after the other and an edit that loses a race with a delete finds it deleted.
 */
export const reviseMessage = async (
  executor: Executor,
  clock: Clock,
  userId: string,
  messageId: string,
  content: string,
  engine?: Engine,
): Promise<Revised> => {
  const { context } = await requireMessageById(executor, userId, messageId);

  const row = await executor
    .selectFrom('messages')
    .select(['sender_id', 'content', 'deleted_at', 'created_at', 'state_version'])
    .where('id', '=', messageId)
    // NO KEY UPDATE: what the UPDATE below takes anyway. Edits, deletes and resolutions of this row
    // take turns on it, and a row that only points here (a reply, a reaction, a read position) is
    // not made to wait — FOR UPDATE would, and a reader holding its membership deadlocks on it.
    .forNoKeyUpdate()
    .executeTakeFirst();
  // Deleted between the guard and the lock: the guard's answer, given late.
  if (row?.deleted_at !== null) throw messageNotFound();
  if (row.sender_id !== userId) {
    throw new AppError({ code: 'FORBIDDEN', message: 'Only the author can edit a message.' });
  }

  const built = async (): Promise<Message> => {
    const message = await readBuilt(executor, messageId);
    if (message === undefined) throw messageNotFound();
    return message;
  };

  // The same words again are not an edit: nothing written, not marked edited (D-103 §6).
  if (row.content === content) {
    return {
      message: await built(),
      changed: false,
      version: row.state_version,
      recipients: [],
      unformatted: null,
    };
  }

  // The reading a send does, or its refusal (D-12, D-101).
  const { names, reading, metadata } = readBody(content, engine);

  const updated = await executor
    .updateTable('messages')
    .set({
      content,
      metadata,
      edited_at: clock.now(),
      updated_at: clock.now(),
      state_version: sql<number>`state_version + 1`,
    })
    .where('id', '=', messageId)
    .returning('state_version')
    .executeTakeFirstOrThrow();

  // The mention rows follow the content; what was told is not taken back (D-103 §5).
  const named = await resolveMentions(executor, context, names);
  const previous = (
    await executor
      .selectFrom('mentions')
      .select('mentioned_user_id')
      .where('message_id', '=', messageId)
      .execute()
  ).map((mention) => mention.mentioned_user_id);
  const gone = previous.filter((userId) => !named.includes(userId));
  if (gone.length > 0) {
    await executor
      .deleteFrom('mentions')
      .where('message_id', '=', messageId)
      .where('mentioned_user_id', 'in', gone)
      .execute();
  }
  const fresh = added(previous, named);
  if (fresh.length > 0) {
    await executor
      .insertInto('mentions')
      .values(
        fresh.map((mentioned) => ({
          workspace_id: context.workspaceId,
          channel_id: context.channelId,
          message_id: messageId,
          mentioned_user_id: mentioned,
        })),
      )
      .onConflict((conflict) => conflict.columns(['message_id', 'mentioned_user_id']).doNothing())
      .execute();
  }

  // One notification per person per message (D-99 §1): somebody already told about it — the
  // other side of a direct message, the author of the thread a reply answers — is counted for it
  // already, and a second would put their mentions above their unread messages (I-6). D-103 §5.
  const alreadyTold =
    fresh.length === 0
      ? new Set<string>()
      : new Set(
          (
            await executor
              .selectFrom('notifications')
              .select('user_id')
              .where('message_id', '=', messageId)
              .where('user_id', 'in', fresh)
              .execute()
          ).map((notification) => notification.user_id),
        );
  // And told once, ever: `notify` writes only a notification that is not held.
  const told = await notify(
    executor,
    context,
    messageId,
    new Map(
      fresh
        .filter((mentioned) => !alreadyTold.has(mentioned))
        .map((mentioned) => [mentioned, 'mention' as const]),
    ),
    clock.now(),
    new Date(row.created_at),
  );
  const recipients =
    told.length === 0
      ? []
      : await countMentions(executor, context, messageId, told, new Date(row.created_at));

  return {
    message: await built(),
    changed: true,
    version: updated.state_version,
    recipients,
    unformatted: reading.tree === null ? reading.reason : null,
    ...(reading.tree === null && reading.reason === 'engine'
      ? { engineFailure: reading.error }
      : {}),
  };
};

/**
 * One more unread mention for each person told, where the message is counted unread for them:
 * their position is before it, and they were in the channel when it was written. The unread
 * count is not touched — the message was counted when it was sent (I-6 holds by the same rule).
 */
const countMentions = async (
  executor: Executor,
  context: ChannelContext,
  messageId: string,
  told: readonly string[],
  writtenAt: Date,
): Promise<readonly ChannelStateUpdate[]> => {
  const changed = await executor
    .updateTable('channel_members')
    .set({
      unread_mention_count: sql<number>`unread_mention_count + 1`,
      state_version: sql<number>`state_version + 1`,
    })
    .where('channel_id', '=', context.channelId)
    .where('user_id', 'in', told)
    .where((eb) =>
      eb.or([eb('last_read_message_id', 'is', null), eb('last_read_message_id', '<', messageId)]),
    )
    .where('joined_at', '<=', writtenAt)
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

export interface EditDependencies {
  readonly atomically: Atomically;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly log?: Logger;
  readonly engine?: Engine;
}

/**
 * Edits a message: the one way in. Commits, then tells the room what changed and each person
 * whose numbers moved (D-35).
 */
export const edit = async (
  dependencies: EditDependencies,
  caller: { readonly userId: string; readonly sessionId: string },
  messageId: string,
  content: string,
): Promise<Message> => {
  const { atomically, clock, bus, log = NO_LOG, engine } = dependencies;
  const revised = await atomically(async (transaction) => {
    // The session the caller authenticated with, held live for this transaction (D-85).
    await requireLiveSession(transaction, clock, caller.sessionId);
    return await reviseMessage(transaction, clock, caller.userId, messageId, content, engine);
  });
  if (revised.unformatted === 'engine') {
    log.error('markdown engine failed inside its bounds', {
      messageId,
      length: content.length,
      err: revised.engineFailure,
    });
  }
  const { message } = revised;
  // The room first — the words changed — then each newly named person's own numbers (D-99 §2).
  // Nothing at all when the same words came again: nothing changed.
  await publishAfterCommit(log, [
    revised.changed
      ? [
          publication('MESSAGE_REVISED', () =>
            publishMessageRevised(
              bus,
              clock,
              {
                channelId: message.channelId,
                messageId: message.id,
                parentId: message.parentId,
                content: message.content,
                editedAt: message.editedAt,
                deletedAt: message.deletedAt,
                mentions: message.mentions,
              },
              revised.version,
            ),
          ),
        ]
      : [],
    revised.recipients.map((recipient) =>
      publication('CHANNEL_STATE', () =>
        publishChannelState(
          bus,
          clock,
          recipient.userId,
          revised.message.channelId,
          recipient.state,
          recipient.version,
        ),
      ),
    ),
  ]);
  return revised.message;
};
