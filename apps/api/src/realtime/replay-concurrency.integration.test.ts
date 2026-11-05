/**
 * How many replays a node runs at once (`SOCKET_REPLAY_CONCURRENCY`, #1029).
 *
 * The read's seam says when each replay has begun, so "the third has not started" is observed, not
 * inferred from timing. Every socket here is a router identity of its own over one database
 * transaction, the way `subscribe-order.integration.test.ts` drives one.
 */
import { nobodyActive } from '../platform/attention';
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { createApp } from '../ingress/http/app';
import { aSignedInUser, type SignedInUser } from '../testing/signed-in';
import { testDependencies } from '../testing/doubles';
import { missedIn } from '../features/chat/messages/messages';
import { fixedClock } from '../platform/clock';
import { createLogger } from '../platform/logging';
import { atomicallyOn } from '../platform/transactions';
import { aUniqueSlug } from '../testing/users';
import { inProcessEventBus } from './bus';
import { inProcessRateLimiter, SOCKET_FRAME_BUDGET } from './rate-limiter';
import { inMemoryPresenceRegistry } from './presence';
import { createReplayGate, type ReplayGate } from './replay-gate';
import { routeFrame } from './router';
import { NO_SESSION_LIFETIME } from '../modules/auth/session-lifetime';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const BEFORE = messageId(new Date(NOW.getTime() - 1));
/** One id for every `SUBSCRIBE`, so that what two connections are answered can be compared whole. */
const SUBSCRIBE_ID = messageId(NOW);
const MESSAGES = 3;
const silent = createLogger({ level: 'silent' });

