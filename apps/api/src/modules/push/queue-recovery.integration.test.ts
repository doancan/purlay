/** Durable work is committed atomically, fairly leased across nodes, retried per device and finitely retained. */
import { afterAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId } from '@purlay/types';
import { send } from '../../features/chat/messages/messages';
import { atomicallyOn } from '../../platform/transactions';
import { PUSH_ATTEMPTS_MAX, PUSH_LEASE_MS, PUSH_TTL_SECONDS } from '../../platform/push-policy';
import { NOW } from '../../testing/doubles';
import { pendingPush, PUSH_QUIET_BUS } from '../../testing/pending-push';
import { aPushService, KEYS } from '../../testing/push-service';
import { createDelivery } from './delivery';
import { devicesFor } from './devices';
import { createFailureCount } from './failures';
import { claimPush, beginPushAttempt } from './queue';
import { settlePush } from './queue-result';
import { createPushSender } from './sender';

afterAll(closeIntegrationDatabase);

describe('integration: durable push recovery', () => {
  test('a crash during the final allowed handoff retires the occurrence without another provider attempt', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db);
      const service = aPushService();
      const queue = world.dependencies(service.post);
      for (let attempt = 0; attempt < PUSH_ATTEMPTS_MAX; attempt++) {
        const claim = (await claimPush(queue))!;
        expect(claim.attempts).toBe(attempt);
        expect(await beginPushAttempt(db, claim, world.clock.now(), KEYS.publicKey)).toBe(true);
        // A dead process never settles its handoff; the next node recovers at lease expiry.
        world.clock.to(new Date(world.clock.now().getTime() + PUSH_LEASE_MS));
      }
      const restarted = await createPushSender(queue);
      await restarted.flush(10_000);
      expect(service.sent).toHaveLength(0);
      expect(
        await db
          .selectFrom('push_deliveries')
          .select(['state', 'attempts', 'lease_id'])
          .where('subscription_id', '=', world.devices[0]!.id)
          .execute(),
      ).toEqual([{ state: 'exhausted', attempts: PUSH_ATTEMPTS_MAX, lease_id: null }]);
      expect(
        await db
          .selectFrom('push_intents')
          .select('state')
          .where('user_id', '=', world.reader)
          .execute(),
      ).toEqual([{ state: 'completed' }]);
      expect(
        await db
          .selectFrom('push_subscriptions')
          .select('failures')
          .where('user_id', '=', world.reader)
          .execute(),
      ).toEqual([{ failures: 0 }]);
    });
  });

  test('a stale occurrence wake-up defers to its pending device deadline without sending early', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db);
      const later = new Date(NOW.getTime() + PUSH_LEASE_MS);
      await db
        .updateTable('push_deliveries')
        .set({ next_attempt_at: later })
        .where('subscription_id', '=', world.devices[0]!.id)
        .execute();
      const service = aPushService();
      const queue = world.dependencies(service.post);
      expect(await claimPush(queue)).toBeUndefined();
      expect(
        await db
          .selectFrom('push_intents')
          .select(['state', 'next_check_at'])
          .where('user_id', '=', world.reader)
          .execute(),
      ).toEqual([{ state: 'admitted', next_check_at: later }]);
      const sender = await createPushSender(queue);
      await sender.flush(10_000);
      expect(service.sent).toHaveLength(0);
      world.clock.to(later);
      await sender.flush(10_000);
      expect(service.sent).toHaveLength(1);
      expect(
        await db
          .selectFrom('push_deliveries')
          .select(['state', 'attempts'])
          .where('subscription_id', '=', world.devices[0]!.id)
          .execute(),
      ).toEqual([{ state: 'delivered', attempts: 1 }]);
    });
  });

  test('an expired unreplaced lease cannot cancel or acknowledge still-recoverable work', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db);
      const queue = world.dependencies(aPushService().post);
      const claim = (await claimPush(queue))!;
      world.clock.to(new Date(NOW.getTime() + PUSH_LEASE_MS));
      expect(await beginPushAttempt(db, claim, world.clock.now(), KEYS.publicKey)).toBe(false);
      await settlePush(db, claim, { kind: 'canceled' }, world.clock);
      expect(
        await db
          .selectFrom('push_deliveries')
          .select('state')
          .where(
            'subscription_id',
            'in',
            world.devices.map((device) => device.id),
          )
          .execute(),
      ).toEqual([{ state: 'pending' }]);
      const service = aPushService();
      const fresh = await createPushSender(world.dependencies(service.post));
      await fresh.flush(10_000);
      expect(service.sent).toHaveLength(1);
    });
  });
  test('notification and targets are invisible until commit and both roll back on a failed write', async () => {
    const owned = await cloneIntegrationDatabase();
    const written = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let writing: Promise<unknown> | undefined;
    try {
      const world = await pendingPush(owned.db);
      const id = messageId(new Date(NOW.getTime() + 1));
      writing = owned.db
        .transaction()
        .execute(async (tx) => {
          await send(
            { atomically: atomicallyOn(tx), clock: world.clock, bus: PUSH_QUIET_BUS },
            world.room.members['writer']!.context,
            { id, content: `@${world.room.members['reader']!.username} uncommitted` },
          );
          written.resolve(undefined);
          await release.promise;
          throw new Error('injected source rollback');
        })
        .catch((error: unknown) => error);
      await written.promise;
      expect(
        await owned.db
          .selectFrom('notifications')
          .select('id')
          .where('message_id', '=', id)
          .execute(),
      ).toEqual([]);
      expect(
        await owned.db
          .selectFrom('push_intents')
          .select('id')
          .where('record_id', '=', id)
          .execute(),
      ).toEqual([]);
      release.resolve(undefined);
      expect(await writing).toBeInstanceOf(Error);
      expect(
        await owned.db
          .selectFrom('push_intents')
          .select('id')
          .where('user_id', '=', world.reader)
          .execute(),
      ).toHaveLength(1);
      expect(
        await owned.db
          .selectFrom('push_deliveries')
          .select('intent_id')
          .where(
            'subscription_id',
            'in',
            world.devices.map((device) => device.id),
          )
          .execute(),
      ).toHaveLength(1);
    } finally {
      release.resolve(undefined);
      await writing;
      await owned.drop();
    }
  }, 30_000);

  test('two nodes share the per-person allowance while another person still gets a slot', async () => {
    const owned = await cloneIntegrationDatabase();
    const reached = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const nodes: Awaited<ReturnType<typeof createPushSender>>[] = [];
    let active = 0,
      maximum = 0;
    const topics: string[] = [];
    try {
      const world = await pendingPush(owned.db, 3);
      const provider = async (
        _url: URL,
        headers: Readonly<Record<string, string>>,
      ): Promise<{ kind: 'answered'; status: number }> => {
        topics.push(headers['topic']!);
        active++;
        maximum = Math.max(maximum, active);
        if (active === 2) reached.resolve(undefined);
        await release.promise;
        active--;
        return { kind: 'answered', status: 201 };
      };
      for (let n = 0; n < 2; n++) {
        const node = await createPushSender(world.dependencies(provider));
        nodes.push(node);
        node.told(world.message, [world.reader]);
      }
      await reached.promise;
      expect(active).toBe(2);
      const other = await pendingPush(owned.db);
      const service = aPushService();
      const third = await createPushSender(other.dependencies(service.post));
      nodes.push(third);
      await third.flush(10_000);
      expect(service.sent).toHaveLength(1);
      expect(service.sent[0]!.url).toContain(other.reader);
      expect(topics).toHaveLength(2);
      release.resolve(undefined);
      await Promise.all(
        nodes.map(async (node) => {
          await node.flush(10_000);
        }),
      );
      expect(maximum).toBe(2);
      expect(topics).toHaveLength(3);
      expect(new Set(topics).size).toBe(3);
      expect(
        await owned.db
          .selectFrom('push_deliveries')
          .select('state')
          .where(
            'subscription_id',
            'in',
            [...world.devices, ...other.devices].map((device) => device.id),
          )
          .execute(),
      ).toEqual(Array.from({ length: 4 }, () => ({ state: 'delivered' })));
    } finally {
      release.resolve(undefined);
      await Promise.all(
        nodes.map(async (node) => {
          await node.flush(10_000);
        }),
      );
      await owned.drop();
    }
  }, 30_000);

  test('a late acknowledgement cannot settle a replacement lease, including at the exact boundary', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db);
      const queue = world.dependencies(aPushService().post);
      const first = (await claimPush(queue))!;
      expect(await beginPushAttempt(db, first, NOW, KEYS.publicKey)).toBe(true);
      world.clock.to(new Date(NOW.getTime() + PUSH_LEASE_MS - 1));
      expect(await claimPush(queue)).toBeUndefined();
      world.clock.to(new Date(NOW.getTime() + PUSH_LEASE_MS));
      const replacement = (await claimPush(queue))!;
      expect(replacement.leaseId).not.toBe(first.leaseId);
      await settlePush(db, first, { kind: 'delivered', status: 201 }, world.clock);
      const waiting = await db
        .selectFrom('push_deliveries')
        .select(['state', 'lease_id'])
        .where(
          'subscription_id',
          'in',
          world.devices.map((device) => device.id),
        )
        .executeTakeFirstOrThrow();
      expect(waiting).toEqual({ state: 'pending', lease_id: replacement.leaseId });
      await settlePush(db, replacement, { kind: 'delivered', status: 201 }, world.clock);
      expect(
        await db
          .selectFrom('push_deliveries')
          .select('state')
          .where(
            'subscription_id',
            'in',
            world.devices.map((device) => device.id),
          )
          .execute(),
      ).toEqual([{ state: 'delivered' }]);
    });
  });

  for (const lateStatus of [201, 410, 503]) {
    test(`a stale provider ${String(lateStatus)} cannot erase or change a newer successful lease`, async () => {
      await withRollback(async (db) => {
        const world = await pendingPush(db);
        const started = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        let calls = 0;
        const dependencies = world.dependencies(async () => {
          calls++;
          if (calls === 1) {
            started.resolve(undefined);
            await release.promise;
            return { kind: 'answered', status: lateStatus };
          }
          return { kind: 'answered', status: 201 };
        });
        const first = (await claimPush(dependencies))!;
        const [device] = await devicesFor(
          dependencies,
          world.message,
          [world.reader],
          world.notification,
        );
        const deliver = await createDelivery(dependencies, {
          failed: createFailureCount(dependencies),
        });
        const previous = deliver(device!, first);
        try {
          await started.promise;
          world.clock.to(new Date(NOW.getTime() + PUSH_LEASE_MS));
          const next = (await claimPush(dependencies))!;
          await settlePush(db, next, await deliver(device!, next), world.clock);
          release.resolve(undefined);
          await settlePush(db, first, await previous, world.clock);
          expect(
            await db
              .selectFrom('push_subscriptions')
              .select('failures')
              .where('user_id', '=', world.reader)
              .execute(),
          ).toEqual([{ failures: 0 }]);
          expect(
            await db
              .selectFrom('push_deliveries')
              .select('state')
              .where(
                'subscription_id',
                'in',
                world.devices.map((device) => device.id),
              )
              .execute(),
          ).toEqual([{ state: 'delivered' }]);
        } finally {
          release.resolve(undefined);
          await previous;
        }
      });
    });
  }

  test('a successful device is not sent again while another device retries, with its current sound and locale', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db, 2);
      const service = aPushService();
      let retry = true;
      const post = async (
        ...args: Parameters<typeof service.post>
      ): ReturnType<typeof service.post> => {
        await service.post(...args);
        return { kind: 'answered', status: retry && args[0].pathname.endsWith('/1') ? 503 : 201 };
      };
      const first = await createPushSender(world.dependencies(post));
      await first.flush(10_000);
      expect(service.sent).toHaveLength(2);
      await db
        .updateTable('push_subscriptions')
        .set({ sound: false, created_at: world.clock.now() })
        .where('id', '=', world.devices[1]!.id)
        .execute();
      await db.updateTable('users').set({ locale: 'tr' }).where('id', '=', world.reader).execute();
      retry = false;
      world.clock.to(new Date(NOW.getTime() + 5_000));
      const second = await createPushSender(world.dependencies(post));
      await second.flush(10_000);
      expect(service.sent).toHaveLength(3);
      expect(service.sent[2]!.url).toContain('/1');
      const payload = await world.devices[1]!.browser.read(service.sent[2]!.body);
      expect(payload).toMatchObject({ silent: true });
      expect(JSON.stringify(payload)).toContain('senden bahsetti');
      expect(service.sent[2]!.headers['topic']).toBe(
        service.sent.find((entry) => entry.url.endsWith('/1'))!.headers['topic'],
      );
      expect(service.sent[2]!.headers['ttl']).toBe(String(PUSH_TTL_SECONDS - 5));
      expect(
        (
          await db
            .selectFrom('push_deliveries')
            .select('attempts')
            .orderBy('attempts')
            .where(
              'subscription_id',
              'in',
              world.devices.map((device) => device.id),
            )
            .execute()
        ).map((row) => row.attempts),
      ).toEqual([1, 2]);
    });
  });

  test('temporary failures exhaust only this occurrence, retain the device and never exceed eight attempts', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db);
      const service = aPushService(503);
      const sender = await createPushSender(world.dependencies(service.post));
      for (let attempt = 1; attempt <= PUSH_ATTEMPTS_MAX; attempt++) {
        await sender.flush(10_000);
        const target = await db
          .selectFrom('push_deliveries')
          .selectAll()
          .where(
            'subscription_id',
            'in',
            world.devices.map((device) => device.id),
          )
          .executeTakeFirstOrThrow();
        expect(target.attempts).toBe(attempt);
        if (attempt < PUSH_ATTEMPTS_MAX) world.clock.to(target.next_attempt_at);
      }
      world.clock.to(new Date(world.clock.now().getTime() + 60 * 60_000));
      await sender.releaseHeld();
      await sender.flush(10_000);
      expect(service.sent).toHaveLength(PUSH_ATTEMPTS_MAX);
      expect(
        await db
          .selectFrom('push_deliveries')
          .select('state')
          .where(
            'subscription_id',
            'in',
            world.devices.map((device) => device.id),
          )
          .execute(),
      ).toEqual([{ state: 'exhausted' }]);
      expect(
        await db
          .selectFrom('push_subscriptions')
          .select('failures')
          .where('user_id', '=', world.reader)
          .execute(),
      ).toEqual([{ failures: 5 }]);
    });
  });

  test('provider Retry-After delays recovery, while expiry removes work rather than resetting its TTL', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db);
      const service = aPushService();
      const sender = await createPushSender(
        world.dependencies(async (...args) => {
          await service.post(...args);
          return { kind: 'answered', status: 429, retryAfter: '120' };
        }),
      );
      await sender.flush(10_000);
      world.clock.to(new Date(NOW.getTime() + 119_999));
      await sender.releaseHeld();
      await sender.flush(10_000);
      expect(service.sent).toHaveLength(1);
      world.clock.to(new Date(NOW.getTime() + 120_000));
      await sender.releaseHeld();
      await sender.flush(10_000);
      expect(service.sent).toHaveLength(2);
      world.clock.to(new Date(NOW.getTime() + PUSH_TTL_SECONDS * 1_000));
      await sender.releaseHeld();
      await sender.flush(10_000);
      expect(
        await db
          .selectFrom('push_intents')
          .select('id')
          .where('user_id', '=', world.reader)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('push_deliveries')
          .select('intent_id')
          .where(
            'subscription_id',
            'in',
            world.devices.map((device) => device.id),
          )
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('notifications')
          .select('read_at')
          .where('user_id', '=', world.reader)
          .execute(),
      ).toEqual([{ read_at: null }]);
    });
  });
});
