/**
 * A channel's files (#485, D-129): every attachment of a message in it, newest message first.
 *
 * - **Only the channel's, and only through its context.** The caller reached the channel through
 *   `ChannelContext`; the rows are found by `message_attachments.channel_id`, which the link sets and a
 *   key binds to the message's own channel (I-1).
 * - **What the channel shows.** An unattached upload is its uploader's alone and is never listed; a
 *   deleted message's files go with its words, as the tombstone hides them (D-109 §6).
 * - **Keyset on the message, then the file.** A message carries several (`ATTACHMENTS_PER_MESSAGE_MAX`),
 *   so the cursor is a file's id and the next page starts after it within its message.
 */
import { sql, type Executor } from '@purlay/db';
import type { FilePage, FileQuery } from '@purlay/types';
import { AppError } from '../../../platform/errors';
import type { ChannelContext } from './guard';
import { limitOf } from '../../../platform/pagination';
import { asAttachment } from '../../../modules/attachments/uploads';

const at = (value: Date | string): string => new Date(value).toISOString();

/** The message the cursor's file is in, within this channel; a file elsewhere is no cursor here. */
const cursorOf = async (
  executor: Executor,
  context: ChannelContext,
  before: string,
): Promise<string> => {
  const row = await executor
    .selectFrom('message_attachments')
    .select('message_id')
    .where('attachment_id', '=', before)
    .where('channel_id', '=', context.channelId)
    .executeTakeFirst();
  if (row === undefined) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'That file is not in this channel.',
      details: { fields: { before: 'is not a file of this channel' } },
    });
  }
  return row.message_id;
};

export const channelFiles = async (
  executor: Executor,
  context: ChannelContext,
  query: FileQuery,
): Promise<FilePage> => {
  const limit = limitOf(query);
  let statement = executor
    .selectFrom('message_attachments')
    .innerJoin('attachments', 'attachments.id', 'message_attachments.attachment_id')
    .innerJoin('messages', 'messages.id', 'message_attachments.message_id')
    // Only a person's message carries files (an event has none), so the join keeps every one.
    .innerJoin('users', 'users.id', 'messages.sender_id')
    .select([
      'attachments.id',
      'attachments.workspace_id',
      'attachments.uploader_id',
      'attachments.file_name',
      'attachments.mime_type',
      'attachments.size_bytes',
      'attachments.kind',
      'attachments.width',
      'attachments.height',
      'messages.id as message_id',
      'messages.parent_id',
      'messages.created_at',
      'users.id as sender_id',
      'users.username',
      'users.display_name',
      'users.avatar_url',
    ])
    .where('message_attachments.channel_id', '=', context.channelId)
    .where('messages.deleted_at', 'is', null)
    .orderBy('message_attachments.message_id', 'desc')
    .orderBy('message_attachments.attachment_id', 'desc')
    .limit(limit + 1);
  if (query.before !== undefined) {
    const message = await cursorOf(executor, context, query.before);
    statement = statement.where(
      sql<boolean>`(message_attachments.message_id, message_attachments.attachment_id) < (${message}, ${query.before})`,
    );
  }
  const rows = await statement.execute();
  const page = rows.slice(0, limit);
  return {
    data: page.map((row) => ({
      attachment: asAttachment(row),
      messageId: row.message_id,
      parentId: row.parent_id,
      sender: {
        id: row.sender_id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
      },
      sentAt: at(row.created_at),
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
};
