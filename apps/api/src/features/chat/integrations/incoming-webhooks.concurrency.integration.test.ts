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
import { INCOMING_WEBHOOKS_PER_CHANNEL_MAX, messageId } from '@purlay/types';
import type { ChannelContext } from '../channels/guard';
import { archiveChannel } from '../channels/settings';
import { sendMessage } from '../messages/messages';
import { fixedClock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import type { EventBus } from '../../../platform/events';
import { aRecordingLogger } from '../../../testing/doubles';
import { aRoom, counters } from '../../../testing/rooms';
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
  for (const closing of ['channel', 'workspace'] as const) {
    test(`a ${closing} closed after lookup accepts no post or side effects`, async () => {
      const { context, channelId, bob } = await aliceOf();
      const made = await cloned.db
        .transaction()
        .execute(
          async (transaction) => await createWebhook(transaction, clock, context, { name: 'ERP' }),
        );
      const { webhookId, secret } = partsOf(made.path);
      let published = 0;
      const outcome = await outcomeOf(
        receivePost(
          {
            database: cloned.db,
            clock,
            log: aRecordingLogger().log,
            bus: {
              ...NOBODY_LISTENS,
              publish: () => {
                published++;
                return Promise.resolve();
              },
            },
            mayPost: async () => {
              if (closing === 'channel')
                await cloned.db.transaction().execute(async (transaction) => {
                  await archiveChannel(transaction, clock, context);
                });
              else
                await cloned.db
                  .updateTable('workspaces')
                  .set({ deleted_at: clock.now() })
                  .where('id', '=', context.workspaceId)
                  .execute();
              return true;
            },
          },
          { webhookId, secret, text: 'Order confirmed' },
        ),
      );
      expect(outcome).toBe('INCOMING_WEBHOOK_NOT_FOUND');
      expect(
        await cloned.db
          .selectFrom('messages')
          .select('id')
          .where('channel_id', '=', channelId)
          .execute(),
      ).toEqual([]);
      expect(
        (
          await cloned.db
            .selectFrom('incoming_webhooks')
            .select('last_used_at')
            .where('id', '=', webhookId)
            .executeTakeFirstOrThrow()
        ).last_used_at,
      ).toBeNull();
      expect((await counters(cloned.db, { channelId }, bob)).unread).toBe(0);
      expect(published).toBe(0);
    });
  }
  for (const closing of ['channel', 'workspace'] as const) {
    test(`a post admitted first holds a later ${closing} closure until commit`, async () => {
      const { context, channelId } = await aliceOf();
      const made = await cloned.db
        .transaction()
        .execute(
          async (transaction) => await createWebhook(transaction, clock, context, { name: 'ERP' }),
        );
      const { webhookId, secret } = partsOf(made.path);
      const written = Promise.withResolvers<undefined>();
      const commit = Promise.withResolvers<undefined>();
      const first = outcomeOf(
        cloned.db.transaction().execute(async (transaction) => {
          await receivePost(
            {
              database: transaction,
              clock,
              bus: NOBODY_LISTENS,
              log: aRecordingLogger().log,
              mayPost: () => Promise.resolve(true),
            },
            { webhookId, secret, text: 'Accepted before closure' },
          );
          written.resolve(undefined);
          await commit.promise;
        }),
      );
      await written.promise;
      const closed = outcomeOf(
        cloned.db.transaction().execute(async (transaction) => {
          if (closing === 'channel') await archiveChannel(transaction, clock, context);
          else
            await transaction
              .updateTable('workspaces')
              .set({ deleted_at: clock.now() })
              .where('id', '=', context.workspaceId)
              .execute();
        }),
      );
      const waited = await waitingOnALock();
      commit.resolve(undefined);
      expect({ waited, outcomes: [await first, await closed] }).toEqual({
        waited: true,
        outcomes: ['done', 'done'],
      });
      expect(
        await cloned.db
          .selectFrom('messages')
          .select('id')
          .where('channel_id', '=', channelId)
          .execute(),
      ).toHaveLength(1);
    });
  }

  test('the message clock is read after a channel lock wait', async () => {
    const { context, channelId } = await aliceOf();
    const made = await cloned.db
      .transaction()
      .execute(
        async (transaction) => await createWebhook(transaction, clock, context, { name: 'ERP' }),
      );
    const held = Promise.withResolvers<undefined>();
    const unlock = Promise.withResolvers<undefined>();
    const locking = cloned.db.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('channels')
        .select('id')
        .where('id', '=', channelId)
        .forNoKeyUpdate()
        .execute();
      held.resolve(undefined);
      await unlock.promise;
    });
    await held.promise;
    let now = clock.now();
    const posted = receivePost(
      {
        database: cloned.db,
        clock: { now: () => now },
        bus: NOBODY_LISTENS,
        log: aRecordingLogger().log,
        mayPost: () => Promise.resolve(true),
      },
      { ...partsOf(made.path), text: 'Current message time' },
    );
    const waited = await waitingOnALock();
    now = new Date(now.getTime() + 60_000);
    unlock.resolve(undefined);
    await locking;
    const id = await posted;
    expect(waited).toBe(true);
    expect(
      (
        await cloned.db
          .selectFrom('messages')
          .select('created_at')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).created_at,
    ).toEqual(now);
  });
  test('a normal human send and a webhook both finish when they overlap on counters', async () => {
    const { context, channelId, bob } = await aliceOf();
    const made = await cloned.db
      .transaction()
      .execute(
        async (transaction) => await createWebhook(transaction, clock, context, { name: 'ERP' }),
      );
    const waitingFor = async (name: string): Promise<boolean> => {
      for (let look = 0; look < 500; look++) {
        const { rows } = await sql<{
          present: boolean;
        }>`select exists(select 1 from pg_stat_activity
          where datname=current_database() and application_name=${name} and wait_event_type='Lock') as present`.execute(
          cloned.db,
        );
        if (rows[0]?.present === true) return true;
      }
      return false;
    };
    const locked = Promise.withResolvers<undefined>();
    const unlock = Promise.withResolvers<undefined>();
    await sql`create function pause_human_counter() returns trigger language plpgsql as
      ${sql.raw(`$$ begin if new.user_id='${bob}'::uuid then perform pg_advisory_xact_lock(723302819); end if; return new; end $$`)}`.execute(
      cloned.db,
    );
    await sql`create trigger pause_human_counter after update on channel_members for each row execute function pause_human_counter()`.execute(
      cloned.db,
    );
    try {
      const barrier = cloned.db.transaction().execute(async (transaction) => {
        await sql`select pg_advisory_xact_lock(723302819)`.execute(transaction);
        locked.resolve(undefined);
        await unlock.promise;
      });
      await locked.promise;
      const human = outcomeOf(
        cloned.db.transaction().execute(async (transaction) => {
          await sql`select set_config('application_name','webhook-human',true)`.execute(
            transaction,
          );
          await sendMessage(transaction, clock, context, {
            id: messageId(clock.now()),
            content: 'Human order note',
          });
        }),
      );
      const humanWaited = await waitingFor('webhook-human');
      const bot = outcomeOf(
        cloned.db.transaction().execute(async (transaction) => {
          await sql`select set_config('application_name','webhook-bot',true)`.execute(transaction);
          await receivePost(
            {
              database: transaction,
              clock,
              bus: NOBODY_LISTENS,
              log: aRecordingLogger().log,
              mayPost: () => Promise.resolve(true),
            },
            { ...partsOf(made.path), text: 'ERP order note' },
          );
        }),
      );
      const botWaited = await waitingFor('webhook-bot');
      unlock.resolve(undefined);
      await barrier;
      const outcomes = [await human, await bot];
      expect({ humanWaited, botWaited, outcomes }).toEqual({
        humanWaited: true,
        botWaited: true,
        outcomes: ['done', 'done'],
      });
      expect(
        await cloned.db
          .selectFrom('messages')
          .select('id')
          .where('channel_id', '=', channelId)
          .execute(),
      ).toHaveLength(2);
      expect((await counters(cloned.db, { channelId }, bob)).unread).toBe(2);
    } finally {
      unlock.resolve(undefined);
      await sql`drop trigger pause_human_counter on channel_members`.execute(cloned.db);
      await sql`drop function pause_human_counter()`.execute(cloned.db);
    }
  });
});
