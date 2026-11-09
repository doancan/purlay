/**
 * The shared bus (D-201): a frame published on one node reaches the sockets of every node once, a node whose
 * Redis is away still serves its own, and a node that missed frames sends its sockets back to replay.
 * Against a real Redis, with real sockets: `shared.redis.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import type { ServerFrame } from '@purlay/types';
import { redisNames } from '../platform/redis-names';
import { aRecordingLogger } from '../testing/doubles';
import { aFakeLink, type FakeLink } from '../testing/redis';
import type { Timers } from './hub';
import { GAP_REPLAY_MIN_MS, redisBackplane } from './redis-bus';

const names = redisNames();

/** A topic's id is a UUID, as the contract's are: the bus refuses a topic that is not shaped like one. */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CH1 = `channel:${uuid(1)}` as const;
const CH2 = `channel:${uuid(2)}` as const;
const CHT = `channel:${uuid(3)}` as const;
const ORIGIN_X = uuid(900);

const frame = (n: number): ServerFrame => ({
  event: 'PINS_UPDATED',
  data: { channelId: uuid(n + 100) },
  ts: n,
});

/** Links to one Redis: a `PUBLISH` on any is heard on the subscription of every link that is subscribed. */
const cluster = (
  size: number,
): { links: FakeLink[]; published: string[]; log: ReturnType<typeof aRecordingLogger> } => {
  const links = Array.from({ length: size }, () => aFakeLink());
  const published: string[] = [];
  for (const link of links) {
    link.behaviour.send = (command, args): unknown => {
      if (command !== 'PUBLISH') return null;
      const message = args[1] ?? '';
      published.push(message);
      for (const other of links) if (other.state.subscribed) other.deliver(names.bus, message);
      return links.length;
    };
  }
  return { links, published, log: aRecordingLogger() };
};

const nodeOn = (
  link: FakeLink,
  log: ReturnType<typeof aRecordingLogger>,
  onGap?: () => void,
): {
  heard: [string, ServerFrame][];
  bus: ReturnType<ReturnType<typeof redisBackplane>['node']>;
} => {
  const heard: [string, ServerFrame][] = [];
  const bus = redisBackplane(link, log.log).node(
    (socketId, delivered) => heard.push([socketId, delivered]),
    log.log,
    onGap,
  );
  return { heard, bus };
};

