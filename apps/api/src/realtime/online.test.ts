/**
 * Who is online on this node (#480, D-136): the first socket tells at once, a second tells nothing;
 * the last closing tells after the grace, and coming back inside it tells nothing at all; versions
 * only grow, even when the clock steps back; a stopping node tells nobody; a telling that fails is
 * said and takes nothing with it.
 */
import { describe, expect, test } from 'bun:test';
import { AWAY_AFTER_MS, PRESENCE_GRACE_MS, type PresenceChange } from '@purlay/types';
import type { Clock } from '../platform/clock';
import { aRecordingLogger } from '../testing/doubles';
import type { Timers } from './hub';
import { offlinePresence, onlinePresence } from './online';

const timersRecorded = (): Timers & {
  readonly armed: { readonly ms: number; readonly fire: () => void; cleared: boolean }[];
  readonly fireAll: () => void;
  /** Fires the grace timers only: the idle timers are left for `advance`. */
  readonly fireGrace: () => void;
  /** Moves quiet time forward, running each timer that falls due, in order, including ones they arm. */
  readonly advance: (ms: number) => void;
} => {
  const armed: { ms: number; at: number; fire: () => void; cleared: boolean }[] = [];
  let quiet = 0;
  return {
    armed,
    set: (fire, ms): number => {
      armed.push({ ms, at: quiet + ms, fire, cleared: false });
      return armed.length - 1;
    },
    fireGrace: (): void => {
      for (const timer of armed) {
        if (timer.ms === PRESENCE_GRACE_MS && !timer.cleared) {
          timer.cleared = true;
          timer.fire();
        }
      }
    },
    advance: (ms): void => {
      const until = quiet + ms;
      for (;;) {
        const due = armed.filter((t) => !t.cleared && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.cleared = true;
        quiet = Math.max(quiet, due.at);
        due.fire();
      }
      quiet = until;
    },
    clear: (handle): void => {
      const timer = armed[handle as number];
      if (timer !== undefined) timer.cleared = true;
    },
    fireAll: (): void => {
      for (const timer of armed.splice(0)) if (!timer.cleared) timer.fire();
    },
  };
};

const world = (
  announce?: (change: PresenceChange) => Promise<void>,
): {
  readonly online: ReturnType<typeof onlinePresence>;
  readonly told: PresenceChange[];
  readonly timers: ReturnType<typeof timersRecorded>;
  readonly lines: Record<string, unknown>[];
  setNow: (ms: number) => void;
} => {
  let now = 1_000_000;
  const clock: Clock = { now: () => new Date(now) };
  const told: PresenceChange[] = [];
  const timers = timersRecorded();
  const { log, lines } = aRecordingLogger();
  const online = onlinePresence({
    clock,
    timers,
    log,
    announce:
      announce ??
      ((change): Promise<void> => {
        told.push(change);
        return Promise.resolve();
      }),
  });
  return {
    online,
    told,
    timers,
    lines,
    setNow: (ms): void => {
      now = ms;
    },
  };
};

describe('who is online on this node', () => {
  test('the first socket tells at once; a second says nothing new', async () => {
    const w = world();
    w.online.arrived('alice');
    w.online.arrived('alice');
    await w.online.settled();
    expect(w.told.map((c) => [c.userId, c.online])).toEqual([['alice', true]]);
    expect(await w.online.onlineAmong(['alice', 'bob'])).toEqual([
      { userId: 'alice', online: true, away: false, version: w.told[0]?.version ?? -1 },
    ]);
  });

  test('the last socket closing tells after the grace, armed for exactly the grace', async () => {
    const w = world();
    w.online.arrived('alice');
    w.online.left('alice');
    await w.online.settled();
    expect(w.told).toHaveLength(1);
    expect(w.timers.armed.filter((t) => !t.cleared).map((t) => t.ms)).toContain(PRESENCE_GRACE_MS);
    expect(w.online.held()).toEqual({ online: 1, leaving: 1 });
    w.timers.fireGrace();
    await w.online.settled();
    expect(w.told.map((c) => [c.userId, c.online])).toEqual([
      ['alice', true],
      ['alice', false],
    ]);
    expect(w.online.held()).toEqual({ online: 0, leaving: 0 });
    expect(await w.online.onlineAmong(['alice'])).toEqual([]);
  });

  test('coming back inside the grace tells nobody anything: she never left', async () => {
    const w = world();
    w.online.arrived('alice');
    w.online.left('alice');
    w.online.arrived('alice');
    w.timers.fireGrace();
    await w.online.settled();
    expect(w.told.map((c) => c.online)).toEqual([true]);
    expect(w.online.held()).toEqual({ online: 1, leaving: 0 });
  });

  test('versions only grow, even when the clock steps back', async () => {
    const w = world();
    w.online.arrived('alice');
    w.setNow(500);
    w.online.left('alice');
    w.timers.fireGrace();
    w.online.arrived('bob');
    await w.online.settled();
    const versions = w.told.map((c) => c.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(await w.online.version()).toBeGreaterThanOrEqual(versions.at(-1) ?? 0);
  });

  test('a snapshot moves no counter, and every change after it is larger than its version', async () => {
    const w = world();
    w.online.arrived('alice');
    w.setNow(500);
    const read = await w.online.version();
    expect(await w.online.version()).toBe(read);
    w.online.arrived('bob');
    await w.online.settled();
    expect(w.told.at(-1)?.version).toBeGreaterThan(read);
  });

  test('a stopping node tells nobody: its sockets are coming back elsewhere', async () => {
    const w = world();
    w.online.arrived('alice');
    await w.online.settled();
    w.online.stop();
    w.online.left('alice');
    w.online.arrived('bob');
    w.timers.fireGrace();
    await w.online.settled();
    expect(w.told.map((c) => c.userId)).toEqual(['alice']);
    expect(w.online.held().leaving).toBe(0);
  });

  test('a grace already running when the node stops is cancelled', async () => {
    const w = world();
    w.online.arrived('alice');
    w.online.left('alice');
    w.online.stop();
    expect(w.timers.armed.every((t) => t.cleared)).toBe(true);
    w.timers.fireGrace();
    await w.online.settled();
    expect(w.told.map((c) => c.online)).toEqual([true]);
  });

  test('a telling that fails is tried again, after a wait, while it is still true', async () => {
    let failures = 1;
    const told: PresenceChange[] = [];
    const w = world((change) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('no database'));
      }
      told.push(change);
      return Promise.resolve();
    });
    w.online.arrived('alice');
    await w.online.settled();
    expect(told).toEqual([]);
    expect(w.online.held().leaving).toBe(1);
    w.timers.fireAll();
    await w.online.settled();
    expect(told.map((c) => [c.userId, c.online])).toEqual([['alice', true]]);
    expect(w.online.held()).toEqual({ online: 1, leaving: 0 });
  });

  test('a retry of what is no longer true tells nothing: the newer change told it', async () => {
    let failures = 1;
    const told: PresenceChange[] = [];
    const w = world((change) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('no database'));
      }
      told.push(change);
      return Promise.resolve();
    });
    w.online.arrived('alice');
    await w.online.settled();
    w.online.left('alice');
    // The grace runs first and tells the offline; the waiting retry of the online then says nothing.
    const grace = w.timers.armed.find((t) => t.ms === PRESENCE_GRACE_MS);
    if (grace === undefined) throw new Error('no grace armed');
    grace.cleared = true;
    grace.fire();
    await w.online.settled();
    w.timers.fireAll();
    await w.online.settled();
    expect(told.map((c) => c.online)).toEqual([false]);
  });

  test('a telling that fails every time stops after a few tries, said each time', async () => {
    const w = world(() => Promise.reject(new Error('no database')));
    w.online.arrived('alice');
    for (let i = 0; i < 10; i += 1) {
      await w.online.settled();
      // The retries only: five quiet minutes never pass in this test.
      for (const timer of w.timers.armed.splice(0)) {
        if (!timer.cleared && timer.ms !== AWAY_AFTER_MS) timer.fire();
      }
    }
    await w.online.settled();
    const said = w.lines.filter((line) => String(line['msg']).startsWith('presence could not'));
    expect(said).toHaveLength(4);
    expect(said.at(-1)?.['msg']).toBe('presence could not be told');
    expect(w.online.held().leaving).toBe(0);
  });

  test('a stopping node cancels the retries waiting', async () => {
    const w = world(() => Promise.reject(new Error('no database')));
    w.online.arrived('alice');
    await w.online.settled();
    w.online.stop();
    expect(w.online.held().leaving).toBe(0);
  });

  test('a telling that fails is said, and the next still tells', async () => {
    let fail = true;
    const told: string[] = [];
    const w = world((change) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('no database'));
      }
      told.push(change.userId);
      return Promise.resolve();
    });
    w.online.arrived('alice');
    w.online.arrived('bob');
    await w.online.settled();
    expect(told).toEqual(['bob']);
    expect(w.lines.some((line) => line['msg'] === 'presence could not be told; trying again')).toBe(
      true,
    );
  });
});

