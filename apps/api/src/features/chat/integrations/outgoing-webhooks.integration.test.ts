import type { Transaction } from '@purlay/db';
import type { CreatedOutgoingWebhook, WebhookPayload } from '@purlay/types';
import type { ChannelContext } from '../channels/guard';
import type { EventBus } from '../../../platform/events';
import type { Logger } from '../../../platform/logging';
import type { Sent } from '../messages/messages';
import type { WebhookPost } from './webhook-dispatcher';
interface World {
  readonly room: Awaited<ReturnType<typeof aRoom>>;
  readonly alice: ChannelContext;
  readonly bob: ChannelContext;
  readonly created: CreatedOutgoingWebhook;
  readonly send: (content?: string, parentId?: string) => Promise<Sent>;
  readonly run: (post?: WebhookPost, at?: Date) => ReturnType<typeof dispatchWebhooks>;
  readonly log: Logger;
  readonly bus: EventBus;
}
/** Real SQL proof of the channel webhook contract, including bad-day paths (D-312). */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { credentialCipher } from '../../../platform/crypto';
import { atomicallyOn } from '../../../platform/transactions';
import { aRecordingLogger, testConfig } from '../../../testing/doubles';
import { aRoom } from '../../../testing/rooms';
import { sendMessage } from '../messages/messages';
import { setResolved } from '../messages/threads';
import { tombstoneRows } from '../messages/tombstone';
import { createWebhook, rotateIncomingWebhook, receivePost } from './incoming-webhooks';
import {
  createOutgoingWebhook,
  changeOutgoingWebhook,
  enqueueWebhookEvent,
  listOutgoingWebhooks,
  outgoingDeliveries,
  retryOutgoingDelivery,
  rotateOutgoingWebhook,
  deliveryAttempts,
  testOutgoingWebhook,
} from './outgoing-webhooks';
import { dispatchWebhooks, sweepWebhookDeliveries, webhookSignature } from './webhook-dispatcher';
import { AppError } from '../../../platform/errors';
const now = new Date('2026-11-14T12:00:00.000Z');
const clock = fixedClock(now);
const cipher = credentialCipher(testConfig().ENCRYPTION_KEY);
afterAll(async () => {
  await closeIntegrationDatabase();
});
const refusal = async (work: Promise<unknown>): Promise<string> =>
  await work.then(
    () => 'accepted',
    (error: unknown) => {
      if (error instanceof AppError) return error.body.code;
      throw error;
    },
  );
