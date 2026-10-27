/**
 * Who is online when nodes share a record (D-201): a second node holding a person changes nothing for the
 * room, the last node leaving tells, a record that cannot be reached never stops a person from being online
 * here, and a node keeps its claims alive. The record is a reference of the scripts' rules in memory; the
 * scripts themselves are held against a real Redis (`shared.redis.integration.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { PRESENCE_GRACE_MS, type PresenceChange } from '@purlay/types';
import type { Clock } from '../platform/clock';
import { aRecordingLogger } from '../testing/doubles';
import type { Timers } from './hub';
import { onlinePresence, PRESENCE_NODE_TTL_MS, type PresenceDirectory } from './online';

/** The scripts' rules, in memory: claims with lapse times per person, and versions that only grow. */
const sharedRecord = (
  now: () => number,
): { directoryFor: (node: string) => PresenceDirectory; down: { value: boolean } } => {
  const claims = new Map<string, Map<string, number>>();
  const versions = new Map<string, number>();
  /** The lapse index: people nobody has been told are gone. */
  const due = new Set<string>();
  const down = { value: false };
  const live = (userId: string): number => {
    const held = claims.get(userId) ?? new Map<string, number>();
    for (const [node, until] of held) if (until <= now()) held.delete(node);
    claims.set(userId, held);
    return held.size;
  };
  const bump = (userId: string): number => {
    const version = Math.max(now() + 1, (versions.get(userId) ?? 0) + 1);
    versions.set(userId, version);
    return version;
  };
  const guard = (): void => {
    if (down.value) throw new Error('redis is not connected');
  };
  return {
    down,
    directoryFor: (node) => ({
      join: async (userId): Promise<number | null> => {
        // Slower than a leave, so a leave that was not made to wait for it would overtake it.
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
        guard();
        const before = live(userId);
        claims.get(userId)?.set(node, now() + PRESENCE_NODE_TTL_MS);
        due.add(userId);
        return before > 0 ? null : bump(userId);
      },
      leave: async (userId): Promise<number | null> => {
        await Promise.resolve();
        guard();
        claims.get(userId)?.delete(node);
        if (live(userId) > 0) return null;
        due.delete(userId);
        return bump(userId);
      },
      release: async (userIds): Promise<void> => {
        await Promise.resolve();
        guard();
        for (const userId of userIds) claims.get(userId)?.delete(node);
      },
      sweep: async (): Promise<readonly PresenceChange[]> => {
        await Promise.resolve();
        guard();
        const gone: PresenceChange[] = [];
        for (const userId of [...due]) {
          if (live(userId) > 0) continue;
          due.delete(userId);
          gone.push({ userId, online: false, version: bump(userId) });
        }
        return gone;
      },
      among: async (userIds): Promise<readonly PresenceChange[]> => {
        await Promise.resolve();
        guard();
        return userIds.flatMap((userId): PresenceChange[] =>
          live(userId) > 0 ? [{ userId, online: true, version: versions.get(userId) ?? 0 }] : [],
        );
      },
      version: async (): Promise<number> => {
        await Promise.resolve();
        guard();
        return now();
      },
    }),
  };
};

const timersRecorded = (): Timers & {
  readonly armed: { readonly ms: number; readonly fire: () => void; cleared: boolean }[];
  readonly fireDue: (ms: number) => void;
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
    fireDue: (ms): void => {
      for (const timer of armed.filter((t) => !t.cleared && t.ms === ms)) {
        timer.cleared = true;
        timer.fire();
      }
    },
    fireAll: (): void => {
      for (const timer of armed.filter((t) => !t.cleared)) {
        timer.cleared = true;
        timer.fire();
      }
    },
  };
};

interface TestNode {
  readonly online: ReturnType<typeof onlinePresence>;
  readonly told: PresenceChange[];
  readonly timers: ReturnType<typeof timersRecorded>;
  readonly lines: Record<string, unknown>[];
}

