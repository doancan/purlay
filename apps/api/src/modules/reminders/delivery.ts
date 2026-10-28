import type { Executor } from '@purlay/db';
import { requireMessageById } from '../../platform/channels';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import {
  inboxPublications,
  publication,
  publishAfterCommit,
  publishRemindersUpdated,
  type EventBus,
} from '../../platform/events';
import type { Logger } from '../../platform/logging';
import { atomicallyOn } from '../../platform/transactions';
import type { PushSender } from '../push/sender';

/** A reminder is personal attention to an existing message, not a second unread message. */
export const deliverReminders = async ({
  database,
  clock,
  bus,
  log,
  push,
}: {
  readonly database: Executor;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly push?: PushSender;
}): Promise<number> => {
  let delivered = 0;
  for (let count = 0; count < 100; count += 1) {
    const result = await atomicallyOn(database)(async (tx) => {
      const row = await tx
        .selectFrom('message_reminders')
        .selectAll()
        .where('remind_at', '<=', clock.now())
        .orderBy('remind_at')
        .orderBy('id')
        .forUpdate()
        .skipLocked()
        .limit(1)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      let visible = true;
      try {
        await requireMessageById(tx, row.user_id, row.message_id);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        visible = false;
      }
      await tx.deleteFrom('message_reminders').where('id', '=', row.id).execute();
      if (visible) {
        visible =
          (await tx
            .selectFrom('hidden_messages')
            .select('user_id')
            .where('user_id', '=', row.user_id)
            .where('message_id', '=', row.message_id)
            .executeTakeFirst()) === undefined;
      }
      if (visible) {
        const member = await tx
          .selectFrom('workspace_members')
          .select('deep_work_until')
          .where('user_id', '=', row.user_id)
          .where('workspace_id', '=', row.workspace_id)
          .executeTakeFirst();
        // A newly armed reminder gets a new inbox id, including after an earlier one was read.
        await tx
          .deleteFrom('notifications')
          .where('user_id', '=', row.user_id)
          .where('message_id', '=', row.message_id)
          .where('type', '=', 'reminder')
          .execute();
        await tx
          .insertInto('notifications')
          .values({
            user_id: row.user_id,
            workspace_id: row.workspace_id,
            channel_id: row.channel_id,
            message_id: row.message_id,
            type: 'reminder',
            created_at: clock.now(),
            suppressed_by_deep_work:
              member?.deep_work_until != null && member.deep_work_until > clock.now(),
          })
          .execute();
      }
      return { row, visible };
    });
    if (result === undefined) break;
    const { row, visible } = result;
    await publishAfterCommit(log, [
      [
        publication('REMINDERS_UPDATED', async () => {
          await publishRemindersUpdated(bus, clock, row.user_id, row.workspace_id);
        }),
      ],
      visible ? inboxPublications(bus, clock, row.workspace_id, [row.user_id]) : [],
    ]);
    if (visible) {
      delivered += 1;
      push?.told(row.message_id, [row.user_id]);
    }
  }
  return delivered;
};
