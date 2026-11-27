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
import { withinRequest } from '../../../platform/logging';
import { aRoom, notificationsOf, type Room } from '../../../testing/rooms';
import { setNotificationLevel } from '../channels/notification-level';
import { reviseMessage } from '../messages/edit';
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

const afterMinutes = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);

const aRepeat = async (
  db: Transaction,
  kind: 'private' | 'direct_message' = 'private',
): Promise<{
  readonly room: Room;
  readonly alice: Room['members'][string];
  readonly bob: Room['members'][string];
  readonly carol: Room['members'][string];
  readonly dave: Room['members'][string];
  readonly messageId: string;
  readonly originalId: string;
}> => {
  const room = await aRoom(db, ['alice', 'bob', 'carol', 'dave'], { type: kind });
  const { alice, bob, carol, dave } = room.members;
  if (alice === undefined || bob === undefined || carol === undefined || dave === undefined)
    throw new Error('the room has no Alice, Bob, Carol and Dave');
  await setNotificationLevel(db, clock, carol.context, 'all');
  const { message } = await sendMessage(db, clock, alice.context, {
    id: messageId(NOW),
    content: `@${bob.username} please help`,
    priority: 'urgent',
  });
  const original = await db
    .selectFrom('notifications')
    .select(['id', 'type'])
    .where('message_id', '=', message.id)
    .where('user_id', '=', bob.userId)
    .executeTakeFirstOrThrow();
  expect(original.type).toBe('mention');
  // Authority is tested here independently from how the original transaction schedules the receipt.
  await db
    .insertInto('urgent_message_repeats')
    .values({ notification_id: original.id, next_at: afterMinutes(2) })
    .onConflict((conflict) => conflict.column('notification_id').doNothing())
    .execute();
  return { room, alice, bob, carol, dave, messageId: message.id, originalId: original.id };
};

