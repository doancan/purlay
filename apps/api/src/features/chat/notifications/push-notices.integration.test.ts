/**
 * What chat answers push when it asks, as a queued notice is about to go, whether it still may (D-250,
 * `modules/push/notices.ts`): each thing that ends the right to be told is changed after the notice was written, and the
 * answer is read from `canDeliver` itself, not from the sender that asks it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  withRollback,
  type Executor,
  type Transaction,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { aRoom, notificationsOf, type Room } from '../../../testing/rooms';
import { setNotificationLevel } from '../channels/notification-level';
import { sendMessage } from '../messages/messages';
import { chatPushNotices } from './push-notices';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

/** Bob has asked to be told of every message; Alice writes one: the notice that is then queued for him. */
const aQueuedNotice = async (
  db: Transaction,
): Promise<{
  readonly bob: NonNullable<Room['members'][string]>;
  readonly message: string;
}> => {
  const room = await aRoom(db, ['alice', 'bob']);
  const [alice, bob] = [room.members['alice'], room.members['bob']];
  if (alice === undefined || bob === undefined) throw new Error('the room has no Alice and Bob');
  await setNotificationLevel(db, clock, bob.context, 'all');
  const sent = await sendMessage(db, clock, alice.context, {
    id: messageId(NOW),
    content: 'a plain message',
  });
  const notices = await notificationsOf(db, bob.userId);
  expect(notices).toHaveLength(1);
  return { bob, message: sent.message.id };
};

const mayDeliver = async (db: Executor, message: string, userId: string): Promise<boolean> =>
  await chatPushNotices.canDeliver(db, message, userId, NOW);

describe('integration: a queued notice is asked about as the push goes', () => {
  test('is deliverable when nothing has changed since it was written', async () => {
    await withRollback(async (db) => {
      const { bob, message } = await aQueuedNotice(db);
      expect(await mayDeliver(db, message, bob.userId)).toBe(true);
    });
  });

  test('is not, once what it told the person is no longer a reason to push', async () => {
    await withRollback(async (db) => {
      const { bob, message } = await aQueuedNotice(db);
      await db
        .updateTable('notifications')
        .set({ type: 'thread_resolved' })
        .where('message_id', '=', message)
        .where('user_id', '=', bob.userId)
        .execute();
      expect(await mayDeliver(db, message, bob.userId)).toBe(false);
    });
  });

  test('is not, once Deep Work has held it back', async () => {
    await withRollback(async (db) => {
      const { bob, message } = await aQueuedNotice(db);
      await db
        .updateTable('notifications')
        .set({ suppressed_by_deep_work: true })
        .where('message_id', '=', message)
        .where('user_id', '=', bob.userId)
        .execute();
      expect(await mayDeliver(db, message, bob.userId)).toBe(false);
    });
  });

  test('is not, once the person is suspended', async () => {
    await withRollback(async (db) => {
      const { bob, message } = await aQueuedNotice(db);
      await db
        .updateTable('users')
        .set({ suspended_at: NOW })
        .where('id', '=', bob.userId)
        .execute();
      expect(await mayDeliver(db, message, bob.userId)).toBe(false);
    });
  });

  test('is not, once the person’s account is deleted', async () => {
    await withRollback(async (db) => {
      const { bob, message } = await aQueuedNotice(db);
      await db.updateTable('users').set({ deleted_at: NOW }).where('id', '=', bob.userId).execute();
      expect(await mayDeliver(db, message, bob.userId)).toBe(false);
    });
  });

  test('is not, once the message it was about is deleted', async () => {
    await withRollback(async (db) => {
      const { bob, message } = await aQueuedNotice(db);
      await db.updateTable('messages').set({ deleted_at: NOW }).where('id', '=', message).execute();
      expect(await mayDeliver(db, message, bob.userId)).toBe(false);
    });
  });
});
