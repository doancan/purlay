/**
 * Incoming webhooks at once (D-245): two admins making the last one under the cap take turns on the
 * channel's row, and the second is told it is full; a post racing a revocation waits for it on the hook's
 * row and posts nothing once it commits; and posts arriving together are each one message, each counted.
 *
 * Deterministic: the first transaction is held open until the second is seen waiting on a lock. Without
 * the lock the second would read before the first committed, and the wait would never come.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { INCOMING_WEBHOOKS_PER_CHANNEL_MAX } from '@purlay/types';
import type { ChannelContext } from '../../platform/channels';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { EventBus } from '../../platform/events';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom, counters } from '../../testing/rooms';
import { createWebhook, receivePost, revokeWebhook } from './incoming-webhooks';

const clock = fixedClock(new Date('2026-11-01T12:00:00.000Z'));

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

/** Whether a statement here is waiting on a lock, asked of the database until one is. */
const waitingOnALock = async (): Promise<boolean> => {
  for (let look = 0; look < 500; look += 1) {
    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`.execute(cloned.db);
    if ((rows[0]?.count ?? 0) > 0) return true;
  }
  return false;
};

const outcomeOf = async (work: Promise<unknown>): Promise<string> =>
  await work.then(
    () => 'done',
    (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
  );

const NOBODY_LISTENS: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => false,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

const post = async (webhookId: string, secret: string, text: string): Promise<string> =>
  await receivePost(
    {
      database: cloned.db,
      clock,
      bus: NOBODY_LISTENS,
      log: aRecordingLogger().log,
      mayPost: () => Promise.resolve(true),
    },
    { webhookId, secret, text },
  );

const partsOf = (path: string): { webhookId: string; secret: string } => {
  const [, , , , webhookId = '', secret = ''] = path.split('/');
  return { webhookId, secret };
};

const aliceOf = async (): Promise<{ context: ChannelContext; channelId: string; bob: string }> => {
  const room = await aRoom(cloned.db, ['alice', 'bob']);
  const context = room.members['alice']?.context;
  const bob = room.members['bob']?.userId;
  if (context === undefined || bob === undefined) throw new Error('no alice or bob');
  return { context, channelId: room.channelId, bob };
};

describe('integration: incoming webhooks at once', () => {
  test('two at the last place under the cap: the second waits, and is told it is full', async () => {
    const { context } = await aliceOf();
    for (let n = 0; n < INCOMING_WEBHOOKS_PER_CHANNEL_MAX - 1; n++) {
      await cloned.db
        .transaction()
        .execute(
          async (transaction) =>
            await createWebhook(transaction, clock, context, { name: `Hook ${String(n)}` }),
        );
    }
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let made: () => void = () => undefined;
    const firstMade = new Promise<void>((resolve) => {
      made = resolve;
    });
    const firstDone = outcomeOf(
      cloned.db.transaction().execute(async (transaction) => {
        await createWebhook(transaction, clock, context, { name: 'One' });
        made();
        await held;
      }),
    );
    await firstMade;
    const secondDone = outcomeOf(
      cloned.db
        .transaction()
        .execute(
          async (transaction) => await createWebhook(transaction, clock, context, { name: 'Two' }),
        ),
    );
    const waited = await waitingOnALock();
    release();
    expect({ waited, outcomes: [await firstDone, await secondDone] }).toEqual({
      waited: true,
      outcomes: ['done', 'INCOMING_WEBHOOKS_LIMIT'],
    });
  });

  test('a post racing a revocation waits for it, and posts nothing once it commits', async () => {
    const { context, channelId } = await aliceOf();
    const made = await cloned.db
      .transaction()
      .execute(
        async (transaction) => await createWebhook(transaction, clock, context, { name: 'CI' }),
      );
    const { webhookId, secret } = partsOf(made.path);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let revoked: () => void = () => undefined;
    const revokedNow = new Promise<void>((resolve) => {
      revoked = resolve;
    });
    const revocation = outcomeOf(
      cloned.db.transaction().execute(async (transaction) => {
        await revokeWebhook(transaction, clock, context, webhookId);
        revoked();
        await held;
      }),
    );
    await revokedNow;
    const posted = outcomeOf(post(webhookId, secret, 'Build 7 failed'));
    const waited = await waitingOnALock();
    release();
    expect({ waited, outcomes: [await revocation, await posted] }).toEqual({
      waited: true,
      outcomes: ['done', 'INCOMING_WEBHOOK_NOT_FOUND'],
    });
    const messages = await cloned.db
      .selectFrom('messages')
      .select('id')
      .where('channel_id', '=', channelId)
      .execute();
    expect(messages).toEqual([]);
  });

  test('posts arriving together are each one message, and each is counted unread', async () => {
    const { context, channelId, bob } = await aliceOf();
    const made = await cloned.db
      .transaction()
      .execute(
        async (transaction) => await createWebhook(transaction, clock, context, { name: 'CI' }),
      );
    const { webhookId, secret } = partsOf(made.path);
    const ids = await Promise.all(
      Array.from({ length: 8 }, async (_, n) => await post(webhookId, secret, `Step ${String(n)}`)),
    );
    expect(new Set(ids).size).toBe(8);
    expect((await counters(cloned.db, { channelId }, bob)).unread).toBe(8);
  });
});