describe('the presence of a process that does not run what tells it', () => {
  test('counts nobody, holds nothing, tells nobody, and settles at once', async () => {
    offlinePresence.arrived('u1');
    offlinePresence.left('u1');
    offlinePresence.active('u1');
    await offlinePresence.retell('u1');
    expect(await offlinePresence.onlineAmong(['u1', 'u2'])).toEqual([]);
    expect(await offlinePresence.version()).toBe(0);
    expect(offlinePresence.held()).toEqual({ online: 0, leaving: 0 });
    await offlinePresence.settled();
    offlinePresence.stop();
    expect(offlinePresence.held()).toEqual({ online: 0, leaving: 0 });
  });
});

describe('who is away on this node: idleness only (D-257)', () => {
  test('an arrival is active, and five quiet minutes tell away', async () => {
    const w = world();
    w.online.arrived('alice');
    await w.online.settled();
    w.timers.advance(AWAY_AFTER_MS - 1);
    await w.online.settled();
    expect(w.told).toHaveLength(1);
    w.timers.advance(1);
    await w.online.settled();
    expect(w.told.map((c) => [c.online, c.away])).toEqual([
      [true, false],
      [true, true],
    ]);
    expect(w.told[1]?.version).toBeGreaterThan(w.told[0]?.version ?? Infinity);
    expect(await w.online.onlineAmong(['alice'])).toEqual([
      { userId: 'alice', online: true, away: true, version: w.told[1]?.version ?? -1 },
    ]);
  });

  test('a word every minute keeps them active for an hour', async () => {
    const w = world();
    w.online.arrived('alice');
    for (let minute = 0; minute < 60; minute += 1) {
      w.timers.advance(60_000);
      w.online.active('alice');
    }
    await w.online.settled();
    expect(w.told).toHaveLength(1);
  });

  test('the first word after a quiet spell tells active at once', async () => {
    const w = world();
    w.online.arrived('alice');
    w.timers.advance(AWAY_AFTER_MS);
    w.online.active('alice');
    await w.online.settled();
    expect(w.told.map((c) => c.away)).toEqual([false, true, false]);
    const versions = w.told.map((c) => c.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(3);
    // and the window began again
    w.timers.advance(AWAY_AFTER_MS);
    await w.online.settled();
    expect(w.told.map((c) => c.away)).toEqual([false, true, false, true]);
  });

  test('a word from somebody not online here is ignored', async () => {
    const w = world();
    w.online.active('ghost');
    await w.online.settled();
    expect(w.told).toEqual([]);
    expect(w.timers.armed).toEqual([]);
  });

  test('a socket back inside the grace changes nothing, idle or not', async () => {
    const w = world();
    w.online.arrived('alice');
    w.timers.advance(AWAY_AFTER_MS);
    w.online.left('alice');
    w.online.arrived('alice');
    w.timers.fireGrace();
    await w.online.settled();
    expect(w.told.map((c) => c.away)).toEqual([false, true]);
    expect(await w.online.onlineAmong(['alice'])).toMatchObject([{ away: true }]);
  });

  test('back after being offline is active', async () => {
    const w = world();
    w.online.arrived('alice');
    w.timers.advance(AWAY_AFTER_MS);
    w.online.left('alice');
    w.timers.fireGrace();
    w.online.arrived('alice');
    await w.online.settled();
    expect(w.told.map((c) => [c.online, c.away])).toEqual([
      [true, false],
      [true, true],
      [false, false],
      [true, false],
    ]);
    // and the new window runs on its own: no leftover timer tells them away early
    w.timers.advance(AWAY_AFTER_MS - 1);
    await w.online.settled();
    expect(w.told).toHaveLength(4);
  });

  test('going offline cancels the idle timer: nobody is told away after leaving', async () => {
    const w = world();
    w.online.arrived('alice');
    w.online.left('alice');
    w.timers.fireGrace();
    w.timers.advance(AWAY_AFTER_MS * 2);
    await w.online.settled();
    expect(w.told.map((c) => [c.online, c.away])).toEqual([
      [true, false],
      [false, false],
    ]);
  });

  test('retell says the same state at a larger version; offline says nothing', async () => {
    const w = world();
    w.online.arrived('alice');
    await w.online.retell('alice');
    w.timers.advance(AWAY_AFTER_MS);
    await w.online.retell('alice');
    await w.online.retell('bob');
    await w.online.settled();
    expect(w.told.map((c) => [c.userId, c.away])).toEqual([
      ['alice', false],
      ['alice', false],
      ['alice', true],
      ['alice', true],
    ]);
    const versions = w.told.map((c) => c.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(4);
  });

  test('stop cancels the idle timers', async () => {
    const w = world();
    w.online.arrived('alice');
    w.online.stop();
    expect(w.timers.armed.every((t) => t.cleared)).toBe(true);
    w.timers.advance(AWAY_AFTER_MS);
    w.online.active('alice');
    await w.online.retell('alice');
    await w.online.settled();
    expect(w.told.map((c) => c.away)).toEqual([false]);
  });

  test('the window is the one given when one is given', async () => {
    const told: PresenceChange[] = [];
    const timers = timersRecorded();
    const online = onlinePresence({
      clock: { now: () => new Date(1_000_000) },
      timers,
      log: aRecordingLogger().log,
      announce: (change) => {
        told.push(change);
        return Promise.resolve();
      },
      awayAfterMs: 1_000,
    });
    online.arrived('alice');
    timers.advance(1_000);
    await online.settled();
    expect(told.map((c) => c.away)).toEqual([false, true]);
  });
});
