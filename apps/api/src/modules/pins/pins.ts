/**
 * A channel's pinned messages (#485, D-130): what its members keep at hand for everyone in it.
 *
 * - **A member's to change, everyone's to see.** Pinning and unpinning find the message through the
 *   caller's visible channels in one query (`requireMessageById`); seeing a public channel is not
 *   being in it, so a visible non-member is refused `403`, as for renaming it (D-123 §1). The list
 *   is read through the channel's context, by anyone who can see the channel.
 * - **At most `PINS_MAX` a channel**, counted over pins of messages not deleted, under the channel's
 *   row locked: two pins racing at the bound cannot both be the last.
 * - **A change says whether it was one.** Pinning what is pinned, or letting go of what is not,
 *   changes nothing and tells nobody; the caller's answer is the same.
 * - **What the list shows**: messages not deleted, newest pin first, each with who pinned it.
 */
import type { Executor, Transaction } from '@purlay/db';
import { PINS_MAX, type PinList } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { channelNotFound, requireMessageById, type ChannelContext } from '../../platform/channels';
import { AppError } from '../../platform/errors';
import { buildMessages, MESSAGE_COLUMNS } from '../messages/reader';

const at = (value: Date | string): string => new Date(value).toISOString();

/** What a pin or an unpin did: the channel it is in, and whether anything changed there. */
export interface PinChange {
  readonly channelId: string;
  readonly changed: boolean;
}

/**
 * The channel's row, locked for the change, and the caller a member of it. Archived between the
 * guard's read and this lock is gone, as the guard would now say.
 */
const lockForMember = async (executor: Transaction, context: ChannelContext): Promise<void> => {
  const row = await executor
    .selectFrom('channels')
    .select('id')
    .where('id', '=', context.channelId)
    .where('deleted_at', 'is', null)
    // NO KEY UPDATE: the lock a send's own write takes, so a message pointing here is not made to wait.
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (row === undefined) throw channelNotFound();
  const member = await executor
    .selectFrom('channel_members')
    .select('user_id')
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .executeTakeFirst();
  if (member === undefined) {
    throw new AppError({ code: 'FORBIDDEN', message: 'Join the channel to pin in it.' });
  }
};

/** Pins the message for everyone in its channel; pinned already, it is left as it was. */
export const pinMessage = async (
  transaction: Transaction,
  clock: Clock,
  userId: string,
  messageId: string,
): Promise<PinChange> => {
  const { context } = await requireMessageById(transaction, userId, messageId);
  await lockForMember(transaction, context);
  const existing = await transaction
    .selectFrom('pinned_messages')
    .select('message_id')
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  if (existing !== undefined) return { channelId: context.channelId, changed: false };
  const counted = await transaction
    .selectFrom('pinned_messages')
    .innerJoin('messages', 'messages.id', 'pinned_messages.message_id')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('pinned_messages.channel_id', '=', context.channelId)
    .where('messages.deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  if (Number(counted.count) >= PINS_MAX) {
    throw new AppError({
      code: 'PINS_LIMIT',
      message: `At most ${String(PINS_MAX)} pinned messages a channel; unpin one first.`,
    });
  }
  await transaction
    .insertInto('pinned_messages')
    .values({
      message_id: messageId,
      channel_id: context.channelId,
      workspace_id: context.workspaceId,
      pinned_by: userId,
      pinned_at: clock.now(),
    })
    .execute();
  return { channelId: context.channelId, changed: true };
};

/** Lets the pin go, if there is one; a deleted message's pin can still be let go. */
export const unpinMessage = async (
  transaction: Transaction,
  userId: string,
  messageId: string,
): Promise<PinChange> => {
  const { context } = await requireMessageById(transaction, userId, messageId, {
    deleted: 'include',
  });
  await lockForMember(transaction, context);
  const removed = await transaction
    .deleteFrom('pinned_messages')
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  return { channelId: context.channelId, changed: removed.numDeletedRows > 0n };
};

/** The channel's pins, newest first, of messages not deleted. Bounded by `PINS_MAX`: not paged. */
export const channelPins = async (
  executor: Executor,
  context: ChannelContext,
): Promise<PinList> => {
  const rows = await executor
    .selectFrom('pinned_messages')
    .innerJoin('messages', 'messages.id', 'pinned_messages.message_id')
    .innerJoin('users', 'users.id', 'messages.sender_id')
    .leftJoin('users as pinner', 'pinner.id', 'pinned_messages.pinned_by')
    .select(MESSAGE_COLUMNS)
    .select([
      'pinned_messages.pinned_at as pinned_at',
      'pinner.id as pinner_id',
      'pinner.username as pinner_username',
      'pinner.display_name as pinner_display_name',
      'pinner.avatar_url as pinner_avatar_url',
    ])
    .where('pinned_messages.channel_id', '=', context.channelId)
    .where('messages.deleted_at', 'is', null)
    .orderBy('pinned_messages.pinned_at', 'desc')
    .orderBy('pinned_messages.message_id', 'desc')
    .limit(PINS_MAX)
    .execute();
  const messages = await buildMessages(executor, rows);
  return rows.map((row, index) => {
    const message = messages[index];
    // One message per row, in order: a row without one would vanish and look like a shorter list.
    if (message?.id !== row.id) throw new Error(`pin of ${row.id} lost its message`);
    return {
      message,
      pinnedBy:
        row.pinner_id === null || row.pinner_username === null || row.pinner_display_name === null
          ? null
          : {
              id: row.pinner_id,
              username: row.pinner_username,
              displayName: row.pinner_display_name,
              avatarUrl: row.pinner_avatar_url,
            },
      pinnedAt: at(row.pinned_at),
    };
  });
};
