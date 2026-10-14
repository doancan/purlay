/**
 * Who is online on this node (#480, D-136): the first socket tells at once, a second tells nothing;
 * the last closing tells after the grace, and coming back inside it tells nothing at all; versions
 * only grow, even when the clock steps back; a stopping node tells nobody; a telling that fails is
 * said and takes nothing with it.
 */
import { describe, expect, test } from 'bun:test';
import { PRESENCE_GRACE_MS, type PresenceChange } from '@purlay/types';
import type { Clock } from '../platform/clock';
import { aRecordingLogger } from '../testing/doubles';
import type { Timers } from './hub';
import { onlinePresence } from './online';

const timersRecorded = (): Timers & {
  readonly armed: { readonly ms: number; readonly fire: () => void; cleared: boolean }[];
  readonly fireAll: () => void;
} => {
  const armed: { ms: number; fire: () => void; cleared: boolean }[] = [];
  return {
    armed,
    set: (fire, ms): number => {
      armed.push({ ms, fire, cleared: false });
      return armed.length - 1;
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
      { userId: 'alice', online: true, version: w.told[0]?.version ?? -1 },
    ]);
  });

  test('the last socket closing tells after the grace, armed for exactly the grace', async () => {
    const w = world();
    w.online.arrived('alice');
    w.online.left('alice');
    await w.online.settled();
    expect(w.told).toHaveLength(1);
    expect(w.timers.armed.map((t) => t.ms)).toEqual([PRESENCE_GRACE_MS]);
    expect(w.online.held()).toEqual({ online: 1, leaving: 1 });
    w.timers.fireAll();
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
    w.timers.fireAll();
    await w.online.settled();
    expect(w.told.map((c) => c.online)).toEqual([true]);
    expect(w.online.held()).toEqual({ online: 1, leaving: 0 });
  });

  test('versions only grow, even when the clock steps back', async () => {
    const w = world();
    w.online.arrived('alice');
    w.setNow(500);
    w.online.left('alice');
    w.timers.fireAll();
    w.online.arrived('bob');
    await w.online.settled();
    const versions = w.told.map((c) => c.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(w.online.version()).toBeGreaterThanOrEqual(versions.at(-1) ?? 0);
  });

  test('a snapshot moves no counter, and every change after it is larger than its version', async () => {
    const w = world();
    w.online.arrived('alice');
    w.setNow(500);
    const read = w.online.version();
    expect(w.online.version()).toBe(read);
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
    w.timers.fireAll();
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
    w.timers.fireAll();
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
      w.timers.fireAll();
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
