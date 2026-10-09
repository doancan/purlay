/**
 * A subscription is made before its replay is read, so a message committed
 * between the two reaches the client once — in the replay, in the live stream, or
 * in both with the duplicate dropped — and never in neither.
 *
 * The race is made deterministic by the replay read's seam: the hook commits a
 * message at the exact point the old order lost one, rather than sleeping and
 * hoping to land there.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { createApp } from '../ingress/http/app';
import { aSignedInUser, type SignedInUser } from '../testing/signed-in';
import { testDependencies } from '../testing/doubles';
import { missedIn } from '../modules/messages/messages';
import { fixedClock } from '../platform/clock';
import { createLogger } from '../platform/logging';
import { atomicallyOn } from '../platform/transactions';
import { aUniqueSlug } from '../testing/users';
import { inProcessEventBus, type InspectableEventBus } from './bus';
import { createSocketHub, type SocketHub } from './hub';
import { inProcessRateLimiter, SOCKET_FRAME_BUDGET } from './rate-limiter';
import { routeFrame, type RouterDependencies } from './router';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const aChannel = async (db: Executor, who: SignedInUser): Promise<string> => {
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
  const slug = aUniqueSlug('order');
  const workspace = await post('/api/workspaces', { name: slug, slug });
  return (await post(`/api/workspaces/${workspace.id}/channels`, { name: 'general' })).id;
};

interface Rig {
  readonly hub: SocketHub;
  readonly bus: InspectableEventBus;
  readonly written: ServerFrame[];
  readonly route: (
    raw: unknown,
    overrides?: Partial<RouterDependencies>,
    socketId?: string,
  ) => Promise<readonly ServerFrame[]>;
}

/** One hub holding one socket, 's1', with everything written to it recorded. */
const aRig = async (db: Executor, who: SignedInUser): Promise<Rig> => {
  const written: ServerFrame[] = [];
  const hub = createSocketHub(db, clock, {
    log: createLogger({ level: 'silent' }),
    leave: () => undefined,
  });
  const bus = inProcessEventBus(hub.deliver, createLogger({ level: 'silent' }));
  await hub.opened(
    's1',
    {
      send: (payload) => written.push(JSON.parse(payload) as ServerFrame),
      buffered: () => 0,
      close: () => undefined,
    },
    new Request(`${ORIGIN}/ws`, { headers: { cookie: who.cookie } }),
  );
  const limiter = inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET);
  return {
    hub,
    bus,
    written,
    route: async (raw, overrides = {}, socketId = 's1') =>
      await routeFrame(
        {
          database: db,
          clock,
          bus,
          limiter,
          log: createLogger({ level: 'silent' }),
          socket: hub,
          atomically: atomicallyOn(db),
          ...overrides,
        },
        { socketId, userId: who.userId, sessionId: who.sessionId, expiresAt: NOW },
        raw,
      ),
  };
};

const subscribeFrame = (channelId: string, after: string): unknown => ({
  id: messageId(NOW),
  op: 'SUBSCRIBE',
  payload: { channels: [{ channelId, afterMessageId: after }] },
});

const sendFrame = (channelId: string, id: string): unknown => ({
  id,
  op: 'MESSAGE_SEND',
  payload: { channelId, content: id },
});

const idsOf = (frames: readonly ServerFrame[]): string[] =>
  frames.flatMap((f) => (f.event === 'MESSAGE_CREATED' ? [f.data.id] : []));

const BEFORE = messageId(new Date(NOW.getTime() - 1));

interface Outcome {
  written: ServerFrame[];
  first: string;
  late: string;
  replies: ServerFrame[];
}

describe('integration: subscribe before replay', () => {
  const race = async (when: 'after-the-read' | 'before-the-read'): Promise<Outcome> => {
    let outcome: Outcome | undefined;
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, `order-${when}`);
      const channelId = await aChannel(db, alice);
      const rig = await aRig(db, alice);

      const first = messageId(new Date(NOW.getTime() + 1));
      await rig.route(sendFrame(channelId, first));

      const late = messageId(new Date(NOW.getTime() + 2));
      const hooked: typeof missedIn = async (...args) => {
        // Another connection's send: committed, then published to the bus.
        const commit = async (): Promise<void> => {
          await rig.route(sendFrame(channelId, late), {}, 'other');
        };
        if (when === 'before-the-read') await commit();
        const replays = await missedIn(...args);
        if (when === 'after-the-read') await commit();
        return replays;
      };

      const replies = [
        ...(await rig.route(subscribeFrame(channelId, BEFORE), { readReplay: hooked })),
      ];
      rig.hub.reply('s1', replies);
      rig.hub.closed('s1');
      outcome = { written: rig.written, first, late, replies };
    });
    if (outcome === undefined) throw new Error('the race did not run');
    return outcome;
  };

  test('a message committed after the replay was read is delivered, once, after it', async () => {
    const { written, first, late, replies } = await race('after-the-read');
    // Control: the replay did not carry it, so only the live stream can have.
    expect(idsOf(replies)).toEqual([first]);
    expect(written[0]?.event).toBe('ACK');
    expect(idsOf(written)).toEqual([first, late]);
  });

  test('a message committed before the read is in the replay and the live stream, and sent once', async () => {
    const { written, first, late, replies } = await race('before-the-read');
    // Control: it is in both, so the duplicate is real and is being dropped.
    expect(idsOf(replies)).toEqual([first, late]);
    expect(idsOf(written)).toEqual([first, late]);
  });

  test('a connection that closes while its replay is read is not left subscribed', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'order-closed');
      const channelId = await aChannel(db, alice);
      const rig = await aRig(db, alice);
      const closing: typeof missedIn = async (...args) => {
        const replays = await missedIn(...args);
        // What the socket's close handler does, mid-read.
        rig.bus.forget('s1');
        rig.hub.closed('s1');
        return replays;
      };
      await rig.route(subscribeFrame(channelId, BEFORE), { readReplay: closing });
      expect(rig.bus.size()).toEqual({ topics: 0, sockets: 0 });
    });
  });

  test('a connection already closed when its channels are authorised subscribes nothing', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'order-gone');
      const channelId = await aChannel(db, alice);
      const rig = await aRig(db, alice);
      const replies = await rig.route(subscribeFrame(channelId, BEFORE), {
        socket: { hold: () => undefined, isOpen: () => false, drop: () => undefined },
      });
      expect(replies).toEqual([]);
      expect(rig.bus.size()).toEqual({ topics: 0, sockets: 0 });
    });
  });

  test('a subscription that fails leaves nothing subscribed, and a prior one intact', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'order-fails');
      const channelId = await aChannel(db, alice);
      const rig = await aRig(db, alice);
      const failing: typeof missedIn = async () => await Promise.reject(new Error('read failed'));

      const refused = await rig.route(subscribeFrame(channelId, BEFORE), { readReplay: failing });
      rig.hub.reply('s1', refused);
      expect(refused[0]).toMatchObject({ event: 'ERROR', data: { code: 'INTERNAL' } });
      expect(rig.bus.size()).toEqual({ topics: 0, sockets: 0 });

      // Subscribed for real; a failing resubscribe must not undo it.
      rig.hub.reply('s1', await rig.route(subscribeFrame(channelId, BEFORE)));
      rig.hub.reply(
        's1',
        await rig.route(subscribeFrame(channelId, BEFORE), { readReplay: failing }),
      );
      expect(rig.bus.size()).toEqual({ topics: 1, sockets: 1 });
      rig.hub.closed('s1');
    });
  });
});
