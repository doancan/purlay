/**
 * The same delivery twice at once (D-134 §5) — GitHub's Redeliver pressed while the first is still on
 * its way: one is posted and the other is a duplicate, never two messages and never a constraint's
 * `500`. The delivery's id is recorded in the transaction that posts it, so the second waits on the
 * first's row and then finds it.
 *
 * And one signed body under two delivery ids at once — a replay racing what it copies (D-231 §1): one
 * message, the other a duplicate.
 *
 * Deterministic: the first is held open, after its write and before its commit, until the second is
 * seen waiting on a lock.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { credentialCipher } from '../../platform/crypto';
import { AppError } from '../../platform/errors';
import type { EventBus } from '../../platform/events';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { createFeed } from './feeds';
import { receiveDelivery, type Delivery } from './webhook';

const clock = fixedClock(new Date('2026-10-14T12:00:00.000Z'));
const cipher = credentialCipher(Buffer.alloc(32, 4).toString('base64'));
const quiet: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => false,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const waitingOnALock = async (): Promise<boolean> => {
  for (let look = 0; look < 500; look += 1) {
    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`.execute(cloned.db);
    if ((rows[0]?.count ?? 0) > 0) return true;
  }
  return false;
};

describe('integration: one delivery twice at once', () => {
  test('one posts, the other waits and is a duplicate: one message', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice']);
    const alice = room.members['alice']?.context;
    if (alice === undefined) throw new Error('no alice');
    const made = await db
      .transaction()
      .execute(
        async (t) =>
          await createFeed(t, clock, cipher, alice, { repository: 'acme/api', events: ['push'] }),
      );
    const raw = new TextEncoder().encode(
      JSON.stringify({
        repository: { id: 42, full_name: 'acme/api' },
        sender: { login: 'octocat' },
        ref: 'refs/heads/main',
        before: 'a'.repeat(40),
        after: 'b'.repeat(40),
        created: false,
        deleted: false,
        forced: false,
        commits: [{ id: 'b'.repeat(40), message: 'Once' }],
      }),
    );
    const delivery = {
      feedId: made.feed.id,
      signature: `sha256=${createHmac('sha256', made.secret).update(raw).digest('hex')}`,
      event: 'push',
      deliveryId: 'the-same-one',
      body: raw,
    };
    const run = async (database: Executor, sent: Delivery = delivery): Promise<string> =>
      await receiveDelivery(
        {
          database,
          clock,
          cipher,
          bus: quiet,
          log: aRecordingLogger().log,
          mayDeliver: () => Promise.resolve(true),
        },
        sent,
      ).then(
        (outcome) => outcome,
        (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
      );

    // The first holds its delivery row: the second's insert of the same id must wait for it.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let recorded: () => void = () => undefined;
    const firstRecorded = new Promise<void>((resolve) => {
      recorded = resolve;
    });
    const first = db.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('github_deliveries')
        .values({ feed_id: made.feed.id, delivery_id: 'the-same-one' })
        .execute();
      recorded();
      await held;
    });
    await firstRecorded;
    const second = run(db);
    const waited = await waitingOnALock();
    release();
    await first;
    expect(waited).toBe(true);
    expect(await second).toBe('duplicate');

    // And two whole deliveries racing, end to end: one message.
    const again = { ...delivery, deliveryId: 'raced' };
    const outcomes = await Promise.all([
      receiveDelivery(
        {
          database: db,
          clock,
          cipher,
          bus: quiet,
          log: aRecordingLogger().log,
          mayDeliver: () => Promise.resolve(true),
        },
        again,
      ),
      receiveDelivery(
        {
          database: db,
          clock,
          cipher,
          bus: quiet,
          log: aRecordingLogger().log,
          mayDeliver: () => Promise.resolve(true),
        },
        again,
      ),
    ]);
    expect([...outcomes].sort()).toEqual(['duplicate', 'posted']);

    // And one signed body under two ids at once — the second a replay with an id made up (D-231 §1).
    const replayed = new TextEncoder().encode(
      new TextDecoder().decode(raw).replace('"Once"', '"Replayed"'),
    );
    const signed = {
      ...delivery,
      signature: `sha256=${createHmac('sha256', made.secret).update(replayed).digest('hex')}`,
      body: replayed,
    };
    const replays = await Promise.all(
      ['genuine', 'made-up'].map(async (deliveryId) => await run(db, { ...signed, deliveryId })),
    );
    expect([...replays].sort()).toEqual(['duplicate', 'posted']);
    const events = await db
      .selectFrom('messages')
      .select('id')
      .where('channel_id', '=', room.channelId)
      .execute();
    expect(events).toHaveLength(2);
  });
});
