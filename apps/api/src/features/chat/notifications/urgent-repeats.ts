/** One cursor per original directed notification. Missed slots expire in place. */
import { createHash } from 'node:crypto';
import { isTransaction } from '@purlay/db';
import { enqueuePush, URGENT_REPEAT_KIND } from '../../../modules/push/notices';
import type { PushSender } from '../../../modules/push/sender';
import { inDeepWork } from '../../../modules/workspaces/deep-work';
import type { Clock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import { atomicallyOn } from '../../../platform/transactions';
import type { ChatDb } from '../schema';
import { chatPushNotices, URGENT_REPEAT_WINDOW_MS } from './push-notices';

const INTERVAL_MS = 2 * 60_000;
const BATCH_SIZE = 100;

export const armUrgentRepeats = async (
  database: ChatDb,
  at: Date,
  notificationIds: readonly string[],
): Promise<void> => {
  if (notificationIds.length === 0) return;
  if (!isTransaction(database))
    throw new Error('Urgent repeats must commit with their notifications');
  const nextAt = new Date(at.getTime() + INTERVAL_MS);
  await database
    .insertInto('urgent_message_repeats')
    .values(notificationIds.map((id) => ({ notification_id: id, next_at: nextAt })))
    .execute();
};

/** A deterministic version 8 UUID identifies a slot across retries and racing workers. */
const occurrenceId = (notificationId: string, slot: number): string => {
  const digest = createHash('sha256')
    .update(`purlay/urgent-repeat/v1:${notificationId}:${String(slot)}`)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const stillEligible = async (
  database: ChatDb,
  row: { readonly notificationId: string; readonly messageId: string; readonly userId: string },
  now: Date,
): Promise<boolean> => {
  try {
    return await chatPushNotices.canDeliver(
      database,
      row.messageId,
      row.userId,
      now,
      row.notificationId,
      true,
    );
  } catch (error) {
    // The push queue and sender check the recipient's exact live device session where policy
    // needs it. The scheduler has no recipient session to supply to the workspace guard.
    if (error instanceof AppError && error.body.code === 'WORKSPACE_ACCESS_REQUIRED') return true;
    throw error;
  }
};

export const deliverUrgentRepeats = async ({
  database,
  clock,
  push,
}: {
  readonly database: ChatDb;
  readonly clock: Clock;
  readonly push?: PushSender;
}): Promise<number> => {
  let captured = 0;
  const skipped: string[] = [];
  for (let index = 0; index < BATCH_SIZE; index += 1) {
    const result = await atomicallyOn(database)(async (tx) => {
      const now = clock.now();
      let due = tx
        .selectFrom('urgent_message_repeats as repeat')
        .innerJoin('notifications as notice', 'notice.id', 'repeat.notification_id')
        .innerJoin('workspaces as workspace', 'workspace.id', 'notice.workspace_id')
        .select([
          'notice.id as notificationId',
          'notice.workspace_id as workspaceId',
          'repeat.next_at as nextAt',
          'workspace.urgent_messages_enabled as enabled',
          'workspace.deleted_at as workspaceDeletedAt',
        ])
        .where('repeat.next_at', '<=', now)
        .orderBy('repeat.next_at')
        .orderBy('repeat.notification_id')
        .limit(1);
      if (skipped.length > 0) due = due.where('repeat.notification_id', 'not in', skipped);
      // Workspace deletion can hold the workspace while cascading through notifications.
      // Take workspace first, before the cursor and before push capture takes its workspace FK.
      const candidate = await due.forKeyShare('workspace').skipLocked().executeTakeFirst();
      if (candidate === undefined) return undefined;
      const row = await tx
        .selectFrom('urgent_message_repeats as repeat')
        .innerJoin('notifications as notice', 'notice.id', 'repeat.notification_id')
        .select([
          'notice.id as notificationId',
          'notice.user_id as userId',
          'notice.message_id as messageId',
          'notice.created_at as createdAt',
          'notice.read_at as readAt',
        ])
        .where('repeat.notification_id', '=', candidate.notificationId)
        .where('repeat.next_at', '=', candidate.nextAt)
        .forUpdate('repeat')
        .skipLocked()
        .executeTakeFirst();
      if (row === undefined) return { skipped: candidate.notificationId };
      const at = row.createdAt.getTime();
      const cursor = tx
        .updateTable('urgent_message_repeats')
        .where('notification_id', '=', row.notificationId);
      if (at + URGENT_REPEAT_WINDOW_MS <= now.getTime()) {
        await tx
          .deleteFrom('urgent_message_repeats')
          .where('notification_id', '=', row.notificationId)
          .execute();
        return {};
      }

      const slot = Math.floor((now.getTime() - at) / INTERVAL_MS);
      const createdAt = new Date(at + slot * INTERVAL_MS);
      const expiresAt = new Date(createdAt.getTime() + INTERVAL_MS);
      const eligible =
        candidate.workspaceDeletedAt === null &&
        candidate.enabled &&
        row.readAt === null &&
        !(await inDeepWork(tx, candidate.workspaceId, [row.userId], now)).has(row.userId) &&
        (await stillEligible(tx, row, now));
      if (eligible)
        await (push?.capture ?? enqueuePush)(tx, now, [
          {
            source: 'message',
            sourceId: occurrenceId(row.notificationId, slot),
            recordId: row.messageId,
            userId: row.userId,
            workspaceId: candidate.workspaceId,
            module: 'chat',
            kind: URGENT_REPEAT_KIND,
            createdAt,
            repeat: { notificationId: row.notificationId, expiresAt },
          },
        ]);
      await cursor.set({ next_at: expiresAt }).execute();
      return eligible ? { told: row } : {};
    });
    if (result === undefined) break;
    if (result.skipped !== undefined) skipped.push(result.skipped);
    if (result.told !== undefined) {
      push?.told(result.told.messageId, [result.told.userId]);
      captured += 1;
    }
  }
  return captured;
};