const world = async (db: Transaction): Promise<World> => {
  const room = await aRoom(db, ['alice', 'bob']);
  const alice = room.members['alice']?.context;
  const bob = room.members['bob']?.context;
  if (alice === undefined || bob === undefined) throw new Error('missing room members');
  const created = await createOutgoingWebhook(db, clock, cipher, alice, {
    name: 'CI İstanbul 🐈',
    url: 'https://example.com/hook',
    events: ['message.created', 'thread.resolved', 'thread.reopened'],
  });
  const send = async (content = 'secret text', parentId?: string): Promise<Sent> =>
    await sendMessage(db, clock, alice, {
      id: messageId(now),
      content,
      ...(parentId === undefined ? {} : { parentId }),
    });
  const log = aRecordingLogger().log;
  const bus: EventBus = {
    publish: () => Promise.resolve(),
    subscribe: () => false,
    unsubscribe: () => undefined,
    forget: () => undefined,
  };
  const run = async (
    post: WebhookPost = () => Promise.resolve({ status: 204, error: null }),
    at = now,
  ): ReturnType<typeof dispatchWebhooks> =>
    await dispatchWebhooks({
      database: db,
      clock: fixedClock(at),
      cipher,
      log,
      post,
      random: () => 0.5,
    });
  return { room, alice, bob, created, send, run, log, bus };
};
describe('integration: outgoing webhooks', () => {
  test('human send queues once, with an immutable versioned payload, a sealed key and a valid signature', async () => {
    await withRollback(async (db) => {
      const w = await world(db);
      const sent = await w.send();
      await sendMessage(db, clock, w.alice, { id: sent.message.id, content: 'secret text' });
      const rows = await db
        .selectFrom('webhook_deliveries')
        .selectAll()
        .where('webhook_id', '=', w.created.webhook.id)
        .execute();
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(rows[0]?.payload ?? '') as WebhookPayload;
      expect(payload).toMatchObject({
        type: 'message.created',
        version: 1,
        workspaceId: w.room.workspaceId,
        channelId: w.room.channelId,
        data: { messageId: sent.message.id, content: 'secret text', senderId: w.alice.userId },
      });
      const stored = await db
        .selectFrom('outgoing_webhooks')
        .select('secret_encrypted')
        .where('id', '=', w.created.webhook.id)
        .executeTakeFirstOrThrow();
      expect(stored.secret_encrypted).not.toContain(w.created.secret);
      const result = await w.run((url, headers, bytes) => {
        expect(url.href).toBe('https://example.com/hook');
        expect(headers['x-purlay-id']).toBe(payload.id);
        expect(headers['x-purlay-signature']).toBe(
          webhookSignature(
            w.created.secret,
            headers['x-purlay-timestamp'] ?? '',
            new TextDecoder().decode(bytes),
          ),
        );
        return Promise.resolve({ status: 204, error: null });
      });
      expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
      expect((await outgoingDeliveries(db, w.alice, w.created.webhook.id)).data[0]?.state).toBe(
        'succeeded',
      );
      expect(
        await deliveryAttempts(db, w.alice, w.created.webhook.id, rows[0]?.id ?? ''),
      ).toHaveLength(1);
      expect((await w.run()).claimed).toBe(0);
    });
  });
  test('thread transitions queue only when changed, and events from integrations never loop', async () => {
    await withRollback(async (db) => {
      const w = await world(db);
      const root = await w.send('question');
      await w.send('answer', root.message.id);
      const deps = { atomically: atomicallyOn(db), clock, bus: w.bus };
      await setResolved(deps, w.alice.userId, root.message.id, true);
      await setResolved(deps, w.alice.userId, root.message.id, true);
      await setResolved(deps, w.alice.userId, root.message.id, false);
      const types = (
        await db
          .selectFrom('webhook_deliveries')
          .select('event_type')
          .where('webhook_id', '=', w.created.webhook.id)
          .execute()
      ).map((r) => r.event_type);
      expect(types.sort()).toEqual([
        'message.created',
        'message.created',
        'thread.reopened',
        'thread.resolved',
      ]);
      await enqueueWebhookEvent(
        db,
        { ...root.message, sender: null, incomingWebhook: { name: 'CI' } },
        'message.created',
        now,
      );
      expect(
        await db
          .selectFrom('webhook_deliveries')
          .select('id')
          .where('webhook_id', '=', w.created.webhook.id)
          .execute(),
      ).toHaveLength(4);
    });
  });
  test('pause retains queued events; resume sends them; revocation cancels and cannot be retried', async () => {
    await withRollback(async (db) => {
      const w = await world(db);
      await changeOutgoingWebhook(db, clock, w.alice, w.created.webhook.id, true);
      await w.send();
      expect((await w.run()).claimed).toBe(0);
      expect((await outgoingDeliveries(db, w.alice, w.created.webhook.id)).data).toHaveLength(1);
      await changeOutgoingWebhook(db, clock, w.alice, w.created.webhook.id, false);
      expect((await w.run()).succeeded).toBe(1);
      await w.send('another');
      await changeOutgoingWebhook(db, clock, w.alice, w.created.webhook.id, 'revoke');
      expect((await w.run()).claimed).toBe(0);
      expect(await listOutgoingWebhooks(db, w.alice)).toEqual([]);
      expect(
        await db
          .selectFrom('webhook_deliveries')
          .select('state')
          .where('webhook_id', '=', w.created.webhook.id)
          .where('state', '=', 'cancelled')
          .execute(),
      ).toHaveLength(1);
    });
  });
  for (const [status, retry] of [
    [null, true],
    [408, true],
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [404, false],
    [302, false],
    [600, false],
  ] as const) {
    test(`HTTP ${String(status)} has the specified retry policy and records one attempt`, async () => {
      await withRollback(async (db) => {
        const w = await world(db);
        await w.send();
        await w.run(() =>
          Promise.resolve({
            status,
            error: status === null ? 'network_error' : null,
            retryAfter: '60',
          }),
        );
        const [row] = (await outgoingDeliveries(db, w.alice, w.created.webhook.id)).data;
        expect(row?.state).toBe(retry ? 'pending' : 'failed');
        expect(row?.attemptCount).toBe(1);
        if (retry) {
          expect((await w.run()).claimed).toBe(0);
          expect(new Date(row?.nextAttemptAt ?? '').getTime()).toBeGreaterThanOrEqual(
            now.getTime() + 60_000,
          );
        } else {
          await retryOutgoingDelivery(db, clock, w.alice, w.created.webhook.id, row?.id ?? '');
          expect((await w.run()).succeeded).toBe(1);
        }
      });
    });
  }
  test('abandoned leases recover; a fresh lease cannot be claimed; 24-hour expiry is terminal', async () => {
    await withRollback(async (db) => {
      const w = await world(db);
      await w.send();
      await db
        .updateTable('webhook_deliveries')
        .set({
          state: 'sending',
          lease_token: crypto.randomUUID(),
          lease_until: new Date(now.getTime() + 1000),
        })
        .execute();
      expect((await w.run()).claimed).toBe(0);
      expect((await w.run(undefined, new Date(now.getTime() + 1001))).succeeded).toBe(1);
      await w.send('expired');
      expect((await w.run(undefined, new Date(now.getTime() + 86_400_001))).claimed).toBe(0);
      expect(
        (
          await db
            .selectFrom('webhook_deliveries')
            .selectAll()
            .where('webhook_id', '=', w.created.webhook.id)
            .where('state', '=', 'failed')
            .execute()
        )[0]?.last_error,
      ).toBe('expired');
    });
  });
  test('private channel scope, member role and DMs cannot configure outgoing destinations', async () => {
    await withRollback(async (db) => {
      const w = await world(db);
      expect(await refusal(listOutgoingWebhooks(db, w.bob))).toBe('FORBIDDEN');
      const other = await aRoom(db, ['other']);
      const context = other.members['other']?.context;
      if (context === undefined) throw new Error('no other');
      expect(
        await refusal(rotateOutgoingWebhook(db, clock, cipher, context, w.created.webhook.id)),
      ).toBe('OUTGOING_WEBHOOK_NOT_FOUND');
      const dm = await aRoom(db, ['dm'], { type: 'direct_message' });
      const own = dm.members['dm']?.context;
      if (own === undefined) throw new Error('no dm');
      expect(
        await refusal(
          createOutgoingWebhook(db, clock, cipher, own, {
            name: 'DM',
            url: 'https://example.com',
            events: ['message.created'],
          }),
        ),
      ).toBe('CHANNEL_NOT_FOUND');
    });
  });
  test('rotation uses the new signing secret and a queued test uses the same dispatcher', async () => {
    await withRollback(async (db) => {
      const w = await world(db);
      const rotated = await rotateOutgoingWebhook(db, clock, cipher, w.alice, w.created.webhook.id);
      expect(rotated.secret).not.toBe(w.created.secret);
      await testOutgoingWebhook(db, clock, w.alice, w.created.webhook.id);
      await w.run((_url, headers, body) => {
        expect(headers['x-purlay-signature']).toBe(
          webhookSignature(
            rotated.secret,
            headers['x-purlay-timestamp'] ?? '',
            new TextDecoder().decode(body),
          ),
        );
        return Promise.resolve({ status: 200, error: null });
      });
      const incoming = await createWebhook(db, clock, w.alice, { name: 'CI' });
      const renewed = await rotateIncomingWebhook(db, clock, w.alice, incoming.webhook.id);
      const parts = incoming.path.split('/');
      expect(
        await refusal(
          receivePost(
            { database: db, clock, log: w.log, bus: w.bus, mayPost: () => Promise.resolve(true) },
            { webhookId: incoming.webhook.id, secret: parts.at(-1) ?? '', text: 'old' },
          ),
        ),
      ).toBe('INCOMING_WEBHOOK_NOT_FOUND');
      expect(renewed.path).not.toBe(incoming.path);
    });
  });
  test('tombstones remove delivery payloads and attempts; retention removes terminal evidence after seven days', async () => {
    await withRollback(async (db) => {
      const w = await world(db);
      const message = await w.send();
      await w.run();
      const deliveries = await db
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('webhook_id', '=', w.created.webhook.id)
        .execute();
      await tombstoneRows(db, now, [message.message.id]);
      expect(
        await db
          .selectFrom('webhook_deliveries')
          .selectAll()
          .where('webhook_id', '=', w.created.webhook.id)
          .execute(),
      ).toHaveLength(0);
      expect(
        await db
          .selectFrom('webhook_delivery_attempts')
          .selectAll()
          .where(
            'delivery_id',
            'in',
            deliveries.map((row) => row.id),
          )
          .execute(),
      ).toHaveLength(0);
      await testOutgoingWebhook(db, clock, w.alice, w.created.webhook.id);
      await w.run();
      expect(
        (await sweepWebhookDeliveries(db, fixedClock(new Date(now.getTime() + 7 * 86_400_000 + 1))))
          .removed,
      ).toBe(1);
    });
  });
});
describe('integration: webhook regression coverage', () => {
  test('incoming secret rotation winning after authentication rejects the old request before insertion', async () => {
    await withRollback(async (db) => {
      const w = await world(db);
      const incoming = await createWebhook(db, clock, w.alice, { name: 'CI' });
      const result = await refusal(
        receivePost(
          {
            database: db,
            clock,
            log: w.log,
            bus: w.bus,
            mayPost: async () => {
              await rotateIncomingWebhook(db, clock, w.alice, incoming.webhook.id);
              return true;
            },
          },
          {
            webhookId: incoming.webhook.id,
            secret: incoming.path.split('/').at(-1) ?? '',
            text: 'old secret raced renewal',
          },
        ),
      );
      expect(result).toBe('INCOMING_WEBHOOK_NOT_FOUND');
      expect(
        await db
          .selectFrom('messages')
          .select('id')
          .where('channel_id', '=', w.room.channelId)
          .execute(),
      ).toHaveLength(0);
    });
  });
  test('retention drains more than one batch and expires old attempts independently of manual retries', async () => {
    await withRollback(async (db) => {
      const w = await world(db);
      const rows = Array.from({ length: 1001 }, () => ({
        id: messageId(now),
        webhook_id: w.created.webhook.id,
        event_id: crypto.randomUUID(),
        event_type: 'webhook.test',
        payload: '{}',
        state: 'succeeded',
        next_attempt_at: now,
        expires_at: new Date(now.getTime() + 86_400_000),
        created_at: now,
        completed_at: now,
      }));
      await db.insertInto('webhook_deliveries').values(rows).execute();
      const later = fixedClock(new Date(now.getTime() + 7 * 86_400_000 + 1));
      expect((await sweepWebhookDeliveries(db, later)).removed).toBe(1001);
      await testOutgoingWebhook(db, clock, w.alice, w.created.webhook.id);
      const delivery = await db
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('webhook_id', '=', w.created.webhook.id)
        .executeTakeFirstOrThrow();
      await db
        .insertInto('webhook_delivery_attempts')
        .values({
          id: crypto.randomUUID(),
          delivery_id: delivery.id,
          attempted_at: new Date(now.getTime() - 8 * 86_400_000),
          duration_ms: 1,
          status: 500,
          error: 'http_error',
        })
        .execute();
      expect((await sweepWebhookDeliveries(db, clock)).removed).toBe(0);
      expect(
        await db
          .selectFrom('webhook_delivery_attempts')
          .select('id')
          .where('delivery_id', '=', delivery.id)
          .execute(),
      ).toHaveLength(0);
    });
  });

  test('a private channel admin can configure hooks, a removed admin cannot reuse its old context, and the cap is enforced', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { type: 'private' });
      const alice = room.members['alice']?.context;
      if (alice === undefined) throw new Error('no owner');
      for (let index = 0; index < 10; index++)
        await createOutgoingWebhook(db, clock, cipher, alice, {
          name: `Hook ${String(index)}`,
          url: 'https://example.com',
          events: ['message.created'],
        });
      expect(
        await refusal(
          createOutgoingWebhook(db, clock, cipher, alice, {
            name: 'one too many',
            url: 'https://example.com',
            events: ['message.created'],
          }),
        ),
      ).toBe('OUTGOING_WEBHOOKS_LIMIT');
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', alice.userId)
        .execute();
      expect(await refusal(listOutgoingWebhooks(db, alice))).toBe('CHANNEL_NOT_FOUND');
    });
  });

  test('transport and decryption failures produce a bounded retry with no exception text in history', async () => {
    await withRollback(async (db) => {
      const w = await world(db);
      await w.send();
      await w.run(() => Promise.reject(new Error('secret URL must never be stored')));
      const [first] = (await outgoingDeliveries(db, w.alice, w.created.webhook.id)).data;
      expect(first?.lastError).toBe('delivery_error');
      await db
        .updateTable('outgoing_webhooks')
        .set({ secret_encrypted: 'broken' })
        .where('id', '=', w.created.webhook.id)
        .execute();
      const result = await w.run(undefined, new Date(now.getTime() + 60_000));
      expect(result.failed).toBe(1);
      expect(
        JSON.stringify(await outgoingDeliveries(db, w.alice, w.created.webhook.id)),
      ).not.toContain('secret URL');
    });
  });
});