describe('the shared bus', () => {
  test('a frame published on node A is delivered to a subscriber on node B exactly once, and to one on A once too', async () => {
    const { links, log } = cluster(2);
    const a = nodeOn(links[0]!, log);
    const b = nodeOn(links[1]!, log);
    a.bus.subscribe(CH1, 'sa');
    b.bus.subscribe(CH1, 'sb');
    b.bus.subscribe(CH2, 'other');

    await a.bus.publish(CH1, frame(1));

    expect(a.heard).toEqual([['sa', frame(1)]]);
    expect(b.heard).toEqual([['sb', frame(1)]]);
  });

  test('frames arrive in the order they were published', async () => {
    const { links, log } = cluster(2);
    const a = nodeOn(links[0]!, log);
    const b = nodeOn(links[1]!, log);
    b.bus.subscribe(CH1, 'sb');
    for (let n = 0; n < 20; n += 1) await a.bus.publish(CH1, frame(n));
    expect(b.heard.map(([, f]) => f.ts)).toEqual(Array.from({ length: 20 }, (_, n) => n));
  });

  test('two nodes in one process on one link hear a frame once each, not twice', async () => {
    const { links, log } = cluster(1);
    const link = links[0]!;
    const backplane = redisBackplane(link, log.log);
    const heardA: string[] = [];
    const heardB: string[] = [];
    const a = backplane.node((id) => heardA.push(id), log.log);
    const b = backplane.node((id) => heardB.push(id), log.log);
    a.subscribe(CHT, 'sa');
    b.subscribe(CHT, 'sb');
    await a.publish(CHT, frame(1));
    expect(heardA).toEqual(['sa']);
    expect(heardB).toEqual(['sb']);
  });

  test('with the shared bus refusing, a node delivers to its own sockets and says so', async () => {
    const { links, log } = cluster(2);
    const link = links[0]!;
    link.behaviour.send = (): unknown => {
      throw new Error('redis is not connected');
    };
    link.state.connected = false;
    const a = nodeOn(link, log);
    a.bus.subscribe(CH1, 'sa');
    await a.bus.publish(CH1, frame(1));
    expect(a.heard).toEqual([['sa', frame(1)]]);
    expect(
      log.lines.some((line) => String(line['msg']).includes('delivering on this node only')),
    ).toBe(true);
  });

  test('with only the subscription down, the frame goes out for the others and is delivered here directly, once', async () => {
    const { links, published, log } = cluster(2);
    const a = nodeOn(links[0]!, log);
    const b = nodeOn(links[1]!, log);
    a.bus.subscribe(CH1, 'sa');
    b.bus.subscribe(CH1, 'sb');
    links[0]!.state.subscribed = false;
    await a.bus.publish(CH1, frame(1));
    expect(published).toHaveLength(1);
    expect(a.heard).toEqual([['sa', frame(1)]]);
    expect(b.heard).toEqual([['sb', frame(1)]]);
  });

  test('when the subscription comes back every node is told frames may have been missed', () => {
    const { links, log } = cluster(1);
    const link = links[0]!;
    let gaps = 0;
    nodeOn(link, log, () => {
      gaps += 1;
    });
    let others = 0;
    redisBackplane(link, log.log).node(
      () => undefined,
      log.log,
      () => {
        others += 1;
      },
    );
    link.resubscribe();
    expect(gaps).toBe(1);
    // A second backplane over the same link is its own, with its own nodes: it was told for its own.
    expect(others).toBe(1);
  });

  test('a node that asks for no gap callback is not broken by one', () => {
    const { links, log } = cluster(1);
    const link = links[0]!;
    nodeOn(link, log);
    expect(() => {
      link.resubscribe();
    }).not.toThrow();
  });

  test('what is not a frame is dropped, said, and never written to the log', () => {
    const { links, log } = cluster(1);
    const link = links[0]!;
    const a = nodeOn(link, log);
    a.bus.subscribe(CH1, 'sa');
    for (const bad of [
      'not json',
      '7',
      'null',
      JSON.stringify({ topic: 1, frame: {} }),
      JSON.stringify({ topic: CH1, frame: 'x' }),
      JSON.stringify({ topic: CH1, frame: { nothing: 1 }, secret: 'SECRET-WORDS' }),
    ]) {
      link.deliver(names.bus, bad);
    }
    expect(a.heard).toEqual([]);
    expect(
      log.lines.filter((line) => String(line['msg']).includes('could not be read')),
    ).toHaveLength(6);
    expect(JSON.stringify(log.lines)).not.toContain('SECRET-WORDS');
  });

  test('one socket whose delivery throws does not stop the rest, or the publisher', async () => {
    const { links, log } = cluster(1);
    const link = links[0]!;
    const heard: string[] = [];
    const node = redisBackplane(link, log.log).node((id) => {
      if (id === 'bad') throw new Error('socket closed');
      heard.push(id);
    }, log.log);
    node.subscribe(CHT, 'bad');
    node.subscribe(CHT, 'good');
    await node.publish(CHT, frame(1));
    expect(heard).toEqual(['good']);
  });

  test('unsubscribing and forgetting work as they do in process', async () => {
    const { links, log } = cluster(1);
    const a = nodeOn(links[0]!, log);
    expect(a.bus.subscribe(CHT, 's')).toBe(true);
    expect(a.bus.subscribe(CHT, 's')).toBe(false);
    a.bus.forget('s');
    await a.bus.publish(CHT, frame(1));
    expect(a.heard).toEqual([]);
    expect(a.bus.size()).toEqual({ topics: 0, sockets: 0 });
  });

  test('a frame its publisher could not get to Redis is found by the others, whose subscriptions never dropped', async () => {
    const { links, log } = cluster(2);
    const publisher = links[0]!;
    let gapsA = 0;
    let gapsB = 0;
    const a = nodeOn(publisher, log, () => {
      gapsA += 1;
    });
    nodeOn(links[1]!, log, () => {
      gapsB += 1;
    });
    const works = publisher.behaviour.send;
    await a.bus.publish(CHT, frame(1));
    publisher.behaviour.send = (): unknown => {
      throw new Error('redis is not connected');
    };
    await a.bus.publish(CHT, frame(2));
    publisher.behaviour.send = works;
    expect([gapsA, gapsB]).toEqual([0, 0]);
    await a.bus.publish(CHT, frame(3));
    // The others were told; the publisher, which delivered the lost one itself, was not.
    expect([gapsA, gapsB]).toEqual([0, 1]);
  });

  test('frames counted in order, or from a backplane that restarted, are no hole', () => {
    const { links, log } = cluster(1);
    const link = links[0]!;
    let gaps = 0;
    nodeOn(link, log, () => {
      gaps += 1;
    });
    const hear = (origin: string, seq: number): void => {
      link.deliver(names.bus, JSON.stringify({ topic: CHT, frame: frame(seq), origin, seq }));
    };
    hear(ORIGIN_X, 7);
    hear(ORIGIN_X, 8);
    hear(ORIGIN_X, 9);
    // Restarted: counting again from one.
    hear(ORIGIN_X, 1);
    hear(ORIGIN_X, 2);
    expect(gaps).toBe(0);
    hear(ORIGIN_X, 4);
    expect(gaps).toBe(1);
  });
});

