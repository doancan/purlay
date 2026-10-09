/**
 * What the hub arms for a connection, and that closing releases it.
 *
 * A session's expiry is a timer that may be thirty days away. One left behind by
 * every socket that ever closed is a leak measured in connections, not requests.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { aSignedInUser } from '../testing/signed-in';
import { fixedClock } from '../platform/clock';
import { createLogger } from '../platform/logging';
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
