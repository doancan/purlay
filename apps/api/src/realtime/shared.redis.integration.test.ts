/**
 * The shared adapters against a real Redis, each "node" a link of its own (D-201): one quota across nodes
 * under concurrency, presence per person across nodes with a dead node's claims lapsing, one typing window,
 * a bus that delivers each frame once per node in one order, and a link that survives its connection being
 * cut. The fakes in the unit tests say what the code asks for; only a Redis says whether it works.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { ServerFrame } from '@purlay/types';
import { channelTopic, type Topic } from '../platform/events';
import { fixedClock } from '../platform/clock';
import { createLogger } from '../platform/logging';
import { KEEPALIVE_MS, bunRedisClient, connectRedis, type RedisLink } from '../platform/redis';
import { aDroppableProxy, aRealLink, redisUrlForTests, refusedWith } from '../testing/redis';
import { inMemoryPresenceRegistry } from './presence';
import { inProcessRateLimiter } from './rate-limiter';
import { redisBackplane } from './redis-bus';
import { redisRateLimiter } from './redis-limiter';
import {
  LAPSE_INDEX,
  ONLINE_PREFIX,
  redisPresenceDirectory,
  redisPresenceRegistry,
} from './redis-presence';

const silent = createLogger({ level: 'silent' });
const links: RedisLink[] = [];
const node = async (url?: string): Promise<RedisLink> => {
  const link = await aRealLink(url);
  links.push(link);
  return link;
};
const unique = (word: string): string => `${word}-${crypto.randomUUID()}`;

afterAll(() => {
  for (const link of links) link.close();
});

const limiterOn = (
  link: RedisLink,
  name: string,
  budget: { perSecond: number; burst: number },
): ReturnType<typeof redisRateLimiter> =>
  redisRateLimiter({
    link,
    name,
    budget,
    local: inProcessRateLimiter(fixedClock(new Date()), budget),
    log: silent,
  });

describe('integration: the rate limiter across nodes', () => {
  test('two nodes grant one quota, not two, however the calls interleave', async () => {
    const name = unique('quota');
    const budget = { perSecond: 0.001, burst: 50 };
    const a = limiterOn(await node(), name, budget);
    const b = limiterOn(await node(), name, budget);
    const answers = await Promise.all(
      Array.from({ length: 200 }, (_, n) => (n % 2 === 0 ? a : b).consume('user-1')),
    );
    expect(answers.filter(Boolean)).toHaveLength(50);
  });

  test('a key is charged to its own bucket: another user, and another named limiter, are untouched', async () => {
    const budget = { perSecond: 0.001, burst: 2 };
    const name = unique('keys');
    const limiter = limiterOn(await node(), name, budget);
    expect([
      await limiter.consume('x'),
      await limiter.consume('x'),
      await limiter.consume('x'),
    ]).toEqual([true, true, false]);
    expect(await limiter.consume('y')).toBe(true);
    expect(await limiterOn(await node(), unique('other'), budget).consume('x')).toBe(true);
  });

  test('refills continuously at the rate, as the in-process bucket does', async () => {
    const limiter = limiterOn(await node(), unique('refill'), { perSecond: 20, burst: 2 });
    expect([
      await limiter.consume('k'),
      await limiter.consume('k'),
      await limiter.consume('k'),
    ]).toEqual([true, true, false]);
    await Bun.sleep(130);
    expect(await limiter.consume('k')).toBe(true);
  });

  test('a cost larger than the burst is never granted, and a cost is spent whole', async () => {
    const limiter = limiterOn(await node(), unique('cost'), { perSecond: 100, burst: 4 });
    expect(await limiter.consume('k', 5)).toBe(false);
    expect(await limiter.consume('k', 3)).toBe(true);
    expect(await limiter.consume('k', 3)).toBe(false);
  });

  test('a bucket expires by itself once it would have refilled, so nothing is swept', async () => {
    const link = await node();
    const name = unique('expiry');
    await limiterOn(link, name, { perSecond: 1000, burst: 2 }).consume('k');
    const ttl = await link.send('PTTL', [`purlay:rl:${name}:k`]);
    expect(typeof ttl === 'number' && ttl > 0 && ttl <= 1_100).toBe(true);
  });

  test('forgetting drops the bucket: the next call starts full', async () => {
    const link = await node();
    const limiter = limiterOn(link, unique('forget'), { perSecond: 0.001, burst: 1 });
    expect(await limiter.consume('k')).toBe(true);
    expect(await limiter.consume('k')).toBe(false);
    limiter.forget('k');
    await Bun.sleep(50);
    expect(await limiter.consume('k')).toBe(true);
  });
});

describe('integration: who is online across nodes', () => {
  test('a person is online while any node holds them, and a version is given only where that changed', async () => {
    const a = redisPresenceDirectory(await node(), 'node-a');
    const b = redisPresenceDirectory(await node(), 'node-b');
    const user = unique('user');

    const first = await a.join(user);
    expect(first).not.toBeNull();
    expect(await b.join(user)).toBeNull();
    expect(await a.join(user)).toBeNull();
    expect(await b.among([user, unique('nobody')])).toEqual([
      { userId: user, online: true, version: first ?? 0 },
    ]);

    expect(await a.leave(user)).toBeNull();
    expect(await b.among([user])).toHaveLength(1);
    const left = await b.leave(user);
    expect(left).not.toBeNull();
    expect(left ?? 0).toBeGreaterThan(first ?? 0);
    expect(await a.among([user])).toEqual([]);

    const back = await a.join(user);
    expect(back ?? 0).toBeGreaterThan(left ?? 0);
  });

  test('a node that dies leaves nobody online past its claim: the lapsed claim is not counted, and is cleared', async () => {
    const link = await node();
    const live = redisPresenceDirectory(link, 'node-live');
    const user = unique('user');
    // What a node that died left behind: a claim whose time has passed.
    await link.send('HSET', [
      `${ONLINE_PREFIX}${user}`,
      'n:node-dead',
      String(Date.now() - 1_000),
      'v',
      '5',
    ]);
    expect(await live.among([user])).toEqual([]);
    // Nobody live held them, so the node that comes now is the one that makes them online.
    expect(await live.join(user)).not.toBeNull();
    expect(await link.send('HEXISTS', [`${ONLINE_PREFIX}${user}`, 'n:node-dead'])).toBe(0);
  });

  test('a person a dead node held and a live node holds is not told offline when the live node leaves late', async () => {
    const link = await node();
    const live = redisPresenceDirectory(link, 'node-live');
    const user = unique('user');
    await link.send('HSET', [`${ONLINE_PREFIX}${user}`, 'n:node-dead', String(Date.now() - 1_000)]);
    await live.join(user);
    expect(await live.leave(user)).not.toBeNull();
  });

  test('versions come from one clock and a snapshot is smaller than every change after it', async () => {
    const a = redisPresenceDirectory(await node(), 'node-a');
    const b = redisPresenceDirectory(await node(), 'node-b');
    const user = unique('user');
    const snapshot = await a.version();
    const change = await b.join(user);
    expect(change ?? 0).toBeGreaterThan(snapshot);
    // Two people leaving and joining in one millisecond are still ordered.
    const versions: number[] = [];
    for (let n = 0; n < 20; n += 1) {
      versions.push((await b.leave(user)) ?? 0, (await b.join(user)) ?? 0);
    }
    expect(versions).toEqual([...versions].sort((x, y) => x - y));
    expect(new Set(versions).size).toBe(versions.length);
  });

  test('a claim is kept while it is renewed', async () => {
    const link = await node();
    const a = redisPresenceDirectory(link, 'node-a');
    const user = unique('user');
    await a.join(user);
    expect(await a.join(user)).toBeNull();
    const ttl = await link.send('PTTL', [`${ONLINE_PREFIX}${user}`]);
    expect(typeof ttl === 'number' && ttl > 25_000).toBe(true);
  });
});

describe('integration: people nobody told of (D-201)', () => {
  /** Sweeps until it has heard of these people: the index is shared with every other test's. */
  const sweptOf = async (
    directory: ReturnType<typeof redisPresenceDirectory>,
    users: readonly string[],
  ): Promise<{ userId: string; online: boolean; version: number }[]> => {
    const found: { userId: string; online: boolean; version: number }[] = [];
    for (let round = 0; round < 20; round += 1) {
      found.push(...(await directory.sweep()).filter((change) => users.includes(change.userId)));
    }
    return found;
  };

  test('a node that died is found by the next sweep of any node, once, at a version after the join', async () => {
    const link = await node();
    const dead = redisPresenceDirectory(link, 'node-dead');
    const live = redisPresenceDirectory(await node(), 'node-live');
    const user = unique('user');
    const joined = (await dead.join(user)) ?? 0;
    // Not due yet: the claim is alive.
    expect(await sweptOf(live, [user])).toEqual([]);
    await link.send('HSET', [`${ONLINE_PREFIX}${user}`, 'n:node-dead', String(Date.now() - 1_000)]);
    await link.send('ZADD', [LAPSE_INDEX, String(Date.now() - 1_000), user]);
    const gone = await sweptOf(live, [user]);
    expect(gone).toHaveLength(1);
    expect(gone[0]?.online).toBe(false);
    expect(gone[0]?.version ?? 0).toBeGreaterThan(joined);
    expect(await sweptOf(live, [user])).toEqual([]);
    expect(await live.among([user])).toEqual([]);
  });

  test('a person who is renewed is never swept, and a person who left properly is not told twice', async () => {
    const link = await node();
    const a = redisPresenceDirectory(link, 'node-a');
    const sweeper = redisPresenceDirectory(await node(), 'node-sweeper');
    const user = unique('user');
    const left = unique('user');
    await a.join(user);
    await a.join(left);
    expect(await a.leave(left)).not.toBeNull();
    await link.send('ZADD', [LAPSE_INDEX, String(Date.now() - 1_000), user]);
    // The index says lapsed, but the claim is live: the sweep only moves the entry on.
    expect(await sweptOf(sweeper, [user, left])).toEqual([]);
    expect(await sweeper.among([user])).toHaveLength(1);
  });

  test('a node that stops gives its claims up: told gone unless the person is held elsewhere', async () => {
    const a = redisPresenceDirectory(await node(), 'node-a');
    const b = redisPresenceDirectory(await node(), 'node-b');
    const sweeper = redisPresenceDirectory(await node(), 'node-sweeper');
    const alone = unique('user');
    const shared = unique('user');
    await a.join(alone);
    await a.join(shared);
    await b.join(shared);
    await a.release([alone, shared]);
    const gone = await sweptOf(sweeper, [alone, shared]);
    expect(gone.map((change) => change.userId)).toEqual([alone]);
    expect(await sweeper.among([alone, shared])).toMatchObject([{ userId: shared }]);
  });
});