const aChannelWithMessages = async (db: Executor, who: SignedInUser): Promise<string> => {
  const app = createApp(testDependencies({ database: db, clock }));
  const post = async (path: string, body: unknown): Promise<{ id: string }> =>
    (await (
      await app.handle(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: { cookie: who.cookie, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    ).json()) as { id: string };
  const slug = aUniqueSlug('gate');
  const workspace = await post('/api/workspaces', { name: slug, slug });
  const channel = await post(`/api/workspaces/${workspace.id}/channels`, { name: 'ops' });
  const bus = inProcessEventBus(() => undefined, createLogger({ level: 'silent' }));
  for (let n = 1; n <= MESSAGES; n += 1) {
    const id = messageId(new Date(NOW.getTime() + n));
    await routeFrame(
      routerOver(db, bus, new Set(['author'])),
      { socketId: 'author', userId: who.userId, sessionId: who.sessionId, expiresAt: NOW },
      { id, op: 'MESSAGE_SEND', payload: { channelId: channel.id, content: id } },
    );
  }
  return channel.id;
};

type Bus = ReturnType<typeof inProcessEventBus>;

/** What the router needs, with `open` the sockets that are connected. */
const routerOver = (
  db: Executor,
  bus: Bus,
  open: ReadonlySet<string>,
  overrides: { replayGate?: ReplayGate; readReplay?: typeof missedIn } = {},
): Parameters<typeof routeFrame>[0] => ({
  database: db,
  clock,
  bus,
  limiter: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
  userWrites: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
  presence: inMemoryPresenceRegistry(clock),
  attention: nobodyActive,
  online: { active: () => undefined },
  sessionLifetime: () => NO_SESSION_LIFETIME,
  log: createLogger({ level: 'silent' }),
  atomically: atomicallyOn(db),
  socket: {
    hold: () => undefined,
    isOpen: (socketId) => open.has(socketId),
    drop: () => undefined,
  },
  ...overrides,
});

const subscribe = (channelId: string): unknown => ({
  id: SUBSCRIBE_ID,
  op: 'SUBSCRIBE',
  payload: { channels: [{ channelId, afterMessageId: BEFORE }] },
});

const idsOf = (frames: readonly ServerFrame[]): string[] =>
  frames.flatMap((frame) => (frame.event === 'MESSAGE_CREATED' ? [frame.data.id] : []));

/** A replay read that waits on `hold` after it has begun, and counts how many have begun and how many are in it. */
const watchedReads = (): {
  readReplay: typeof missedIn;
  began: () => number;
  mostInside: () => number;
  open: () => void;
} => {
  let opened = false;
  let began = 0;
  let inside = 0;
  let mostInside = 0;
  const waiting: (() => void)[] = [];
  const readReplay: typeof missedIn = async (...args) => {
    began += 1;
    inside += 1;
    mostInside = Math.max(mostInside, inside);
    if (!opened) {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    }
    try {
      return await missedIn(...args);
    } finally {
      inside -= 1;
    }
  };
  return {
    readReplay,
    began: () => began,
    mostInside: () => mostInside,
    open: (): void => {
      opened = true;
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
};

const identityOf = (who: SignedInUser, socketId: string): Parameters<typeof routeFrame>[1] => ({
  socketId,
  userId: who.userId,
  sessionId: who.sessionId,
  expiresAt: NOW,
});

const soon = async (what: string, done: () => boolean): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

describe('integration: replays are run a few at a time', () => {
  test('one more than the limit waits, and every replay answers the frames it would have without a limit', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'gate-queue');
      const channelId = await aChannelWithMessages(db, alice);
      const sockets = ['s1', 's2', 's3'];
      const open = new Set(sockets);
      const bus = inProcessEventBus(() => undefined, createLogger({ level: 'silent' }));

      // What a lone reconnect gets today, with no gate at all.
      const alone = await routeFrame(
        routerOver(db, bus, open),
        identityOf(alice, 's1'),
        subscribe(channelId),
      );
      expect(idsOf(alone)).toHaveLength(MESSAGES);

      const reads = watchedReads();
      const gate = createReplayGate(2, silent, 5_000);
      const replies = sockets.map(
        async (socketId) =>
          await routeFrame(
            routerOver(db, bus, open, { replayGate: gate, readReplay: reads.readReplay }),
            identityOf(alice, socketId),
            subscribe(channelId),
          ),
      );

      await soon('two replays to begin', () => reads.began() === 2);
      await Bun.sleep(30);
      // The third has been asked for, and is waiting; it has not begun.
      expect(reads.began()).toBe(2);

      reads.open();
      const answers = await Promise.all(replies);
      expect(reads.began()).toBe(3);
      expect(reads.mostInside()).toBe(2);
      for (const answer of answers) expect(answer).toEqual(alone);
    });
  });

  test('a replay still waiting at its deadline is answered DATABASE_UNAVAILABLE, with nothing left subscribed for it', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'gate-deadline');
      const channelId = await aChannelWithMessages(db, alice);
      const open = new Set(['s1', 's2']);
      const bus = inProcessEventBus(() => undefined, createLogger({ level: 'silent' }));
      const reads = watchedReads();
      const gate = createReplayGate(1, silent, 30);
      const route = async (socketId: string): Promise<readonly ServerFrame[]> =>
        await routeFrame(
          routerOver(db, bus, open, { replayGate: gate, readReplay: reads.readReplay }),
          identityOf(alice, socketId),
          subscribe(channelId),
        );

      const first = route('s1');
      await soon('the first replay to begin', () => reads.began() === 1);
      const refused = await route('s2');
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        event: 'ERROR',
        data: { code: 'DATABASE_UNAVAILABLE' },
        refId: SUBSCRIBE_ID,
      });
      // Only the first, which is still being served, holds a subscription.
      expect(bus.size()).toEqual({ topics: 1, sockets: 1 });

      reads.open();
      expect(idsOf(await first)).toHaveLength(MESSAGES);
      // The refused one asks again and is served: its turn was never taken.
      expect(idsOf(await route('s2'))).toHaveLength(MESSAGES);
    });
  });

  test('a socket that closes while it waits reads nothing and leaves its turn to the next', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'gate-closed');
      const channelId = await aChannelWithMessages(db, alice);
      const open = new Set(['s1', 's2', 's3']);
      const bus = inProcessEventBus(() => undefined, createLogger({ level: 'silent' }));
      const reads = watchedReads();
      const gate = createReplayGate(1, silent, 5_000);
      const route = async (socketId: string): Promise<readonly ServerFrame[]> =>
        await routeFrame(
          routerOver(db, bus, open, { replayGate: gate, readReplay: reads.readReplay }),
          identityOf(alice, socketId),
          subscribe(channelId),
        );

      const first = route('s1');
      await soon('the first replay to begin', () => reads.began() === 1);
      const waiting = route('s2');
      const next = route('s3');
      await Bun.sleep(30);

      // What the connection's close handler does while the frame is waiting.
      open.delete('s2');
      bus.forget('s2');
      reads.open();

      expect(await waiting).toEqual([]);
      expect(idsOf(await first)).toHaveLength(MESSAGES);
      expect(idsOf(await next)).toHaveLength(MESSAGES);
      // The closed socket's replay was never read: the first's and the third's only.
      expect(reads.began()).toBe(2);
      expect(bus.size()).toEqual({ topics: 1, sockets: 2 });
      // Nothing is left holding a turn.
      expect(idsOf(await route('s1'))).toHaveLength(MESSAGES);
    });
  });

  test('a first subscription, with no cursor, does not wait for a turn', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'gate-first');
      const channelId = await aChannelWithMessages(db, alice);
      const open = new Set(['s1', 's2']);
      const bus = inProcessEventBus(() => undefined, createLogger({ level: 'silent' }));
      const reads = watchedReads();
      const gate = createReplayGate(1, silent, 5_000);

      // The only turn is taken by a replay that is not finished.
      const replaying = routeFrame(
        routerOver(db, bus, open, { replayGate: gate, readReplay: reads.readReplay }),
        identityOf(alice, 's1'),
        subscribe(channelId),
      );
      await soon('the replay to begin', () => reads.began() === 1);

      const first = await routeFrame(
        routerOver(db, bus, open, { replayGate: gate }),
        identityOf(alice, 's2'),
        {
          id: SUBSCRIBE_ID,
          op: 'SUBSCRIBE',
          payload: { channels: [{ channelId, afterMessageId: null }] },
        },
      );
      expect(first[0]).toMatchObject({ event: 'ACK' });
      expect(idsOf(first)).toEqual([]);

      reads.open();
      await replaying;
    });
  });

  test('a replay that fails gives its turn back', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'gate-fails');
      const channelId = await aChannelWithMessages(db, alice);
      const open = new Set(['s1']);
      const bus = inProcessEventBus(() => undefined, createLogger({ level: 'silent' }));
      const gate = createReplayGate(1, silent, 30);
      const failing: typeof missedIn = async () => await Promise.reject(new Error('read failed'));

      const failed = await routeFrame(
        routerOver(db, bus, open, { replayGate: gate, readReplay: failing }),
        identityOf(alice, 's1'),
        subscribe(channelId),
      );
      expect(failed[0]).toMatchObject({ event: 'ERROR', data: { code: 'INTERNAL' } });

      const served = await routeFrame(
        routerOver(db, bus, open, { replayGate: gate }),
        identityOf(alice, 's1'),
        subscribe(channelId),
      );
      expect(served[0]).toMatchObject({ event: 'ACK' });
    });
  });
});
