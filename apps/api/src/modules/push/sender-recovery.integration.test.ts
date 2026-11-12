/** A retained subscription must also recover its unread delivery after the sender restarts. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId } from '@purlay/types';
import { credentialCipher } from '../../platform/crypto';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { nobodyActive } from '../../platform/attention';
import { NO_LOG } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { NOW, testConfig } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { aSession } from '../../testing/signed-in';
import { aBrowser, aPushService, KEYS } from '../../testing/push-service';
import { TEST_PUSH_POLICY } from '../../testing/push-config';
import { movable } from '../../testing/push-world';
import { send } from '../../features/chat/messages/messages';
import { chatPushNotices } from '../../features/chat/notifications/push-notices';
import { pushConfiguration } from './settings';
import { noNoticeWords } from './notices';
import { createPushSender, type PushSenderDependencies } from './sender';

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration: sender recovery', () => {
  test('a fresh sender retries an unread notification left by a temporary provider failure', async () => {
    await withRollback(async (db) => {
      const clock = movable(NOW);
      const room = await aRoom(db, ['ada', 'bob'], { type: 'direct_message' });
      const ada = room.members['ada']!;
      const bob = room.members['bob']!;
      const browser = await aBrowser();
      const session = await aSession(db, clock, bob.userId, 30);
      await pushConfiguration(db, credentialCipher(DEVELOPMENT_ENCRYPTION_KEY), clock, {
        ...testConfig(),
        VAPID_PUBLIC_KEY: KEYS.publicKey,
        VAPID_PRIVATE_KEY: KEYS.privateKey,
        VAPID_SUBJECT: KEYS.subject,
      }).view();
      await db
        .insertInto('push_subscriptions')
        .values({
          user_id: bob.userId,
          session_id: session.sessionId,
          endpoint: 'https://push.example.com/send/recovery',
          p256dh: browser.p256dh,
          auth: browser.auth,
          server_key: KEYS.publicKey,
        })
        .execute();
      const service = aPushService();
      let status = 503;
      const dependencies: PushSenderDependencies = {
        database: db,
        clock,
        log: NO_LOG,
        keys: KEYS,
        attention: nobodyActive,
        notices: chatPushNotices,
        noticeWords: noNoticeWords,
        ...TEST_PUSH_POLICY,
        post: async (url, headers, body) => {
          await service.post(url, headers, body);
          return { kind: 'answered', status };
        },
      };
      const first = await createPushSender(dependencies);
      await send(
        {
          atomically: atomicallyOn(db),
          clock,
          log: NO_LOG,
          bus: {
            publish: (): Promise<void> => Promise.resolve(),
            subscribe: (): boolean => false,
            unsubscribe: (): void => undefined,
            forget: (): void => undefined,
          },
          push: first,
        },
        ada.context,
        { id: messageId(clock.now()), content: 'A message that still needs Bob' },
      );
      await first.flush();
      expect(service.sent).toHaveLength(1);
      expect(
        await db
          .selectFrom('push_subscriptions')
          .select('id')
          .where('user_id', '=', bob.userId)
          .execute(),
      ).toHaveLength(1);

      status = 201;
      clock.to(new Date(NOW.getTime() + 30_000));
      const restarted = await createPushSender(dependencies);
      await restarted.releaseHeld();
      await restarted.flush();
      expect(service.sent).toHaveLength(2);
      expect(JSON.stringify(await browser.read(service.sent[1]!.body))).toContain(
        `/c/${room.channelId}`,
      );
    });
  });
});
