import type { ChatDb } from '../schema';
import { messageId } from '@purlay/types';
import { requireChannelById } from '../channels/guard';
import { DAY_MS, type Clock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import { inboxPublications, publishAfterCommit, type EventBus } from '../../../platform/events';
import type { Logger } from '../../../platform/logging';
import { atomicallyOn } from '../../../platform/transactions';
import { publishArrival, sendMessage } from '../messages/messages';
import { releaseReservations } from './scheduled';
import type { PushSender } from '../../../modules/push/sender';
import { withinDeferredSource, type WorkspaceAccessLifetime } from '../../../platform/tenancy';

interface Dependencies {
  readonly database: ChatDb;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly push?: PushSender;
  readonly sessionLifetime?: () => WorkspaceAccessLifetime;
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
  const skipped = new Set<string>();
  for (let count = 0; count < 100; count += 1) {
    try {
      const result = await atomicallyOn(database)(async (transaction) => {
        let candidates = transaction
          .selectFrom('scheduled_messages')
          .selectAll()
          .where('state', '=', 'pending')
          .where('send_at', '<=', clock.now())
          .orderBy('send_at')
          .orderBy('id')
          .limit(1);
        if (skipped.size > 0) candidates = candidates.where('id', 'not in', [...skipped]);
        const candidate = await candidates.executeTakeFirst();
        if (candidate === undefined) return undefined;
        try {
          return await withinDeferredSource(
            { ...dependencies, database: transaction },
            { userId: candidate.user_id, sessionId: candidate.source_session_id },
            async () => {
              const row = await transaction
                .selectFrom('scheduled_messages')
                .selectAll()
                .where('id', '=', candidate.id)
                .where('revision', '=', candidate.revision)
                .where('state', '=', 'pending')
                .where(
                  'source_session_id',
                  candidate.source_session_id === null ? 'is' : '=',
                  candidate.source_session_id,
                )
                .forUpdate()
                .skipLocked()
                .executeTakeFirst();
              if (row === undefined) return { skipped: candidate.id };
              const context = await requireChannelById(transaction, row.user_id, row.channel_id);
              // Let go and sent in one transaction: the send claims each file again as it links it.
              const files = await releaseReservations(transaction, row.id);
              const sent = await sendMessage(transaction, clock, context, {
                id: messageId(clock.now()),
                content: row.content,
                ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
                ...(files.length === 0 ? {} : { attachmentIds: [...files] }),
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
            },
          );
        } catch (error) {
          if (error instanceof AppError)
            throw new RefusedDelivery(candidate.id, candidate.revision, error.body.code);
          throw error;
        }
      });
      if (result === undefined) break;
      if ('skipped' in result) {
        skipped.add(result.skipped);
        continue;
      }
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
