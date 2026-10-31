/**
 * Two admins connecting at once (D-134): the channel's row is locked first, so they take turns. The
 * same repository twice is one feed and a `GITHUB_FEED_EXISTS`, never a constraint's `500`; two at the
 * last place under the cap are one feed and a `GITHUB_FEEDS_LIMIT`.
 *
 * Deterministic: the first connection is held open until the second is seen waiting on a lock.
 * Without the lock the second would read before the first committed, and the wait would never come.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  type ClonedDatabase,
  CLONE_HOOK_MS,
} from '@purlay/db';
import { GITHUB_FEEDS_PER_CHANNEL_MAX } from '@purlay/types';
import type { ChannelContext } from '../../platform/channels';
import { fixedClock } from '../../platform/clock';
import { credentialCipher } from '../../platform/crypto';
import { AppError } from '../../platform/errors';
import { aRoom } from '../../testing/rooms';
import { createFeed } from './feeds';

const clock = fixedClock(new Date('2026-10-14T12:00:00.000Z'));
const cipher = credentialCipher(Buffer.alloc(32, 5).toString('base64'));

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
});

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
    () => 'connected',
    (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
  );

/** The first connection made and held open; the second started against it; their outcomes. */
const race = async (
  context: ChannelContext,
  first: string,
  second: string,
): Promise<{ readonly waited: boolean; readonly outcomes: readonly string[] }> => {
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
      await createFeed(transaction, clock, cipher, context, {
        repository: first,
        events: ['push'],
      });
      made();
      await held;
    }),
  );
  await firstMade;
  const secondDone = outcomeOf(
    cloned.db.transaction().execute(
      async (transaction) =>
        await createFeed(transaction, clock, cipher, context, {
          repository: second,
          events: ['push'],
        }),
    ),
  );
  const waited = await waitingOnALock();
  // Let go before asserting, so a failure here does not leave the first transaction open.
  release();
  return { waited, outcomes: [await firstDone, await secondDone] };
};

describe('integration: two connections at once', () => {
  test('the same repository twice: the second waits, and is told it exists', async () => {
    const room = await aRoom(cloned.db, ['alice']);
    const alice = room.members['alice']?.context;
    if (alice === undefined) throw new Error('no alice');
    expect(await race(alice, 'acme/api', 'Acme/API')).toEqual({
      waited: true,
      outcomes: ['connected', 'GITHUB_FEED_EXISTS'],
    });
  });

  test('two at the last place under the cap: the second waits, and is told it is full', async () => {
    const room = await aRoom(cloned.db, ['alice']);
    const alice = room.members['alice']?.context;
    if (alice === undefined) throw new Error('no alice');
    for (let n = 0; n < GITHUB_FEEDS_PER_CHANNEL_MAX - 1; n++) {
      expect(
        await outcomeOf(
          cloned.db.transaction().execute(
            async (transaction) =>
              await createFeed(transaction, clock, cipher, alice, {
                repository: `acme/r${String(n)}`,
                events: ['push'],
              }),
          ),
        ),
      ).toBe('connected');
    }
    expect(await race(alice, 'acme/one', 'acme/two')).toEqual({
      waited: true,
      outcomes: ['connected', 'GITHUB_FEEDS_LIMIT'],
    });
  });
});
