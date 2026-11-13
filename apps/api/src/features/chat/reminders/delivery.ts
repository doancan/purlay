import type { ChatDb } from '../schema';
import { requireMessageById } from '../channels/guard';
import type { Clock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import {
  inboxPublications,
  publication,
  publishAfterCommit,
  publishRemindersUpdated,
  type EventBus,
} from '../../../platform/events';
import type { Logger } from '../../../platform/logging';
import { atomicallyOn } from '../../../platform/transactions';
import { enqueuePush } from '../../../modules/push/notices';
import type { PushSender } from '../../../modules/push/sender';
import { withinDeferredSource, type WorkspaceAccessLifetime } from '../../../platform/tenancy';

/** A reminder is personal attention to an existing message, not a second unread message. */
export const deliverReminders = async ({
  database,
  clock,
  bus,
  log,
  push,
  sessionLifetime,
}: {
  readonly database: ChatDb;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly push?: PushSender;
  readonly sessionLifetime?: () => WorkspaceAccessLifetime;
}): Promise<number> => {
  let delivered = 0;
  const skipped = new Set<string>();
  for (let count = 0; count < 100; count += 1) {
    const result = await atomicallyOn(database)(async (tx) => {
      let candidates = tx
        .selectFrom('message_reminders')
        .selectAll()
        .where('remind_at', '<=', clock.now())
        .orderBy('remind_at')
        .orderBy('id')
        .limit(1);
      if (skipped.size > 0) candidates = candidates.where('id', 'not in', [...skipped]);
      const candidate = await candidates.executeTakeFirst();
      if (candidate === undefined) return undefined;
      const claim = async (): Promise<typeof candidate | undefined> =>
        await tx
          .selectFrom('message_reminders')
          .selectAll()
          .where('id', '=', candidate.id)
          .where('remind_at', '=', candidate.remind_at)
          .where(
            'source_session_id',
            candidate.source_session_id === null ? 'is' : '=',
            candidate.source_session_id,
          )
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
      try {
        return await withinDeferredSource(
          { database: tx, clock, ...(sessionLifetime === undefined ? {} : { sessionLifetime }) },
          { userId: candidate.user_id, sessionId: candidate.source_session_id },
          async () => {
            const row = await claim();
            if (row === undefined) return { skipped: candidate.id };
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
              const createdAt = clock.now();
              const notice = await tx
                .insertInto('notifications')
                .values({
                  user_id: row.user_id,
                  workspace_id: row.workspace_id,
                  channel_id: row.channel_id,
                  message_id: row.message_id,
                  type: 'reminder',
                  created_at: createdAt,
                  suppressed_by_deep_work:
                    member?.deep_work_until != null && member.deep_work_until > clock.now(),
                })
                .returning(['id', 'suppressed_by_deep_work'])
                .executeTakeFirstOrThrow();
              if (!notice.suppressed_by_deep_work)
                await enqueuePush(tx, createdAt, [
                  {
                    source: 'message',
                    sourceId: notice.id,
                    recordId: row.message_id,
                    workspaceId: row.workspace_id,
                    userId: row.user_id,
                    module: 'chat',
                    kind: 'reminder',
                    createdAt,
                  },
                ]);
            }
            return { row, visible };
          },
        );
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const row = await claim();
        if (row === undefined) return { skipped: candidate.id };
        await tx.deleteFrom('message_reminders').where('id', '=', row.id).execute();
        return { row, visible: false };
      }
    });
    if (result === undefined) break;
    if ('skipped' in result) {
      skipped.add(result.skipped);
      continue;
    }
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
