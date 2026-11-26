/** @needs-modules chat */
import { afterAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, closeIntegrationDatabase } from '@purlay/db';
import { messageId } from '@purlay/types';
import { exportPKCS8, generateKeyPair } from 'jose';
import { chatPushNotices } from '../../features/chat/notifications/push-notices';
import { deliverUrgentRepeats } from '../../features/chat/notifications/urgent-repeats';
import { createApnsProvider } from '../../modules/push/apns';
import { noNoticeWords } from '../../modules/push/notices';
import { createPushSender } from '../../modules/push/sender';
import { apnsScopeOf } from '../../platform/apns-credentials';
import { nobodyActive } from '../../platform/attention';
import { SESSION_COOKIE } from '../../platform/cookies';
import { NO_LOG } from '../../platform/events';
import { NOW, testDependencies } from '../../testing/doubles';
import { enableTestPush, TEST_PUSH_POLICY } from '../../testing/push-config';
import { aBrowser, KEYS } from '../../testing/push-service';
import { movable } from '../../testing/push-world';
import { aRoom, counters } from '../../testing/rooms';
import { aSession } from '../../testing/signed-in';
import { createApp } from './app';

afterAll(closeIntegrationDatabase);

const { privateKey } = await generateKeyPair('ES256', { extractable: true });
const credentials = {
  environment: 'sandbox',
  teamId: 'TESTTEAM00',
  keyId: 'TESTKEY000',
  topic: 'com.purlay.ios',
  signingKey: await exportPKCS8(privateKey),
} as const;
const scope = apnsScopeOf(credentials);
const deviceToken = 'ab12'.repeat(16);

