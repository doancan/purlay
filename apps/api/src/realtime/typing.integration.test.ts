/**
 * Typing, through the router against a real database (#411): who may say they are typing where,
 * who hears it, and how often.
 *
 * The router is driven directly, as `realtime.integration.test.ts` drives it: authorising the
 * channel is a real query, and what the room hears is what the bus delivered.
 */
import { nobodyActive } from '../platform/attention';
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, TYPING_TTL_MS, type ServerFrame } from '@purlay/types';
import { aSession } from '../testing/signed-in';
import { channelTopic } from '../platform/events';
import { createLogger } from '../platform/logging';
import { atomicallyOn } from '../platform/transactions';
import { aMovableClock } from '../testing/doubles';
import { aRoom } from '../testing/rooms';
import { inProcessEventBus } from './bus';
import { inMemoryPresenceRegistry } from './presence';
import { inProcessRateLimiter, SOCKET_FRAME_BUDGET } from './rate-limiter';
import { routeFrame } from './router';
import { NO_SESSION_LIFETIME } from '../modules/auth/session-lifetime';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');

/** One node: a bus whose deliveries are recorded per socket, a registry and a clock to move. */
const aNode = (
  db: Executor,
): {
  readonly heard: (socketId: string) => ServerFrame[];
  readonly listen: (channelId: string, socketId: string) => void;
  readonly clock: ReturnType<typeof aMovableClock>;
  /** How many typing windows the registry holds. */
  readonly held: () => number;
  readonly route: (
    identity: { userId: string; sessionId?: string },
    raw: unknown,
  ) => Promise<readonly ServerFrame[]>;
} => {
  const clock = aMovableClock(NOW);
  const delivered = new Map<string, ServerFrame[]>();
  const bus = inProcessEventBus(
    (socketId, frame) => {
      delivered.set(socketId, [...(delivered.get(socketId) ?? []), frame]);
    },
    createLogger({ level: 'silent' }),
  );
  const presence = inMemoryPresenceRegistry(clock);
  return {
    heard: (socketId) => delivered.get(socketId) ?? [],
    listen: (channelId, socketId): void => {
      bus.subscribe(channelTopic(channelId), socketId);
    },
    clock,
    held: presence.held,
    route: async (identity, raw) =>
      await routeFrame(
        {
          database: db,
          clock,
          bus,
          presence,
          attention: nobodyActive,
          sessionLifetime: () => NO_SESSION_LIFETIME,
          limiter: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
          userWrites: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
          log: createLogger({ level: 'silent' }),
          socket: { hold: () => undefined, isOpen: () => true, drop: () => undefined },
          atomically: atomicallyOn(db),
        },
        {
          socketId: `socket-of-${identity.userId}`,
          expiresAt: NOW,
          sessionId: identity.sessionId ?? 'not-read',
          userId: identity.userId,
        },
        raw,
      ),
  };
};

const typing = (channelId: string): unknown => ({
  id: messageId(NOW),
  op: 'TYPING',
  payload: { channelId },
});

const typingFrames = (frames: readonly ServerFrame[]): ServerFrame[] =>
  frames.filter((frame) => frame.event === 'TYPING');

