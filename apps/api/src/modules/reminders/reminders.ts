import { notHiddenBy } from '../messages/hidden';
import { sql, type Executor, type Transaction } from '@purlay/db';
import {
  MESSAGE_REMINDERS_MAX,
  SCHEDULE_AHEAD_MAX_DAYS,
  type MessageReminder,
  type MessageReminderList,
} from '@purlay/types';
import { messageNotFound, requireMessageById, visibleChannelIds } from '../../platform/channels';
import { DAY_MS, type Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { WorkspaceContext } from '../../platform/tenancy';
import { buildMessages, MESSAGE_COLUMNS, readBuilt } from '../messages/reader';

export const setReminder = async (
  tx: Transaction,
  clock: Clock,
  userId: string,
  messageId: string,
  remindAt: string,
): Promise<MessageReminder> => {
  const { context } = await requireMessageById(tx, userId, messageId);
  const date = new Date(remindAt);
  const ahead = date.getTime() - clock.now().getTime();
  if (!Number.isFinite(ahead) || ahead < 5_000 || ahead > SCHEDULE_AHEAD_MAX_DAYS * DAY_MS) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Choose a future time within the next year.',
      details: { fields: { remindAt: 'between five seconds and one year from now' } },
    });
  }
  await tx
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const existing = await tx
    .selectFrom('message_reminders')
    .select('id')
    .where('user_id', '=', userId)
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  if (existing === undefined) {
    const { count } = await tx
      .selectFrom('message_reminders')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('user_id', '=', userId)
      .where('workspace_id', '=', context.workspaceId)
      .executeTakeFirstOrThrow();
    if (count >= MESSAGE_REMINDERS_MAX)
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Cancel a pending reminder before adding another.',
        details: { fields: { reminders: 'at most 100 pending reminders' } },
      });
  }
  const row = await tx
    .insertInto('message_reminders')
    .values({
      user_id: userId,
      workspace_id: context.workspaceId,
      channel_id: context.channelId,
      message_id: messageId,
      remind_at: date,
      created_at: clock.now(),
    })
    .onConflict((conflict) =>
      conflict.columns(['user_id', 'message_id']).doUpdateSet({ remind_at: date }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  const message = await readBuilt(tx, messageId);
  if (message === undefined) throw messageNotFound();
  return {
    id: row.id,
    message,
    remindAt: row.remind_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
};

export const cancelReminder = async (
  tx: Transaction,
  userId: string,
  messageId: string,
): Promise<string> => {
  const { context } = await requireMessageById(tx, userId, messageId, { deleted: 'include' });
  await tx
    .deleteFrom('message_reminders')
    .where('user_id', '=', userId)
    .where('message_id', '=', messageId)
    .execute();
  return context.workspaceId;
};

export const reminderList = async (
  db: Executor,
  context: WorkspaceContext,
): Promise<MessageReminderList> => {
  const visible = await visibleChannelIds(db, context);
  if (visible.length === 0) return [];
  const rows = await db
    .selectFrom('message_reminders')
    .innerJoin('messages', 'messages.id', 'message_reminders.message_id')
    .leftJoin('users', 'users.id', 'messages.sender_id')
    .select(MESSAGE_COLUMNS)
    .select([
      'message_reminders.id as reminder_id',
      'message_reminders.remind_at',
      'message_reminders.created_at as reminder_created_at',
    ])
    .where('message_reminders.user_id', '=', context.userId)
    .where('message_reminders.workspace_id', '=', context.workspaceId)
    .where('message_reminders.channel_id', 'in', visible)
    .where('messages.deleted_at', 'is', null)
    .where(notHiddenBy(context.userId))
    .orderBy('message_reminders.remind_at')
    .orderBy('message_reminders.id')
    .limit(MESSAGE_REMINDERS_MAX)
    .execute();
  const built = new Map((await buildMessages(db, rows)).map((message) => [message.id, message]));
  return rows.flatMap((row) => {
    const message = built.get(row.id);
    return message === undefined
      ? []
      : [
          {
            id: row.reminder_id,
            message,
            remindAt: row.remind_at.toISOString(),
            createdAt: row.reminder_created_at.toISOString(),
          },
        ];
  });
};