describe('integration: a connection that is alive stays alive', () => {
  test('a link idle past its keepalive, subscribed, is still connected and still hears', async () => {
    const topic = channelTopic(unique('idle'));
    const idle = await busNode(topic);
    const other = await busNode(topic);
    await Bun.sleep(KEEPALIVE_MS * 2 + 1_500);
    expect(idle.link.connected()).toBe(true);
    expect(idle.gaps()).toBe(0);
    await other.publish(frame(1));
    await until(() => idle.heard.length === 1, 'a frame after the keepalives');
  }, 20_000);
});

describe('integration: one typing window across nodes', () => {
  test('the room is told once per half window however many nodes the person types through', async () => {
    const a = redisPresenceRegistry(
      await node(),
      silent,
      inMemoryPresenceRegistry(fixedClock(new Date())),
    );
    const b = redisPresenceRegistry(
      await node(),
      silent,
      inMemoryPresenceRegistry(fixedClock(new Date())),
    );
    const channel = unique('channel');
    const user = unique('user');
    expect(await a.startTyping(channel, user, 400)).toBe(true);
    expect(await b.startTyping(channel, user, 400)).toBe(false);
    expect(await a.startTyping(channel, user, 400)).toBe(false);
    // Another person, another channel: their own windows.
    expect(await b.startTyping(channel, unique('user'), 400)).toBe(true);
    expect(await b.startTyping(unique('channel'), user, 400)).toBe(true);
    await Bun.sleep(220);
    // Half spent: the listeners' window is renewed.
    expect(await b.startTyping(channel, user, 400)).toBe(true);
  });

  test('a message arriving ends the window on every node', async () => {
    const a = redisPresenceRegistry(
      await node(),
      silent,
      inMemoryPresenceRegistry(fixedClock(new Date())),
    );
    const b = redisPresenceRegistry(
      await node(),
      silent,
      inMemoryPresenceRegistry(fixedClock(new Date())),
    );
    const channel = unique('channel');
    const user = unique('user');
    expect(await a.startTyping(channel, user, 5_000)).toBe(true);
    b.stopTyping(channel, user);
    await Bun.sleep(50);
    expect(await a.startTyping(channel, user, 5_000)).toBe(true);
  });
});

