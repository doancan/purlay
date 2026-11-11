import { sql, type Selectable, type ScheduledMessages } from '@purlay/db';
import type { ChatDb, ChatTx } from '../schema';
import { Value } from '@sinclair/typebox/value';
import {
  Uuid,
  SCHEDULED_MESSAGES_MAX,
  SCHEDULE_AHEAD_MAX_DAYS,
  type ScheduleMessageRequest,
  type ScheduledMessage,
  type ScheduledMessageList,
} from '@purlay/types';
import { AppError } from '../../../platform/errors';
import { DAY_MS, type Clock } from '../../../platform/clock';
import {
  requireChannelById,
  requireChannelMember,
  requireThreadContextById,
  visibleChannelIds,
} from '../channels/guard';
import type { WorkspaceContext } from '../../../platform/tenancy';
import { asAttachment } from '../../../modules/attachments/uploads';
import { readBody } from '../messages/body';

const missing = (): AppError =>
  new AppError({ code: 'SCHEDULED_MESSAGE_NOT_FOUND', message: 'Scheduled message not found.' });
const alreadySent = (): AppError =>
  new AppError({ code: 'SCHEDULED_MESSAGE_SENT', message: 'This message has already been sent.' });

type ScheduledRow = Selectable<ScheduledMessages>;

/**
 * Lets go of the files a draft reserved and answers their ids. The trigger on `scheduled_message_attachments`
 * gives each file's claim back as its row goes, so a file let go is an unsent upload again.
 */
export const releaseReservations = async (
  transaction: ChatTx,
  scheduledId: string,
): Promise<readonly string[]> => {
  const released = await transaction
    .deleteFrom('scheduled_message_attachments')
    .where('scheduled_message_id', '=', scheduledId)
    .returning('attachment_id')
    .execute();
  // In the order they were uploaded (their ids are v7), as a send lists them.
  return released.map((row) => row.attachment_id).sort();
};
const rowById = async (db: ChatDb, id: string): Promise<ScheduledRow | undefined> =>
  await db.selectFrom('scheduled_messages').selectAll().where('id', '=', id).executeTakeFirst();

/** Attachments are loaded for the whole list, never one query per scheduled message. */
const build = async (db: ChatDb, rows: readonly ScheduledRow[]): Promise<ScheduledMessageList> => {
  if (rows.length === 0) return [];
  const attachments = await db
    .selectFrom('scheduled_message_attachments as reserved')
    .innerJoin('attachments', 'attachments.id', 'reserved.attachment_id')
    .selectAll('attachments')
    .select('reserved.scheduled_message_id')
    .where(
      'reserved.scheduled_message_id',
      'in',
      rows.map((row) => row.id),
    )
    .orderBy('attachments.id')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    parentId: row.parent_id,
    content: row.content,
    attachments: attachments
      .filter((file) => file.scheduled_message_id === row.id)
      .map(asAttachment),
    sendAt: row.send_at.toISOString(),
    state: row.state,
    sentMessageId: row.sent_message_id,
    failureCode: row.failure_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
};

