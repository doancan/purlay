import type { ChatDb, ChatTx } from '../schema';
import { Value } from '@sinclair/typebox/value';
import { messageId, Uuid, type Message } from '@purlay/types';
import { requireChannelById, type ChannelContext } from '../channels/guard';
import { DAY_MS, type Clock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import { inboxPublications, publishAfterCommit, type EventBus } from '../../../platform/events';
import type { Logger } from '../../../platform/logging';
import { atomicallyOn } from '../../../platform/transactions';
import { publishArrival, sendMessage, type Sent } from '../messages/messages';
import {
  alreadySent,
  releaseReservations,
  scheduledNotFound,
  type ScheduledRow,
} from './scheduled';
import type { PushSender } from '../../../modules/push/sender';
import type { PushCapture } from '../../../modules/push/notices';
import { requireLiveSession } from '../../../modules/auth/sessions';
import { withinDeferredSource, type WorkspaceAccessLifetime } from '../../../platform/tenancy';

interface Dependencies {
  readonly database: ChatDb;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly push?: PushSender | undefined;
  readonly sessionLifetime?: () => WorkspaceAccessLifetime;
}

/** Rolls the send back before recording a domain refusal in a new transaction. */
class RefusedDelivery extends Error {
  readonly id: string;
  readonly revision: number;
  readonly refusal: AppError;
  constructor(id: string, revision: number, refusal: AppError) {
    super(refusal.body.code);
    this.id = id;
    this.revision = revision;
    this.refusal = refusal;
  }
}

interface Delivered {
  readonly context: ChannelContext;
  readonly sent: Sent;
}

/**
 * Sends one locked row as its author and marks it sent, in the caller's transaction. The scheduler and *Send now*
 * deliver by this one path, so both recheck the channel, the membership and the reply target the same way, and both
 * mint the message's UUIDv7 at the moment of delivery. A refusal comes out as a `RefusedDelivery`.
 */
const deliverRow = async (
  transaction: ChatTx,
  clock: Clock,
  row: ScheduledRow,
  capture?: PushCapture,
): Promise<Delivered> => {
  try {
    const context = await requireChannelById(transaction, row.user_id, row.channel_id);
    // Let go and sent in one transaction: the send claims each file again as it links it.
    const files = await releaseReservations(transaction, row.id);
    const sent = await sendMessage(
      transaction,
      clock,
      context,
      {
        id: messageId(clock.now()),
        content: row.content,
        ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
        ...(files.length === 0 ? {} : { attachmentIds: [...files] }),
      },
      undefined,
      capture,
    );
    await transaction
      .updateTable('scheduled_messages')
      // A failed row sent now forgets why it failed: the table holds a reason on failed rows alone.
      .set({
        state: 'sent',
        sent_message_id: sent.message.id,
        failure_code: null,
        updated_at: clock.now(),
      })
      .where('id', '=', row.id)
      .execute();
    return { context, sent };
  } catch (error) {
    if (error instanceof AppError) throw new RefusedDelivery(row.id, row.revision, error);
    throw error;
  }
};

/** Tells the room, each person told and their devices, once the delivery has committed (D-35). */
const announce = async (
  dependencies: Dependencies,
  { context, sent }: Delivered,
): Promise<void> => {
  const { bus, clock, log, push } = dependencies;
  await publishArrival(dependencies, context.channelId, sent.message, sent.thread, sent.recipients);
  await publishAfterCommit(log, [inboxPublications(bus, clock, context.workspaceId, sent.told)]);
  push?.told(sent.message.id, sent.told);
};

/**
 * Records why a row could not be sent, in a new transaction. The person may have edited or cancelled after the failed
 * one released its lock, so only the revision that was tried is marked, and never a row that went meanwhile.
 */
const markFailed = async (dependencies: Dependencies, refused: RefusedDelivery): Promise<void> => {
  await dependencies.database
    .updateTable('scheduled_messages')
    .set({
      state: 'failed',
      failure_code: refused.refusal.body.code,
      updated_at: dependencies.clock.now(),
    })
    .where('id', '=', refused.id)
    .where('revision', '=', refused.revision)
    .where('state', '<>', 'sent')
    .execute();
};

/** Each claimed row and its actual message commit together, across all API processes. */
export const deliverScheduled = async (dependencies: Dependencies): Promise<number> => {
  const { database, clock } = dependencies;
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
              // Skipped, not waited for: a row another node, or its author's Send now, holds is theirs to send.
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
              return await deliverRow(transaction, clock, row, dependencies.push?.capture);
            },
          );
        } catch (error) {
          // The author's original session that ended is refused here, before any row is touched.
          if (error instanceof AppError)
            throw new RefusedDelivery(candidate.id, candidate.revision, error);
          throw error;
        }
      });
      if (result === undefined) break;
      if ('skipped' in result) {
        skipped.add(result.skipped);
        continue;
      }
      delivered += 1;
      await announce(dependencies, result);
    } catch (error) {
      if (!(error instanceof RefusedDelivery)) throw error;
      await markFailed(dependencies, error);
    }
  }
  await database
    .deleteFrom('scheduled_messages')
    .where('state', '<>', 'pending')
    .where('updated_at', '<', new Date(clock.now().getTime() - 30 * DAY_MS))
    .execute();
  return delivered;
};

/**
 * *Send now*: the caller's own pending or failed scheduled message, delivered at once by the scheduler's path and
 * marked sent in the same transaction (D-324). The row is locked and waited for, never skipped: a scheduler that holds
 * it commits first and this answers `SCHEDULED_MESSAGE_SENT`, and one that comes second skips it, so a race and a
 * double press each make one message. A refusal at delivery is written on the row as the scheduler writes it, and is
 * the answer.
 */
export const sendScheduledNow = async (
  dependencies: Dependencies,
  caller: { readonly userId: string; readonly sessionId: string },
  channelId: string,
  scheduledId: string,
): Promise<Message> => {
  const { database, clock } = dependencies;
  const { userId, sessionId } = caller;
  let delivered: Delivered;
  try {
    delivered = await atomicallyOn(database)(async (transaction) => {
      await requireLiveSession(transaction, clock, sessionId);
      // The channel first: one the caller cannot see is not found whatever the draft's id (D-21).
      await requireChannelById(transaction, userId, channelId);
      if (!Value.Check(Uuid, scheduledId)) throw scheduledNotFound();
      const row = await transaction
        .selectFrom('scheduled_messages')
        .selectAll()
        .where('id', '=', scheduledId)
        .forUpdate()
        .executeTakeFirst();
      if (row?.user_id !== userId || row.channel_id !== channelId) throw scheduledNotFound();
      if (row.state === 'sent') throw alreadySent();
      return await deliverRow(transaction, clock, row, dependencies.push?.capture);
    });
  } catch (error) {
    if (!(error instanceof RefusedDelivery)) throw error;
    await markFailed(dependencies, error);
    throw error.refusal;
  }
  await announce(dependencies, delivered);
  return delivered.sent.message;
};
