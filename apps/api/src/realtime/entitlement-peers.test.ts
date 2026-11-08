/**
 * The record of the nodes that read workspace grants (D-292), against a link that answers as the test says: a node renews its field
 * for as long as it lives, a Redis that is away is not a crash, a node that stops takes its field out, and a question that is not
 * answered with a number is a failure and not a zero. The scripts themselves are held against a real Redis by
 * `entitlement-peers.redis.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { redisNames } from '../platform/redis-names';
import { aRecordingLogger } from '../testing/doubles';
import { aFakeLink } from '../testing/redis';
import {
  advertiseEntitlements,
  advertiseSuspension,
  peersBehind,
  suspensionPeersBehind,
} from './entitlement-peers';
import type { Timers } from './hub';
import { ANNOUNCE_RETRY_MS, NODE_TTL_MS } from './module-set';

const names = redisNames();

/** Timers that run when the test says: a renewal is a turn of the loop, not a wait. */
const manualTimers = (): {
  timers: Timers;
  tick: () => Promise<void>;
  pending: () => number;
  /** The wait each timer was set for, in the order they were set. */
  delays: number[];
} => {
  const waiting = new Map<number, () => void>();
  const delays: number[] = [];
  let id = 0;
  return {
    delays,
    timers: {
      set: (callback, ms): number => {
        delays.push(ms);
        id += 1;
        waiting.set(id, callback);
        return id;
      },
      clear: (handle): void => {
        waiting.delete(handle as number);
      },
    },
    tick: async (): Promise<void> => {
      for (const [handle, callback] of [...waiting]) {
        waiting.delete(handle);
        callback();
      }
      await Bun.sleep(0);
    },
    pending: (): number => waiting.size,
  };
};

const settle = async (): Promise<void> => {
  await Bun.sleep(0);
};

describe('a node that reads workspace grants says so', () => {
  test('asks again soon when it could not say so, and settles to the renewal once it has', async () => {
    const link = aFakeLink();
    let connected = false;
    link.behaviour.script = (): number => {
      if (!connected) throw new Error('redis is not connected');
      return 1;
    };
    const clock = manualTimers();
    advertiseEntitlements({
      link,
      nodeId: 'node-a',
      log: aRecordingLogger().log,
      timers: clock.timers,
    });
    await settle();
    // As the module set: a process says it as it starts, before its Redis connection is up, and a node absent from the
    // record for a third of the lapse is a node a restriction does not wait for.
    expect(clock.delays).toEqual([ANNOUNCE_RETRY_MS]);

    connected = true;
    await clock.tick();
    await clock.tick();
    expect(clock.delays).toEqual([ANNOUNCE_RETRY_MS, NODE_TTL_MS / 3, NODE_TTL_MS / 3]);
  });

  test('under its own id with the time to live of the module set, and again at each renewal, until it stops', async () => {
    const link = aFakeLink();
    link.behaviour.script = (): number => 1;
    link.behaviour.send = (): number => 1;
    const clock = manualTimers();
    const node = advertiseEntitlements({
      link,
      nodeId: 'node-a',
      log: aRecordingLogger().log,
      timers: clock.timers,
    });
    await settle();
    expect(link.scripts[0]?.keys).toEqual([names.entitlementNodes]);
    expect(link.scripts[0]?.args).toEqual(['node-a', String(NODE_TTL_MS)]);
    await clock.tick();
    await clock.tick();
    expect(link.scripts).toHaveLength(3);

    await node.stop();
    expect(clock.pending()).toBe(0);
    expect(link.sent).toEqual([{ command: 'HDEL', args: [names.entitlementNodes, 'node-a'] }]);
    await clock.tick();
    expect(link.scripts).toHaveLength(3);
  });

  test('keeps going when Redis is away, and a node that cannot take its field out leaves it to lapse', async () => {
    const link = aFakeLink();
    const clock = manualTimers();
    // Every command rejects, as a link that has lost its connection does.
    const node = advertiseEntitlements({
      link,
      nodeId: 'node-a',
      log: aRecordingLogger().log,
      timers: clock.timers,
    });
    await settle();
    expect(clock.pending()).toBe(1);
    await clock.tick();
    expect(link.scripts).toHaveLength(2);
    await node.stop();
    expect(link.sent).toHaveLength(1);
  });
});

describe('how many nodes do not read workspace grants', () => {
  test('is what the script answers, asked of the module-set record and the capability record together', async () => {
    const link = aFakeLink();
    link.behaviour.script = (): number => 2;
    expect(await peersBehind(link)).toBe(2);
    expect(link.scripts[0]?.keys).toEqual([names.moduleSet, names.entitlementNodes]);
  });

  test('is a failure and not a zero when the answer is not a number, or Redis cannot answer', async () => {
    const reasonOf = async (link: ReturnType<typeof aFakeLink>): Promise<string> => {
      try {
        await peersBehind(link);
        return 'answered';
      } catch (error) {
        return (error as Error).message;
      }
    };
    const odd = aFakeLink();
    odd.behaviour.script = (): string => 'none';
    expect(await reasonOf(odd)).toContain('answered something else');
    const away = aFakeLink();
    away.behaviour.script = (): never => {
      throw new Error('redis is not connected');
    };
    expect(await reasonOf(away)).toContain('not connected');
  });
});

describe('a node that reads the stopped modules says so in a record of its own (D-296)', () => {
  test('under its own id, in the suspension record and not in the grants one, and takes its field out when it stops', async () => {
    const link = aFakeLink();
    link.behaviour.script = (): number => 1;
    link.behaviour.send = (): number => 1;
    const clock = manualTimers();
    const node = advertiseSuspension({
      link,
      nodeId: 'node-a',
      log: aRecordingLogger().log,
      timers: clock.timers,
    });
    await settle();
    expect(link.scripts[0]?.keys).toEqual([names.suspensionNodes]);
    expect(link.scripts[0]?.args).toEqual(['node-a', String(NODE_TTL_MS)]);
    await node.stop();
    expect(link.sent).toEqual([{ command: 'HDEL', args: [names.suspensionNodes, 'node-a'] }]);
  });

  test('is asked of the module-set record and the suspension record together, and is a failure and not a zero when it is not a number', async () => {
    const link = aFakeLink();
    link.behaviour.script = (): number => 3;
    expect(await suspensionPeersBehind(link)).toBe(3);
    expect(link.scripts[0]?.keys).toEqual([names.moduleSet, names.suspensionNodes]);
    link.behaviour.script = (): string => 'ok';
    let message = 'answered';
    try {
      await suspensionPeersBehind(link);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('something else');
  });
});