const cluster = (): {
  node: () => TestNode;
  now: { value: number };
  record: ReturnType<typeof sharedRecord>;
} => {
  const now = { value: 1_000_000 };
  const clock: Clock = { now: () => new Date(now.value) };
  const record = sharedRecord(() => now.value);
  let made = 0;
  return {
    now,
    record,
    node: (): TestNode => {
      made += 1;
      const told: PresenceChange[] = [];
      const timers = timersRecorded();
      const { log, lines } = aRecordingLogger();
      const online = onlinePresence({
        clock,
        timers,
        log,
        announce: (change): Promise<void> => {
          told.push(change);
          return Promise.resolve();
        },
        directory: record.directoryFor(`node-${String(made)}`),
      });
      return { online, told, timers, lines };
    },
  };
};

describe('who is online across nodes', () => {
  test('a person on both nodes is told online once, and offline only when the last node lets them go', async () => {
    const world = cluster();
    const a = world.node();
    const b = world.node();

    a.online.arrived('alice');
    await a.online.settled();
    b.online.arrived('alice');
    await b.online.settled();
    expect(a.told.map((c) => c.online)).toEqual([true]);
    expect(b.told).toEqual([]);

    a.online.left('alice');
    a.timers.fireDue(PRESENCE_GRACE_MS);
    await a.online.settled();
    // Still held on node B: nothing changed for anybody.
    expect(a.told.map((c) => c.online)).toEqual([true]);

    b.online.left('alice');
    b.timers.fireDue(PRESENCE_GRACE_MS);
    await b.online.settled();
    expect(b.told.map((c) => c.online)).toEqual([false]);
    expect((b.told[0]?.version ?? 0) > (a.told[0]?.version ?? 0)).toBe(true);
  });

  test('a person online on the other node is online when this node is asked', async () => {
    const world = cluster();
    const a = world.node();
    const b = world.node();
    b.online.arrived('bob');
    await b.online.settled();
    expect((await a.online.onlineAmong(['bob', 'carol'])).map((c) => c.userId)).toEqual(['bob']);
  });

  test('a node that dies stops claiming people: they are offline to every read once its claim lapses', async () => {
    const world = cluster();
    const a = world.node();
    const b = world.node();
    b.online.arrived('bob');
    await b.online.settled();
    world.now.value += PRESENCE_NODE_TTL_MS - 1;
    expect(await a.online.onlineAmong(['bob'])).toHaveLength(1);
    world.now.value += 2;
    expect(await a.online.onlineAmong(['bob'])).toEqual([]);
  });

  test('a live node renews its claims, so what it holds does not lapse', async () => {
    const world = cluster();
    const a = world.node();
    const b = world.node();
    b.online.arrived('bob');
    await b.online.settled();
    for (let step = 0; step < 6; step += 1) {
      world.now.value += PRESENCE_NODE_TTL_MS / 3;
      b.timers.fireDue(PRESENCE_NODE_TTL_MS / 3);
      await b.online.settled();
    }
    expect(await a.online.onlineAmong(['bob'])).toHaveLength(1);
    expect(b.told.map((c) => c.online)).toEqual([true]);
  });

  test('a node whose claims lapsed while it stalled: the person is told gone, then back, in order', async () => {
    const world = cluster();
    const a = world.node();
    a.online.arrived('alice');
    await a.online.settled();
    world.now.value += PRESENCE_NODE_TTL_MS + 1;
    a.timers.fireDue(PRESENCE_NODE_TTL_MS / 3);
    await a.online.settled();
    // Their claim lapsed unrenewed, so they were told gone; then renewed, so told back: in that order.
    expect(a.told.map((c) => c.online)).toEqual([true, false, true]);
    const versions = a.told.map((c) => c.version);
    expect(versions).toEqual([...versions].sort((x, y) => x - y));
  });

  test('a join is never overtaken by the leave after it, however the record answers', async () => {
    const world = cluster();
    const a = world.node();
    a.online.arrived('alice');
    a.online.left('alice');
    a.timers.fireDue(PRESENCE_GRACE_MS);
    await a.online.settled();
    expect(a.told.map((c) => c.online)).toEqual([true, false]);
    expect(await world.node().online.onlineAmong(['alice'])).toEqual([]);
  });

  test('a record that cannot be reached still lets a person be online here, and says so', async () => {
    const world = cluster();
    const a = world.node();
    world.record.down.value = true;
    a.online.arrived('alice');
    await a.online.settled();
    expect(a.told.map((c) => c.online)).toEqual([true]);
    expect(
      a.lines.some((line) => String(line['msg']).includes('telling from this node alone')),
    ).toBe(true);
    // Their own node answers for them while the record is away.
    expect((await a.online.onlineAmong(['alice'])).map((c) => c.userId)).toEqual(['alice']);
    expect(typeof (await a.online.version())).toBe('number');
  });

  test('leaving while the record is away tells nobody they left, and holds nothing up', async () => {
    const world = cluster();
    const a = world.node();
    a.online.arrived('alice');
    await a.online.settled();
    world.record.down.value = true;
    a.online.left('alice');
    a.timers.fireDue(PRESENCE_GRACE_MS);
    await a.online.settled();
    expect(a.told.map((c) => c.online)).toEqual([true]);
    expect(a.online.held()).toEqual({ online: 0, leaving: 0 });
  });

  test('a renewal that fails is tried again at the next one, and never an error', async () => {
    const world = cluster();
    const a = world.node();
    a.online.arrived('alice');
    await a.online.settled();
    world.record.down.value = true;
    a.timers.fireDue(PRESENCE_NODE_TTL_MS / 3);
    await a.online.settled();
    expect(a.lines.filter((line) => line['level'] === 'error')).toEqual([]);
    expect(a.timers.armed.some((t) => !t.cleared && t.ms === PRESENCE_NODE_TTL_MS / 3)).toBe(true);
  });

  test('a stopping node renews nothing', async () => {
    const world = cluster();
    const a = world.node();
    a.online.arrived('alice');
    await a.online.settled();
    a.online.stop();
    expect(a.timers.armed.every((t) => t.cleared)).toBe(true);
  });

  test('a node that dies without a word: whoever renews next tells the room, once', async () => {
    const world = cluster();
    const dying = world.node();
    const living = world.node();
    dying.online.arrived('bob');
    await dying.online.settled();
    world.now.value += PRESENCE_NODE_TTL_MS + 1;
    living.timers.fireDue(PRESENCE_NODE_TTL_MS / 3);
    await living.online.settled();
    expect(living.told.map((c) => [c.userId, c.online])).toEqual([['bob', false]]);
    world.now.value += 1;
    living.timers.fireDue(PRESENCE_NODE_TTL_MS / 3);
    await living.online.settled();
    expect(living.told).toHaveLength(1);
  });

  test('a node that stops gives its claims up: a person who does not come back elsewhere is told gone at the next sweep', async () => {
    const world = cluster();
    const stopping = world.node();
    const staying = world.node();
    stopping.online.arrived('bob');
    stopping.online.arrived('carol');
    await stopping.online.settled();
    // Carol reconnects to the other node as the first closes; Bob does not.
    staying.online.arrived('carol');
    await staying.online.settled();
    stopping.online.stop();
    await stopping.online.settled();
    staying.timers.fireDue(PRESENCE_NODE_TTL_MS / 3);
    await staying.online.settled();
    expect(staying.told.map((c) => [c.userId, c.online])).toEqual([['bob', false]]);
    expect(await staying.online.onlineAmong(['bob', 'carol'])).toMatchObject([{ userId: 'carol' }]);
  });

  test('a release that fails is said, and the claims lapse by themselves', async () => {
    const world = cluster();
    const stopping = world.node();
    stopping.online.arrived('bob');
    await stopping.online.settled();
    world.record.down.value = true;
    stopping.online.stop();
    await stopping.online.settled();
    expect(
      stopping.lines.some((line) => String(line['msg']).includes('could not be released')),
    ).toBe(true);
  });

  test('a version this node makes itself is larger than any the record gave', async () => {
    const world = cluster();
    const a = world.node();
    a.online.arrived('alice');
    await a.online.settled();
    const given = a.told[0]?.version ?? 0;
    world.record.down.value = true;
    a.online.arrived('bob');
    await a.online.settled();
    expect((a.told[1]?.version ?? 0) > given).toBe(true);
  });
});