/** A node: a backplane over its own link, one socket id listening to the topic, recording what it heard. */
const busNode = async (
  topic: Topic,
  url?: string,
): Promise<{
  readonly heard: ServerFrame[];
  readonly publish: (frame: ServerFrame) => Promise<void>;
  readonly size: () => { topics: number; sockets: number };
  readonly gaps: () => number;
  readonly link: RedisLink;
}> => {
  const link = await node(url);
  const heard: ServerFrame[] = [];
  let gaps = 0;
  const bus = redisBackplane(link, silent).node(
    (_socketId, frame) => heard.push(frame),
    silent,
    () => {
      gaps += 1;
    },
  );
  bus.subscribe(topic, 'socket');
  return {
    heard,
    publish: async (frame): Promise<void> => {
      await bus.publish(topic, frame);
    },
    size: bus.size,
    gaps: () => gaps,
    link,
  };
};

const frame = (ts: number): ServerFrame => ({
  event: 'PINS_UPDATED',
  data: { channelId: 'c' },
  ts,
});

const until = async (done: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

describe('integration: the bus across nodes', () => {
  test('each frame reaches every node exactly once, each publisher’s in its order, all nodes in one order', async () => {
    const topic = channelTopic(unique('c'));
    const [a, b, c] = [await busNode(topic), await busNode(topic), await busNode(topic)];
    // A and B publish at once, a hundred each, a frame's `ts` saying who sent it and which.
    const send = async (from: typeof a, who: number): Promise<void> => {
      for (let n = 0; n < 100; n += 1) await from.publish(frame(who * 1_000 + n));
    };
    await Promise.all([send(a, 1), send(b, 2)]);
    await until(() => [a, b, c].every((n) => n.heard.length >= 200), 'every node to hear 200');
    await Bun.sleep(100);

    for (const n of [a, b, c]) expect(n.heard).toHaveLength(200);
    const order = (n: typeof a): number[] => n.heard.map((f) => f.ts);
    expect(order(b)).toEqual(order(a));
    expect(order(c)).toEqual(order(a));
    for (const who of [1, 2]) {
      expect(order(a).filter((ts) => Math.floor(ts / 1_000) === who)).toEqual(
        Array.from({ length: 100 }, (_, n) => who * 1_000 + n),
      );
    }
  });

  test('a node that listens to another topic hears nothing of this one', async () => {
    const topic = channelTopic(unique('c'));
    const a = await busNode(topic);
    const bystander = await busNode(channelTopic(unique('other')));
    await a.publish(frame(1));
    await until(() => a.heard.length === 1, 'the publisher to hear itself');
    await Bun.sleep(100);
    expect(bystander.heard).toEqual([]);
  });
});

describe('integration: a Redis that is away, or comes and goes', () => {
  test('a link to nothing answers no command, never throws outside its promise, and closes cleanly', async () => {
    const link = connectRedis({ create: () => bunRedisClient('redis://127.0.0.1:1'), log: silent });
    await Bun.sleep(100);
    expect(link.connected()).toBe(false);
    expect(link.problem()).toBeDefined();
    expect(await refusedWith(link.send('PING', []))).toContain('not connected');
    // The limiter on it answers from a bucket of its own rather than failing.
    const limiter = limiterOn(link, 'away', { perSecond: 0.001, burst: 1 });
    expect([await limiter.consume('k'), await limiter.consume('k')]).toEqual([true, false]);
    link.close();
  });

  test('a bus on it still serves its own sockets', async () => {
    const link = connectRedis({ create: () => bunRedisClient('redis://127.0.0.1:1'), log: silent });
    const heard: ServerFrame[] = [];
    const bus = redisBackplane(link, silent).node((_id, f) => heard.push(f), silent);
    bus.subscribe('channel:t', 's');
    await bus.publish('channel:t', frame(1));
    expect(heard).toEqual([frame(1)]);
    link.close();
  });

  test('a connection that is cut is made again, subscribed again, and the node is told it may have missed frames', async () => {
    const proxy = await aDroppableProxy(redisUrlForTests());
    try {
      const topic = channelTopic(unique('c'));
      const behind = await busNode(topic, proxy.url);
      const direct = await busNode(topic);
      await direct.publish(frame(1));
      await until(() => behind.heard.length === 1, 'the first frame');
      expect(behind.gaps()).toBe(0);

      proxy.drop();
      await until(() => !behind.link.subscribed(), 'the loss to be noticed');
      // While it is away a publish is delivered on this node alone: the people here still hear each other.
      await behind.publish(frame(2));
      expect(behind.heard.map((f) => f.ts)).toEqual([1, 2]);
      await until(() => behind.link.connected(), 'the connections to come back');
      await until(() => behind.gaps() === 1, 'the gap to be reported');

      // Subscribed again: what another node publishes now arrives.
      await direct.publish(frame(3));
      await until(() => behind.heard.some((f) => f.ts === 3), 'a frame after the reconnection');
      expect(behind.heard.filter((f) => f.ts === 3)).toHaveLength(1);
      // And the commands work again.
      expect(await behind.link.send('PING', [])).toBe('PONG');
    } finally {
      proxy.stop();
    }
  });

  test('closing a link that is mid-reconnect leaves nothing running', async () => {
    const proxy = await aDroppableProxy(redisUrlForTests());
    const link = await aRealLink(proxy.url);
    proxy.stop();
    await until(() => !link.connected(), 'the loss to be noticed');
    link.close();
    await Bun.sleep(600);
    expect(link.connected()).toBe(false);
  });
});
