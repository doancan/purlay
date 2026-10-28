import type { Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { requireChannelById } from '../../platform/channels';
import { DAY_MS, type Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { inboxPublications, publishAfterCommit, type EventBus } from '../../platform/events';
import type { Logger } from '../../platform/logging';
import { atomicallyOn } from '../../platform/transactions';
import { publishArrival, sendMessage } from '../messages/messages';
import type { PushSender } from '../push/sender';

interface Dependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly push?: PushSender;
}

/** Rolls the send back before recording a domain refusal in a new transaction. */
class RefusedDelivery extends Error {
  readonly id: string;
  readonly revision: number;
  readonly code: string;
  constructor(id: string, revision: number, code: string) {
    super(code);
    this.id = id;
    this.revision = revision;
    this.code = code;
  }
}

/** Each claimed row and its actual message commit together, across all API processes. */
export const deliverScheduled = async (dependencies: Dependencies): Promise<number> => {
  const { database, clock, bus, log, push } = dependencies;
  let delivered = 0;
  for (let count = 0; count < 100; count += 1) {
    try {
      const result = await atomicallyOn(database)(async (transaction) => {
        const row = await transaction
          .selectFrom('scheduled_messages')
          .selectAll()
          .where('state', '=', 'pending')
          .where('send_at', '<=', clock.now())
          .orderBy('send_at')
          .orderBy('id')
          .forUpdate()
          .skipLocked()
          .limit(1)
          .executeTakeFirst();
        if (row === undefined) return undefined;
        try {
          const context = await requireChannelById(transaction, row.user_id, row.channel_id);
          const files = await transaction
            .updateTable('attachments')
            .set({ scheduled_message_id: null })
            .where('scheduled_message_id', '=', row.id)
            .returning('id')
            .execute();
          const sent = await sendMessage(transaction, clock, context, {
            id: messageId(clock.now()),
            content: row.content,
            ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
            ...(files.length === 0 ? {} : { attachmentIds: files.map((file) => file.id) }),
          });
          await transaction
            .updateTable('scheduled_messages')
            .set({
              state: 'sent',
              sent_message_id: sent.message.id,
              updated_at: clock.now(),
            })
            .where('id', '=', row.id)
            .execute();
          return { context, sent };
        } catch (error) {
          if (error instanceof AppError)
            throw new RefusedDelivery(row.id, row.revision, error.body.code);
          throw error;
        }
      });
      if (result === undefined) break;
      const { context, sent } = result;
      delivered += 1;
      await publishArrival(
        dependencies,
        context.channelId,
        sent.message,
        sent.thread,
        sent.recipients,
      );
      await publishAfterCommit(log, [
        inboxPublications(bus, clock, context.workspaceId, sent.told),
      ]);
      push?.told(sent.message.id, sent.told);
    } catch (error) {
      if (!(error instanceof RefusedDelivery)) throw error;
      // A user may have edited or cancelled after the failed transaction released its lock.
      await database
        .updateTable('scheduled_messages')
        .set({
          state: 'failed',
          failure_code: error.code,
          updated_at: clock.now(),
        })
        .where('id', '=', error.id)
        .where('revision', '=', error.revision)
        .where('state', '=', 'pending')
        .execute();
    }
  }
  await database
    .deleteFrom('scheduled_messages')
    .where('state', '<>', 'pending')
    .where('updated_at', '<', new Date(clock.now().getTime() - 30 * DAY_MS))
    .execute();
  return delivered;
};
