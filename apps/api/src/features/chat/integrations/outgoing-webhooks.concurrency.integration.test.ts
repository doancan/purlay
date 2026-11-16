/** Independent connections prove leases, rollback and throughput rather than a mock of SQL. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  sql,
  closeIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId, OUTGOING_WEBHOOKS_MAX, type CreatedOutgoingWebhook } from '@purlay/types';
import type { ChannelContext } from '../channels/guard';
import { fixedClock } from '../../../platform/clock';
import { credentialCipher } from '../../../platform/crypto';
import { aRecordingLogger, testConfig } from '../../../testing/doubles';
import { aRoom } from '../../../testing/rooms';
import { sendMessage } from '../messages/messages';
import { tombstoneRows } from '../messages/tombstone';
import { changeOutgoingWebhook, createOutgoingWebhook } from './outgoing-webhooks';
import { dispatchWebhooks, sweepWebhookDeliveries, type WebhookPost } from './webhook-dispatcher';

let cloned: ClonedDatabase;
const now = new Date('2026-11-14T12:00:00.000Z');
const clock = fixedClock(now);
const cipher = credentialCipher(testConfig().ENCRYPTION_KEY);
const log = aRecordingLogger().log;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
beforeEach(async () => {
  await cloned.db.deleteFrom('outgoing_webhooks').execute();
});
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
const ready = async (): Promise<{ context: ChannelContext; created: CreatedOutgoingWebhook }> => {
  const room = await aRoom(cloned.db, ['alice']);
  const context = room.members['alice']?.context;
  if (context === undefined) throw new Error('missing owner');
  const created = await cloned.db.transaction().execute(
    async (tx) =>
      await createOutgoingWebhook(tx, clock, cipher, context, {
        name: 'CI',
        url: 'https://example.com/hook',
        events: ['message.created'],
      }),
  );
  return { context, created };
};
const send = async (context: ChannelContext): Promise<void> => {
  await cloned.db
    .transaction()
    .execute(
      async (tx) => await sendMessage(tx, clock, context, { id: messageId(now), content: 'event' }),
    );
};
const run = async (post: WebhookPost, at = now): ReturnType<typeof dispatchWebhooks> =>
  await dispatchWebhooks({
    database: cloned.db,
    clock: fixedClock(at),
    cipher,
    log,
    post,
    random: () => 0.5,
  });

describe('integration: concurrent outgoing delivery', () => {
  test('a second worker cannot claim the first worker’s active lease and HTTP holds no SQL transaction', async () => {
    const { context, created } = await ready();
    await send(context);
    let started: () => void = () => undefined;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = run(async () => {
      started();
      await blocked;
      return { status: 204, error: null };
    });
    await sending;
    const active = await cloned.db
      .selectFrom('webhook_deliveries')
      .select('state')
      .where('webhook_id', '=', created.webhook.id)
      .executeTakeFirstOrThrow();
    expect(active.state).toBe('sending');
    expect(await run(() => Promise.resolve({ status: 204, error: null }))).toEqual({
      claimed: 0,
      succeeded: 0,
      failed: 0,
    });
    release();
    expect((await first).succeeded).toBe(1);
    expect(
      await cloned.db
        .selectFrom('webhook_delivery_attempts')
        .select('id')
        .where(
          'delivery_id',
          'in',
          cloned.db
            .selectFrom('webhook_deliveries')
            .select('id')
            .where('webhook_id', '=', created.webhook.id),
        )
        .execute(),
    ).toHaveLength(1);
  });
  test('a crashed lease is reclaimed; a stale worker cannot overwrite the new result', async () => {
    const { context, created } = await ready();
    await send(context);
    let started: () => void = () => undefined;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = run(async () => {
      started();
      await blocked;
      return { status: 500, error: null };
    });
    await sending;
    expect(
      (
        await run(
          () => Promise.resolve({ status: 204, error: null }),
          new Date(now.getTime() + 61_000),
        )
      ).succeeded,
    ).toBe(1);
    release();
    expect((await first).failed).toBe(0);
    const row = await cloned.db
      .selectFrom('webhook_deliveries')
      .selectAll()
      .where('webhook_id', '=', created.webhook.id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('succeeded');
    expect(row.last_status).toBe(204);
    expect(row.attempt_count).toBe(1);
  });
  test('rolling back the source transaction rolls back its outbox rows', async () => {
    const { context, created } = await ready();
    let rolledBack = false;
    try {
      await cloned.db.transaction().execute(async (tx) => {
        await sendMessage(tx, clock, context, { id: messageId(now), content: 'must rollback' });
        throw new Error('injected after enqueue');
      });
    } catch {
      rolledBack = true;
    }
    expect(rolledBack).toBe(true);
    expect(
      await cloned.db
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('webhook_id', '=', created.webhook.id)
        .execute(),
    ).toHaveLength(0);
  });
  test('one invocation drains 100 messages fanned out to ten hooks, rather than twenty a minute', async () => {
    const { context } = await ready();
    for (let hook = 1; hook < 10; hook++)
      await cloned.db.transaction().execute(
        async (tx) =>
          await createOutgoingWebhook(tx, clock, cipher, context, {
            name: `CI ${String(hook)}`,
            url: 'https://example.com/hook',
            events: ['message.created'],
          }),
      );
    for (let message = 0; message < 100; message++) await send(context);
    const hooks = await cloned.db
      .selectFrom('outgoing_webhooks')
      .select('id')
      .where('channel_id', '=', context.channelId)
      .execute();
    const hookIds = hooks.map((row) => row.id);
    expect(
      await cloned.db
        .selectFrom('webhook_deliveries')
        .select('id')
        .where('webhook_id', 'in', hookIds)
        .execute(),
    ).toHaveLength(1000);
    const start = performance.now();
    const result = await run(() => Promise.resolve({ status: 204, error: null }));
    expect(result).toEqual({ claimed: 1000, succeeded: 1000, failed: 0 });
    expect(performance.now() - start).toBeLessThan(45_000);
    expect(
      await cloned.db
        .selectFrom('webhook_delivery_attempts')
        .select('id')
        .where(
          'delivery_id',
          'in',
          cloned.db
            .selectFrom('webhook_deliveries')
            .select('id')
            .where('webhook_id', 'in', hookIds),
        )
        .execute(),
    ).toHaveLength(1000);
  }, 60_000);
});

describe('integration: webhook regression coverage', () => {
  for (const change of ['pause', 'revoke', 'erase'] as const) {
    test(`a ${change} committed during decryption prevents a new HTTP request`, async () => {
      const { context, created } = await ready();
      await send(context);
      let opened: () => void = () => undefined;
      const opening = new Promise<void>((resolve) => {
        opened = resolve;
      });
      let release: () => void = () => undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const work = dispatchWebhooks({
        database: cloned.db,
        clock,
        log,
        cipher: {
          seal: cipher.seal,
          open: async (bytes, id) => {
            opened();
            await blocked;
            return await cipher.open(bytes, id);
          },
        },
        post: () => {
          calls++;
          return Promise.resolve({ status: 204, error: null });
        },
      });
      await opening;
      if (change === 'erase') {
        const row = await cloned.db
          .selectFrom('webhook_deliveries')
          .select('message_id')
          .where('webhook_id', '=', created.webhook.id)
          .executeTakeFirstOrThrow();
        await cloned.db.transaction().execute(async (tx) => {
          await tombstoneRows(tx, now, [row.message_id ?? '']);
        });
      } else
        await cloned.db.transaction().execute(async (tx) => {
          await changeOutgoingWebhook(
            tx,
            clock,
            context,
            created.webhook.id,
            change === 'pause' ? true : 'revoke',
          );
        });
      release();
      await work;
      expect(calls).toBe(0);
    });
  }

  test('retention waiting on a manual retry rechecks its age and keeps the renewed delivery', async () => {
    const { context, created } = await ready();
    await send(context);
    const old = new Date(now.getTime() - 9 * 86_400_000);
    await cloned.db
      .updateTable('webhook_deliveries')
      .set({ state: 'failed', completed_at: old, expires_at: old, created_at: old })
      .where('webhook_id', '=', created.webhook.id)
      .execute();
    let locked: () => void = () => undefined;
    const readyToSweep = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retry = cloned.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('webhook_deliveries')
        .set({
          state: 'pending',
          completed_at: null,
          expires_at: new Date(now.getTime() + 86_400_000),
        })
        .where('webhook_id', '=', created.webhook.id)
        .execute();
      locked();
      await gate;
    });
    await readyToSweep;
    const sweep = sweepWebhookDeliveries(cloned.db, clock);
    let waiting = false;
    for (let look = 0; look < 500; look++) {
      const { rows } = await sql<{
        count: number;
      }>`select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
        cloned.db,
      );
      if ((rows[0]?.count ?? 0) > 0) {
        waiting = true;
        break;
      }
    }
    release();
    await retry;
    expect(waiting).toBe(true);
    expect((await sweep).removed).toBe(0);
    expect(
      (
        await cloned.db
          .selectFrom('webhook_deliveries')
          .selectAll()
          .where('webhook_id', '=', created.webhook.id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('pending');
  });
});

describe('integration: concurrent outgoing configuration', () => {
  test('integration: concurrent outgoing creations serialize the final place under the channel cap', async () => {
    const { context } = await ready();
    const create = async (): Promise<CreatedOutgoingWebhook> =>
      await cloned.db.transaction().execute(
        async (tx) =>
          await createOutgoingWebhook(tx, clock, cipher, context, {
            name: 'CI',
            url: 'https://example.com/hook',
            events: ['message.created'],
          }),
      );
    for (let n = 1; n < OUTGOING_WEBHOOKS_MAX - 1; n++) await create();
    const made = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const first = cloned.db.transaction().execute(async (tx) => {
      const result = await createOutgoingWebhook(tx, clock, cipher, context, {
        name: 'Final place',
        url: 'https://example.com/hook',
        events: ['message.created'],
      });
      made.resolve();
      await release.promise;
      return result;
    });
    await made.promise;
    const second = create().then(
      () => 'created',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    let waiting = false;
    try {
      for (let look = 0; look < 500; look++) {
        const result = await sql<{
          count: number;
        }>`select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(
          cloned.db,
        );
        if ((result.rows[0]?.count ?? 0) > 0) {
          waiting = true;
          break;
        }
      }
    } finally {
      release.resolve(undefined);
    }
    await first;
    expect(waiting).toBe(true);
    expect(await second).toContain('as many outgoing webhooks');
    expect(
      await cloned.db
        .selectFrom('outgoing_webhooks')
        .select('id')
        .where('channel_id', '=', context.channelId)
        .execute(),
    ).toHaveLength(OUTGOING_WEBHOOKS_MAX);
  });
});
