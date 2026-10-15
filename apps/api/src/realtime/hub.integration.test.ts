/**
 * What the hub arms for a connection, and that closing releases it.
 *
 * A session's expiry is a timer that may be thirty days away. One left behind by
 * every socket that ever closed is a leak measured in connections, not requests.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { CLOSE_CODES } from '@purlay/types';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { aSignedInUser } from '../testing/signed-in';
import { fixedClock } from '../platform/clock';
import { createLogger } from '../platform/logging';
import { revokeAllSessions } from '../modules/auth/sessions';
import { publishSessionsEnded, sessionTopic } from '../platform/events';
import { inProcessEventBus } from './bus';
import { createSocketHub, type Timers } from './hub';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const quietConnection = {
  send: (): number => 0,
  buffered: (): number => 0,
  close: (): void => undefined,
};

const recorded = (): Timers & { armed: number[]; cleared: unknown[] } => {
  const armed: number[] = [];
  const cleared: unknown[] = [];
  return {
    armed,
    cleared,
    set: (_callback, ms): number => {
      armed.push(ms);
      return armed.length;
    },
    clear: (handle): void => {
      cleared.push(handle);
    },
  };
};

describe('integration: the hub’s expiry timer', () => {
  test('is armed when the identity resolves and cancelled when the connection closes', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'hub-timer');
      const timers = recorded();
      const hub = createSocketHub(db, clock, {
        log: createLogger({ level: 'silent' }),
        leave: () => undefined,
        listen: () => undefined,
        timers,
      });
      await hub.opened(
        's',
        quietConnection,
        new Request('https://purlay.test/ws', { headers: { cookie: alice.cookie } }),
      );
      // The control: without it "nothing was cleared" would pass just as well if
      // no timer had ever been set.
      expect(timers.armed).toHaveLength(1);
      expect(timers.cleared).toEqual([]);

      expect(hub.connectionsOf(alice.userId)).toBe(1);

      hub.closed('s');
      expect(timers.cleared).toEqual([1]);
      expect(hub.size()).toBe(0);
      // Given back, and the entry with it: a count per user ever seen is a leak.
      expect(hub.connectionsOf(alice.userId)).toBe(0);
    });
  });

  test('a connection closed while its identity resolves arms nothing', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'hub-timer-early');
      const timers = recorded();
      const hub = createSocketHub(db, clock, {
        log: createLogger({ level: 'silent' }),
        leave: () => undefined,
        listen: () => undefined,
        timers,
      });
      const opening = hub.opened(
        's',
        quietConnection,
        new Request('https://purlay.test/ws', { headers: { cookie: alice.cookie } }),
      );
      hub.closed('s');
      await opening;
      expect(timers.armed).toEqual([]);
    });
  });
});

/**
 * A sign-out that lands while a socket is opening. The identity is read, then the
 * socket subscribes to the topic its session's end is published on; a sign-out
 * between the two was published to nobody, and the socket stayed open and
 * authenticated — a send in that window was acknowledged and stored. The hook runs
 * the sign-out at exactly that point: when the first read has returned.
 */
describe('integration: a sign-out while a socket is opening', () => {
  test('is seen by the confirming read, and the socket is closed', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'open-race');
      let armed = true;
      const racing = db.withPlugin({
        transformQuery: (args) => args.node,
        transformResult: async (args) => {
          if (armed) {
            armed = false;
            // The sign-out: written, then published on the session's topic — to
            // whoever is listening, which at this moment is nobody.
            const ended = await revokeAllSessions(db, clock, alice.userId);
            await publishSessionsEnded(bus, clock, ended);
          }
          return args.result;
        },
      });
      const closes: number[] = [];
      const events: string[] = [];
      const log = createLogger({ level: 'silent' });
      const hub = createSocketHub(racing, clock, {
        log,
        leave: () => undefined,
        listen: (identity) => {
          bus.subscribe(sessionTopic(identity.sessionId), identity.socketId);
        },
      });
      const bus = inProcessEventBus(hub.deliver, log);

      const identity = await hub.opened(
        's',
        {
          send: (payload): number => {
            events.push(`send ${payload}`);
            return payload.length;
          },
          buffered: (): number => 0,
          close: (code, reason): void => {
            closes.push(code);
            events.push(`close ${String(code)} ${reason}`);
          },
        },
        new Request('https://purlay.test/ws', { headers: { cookie: alice.cookie } }),
      );

      expect(armed).toBe(false);
      expect(identity).toBeUndefined();
      expect(closes).toEqual([4401]);
      // Said why, then closed (#194, #577): the client is told, not left to guess from a code.
      expect(events).toEqual([
        `send ${JSON.stringify({ event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts: clock.now().getTime() })}`,
        `close ${String(CLOSE_CODES.SESSION_ENDED)} signed-out`,
      ]);
      // And nothing on it is answered: the frames queued behind it see no identity.
      expect(await hub.identity('s')).toBeUndefined();
      hub.closed('s');
    });
  });

  // The other side of the window: the sign-out lands after admission let the socket in and before
  // the hub's first read — what a client that signs out the moment its socket opens can meet under
  // load. It had a session, and is told why, like every end of one (#194, #577). Seen in a full run:
  // a 4401 close with no frame before it (#632).
  test('a session gone before the hub first reads it is still told why before the close', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'open-race-before');
      await revokeAllSessions(db, clock, alice.userId);
      const events: string[] = [];
      const log = createLogger({ level: 'silent' });
      const hub = createSocketHub(db, clock, {
        log,
        leave: () => undefined,
        listen: () => undefined,
      });

      const identity = await hub.opened(
        's',
        {
          send: (payload): number => {
            events.push(`send ${payload}`);
            return payload.length;
          },
          buffered: (): number => 0,
          close: (code, reason): void => {
            events.push(`close ${String(code)} ${reason}`);
          },
        },
        new Request('https://purlay.test/ws', { headers: { cookie: alice.cookie } }),
      );

      expect(identity).toBeUndefined();
      expect(events).toEqual([
        `send ${JSON.stringify({ event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts: clock.now().getTime() })}`,
        `close ${String(CLOSE_CODES.SESSION_ENDED)} signed-out`,
      ]);
      hub.closed('s');
    });
  });

  test('a sign-out after the socket is listening is heard on the topic instead', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'open-race-after');
      const closes: number[] = [];
      const log = createLogger({ level: 'silent' });
      const hub = createSocketHub(db, clock, {
        log,
        leave: () => undefined,
        listen: (identity) => {
          bus.subscribe(sessionTopic(identity.sessionId), identity.socketId);
        },
      });
      const bus = inProcessEventBus(hub.deliver, log);
      const identity = await hub.opened(
        's',
        {
          send: (): number => 0,
          buffered: (): number => 0,
          close: (code): void => {
            closes.push(code);
          },
        },
        new Request('https://purlay.test/ws', { headers: { cookie: alice.cookie } }),
      );
      expect(identity).toBeDefined();
      expect(closes).toEqual([]);

      await publishSessionsEnded(bus, clock, [identity?.sessionId ?? '']);
      expect(closes).toEqual([4401]);
      hub.closed('s');
    });
  });
});