describe('integration: urgent chat delivery through APNs and Web Push', () => {
  test('an urgent chat message alerts at send, +2 and +4 until a different session reads it', async () => {
    const cloned = await cloneIntegrationDatabase();
    try {
      const database = cloned.db;
      const clock = movable(NOW);
      const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);
      const room = await aRoom(database, ['alice', 'bob'], { type: 'direct_message' });
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      if (alice === undefined || bob === undefined) throw new Error('Incomplete urgent DM fixture');
      const writer = await aSession(database, clock, alice.userId);
      const phone = await aSession(database, clock, bob.userId);
      const webSession = await aSession(database, clock, bob.userId);
      const reader = await aSession(database, clock, bob.userId);
      expect(reader.sessionId).not.toBe(phone.sessionId);
      expect(reader.sessionId).not.toBe(webSession.sessionId);
      await enableTestPush(database, clock);
      const browser = await aBrowser();
      const endpoint = 'https://push.example.com/send/urgent-chat';

      const posts: { at: Date; collapseId: string | null; body: string }[] = [];
      const webPosts: { at: Date; topic: string | undefined; body: Uint8Array }[] = [];
      const send = await createApnsProvider(credentials, clock, (url, options) => {
        expect(url.pathname).toBe(`/3/device/${deviceToken}`);
        if (typeof options.body !== 'string') throw new Error('Missing APNs JSON body');
        posts.push({
          at: clock.now(),
          collapseId: new Headers(options.headers).get('apns-collapse-id'),
          body: options.body,
        });
        return Promise.resolve(new Response(null, { status: 200 }));
      });
      const push = await createPushSender({
        database,
        clock,
        keys: KEYS,
        post: (url, headers, body) => {
          expect(url.href).toBe(endpoint);
          expect(headers['content-encoding']).toBe('aes128gcm');
          webPosts.push({ at: clock.now(), topic: headers['topic'], body });
          return Promise.resolve({ kind: 'answered', status: webPosts.length === 2 ? 503 : 201 });
        },
        log: NO_LOG,
        attention: nobodyActive,
        notices: chatPushNotices,
        noticeWords: noNoticeWords,
        ...TEST_PUSH_POLICY,
        apns: { scope, send },
      });
      const app = createApp(testDependencies({ database, clock, push, apnsScope: scope }));
      const request = (
        method: 'POST' | 'PUT',
        path: string,
        token: string,
        body: unknown,
      ): Promise<Response> =>
        app.handle(
          new Request(`https://purlay.test${path}`, {
            method,
            headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${token}` },
            body: JSON.stringify(body),
          }),
        );
      expect(
        (await request('POST', '/api/push/apns/subscriptions', phone.token, { deviceToken }))
          .status,
      ).toBe(204);
      expect(
        (
          await request('POST', '/api/push/subscriptions', webSession.token, {
            endpoint,
            keys: { p256dh: browser.p256dh, auth: browser.auth },
            locale: 'en',
          })
        ).status,
      ).toBe(204);

      const id = messageId(NOW);
      const content = 'a private instruction that must never enter the alert';
      const channel = `/api/channels/${room.channelId}`;
      const sent = await request('POST', `${channel}/messages`, writer.token, {
        id,
        content,
        priority: 'urgent',
      });
      expect(sent.status).toBe(201);
      await push.flush(10_000);
      expect(posts.map(({ at: time }) => time)).toEqual([NOW]);
      expect(webPosts.map(({ at: time }) => time)).toEqual([NOW]);

      const receipts = async (): Promise<{ id: string; type: string; read_at: Date | null }[]> =>
        await database
          .selectFrom('notifications')
          .select(['id', 'type', 'read_at'])
          .where('message_id', '=', id)
          .where('user_id', '=', bob.userId)
          .execute();
      const original = await receipts();
      expect(original).toMatchObject([{ type: 'direct_message', read_at: null }]);
      expect(await counters(database, room, bob.userId)).toMatchObject({ unread: 1, mentions: 1 });
      const retryAt = new Date(at(2).getTime() + 5_000);
      for (const minute of [1, 2, 4]) {
        clock.to(at(minute));
        expect(await deliverUrgentRepeats({ database, clock, push })).toBe(minute < 2 ? 0 : 1);
        await push.flush(10_000);
        if (minute === 2) {
          clock.to(retryAt);
          await push.flush(10_000);
        }
      }
      expect(posts.map(({ at: time }) => time)).toEqual([NOW, at(2), at(4)]);
      expect(new Set(posts.map(({ collapseId }) => collapseId)).size).toBe(3);
      expect(posts[0]?.body).toContain('alice wrote to you');
      expect(posts[1]?.body).toContain('Urgent · alice wrote to you');
      expect(posts[2]?.body).toContain('Urgent · alice wrote to you');
      expect(posts.every(({ body }) => !body.includes(content))).toBe(true);
      expect(webPosts.map(({ at: time }) => time)).toEqual([NOW, at(2), retryAt, at(4)]);
      const topics = webPosts.map(({ topic }) => topic);
      expect(topics.every((topic) => typeof topic === 'string' && /^[\w-]{32}$/.test(topic))).toBe(
        true,
      );
      expect(topics[2]).toBe(topics[1]);
      expect(new Set(topics).size).toBe(3);
      const payloads = await Promise.all(webPosts.map(({ body }) => browser.read(body)));
      expect(payloads).toMatchObject(
        ['alice wrote to you', ...Array<string>(3).fill('Urgent · alice wrote to you')].map(
          (body) => ({ body, tag: `channel:${room.channelId}`, silent: false }),
        ),
      );
      expect(JSON.stringify(payloads)).not.toContain(content);
      expect(await receipts()).toEqual(original);
      expect(await counters(database, room, bob.userId)).toMatchObject({ unread: 1, mentions: 1 });

      clock.to(at(5));
      const read = await request('PUT', `${channel}/read`, reader.token, { lastReadMessageId: id });
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({
        lastReadMessageId: id,
        unreadCount: 0,
        unreadMentionCount: 0,
      });
      expect(await receipts()).toEqual(original.map((receipt) => ({ ...receipt, read_at: at(5) })));
      for (const minute of [6, 8, 18, 20]) {
        clock.to(at(minute));
        expect(await deliverUrgentRepeats({ database, clock, push })).toBe(0);
        await push.flush(10_000);
      }
      expect(posts).toHaveLength(3);
      expect(webPosts).toHaveLength(4);
      expect(await counters(database, room, bob.userId)).toEqual({
        lastRead: id,
        unread: 0,
        mentions: 0,
      });
    } finally {
      await cloned.drop();
    }
  }, 60_000);
});
