/**
 * The shared bus (D-201): a frame published on one node reaches the sockets of every node once, a node whose
 * Redis is away still serves its own, and a node that missed frames sends its sockets back to replay.
 * Against a real Redis, with real sockets: `shared.redis.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import type { ServerFrame } from '@purlay/types';
import { aRecordingLogger } from '../testing/doubles';
import { aFakeLink, type FakeLink } from '../testing/redis';
import { BUS_CHANNEL, redisBackplane } from './redis-bus';

const frame = (n: number): ServerFrame => ({
  event: 'PINS_UPDATED',
  data: { channelId: `c${String(n)}` },
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
      for (const other of links) if (other.state.subscribed) other.deliver(BUS_CHANNEL, message);
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
    a.bus.subscribe('channel:1', 'sa');
    b.bus.subscribe('channel:1', 'sb');
    b.bus.subscribe('channel:2', 'other');

    await a.bus.publish('channel:1', frame(1));

    expect(a.heard).toEqual([['sa', frame(1)]]);
    expect(b.heard).toEqual([['sb', frame(1)]]);
  });

  test('frames arrive in the order they were published', async () => {
    const { links, log } = cluster(2);
    const a = nodeOn(links[0]!, log);
    const b = nodeOn(links[1]!, log);
    b.bus.subscribe('channel:1', 'sb');
    for (let n = 0; n < 20; n += 1) await a.bus.publish('channel:1', frame(n));
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
    a.subscribe('channel:t', 'sa');
    b.subscribe('channel:t', 'sb');
    await a.publish('channel:t', frame(1));
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
    a.bus.subscribe('channel:1', 'sa');
    await a.bus.publish('channel:1', frame(1));
    expect(a.heard).toEqual([['sa', frame(1)]]);
    expect(
      log.lines.some((line) => String(line['msg']).includes('delivering on this node only')),
    ).toBe(true);
  });

  test('with only the subscription down, the frame goes out for the others and is delivered here directly, once', async () => {
    const { links, published, log } = cluster(2);
    const a = nodeOn(links[0]!, log);
    const b = nodeOn(links[1]!, log);
    a.bus.subscribe('channel:1', 'sa');
    b.bus.subscribe('channel:1', 'sb');
    links[0]!.state.subscribed = false;
    await a.bus.publish('channel:1', frame(1));
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
    a.bus.subscribe('channel:1', 'sa');
    for (const bad of [
      'not json',
      '7',
      'null',
      JSON.stringify({ topic: 1, frame: {} }),
      JSON.stringify({ topic: 'channel:1', frame: 'x' }),
      JSON.stringify({ topic: 'channel:1', frame: { nothing: 1 }, secret: 'SECRET-WORDS' }),
    ]) {
      link.deliver(BUS_CHANNEL, bad);
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
    node.subscribe('channel:t', 'bad');
    node.subscribe('channel:t', 'good');
    await node.publish('channel:t', frame(1));
    expect(heard).toEqual(['good']);
  });

  test('unsubscribing and forgetting work as they do in process', async () => {
    const { links, log } = cluster(1);
    const a = nodeOn(links[0]!, log);
    expect(a.bus.subscribe('channel:t', 's')).toBe(true);
    expect(a.bus.subscribe('channel:t', 's')).toBe(false);
    a.bus.forget('s');
    await a.bus.publish('channel:t', frame(1));
    expect(a.heard).toEqual([]);
    expect(a.bus.size()).toEqual({ topics: 0, sockets: 0 });
  });
});
