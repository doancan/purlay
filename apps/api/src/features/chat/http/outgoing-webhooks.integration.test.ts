import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import {
  CreatedOutgoingWebhook,
  CreatedIncomingWebhook,
  OutgoingWebhookList,
  WebhookDeliveryPage,
} from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { SESSION_COOKIE } from '../../../platform/cookies';
import { createApp } from '../../../ingress/http/app';
import { aRoom } from '../../../testing/rooms';
import { aSession } from '../../../testing/signed-in';
import { aRecordingLogger, testDependencies } from '../../../testing/doubles';

const clock = fixedClock(new Date('2026-11-14T12:00:00.000Z'));
afterAll(async () => {
  await closeIntegrationDatabase();
});
describe('integration: outgoing webhooks over HTTP', () => {
  test('admin configures, tests, inspects, pauses, resumes, rotates and revokes with no secret in logs', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const owner = await aSession(db, clock, room.members['alice']?.userId ?? '', 30);
      const member = await aSession(db, clock, room.members['bob']?.userId ?? '', 30);
      const { log, lines } = aRecordingLogger();
      const app = createApp(testDependencies({ database: db, clock, log }));
      const call = async (
        method: string,
        path: string,
        body?: unknown,
        token = owner.token,
      ): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test/api/channels/${room.channelId}/${path}`, {
            method,
            headers: {
              cookie: `${SESSION_COOKIE}=${token}`,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      expect((await call('GET', 'outgoing-webhooks', undefined, member.token)).status).toBe(403);
      expect((await call('GET', 'outgoing-webhooks', undefined, '')).status).toBe(401);
      for (const body of [
        { name: 'CI', url: 'http://example.com', events: ['message.created'] },
        { name: '', url: 'https://example.com', events: [] },
        { name: 'CI', url: 'https://127.0.0.1', events: ['message.created'] },
      ])
        expect((await call('POST', 'outgoing-webhooks', body)).status).toBe(400);
      const response = await call('POST', 'outgoing-webhooks', {
        name: 'CI',
        url: 'https://example.com/hook',
        events: ['message.created'],
      });
      expect(response.status).toBe(201);
      const created: unknown = await response.json();
      if (!Value.Check(CreatedOutgoingWebhook, created)) throw new Error('bad hook');
      const path = `outgoing-webhooks/${created.webhook.id}`;
      const listed: unknown = await (await call('GET', 'outgoing-webhooks')).json();
      expect(Value.Check(OutgoingWebhookList, listed)).toBe(true);
      expect(JSON.stringify(listed)).not.toContain(created.secret);
      expect((await call('POST', `${path}/test`)).status).toBe(204);
      const page: unknown = await (await call('GET', `${path}/deliveries`)).json();
      if (!Value.Check(WebhookDeliveryPage, page)) throw new Error('bad page');
      expect(page.data).toHaveLength(1);
      const id = page.data[0]?.id ?? '';
      expect((await call('GET', `${path}/deliveries/${id}/attempts`)).status).toBe(200);
      expect((await call('GET', `${path}/deliveries?limit=bad`)).status).toBe(400);
      expect((await call('PATCH', path, { paused: true })).status).toBe(204);
      expect((await call('PATCH', path, { paused: false })).status).toBe(204);
      const rotated: unknown = await (await call('POST', `${path}/secret`)).json();
      if (!Value.Check(CreatedOutgoingWebhook, rotated)) throw new Error('bad rotated hook');
      expect(rotated.secret).not.toBe(created.secret);
      expect((await call('DELETE', path)).status).toBe(204);
      expect((await call('POST', `${path}/test`)).status).toBe(404);
      const incoming: unknown = await (
        await call('POST', 'incoming-webhooks', { name: 'CI' })
      ).json();
      if (!Value.Check(CreatedIncomingWebhook, incoming)) throw new Error('bad incoming');
      expect((await call('POST', `incoming-webhooks/${incoming.webhook.id}/secret`)).status).toBe(
        200,
      );
      expect(JSON.stringify(lines)).not.toContain(created.secret);
      expect(JSON.stringify(lines)).not.toContain(rotated.secret);
    });
  });
});
