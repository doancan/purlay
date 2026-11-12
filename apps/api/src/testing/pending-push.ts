/** A real unread chat occurrence captured with one or more browsers, without an after-commit hint. */
import type { Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { nobodyActive } from '../platform/attention';
import { NO_LOG, type EventBus } from '../platform/events';
import { atomicallyOn } from '../platform/transactions';
import { send } from '../features/chat/messages/messages';
import { chatPushNotices } from '../features/chat/notifications/push-notices';
import { noNoticeWords } from '../modules/push/notices';
import type { PushPost, PushSenderDependencies } from '../modules/push/sender';
import { NOW } from './doubles';
import { enableTestPush, TEST_PUSH_POLICY } from './push-config';
import { aBrowser, KEYS } from './push-service';
import { movable } from './push-world';
import { aRoom, type Room } from './rooms';
import { aSession } from './signed-in';

export const PUSH_QUIET_BUS: EventBus = {
  publish: (): Promise<void> => Promise.resolve(),
  subscribe: (): boolean => false,
  unsubscribe: (): void => undefined,
  forget: (): void => undefined,
};

interface PendingPush {
  readonly clock: ReturnType<typeof movable>;
  readonly room: Room;
  readonly reader: string;
  readonly message: string;
  readonly notification: string;
  readonly devices: readonly { id: string; browser: Awaited<ReturnType<typeof aBrowser>> }[];
  readonly dependencies: (post: PushPost) => PushSenderDependencies;
}

export const pendingPush = async (database: Executor, deviceCount = 1): Promise<PendingPush> => {
  const clock = movable(NOW);
  const room = await aRoom(database, ['writer', 'reader'], { type: 'private' });
  const recipient = room.members['reader'];
  const writer = room.members['writer'];
  if (recipient === undefined || writer === undefined)
    throw new Error('Incomplete push fixture room');
  const reader = recipient.userId;
  await enableTestPush(database, clock);
  const devices: { id: string; browser: Awaited<ReturnType<typeof aBrowser>> }[] = [];
  for (let n = 0; n < deviceCount; n += 1) {
    const browser = await aBrowser();
    const session = await aSession(database, clock, reader, 30);
    const row = await database
      .insertInto('push_subscriptions')
      .values({
        user_id: reader,
        session_id: session.sessionId,
        endpoint: `https://push.example.com/${reader}/${String(n)}`,
        p256dh: browser.p256dh,
        auth: browser.auth,
        server_key: KEYS.publicKey,
        created_at: new Date(NOW.getTime() - 1_000 + n),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    devices.push({ id: row.id, browser });
  }
  const message = await send(
    { atomically: atomicallyOn(database), clock, bus: PUSH_QUIET_BUS },
    writer.context,
    { id: messageId(clock.now()), content: `@${recipient.username} private text` },
  );
  const notification = await database
    .selectFrom('notifications')
    .select('id')
    .where('message_id', '=', message.id)
    .where('user_id', '=', reader)
    .executeTakeFirstOrThrow();
  return {
    clock,
    room,
    reader,
    message: message.id,
    notification: notification.id,
    devices,
    dependencies: (post): PushSenderDependencies => ({
      database,
      clock,
      log: NO_LOG,
      keys: KEYS,
      attention: nobodyActive,
      notices: chatPushNotices,
      noticeWords: noNoticeWords,
      ...TEST_PUSH_POLICY,
      post,
    }),
  };
};