/** Full replacement of an owned pending/failed draft. The id makes a retried create one draft. */
export const scheduleMessage = async (
  transaction: ChatTx,
  clock: Clock,
  userId: string,
  channelId: string,
  scheduledId: string,
  input: ScheduleMessageRequest,
): Promise<ScheduledMessage> => {
  // The channel first: one the caller cannot see is not found whatever the draft's id (D-21).
  const context = await requireChannelById(transaction, userId, channelId);
  if (!Value.Check(Uuid, scheduledId)) throw missing();
  await requireChannelMember(transaction, context, 'Join the channel before scheduling a message.');
  // Serializes the per-person, per-workspace bound, including creates with different ids.
  await transaction
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const existing = await transaction
    .selectFrom('scheduled_messages')
    .selectAll()
    .where('id', '=', scheduledId)
    .forUpdate()
    .executeTakeFirst();
  if (existing !== undefined && (existing.user_id !== userId || existing.channel_id !== channelId))
    throw missing();
  if (existing?.state === 'sent') throw alreadySent();
  const now = clock.now();
  const sendAt = new Date(input.sendAt);
  const ahead = sendAt.getTime() - now.getTime();
  if (!Number.isFinite(ahead) || ahead < 5_000 || ahead > SCHEDULE_AHEAD_MAX_DAYS * DAY_MS) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Choose a future time within the next year.',
      details: { fields: { sendAt: 'between five seconds and one year from now' } },
    });
  }
  const attachmentIds = input.attachmentIds ?? [];
  if (input.content.trim() === '' && attachmentIds.length === 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'A message needs words or an attachment.',
      details: { fields: { content: 'words or an attachment' } },
    });
  }
  readBody(input.content);
  if (input.parentId !== undefined) {
    const parent = await requireThreadContextById(transaction, userId, input.parentId);
    if (parent.context.channelId !== channelId || parent.parentId !== null) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Reply to a root in this channel.',
        details: { fields: { parentId: 'a root message in this channel' } },
      });
    }
  }
  if (existing === undefined) {
    const count = await transaction
      .selectFrom('scheduled_messages')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('user_id', '=', userId)
      .where('workspace_id', '=', context.workspaceId)
      .where('state', 'in', ['pending', 'failed'])
      .executeTakeFirstOrThrow();
    if (count.count >= SCHEDULED_MESSAGES_MAX) {
      throw new AppError({
        code: 'SCHEDULED_MESSAGE_LIMIT',
        message: 'Remove a scheduled message before adding another.',
      });
    }
    const inserted = await transaction
      .insertInto('scheduled_messages')
      .values({
        id: scheduledId,
        user_id: userId,
        workspace_id: context.workspaceId,
        channel_id: channelId,
        parent_id: input.parentId ?? null,
        content: input.content,
        send_at: sendAt,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted === undefined) throw missing();
  } else {
    await transaction
      .updateTable('scheduled_messages')
      .set({
        parent_id: input.parentId ?? null,
        content: input.content,
        send_at: sendAt,
        state: 'pending',
        failure_code: null,
        updated_at: now,
        revision: sql<number>`revision + 1`,
      })
      .where('id', '=', scheduledId)
      .execute();
  }
  // Release old reservations, then claim exactly the requested own uploads, in this transaction. A file is
  // reserved in chat's own table and claimed in the core's words (D-250): the claim keeps the orphan sweep, a
  // send and a discard off it, and the table's trigger gives it back when the reservation goes.
  await releaseReservations(transaction, scheduledId);
  if (attachmentIds.length > 0) {
    const reserved = await transaction
      .updateTable('attachments')
      .set({ claimed_at: now })
      .where('id', 'in', attachmentIds)
      .where('workspace_id', '=', context.workspaceId)
      .where('uploader_id', '=', userId)
      .where('claimed_at', 'is', null)
      .returning('id')
      .execute();
    if (reserved.length !== attachmentIds.length) {
      throw new AppError({
        code: 'ATTACHMENT_NOT_FOUND',
        message: 'An attachment is unavailable or already scheduled.',
      });
    }
    await transaction
      .insertInto('scheduled_message_attachments')
      .values(
        reserved.map((file) => ({
          attachment_id: file.id,
          workspace_id: context.workspaceId,
          scheduled_message_id: scheduledId,
        })),
      )
      .execute();
  }
  const row = await rowById(transaction, scheduledId);
  if (row === undefined) throw missing();
  const [built] = await build(transaction, [row]);
  if (built === undefined) throw missing();
  return built;
};

export const cancelScheduledMessage = async (
  transaction: ChatTx,
  userId: string,
  channelId: string,
  scheduledId: string,
): Promise<void> => {
  await requireChannelById(transaction, userId, channelId);
  if (!Value.Check(Uuid, scheduledId)) throw missing();
  const row = await transaction
    .selectFrom('scheduled_messages')
    .select(['user_id', 'channel_id', 'state'])
    .where('id', '=', scheduledId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) return;
  if (row.user_id !== userId || row.channel_id !== channelId) throw missing();
  if (row.state === 'sent') throw alreadySent();
  await transaction.deleteFrom('scheduled_messages').where('id', '=', scheduledId).execute();
};

export const scheduledMessages = async (
  db: ChatDb,
  context: WorkspaceContext,
): Promise<ScheduledMessageList> => {
  const visible = await visibleChannelIds(db, context);
  if (visible.length === 0) return [];
  const rows = await db
    .selectFrom('scheduled_messages')
    .selectAll()
    .where('user_id', '=', context.userId)
    .where('workspace_id', '=', context.workspaceId)
    .where('channel_id', 'in', visible)
    .where('state', 'in', ['pending', 'failed'])
    .orderBy('send_at')
    .orderBy('id')
    .limit(SCHEDULED_MESSAGES_MAX)
    .execute();
  return await build(db, rows);
};