describe('what anyone who can write the Redis may put on the bus (red-team F6)', () => {
  const heardOnA = (
    messages: readonly string[],
  ): { heard: number; dropped: number; secret: boolean } => {
    const { links, log } = cluster(1);
    const link = links[0]!;
    const a = nodeOn(link, log);
    a.bus.subscribe(CH1, 'sa');
    for (const message of messages) link.deliver(names.bus, message);
    return {
      heard: a.heard.length,
      dropped: log.lines.filter((line) => String(line['msg']).includes('could not be read')).length,
      secret: JSON.stringify(log.lines).includes('SECRET'),
    };
  };
  const envelope = (over: Record<string, unknown>): string =>
    JSON.stringify({ topic: CH1, frame: frame(1), origin: ORIGIN_X, seq: 1, ...over });

  test('a frame no node sends, a topic that is not the contract’s, and an origin or count no backplane makes are dropped, said and never fanned out', () => {
    const bad = [
      envelope({ frame: { event: 'SESSION_ENDED', data: { reason: 'SECRET' }, anything: 'goes' } }),
      envelope({ frame: { event: 'UNHEARD_OF', data: {}, ts: 1 } }),
      envelope({ frame: { event: 'PINS_UPDATED', data: { channelId: 'not-an-id' }, ts: 1 } }),
      envelope({ topic: 'user:x' }),
      envelope({ topic: 'room:' + uuid(1) }),
      envelope({ topic: `${CH1}/../..` }),
      envelope({ origin: 'forged' }),
      envelope({ origin: 7 }),
      envelope({ seq: 0 }),
      envelope({ seq: -1 }),
      envelope({ seq: 1.5 }),
      envelope({ seq: 2 ** 60 }),
      envelope({ seq: '1' }),
    ];
    expect(heardOnA(bad)).toEqual({ heard: 0, dropped: bad.length, secret: false });
    expect(heardOnA([envelope({})])).toEqual({ heard: 1, dropped: 0, secret: false });
  });

  test('a forged hole in a count tells every socket to replay once for a while, and again when the wait is over, never once for each frame', () => {
    const { links, log } = cluster(1);
    const link = links[0]!;
    const waiting: (() => void)[] = [];
    const timers: Timers = {
      set: (callback): number => waiting.push(callback),
      clear: (): void => undefined,
    };
    let gaps = 0;
    redisBackplane(link, log.log, timers).node(
      () => undefined,
      log.log,
      () => {
        gaps += 1;
      },
    );
    const hear = (seq: number): void => {
      link.deliver(names.bus, envelope({ seq }));
    };
    hear(1);
    // Fifty claims that frames were lost, each past the last.
    for (let seq = 100; seq < 150; seq += 1) hear(seq * 10);
    expect(gaps).toBe(1);
    expect(waiting).toHaveLength(1);
    // The wait is over: the hole that was claimed in it is told once, not fifty times.
    waiting.shift()?.();
    expect(gaps).toBe(2);
    // And the wait begins again: a hole claimed just now waits, it is neither told at once nor lost.
    hear(99_999);
    expect(gaps).toBe(2);
    expect(waiting).toHaveLength(1);
    expect(GAP_REPLAY_MIN_MS).toBeGreaterThanOrEqual(1_000);
  });
});
