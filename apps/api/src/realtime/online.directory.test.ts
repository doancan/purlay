/**
 * Who is online when nodes share a record (D-201): a second node holding a person changes nothing for the
 * room, the last node leaving tells, a record that cannot be reached never stops a person from being online
 * here, and a node keeps its claims alive. The record is a reference of the scripts' rules in memory; the
 * scripts themselves are held against a real Redis (`shared.redis.integration.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { AWAY_AFTER_MS, PRESENCE_GRACE_MS, type PresenceChange } from '@purlay/types';
import type { Clock } from '../platform/clock';
import { aRecordingLogger } from '../testing/doubles';
import type { Timers } from './hub';
import { onlinePresence, PRESENCE_NODE_TTL_MS, type PresenceDirectory } from './online';

/**
 * The scripts' rules, in memory: claims with lapse times per person, versions that only grow, and each
 * person's idleness — when it falls due, and whether it was told (D-257).
 */
const sharedRecord = (
  now: () => number,
): { directoryFor: (node: string) => PresenceDirectory; down: { value: boolean } } => {
  const claims = new Map<string, Map<string, number>>();
  const versions = new Map<string, number>();
  /** The lapse index: people nobody has been told are gone. */
  const due = new Set<string>();
  /** The idle index: when each person's quiet time comes. */
  const idleAt = new Map<string, number>();
  /** Told idle, and not yet told active again. */
  const toldIdle = new Set<string>();
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
      join: async (userId, awayAfterMs): Promise<number | null> => {
        // Slower than a leave, so a leave that was not made to wait for it would overtake it.
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
        guard();
        const before = live(userId);
        claims.get(userId)?.set(node, now() + PRESENCE_NODE_TTL_MS);
        due.add(userId);
        if (before > 0) return null;
        toldIdle.delete(userId);
        idleAt.set(userId, now() + awayAfterMs);
        return bump(userId);
      },
      leave: async (userId): Promise<number | null> => {
        await Promise.resolve();
        guard();
        claims.get(userId)?.delete(node);
        if (live(userId) > 0) return null;
        due.delete(userId);
        idleAt.delete(userId);
        return bump(userId);
      },
      active: async (userId, awayAfterMs): Promise<number | null> => {
        await Promise.resolve();
        guard();
        if (live(userId) === 0) return null;
        idleAt.set(userId, now() + awayAfterMs);
        return toldIdle.delete(userId) ? bump(userId) : null;
      },
      retell: async (userId): Promise<PresenceChange | null> => {
        await Promise.resolve();
        guard();
        if (live(userId) === 0) return null;
        return { userId, online: true, away: toldIdle.has(userId), version: bump(userId) };
      },
      release: async (userIds): Promise<void> => {
        await Promise.resolve();
        guard();
        for (const userId of userIds) {
          claims.get(userId)?.delete(node);
          if (live(userId) === 0) idleAt.delete(userId);
        }
      },
      sweep: async (): Promise<readonly PresenceChange[]> => {
        await Promise.resolve();
        guard();
        const gone: PresenceChange[] = [];
        for (const userId of [...due]) {
          if (live(userId) > 0) continue;
          due.delete(userId);
          idleAt.delete(userId);
          gone.push({ userId, online: false, away: false, version: bump(userId) });
        }
        for (const [userId, at] of [...idleAt]) {
          if (at > now()) continue;
          idleAt.delete(userId);
          if (live(userId) === 0 || toldIdle.has(userId)) continue;
          toldIdle.add(userId);
          gone.push({ userId, online: true, away: true, version: bump(userId) });
        }
        return gone;
      },
      among: async (userIds): Promise<readonly PresenceChange[]> => {
        await Promise.resolve();
        guard();
        return userIds.flatMap((userId): PresenceChange[] =>
          live(userId) > 0
            ? [
                {
                  userId,
                  online: true,
                  away: toldIdle.has(userId),
                  version: versions.get(userId) ?? 0,
                },
              ]
            : [],
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

describe('who is away across nodes: idleness in the shared record (D-257)', () => {
  const RENEW_MS = PRESENCE_NODE_TTL_MS / 3;
  /** Time passes in renewals: every node renews and sweeps at each, as live nodes do. */
  const pass = async (
    world: ReturnType<typeof cluster>,
    nodes: readonly TestNode[],
    ms: number,
    speaking?: { readonly node: TestNode; readonly userId: string },
  ): Promise<void> => {
    for (let spent = 0; spent < ms; spent += RENEW_MS) {
      world.now.value += RENEW_MS;
      for (const each of nodes) {
        each.timers.fireDue(RENEW_MS);
        await each.online.settled();
      }
      speaking?.node.online.active(speaking.userId);
      await speaking?.node.online.settled();
    }
  };
  const states = (node: TestNode, userId = 'alice'): [boolean, boolean][] =>
    node.told.filter((c) => c.userId === userId).map((c) => [c.online, c.away]);

  test('five quiet minutes are told away once, by one node, and a word on the other tells active at a later version', async () => {
    const world = cluster();
    const a = world.node();
    const b = world.node();
    a.online.arrived('alice');
    await a.online.settled();
    b.online.arrived('alice');
    await b.online.settled();
    await pass(world, [a, b], AWAY_AFTER_MS - RENEW_MS);
    expect([...states(a), ...states(b)]).toEqual([[true, false]]);
    await pass(world, [a, b], 2 * RENEW_MS);
    expect([...states(a), ...states(b)]).toEqual([
      [true, false],
      [true, true],
    ]);
    expect(await b.online.onlineAmong(['alice'])).toMatchObject([{ away: true }]);
    const idle = [...a.told, ...b.told].at(-1)?.version ?? Infinity;

    b.online.active('alice');
    await b.online.settled();
    expect(states(b).at(-1)).toEqual([true, false]);
    expect(b.told.at(-1)?.version).toBeGreaterThan(idle);
    expect(await a.online.onlineAmong(['alice'])).toMatchObject([{ away: false }]);
    // Words while active tell nothing: not a frame per word.
    b.online.active('alice');
    a.online.active('alice');
    await a.online.settled();
    await b.online.settled();
    expect([...a.told, ...b.told]).toHaveLength(3);
  });

  test('a person idle on one node and speaking on the other is active', async () => {
    const world = cluster();
    const a = world.node();
    const b = world.node();
    a.online.arrived('alice');
    await a.online.settled();
    b.online.arrived('alice');
    await b.online.settled();
    await pass(world, [a, b], 3 * AWAY_AFTER_MS, { node: b, userId: 'alice' });
    expect([...states(a), ...states(b)]).toEqual([[true, false]]);
  });

  test('a node that dies while its socket was idle leaves the person active where they speak', async () => {
    const world = cluster();
    const dying = world.node();
    const living = world.node();
    dying.online.arrived('alice');
    await dying.online.settled();
    living.online.arrived('alice');
    await living.online.settled();
    // The dying node renews no more; the living one speaks for her.
    await pass(world, [living], 2 * AWAY_AFTER_MS, { node: living, userId: 'alice' });
    expect([...states(dying), ...states(living)]).toEqual([[true, false]]);
    expect(await living.online.onlineAmong(['alice'])).toMatchObject([
      { online: true, away: false },
    ]);
  });

  test('no node tells idleness from its own timers when it shares a record', async () => {
    const world = cluster();
    const a = world.node();
    a.online.arrived('alice');
    a.online.active('alice');
    await a.online.settled();
    expect(a.timers.armed.some((t) => t.ms === AWAY_AFTER_MS)).toBe(false);
  });

  test('a word for somebody not online here is not recorded', async () => {
    const world = cluster();
    const a = world.node();
    a.online.active('alice');
    await a.online.settled();
    expect(a.told).toEqual([]);
    expect(await a.online.onlineAmong(['alice'])).toEqual([]);
  });

  test('somebody who went offline and came back is active again, whatever they were', async () => {
    const world = cluster();
    const a = world.node();
    a.online.arrived('alice');
    await a.online.settled();
    await pass(world, [a], AWAY_AFTER_MS + RENEW_MS);
    a.online.left('alice');
    a.timers.fireDue(PRESENCE_GRACE_MS);
    await a.online.settled();
    a.online.arrived('alice');
    await a.online.settled();
    expect(states(a)).toEqual([
      [true, false],
      [true, true],
      [false, false],
      [true, false],
    ]);
    expect(await a.online.onlineAmong(['alice'])).toMatchObject([{ away: false }]);
  });

  test('a word the record cannot take is said at warn and tells nothing; the next word corrects it', async () => {
    const world = cluster();
    const a = world.node();
    a.online.arrived('alice');
    await a.online.settled();
    await pass(world, [a], AWAY_AFTER_MS + RENEW_MS);
    world.record.down.value = true;
    a.online.active('alice');
    await a.online.settled();
    expect(states(a)).toEqual([
      [true, false],
      [true, true],
    ]);
    expect(
      a.lines.some(
        (line) => line['level'] === 'warn' && String(line['msg']).includes('shared record'),
      ),
    ).toBe(true);
    expect(a.lines.filter((line) => line['level'] === 'error')).toEqual([]);
    world.record.down.value = false;
    a.online.active('alice');
    await a.online.settled();
    expect(states(a).at(-1)).toEqual([true, false]);
  });

  test('a retelling takes a new version from the record and says the idleness it holds, on any node', async () => {
    const world = cluster();
    const a = world.node();
    const b = world.node();
    a.online.arrived('alice');
    await a.online.settled();
    await pass(world, [a], AWAY_AFTER_MS + RENEW_MS);
    const idle = a.told.at(-1)?.version ?? Infinity;
    // Node B holds no socket of hers: the record still knows her.
    await b.online.retell('alice');
    await b.online.settled();
    expect(b.told).toEqual([
      { userId: 'alice', online: true, away: true, version: expect.any(Number) as number },
    ]);
    expect(b.told[0]?.version).toBeGreaterThan(idle);
    await b.online.retell('bob');
    await b.online.settled();
    expect(b.told).toHaveLength(1);
  });

  test('a retelling the record cannot answer is told from this node’s own record, and only for somebody online here', async () => {
    const world = cluster();
    const a = world.node();
    a.online.arrived('alice');
    await a.online.settled();
    const before = a.told[0]?.version ?? Infinity;
    world.record.down.value = true;
    await a.online.retell('alice');
    await a.online.retell('bob');
    await a.online.settled();
    expect(a.told.slice(1)).toEqual([
      { userId: 'alice', online: true, away: false, version: expect.any(Number) as number },
    ]);
    expect(a.told[1]?.version).toBeGreaterThan(before);
    expect(
      a.lines.some(
        (line) => line['level'] === 'warn' && String(line['msg']).includes('shared record'),
      ),
    ).toBe(true);
  });

  test('a record that cannot be reached is answered for from this node’s own record of the last word', async () => {
    const world = cluster();
    const a = world.node();
    a.online.arrived('alice');
    a.online.arrived('bob');
    await a.online.settled();
    world.now.value += AWAY_AFTER_MS - 1;
    a.online.active('bob');
    await a.online.settled();
    world.now.value += 1;
    world.record.down.value = true;
    expect(await a.online.onlineAmong(['alice', 'bob'])).toMatchObject([
      { userId: 'alice', away: true },
      { userId: 'bob', away: false },
    ]);
    await a.online.retell('alice');
    await a.online.settled();
    expect(a.told.at(-1)).toMatchObject({ userId: 'alice', away: true });
  });

  test('a stopped node takes no word and retells nothing', async () => {
    const world = cluster();
    const a = world.node();
    a.online.arrived('alice');
    await a.online.settled();
    a.online.stop();
    a.online.active('alice');
    await a.online.retell('alice');
    await a.online.settled();
    expect(a.told).toHaveLength(1);
  });
});