describe('integration: urgent repeat push source authority', () => {
  test('uses the original unread receipt through the 20-minute cutoff, even after its initial Deep Work', async () => {
    await withRollback(async (db) => {
      const { bob, messageId: id, originalId } = await aRepeat(db);
      await db
        .updateTable('notifications')
        .set({ suppressed_by_deep_work: true })
        .where('id', '=', originalId)
        .execute();

      expect(
        await chatPushNotices.canDeliver(db, id, bob.userId, afterMinutes(2), originalId),
      ).toBe(false);
      expect(await chatPushNotices.of(db, id, [bob.userId], originalId)).toEqual([]);
      expect(
        await chatPushNotices.canDeliver(db, id, bob.userId, afterMinutes(19), originalId, true),
      ).toBe(true);
      expect(await chatPushNotices.of(db, id, [bob.userId], originalId, true)).toHaveLength(1);
      expect(
        await chatPushNotices.canDeliver(db, id, bob.userId, afterMinutes(20), originalId, true),
      ).toBe(false);
      expect(
        await chatPushNotices.canDeliver(db, id, bob.userId, afterMinutes(2), undefined, true),
      ).toBe(false);
      expect(await chatPushNotices.of(db, id, [bob.userId], undefined, true)).toEqual([]);
    });
  });

  test('loses the repeat when the original mentioned name is removed, without adopting an edit’s new receipt', async () => {
    await withRollback(async (db) => {
      const { alice, bob, dave, messageId: id, originalId } = await aRepeat(db);
      await reviseMessage(
        db,
        fixedClock(afterMinutes(1)),
        alice.userId,
        id,
        `@${dave.username} please help`,
      );
      const newReceipt = await db
        .selectFrom('notifications')
        .select(['id', 'type'])
        .where('message_id', '=', id)
        .where('user_id', '=', dave.userId)
        .executeTakeFirstOrThrow();
      expect(newReceipt.type).toBe('mention');
      expect(
        await chatPushNotices.canDeliver(db, id, bob.userId, afterMinutes(2), originalId, true),
      ).toBe(false);
      expect(await chatPushNotices.of(db, id, [bob.userId], originalId, true)).toEqual([]);
      expect(
        await chatPushNotices.canDeliver(db, id, dave.userId, afterMinutes(2), newReceipt.id, true),
      ).toBe(false);
      expect(await chatPushNotices.of(db, id, [dave.userId], newReceipt.id, true)).toEqual([]);
    });
  });

  test('still addresses a DM participant whose original mention was edited out', async () => {
    await withRollback(async (db) => {
      const { alice, bob, carol, messageId: id, originalId } = await aRepeat(db, 'direct_message');
      await reviseMessage(db, fixedClock(afterMinutes(1)), alice.userId, id, 'please help');
      expect(
        await chatPushNotices.canDeliver(db, id, bob.userId, afterMinutes(2), originalId, true),
      ).toBe(true);
      expect(
        (await chatPushNotices.of(db, id, [bob.userId, carol.userId], originalId, true)).map(
          (notice) => notice.userId,
        ),
      ).toEqual([bob.userId]);
    });
  });

  test('asks again about exact receipt, current unread state, workspace policy and schedule', async () => {
    await withRollback(async (db) => {
      const { room, bob, carol, messageId: id, originalId } = await aRepeat(db);
      const now = afterMinutes(2);
      const follower = await db
        .selectFrom('notifications')
        .select(['id', 'type'])
        .where('message_id', '=', id)
        .where('user_id', '=', carol.userId)
        .executeTakeFirstOrThrow();
      expect(follower.type).toBe('channel_message');
      await db
        .insertInto('urgent_message_repeats')
        .values({ notification_id: follower.id, next_at: now })
        .execute();
      expect(await chatPushNotices.canDeliver(db, id, carol.userId, now, follower.id, true)).toBe(
        false,
      );
      expect(await chatPushNotices.of(db, id, [carol.userId], follower.id, true)).toEqual([]);
      expect(await chatPushNotices.canDeliver(db, id, bob.userId, now, follower.id, true)).toBe(
        false,
      );
      expect(await chatPushNotices.canDeliver(db, id, bob.userId, now, originalId, true)).toBe(
        true,
      );

      await db
        .updateTable('workspaces')
        .set({ urgent_messages_enabled: false })
        .where('id', '=', room.workspaceId)
        .execute();
      expect(await chatPushNotices.canDeliver(db, id, bob.userId, now, originalId, true)).toBe(
        false,
      );
      expect(await chatPushNotices.of(db, id, [bob.userId], originalId, true)).toEqual([]);
      await db
        .updateTable('workspaces')
        .set({ urgent_messages_enabled: true })
        .where('id', '=', room.workspaceId)
        .execute();
      await db
        .updateTable('messages')
        .set({ priority: 'important' })
        .where('id', '=', id)
        .execute();
      expect(await chatPushNotices.canDeliver(db, id, bob.userId, now, originalId, true)).toBe(
        false,
      );
      expect(await chatPushNotices.of(db, id, [bob.userId], originalId, true)).toEqual([]);
      await db.updateTable('messages').set({ priority: 'urgent' }).where('id', '=', id).execute();
      await db
        .updateTable('notifications')
        .set({ read_at: now })
        .where('id', '=', originalId)
        .execute();
      expect(await chatPushNotices.canDeliver(db, id, bob.userId, now, originalId, true)).toBe(
        false,
      );
      await db
        .updateTable('notifications')
        .set({ read_at: null })
        .where('id', '=', originalId)
        .execute();
      await db
        .deleteFrom('urgent_message_repeats')
        .where('notification_id', '=', originalId)
        .execute();
      expect(await chatPushNotices.canDeliver(db, id, bob.userId, now, originalId, true)).toBe(
        false,
      );
      expect(await chatPushNotices.of(db, id, [bob.userId], originalId, true)).toEqual([]);
    });
  });

  test('observes a read during workspace admission and requires device admission for an eligible receipt', async () => {
    await withRollback(async (db) => {
      const { room, bob, messageId: id, originalId } = await aRepeat(db);
      await db
        .updateTable('workspaces')
        .set({ access_policy_epoch: '1' })
        .where('id', '=', room.workspaceId)
        .execute();
      const now = afterMinutes(2);
      const allowed = (): Promise<boolean> =>
        chatPushNotices.canDeliver(db, id, bob.userId, now, originalId, true);

      expect(await allowed().catch((error: unknown) => error)).toMatchObject({
        body: { code: 'WORKSPACE_ACCESS_REQUIRED' },
      });
      expect(
        await withinRequest(
          {
            requestId: 'receipt-read-during-admission',
            startedAt: 0,
            workspaceAccess: async (executor) => {
              await executor
                .updateTable('notifications')
                .set({ read_at: now })
                .where('id', '=', originalId)
                .execute();
            },
          },
          allowed,
        ),
      ).toBe(false);
      expect(await allowed()).toBe(false);
    });
  });

  test('checks current mute and refuses to expand a hidden or inaccessible source', async () => {
    await withRollback(async (db) => {
      const { room, bob, messageId: id, originalId } = await aRepeat(db);
      const eligible = (minutes: number): Promise<boolean> =>
        chatPushNotices.canDeliver(db, id, bob.userId, afterMinutes(minutes), originalId, true);
      await setNotificationLevel(db, clock, bob.context, 'none', afterMinutes(3).toISOString());
      expect(await eligible(2)).toBe(false);
      expect(await eligible(4)).toBe(true);
      await db
        .insertInto('hidden_messages')
        .values({
          message_id: id,
          user_id: bob.userId,
          channel_id: room.channelId,
          workspace_id: room.workspaceId,
        })
        .execute();
      expect(await eligible(4)).toBe(false);
      expect(await chatPushNotices.of(db, id, [bob.userId], originalId, true)).toEqual([]);
      await db.deleteFrom('hidden_messages').where('message_id', '=', id).execute();
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', bob.userId)
        .execute();
      expect(await eligible(4)).toBe(false);
      expect(await chatPushNotices.of(db, id, [bob.userId], originalId, true)).toEqual([]);
    });
  });
});