describe('integration: typing', () => {
  test('a member who types is heard by the channel, by who and for how long, and answered with nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ty-ana', 'ty-ben']);
      const ana = room.members['ty-ana'];
      if (ana === undefined) throw new Error('no ana');
      const node = aNode(db);
      node.listen(room.channelId, 'ben-socket');

      expect(await node.route(ana, typing(room.channelId))).toEqual([]);
      expect(node.heard('ben-socket')).toEqual([
        {
          event: 'TYPING',
          data: { channelId: room.channelId, userId: ana.userId, ttlMs: TYPING_TTL_MS },
          ts: NOW.getTime(),
        },
      ]);
    });
  });

  test('announcing again inside half the window reaches nobody; after it, the room hears it again', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ty-ana2', 'ty-ben2']);
      const ana = room.members['ty-ana2'];
      if (ana === undefined) throw new Error('no ana');
      const node = aNode(db);
      node.listen(room.channelId, 'ben-socket');

      await node.route(ana, typing(room.channelId));
      node.clock.advance(TYPING_TTL_MS / 2 - 1);
      await node.route(ana, typing(room.channelId));
      expect(typingFrames(node.heard('ben-socket'))).toHaveLength(1);
      node.clock.advance(1);
      await node.route(ana, typing(room.channelId));
      expect(typingFrames(node.heard('ben-socket'))).toHaveLength(2);
    });
  });

  test('a channel the sender cannot see is refused as not found, and its room hears nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ty-ana3', 'ty-ben3'], {
        type: 'private',
        outsiders: ['ty-cem3'],
      });
      const cem = room.outsiders['ty-cem3'];
      if (cem === undefined) throw new Error('no cem');
      const node = aNode(db);
      node.listen(room.channelId, 'ben-socket');

      const frame = typing(room.channelId);
      const replies = await node.route(cem, frame);
      expect(replies).toMatchObject([
        {
          event: 'ERROR',
          data: { code: 'CHANNEL_NOT_FOUND' },
          refId: (frame as { id: string }).id,
        },
      ]);
      expect(node.heard('ben-socket')).toEqual([]);
      // Refused before the registry heard of it: an id nobody may see takes no place in memory.
      expect(node.held()).toBe(0);
    });
  });

  test('somebody who can see a public channel but is not in it is not heard there; a member still is', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ty-ana6', 'ty-ben6'], { outsiders: ['ty-cem6'] });
      const cem = room.outsiders['ty-cem6'];
      const ana = room.members['ty-ana6'];
      if (cem === undefined || ana === undefined) throw new Error('no cem or ana');
      const node = aNode(db);
      node.listen(room.channelId, 'ben-socket');

      // An announcement is not a request: nothing to answer, and nothing for the room to hear —
      // what they would type could not be sent (D-156), so "Cem is typing…" would be a lie.
      expect(await node.route(cem, typing(room.channelId))).toEqual([]);
      expect(node.heard('ben-socket')).toEqual([]);
      expect(node.held()).toBe(0);

      await node.route(ana, typing(room.channelId));
      expect(typingFrames(node.heard('ben-socket'))).toMatchObject([
        { data: { userId: ana.userId } },
      ]);
    });
  });

  test('somebody who has left the channel is no longer heard typing in it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ty-ana7', 'ty-ben7']);
      const ana = room.members['ty-ana7'];
      if (ana === undefined) throw new Error('no ana');
      const node = aNode(db);
      node.listen(room.channelId, 'ben-socket');
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', ana.userId)
        .execute();

      expect(await node.route(ana, typing(room.channelId))).toEqual([]);
      expect(node.heard('ben-socket')).toEqual([]);
    });
  });

  test('a channel in another workspace is refused the same way, public or not', async () => {
    await withRollback(async (db) => {
      const theirs = await aRoom(db, ['ty-dan5']);
      const ours = await aRoom(db, ['ty-eve5']);
      const eve = ours.members['ty-eve5'];
      if (eve === undefined) throw new Error('no eve');
      const node = aNode(db);
      node.listen(theirs.channelId, 'dan-socket');

      expect(await node.route(eve, typing(theirs.channelId))).toMatchObject([
        { event: 'ERROR', data: { code: 'CHANNEL_NOT_FOUND' } },
      ]);
      expect(node.heard('dan-socket')).toEqual([]);
      expect(node.held()).toBe(0);
    });
  });

  test('a message ends the window: the next keystroke is heard at once, not half a window later', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ty-ana4', 'ty-ben4']);
      const ana = room.members['ty-ana4'];
      if (ana === undefined) throw new Error('no ana');
      const node = aNode(db);
      node.listen(room.channelId, 'ben-socket');
      const { sessionId } = await aSession(db, node.clock, ana.userId, 30);

      await node.route(ana, typing(room.channelId));
      const sent = await node.route(
        { userId: ana.userId, sessionId },
        {
          id: messageId(NOW),
          op: 'MESSAGE_SEND',
          payload: { channelId: room.channelId, content: 'hi' },
        },
      );
      expect(sent).toMatchObject([{ event: 'ACK' }]);
      await node.route(ana, typing(room.channelId));
      expect(typingFrames(node.heard('ben-socket'))).toHaveLength(2);
    });
  });
});
