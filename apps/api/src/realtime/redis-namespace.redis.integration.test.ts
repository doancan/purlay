/**
 * Two deployments on one real Redis, each with a `REDIS_KEY_PREFIX` of its own, never see each other (D-201):
 * not the other's bus frames, nor its people online, nor its typing windows, nor its rate-limit buckets. And a
 * link with no namespace still writes the `purlay:` names every deployment has always had. The fakes of
 * `redis-namespace.test.ts` say which names an adapter asks for; only a Redis says that the two are apart.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { AWAY_AFTER_MS, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../platform/clock';
import { channelTopic } from '../platform/events';
import { createLogger } from '../platform/logging';
import type { RedisLink } from '../platform/redis';
import { aRealLink } from '../testing/redis';
import { inMemoryPresenceRegistry } from './presence';
import { inProcessRateLimiter } from './rate-limiter';
import { redisBackplane } from './redis-bus';
import { redisRateLimiter } from './redis-limiter';
import { redisPresenceDirectory, redisPresenceRegistry } from './redis-presence';

const silent = createLogger({ level: 'silent' });
const unique = (word: string): string => `${word}-${crypto.randomUUID()}`;
/** A topic's id is a UUID, as the contract's are: the bus refuses one that is not. */
const aUuid = (): string => crypto.randomUUID();
/** Two namespaces no other run uses, so a run beside this one on the same Redis is no third party. */
const SUFFIX = crypto.randomUUID().slice(0, 8);
const NORTH = `north-${SUFFIX}`;
const SOUTH = `south-${SUFFIX}`;

const links: RedisLink[] = [];
const on = async (namespace?: string): Promise<RedisLink> => {
  const link = await aRealLink(undefined, undefined, namespace);
  links.push(link);
  return link;
};

afterAll(async () => {
  // What this file wrote, by its namespaces and by the default's keys it made itself.
  const cleaner = await aRealLink();
  for (const namespace of [NORTH, SOUTH]) {
    const keys = await cleaner.send('KEYS', [`${namespace}:*`]);
    if (Array.isArray(keys) && keys.length > 0) await cleaner.send('DEL', keys.map(String));
  }
  cleaner.close();
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

const frame = (ts: number): ServerFrame => ({
  event: 'PINS_UPDATED',
  data: { channelId: '00000000-0000-4000-8000-000000000001' },
  ts,
});

const until = async (done: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

/** A node on the bus of `link`'s namespace, listening to one topic. `real` is what is heard that is not a probe. */
const busNode = async (
  namespace: string,
  topic: ReturnType<typeof channelTopic>,
): Promise<{
  readonly real: () => number[];
  readonly publish: (ts: number) => Promise<void>;
  readonly listening: () => Promise<void>;
}> => {
  const link = await on(namespace);
  const heard: number[] = [];
  const bus = redisBackplane(link, silent).node(
    (_socketId, delivered) => heard.push(delivered.ts),
    silent,
  );
  bus.subscribe(topic, 'socket');
  return {
    real: () => heard.filter((ts) => ts > 0),
    publish: async (ts): Promise<void> => {
      await bus.publish(topic, frame(ts));
    },
    // A node's subscription is made after its link is up and is not confirmed, so it is known by its own
    // echo: a probe (negative `ts`) is said until this node hears one.
    listening: async (): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (!heard.some((ts) => ts < 0)) {
        if (Date.now() > deadline) throw new Error('a node never heard its own probe');
        await bus.publish(topic, frame(-1));
        await Bun.sleep(25);
      }
    },
  };
};

describe('integration: two namespaces on one Redis', () => {
  test('a frame published in one is heard by every node of that namespace and by none of the other', async () => {
    const topic = channelTopic(aUuid());
    const [north1, north2, south] = [
      await busNode(NORTH, topic),
      await busNode(NORTH, topic),
      await busNode(SOUTH, topic),
    ];
    await Promise.all([north1.listening(), north2.listening(), south.listening()]);

    await north1.publish(1);
    await until(() => north1.real().length === 1 && north2.real().length === 1, 'the north nodes');
    await Bun.sleep(150);
    expect(south.real()).toEqual([]);

    await south.publish(2);
    await until(() => south.real().length === 1, 'the south node to hear itself');
    await Bun.sleep(150);
    expect(north1.real()).toEqual([1]);
    expect(north2.real()).toEqual([1]);
    expect(south.real()).toEqual([2]);
  }, 30_000);

  test('a person online in one is not online in the other, and joining the second is a first join', async () => {
    const user = unique('user');
    const north = redisPresenceDirectory(await on(NORTH), 'node-north');
    const south = redisPresenceDirectory(await on(SOUTH), 'node-south');

    const joined = await north.join(user, AWAY_AFTER_MS);
    expect(joined).not.toBeNull();
    expect(await south.among([user])).toEqual([]);
    // A shared record would answer `null`: somebody else already holds them.
    expect(await south.join(user, AWAY_AFTER_MS)).not.toBeNull();
    expect(await north.among([user])).toEqual([
      { userId: user, online: true, away: false, version: joined ?? 0 },
    ]);

    // The indexes are separate too: the south's person lapses without the north's being swept.
    await south.leave(user);
    expect(await south.among([user])).toEqual([]);
    expect(await north.among([user])).toHaveLength(1);
    await north.leave(user);
  });

  test('a typing window in one does not hold back the same person in the other', async () => {
    const channel = unique('c');
    const user = unique('user');
    const own = inMemoryPresenceRegistry(fixedClock(new Date()));
    const north = redisPresenceRegistry(await on(NORTH), silent, own);
    const south = redisPresenceRegistry(await on(SOUTH), silent, own);

    expect(await north.startTyping(channel, user, 5_000)).toBe(true);
    expect(await north.startTyping(channel, user, 5_000)).toBe(false);
    expect(await south.startTyping(channel, user, 5_000)).toBe(true);
    north.stopTyping(channel, user);
    south.stopTyping(channel, user);
  });

  test('a bucket spent in one is full in the other', async () => {
    const name = unique('quota');
    const budget = { perSecond: 0.001, burst: 1 };
    const north = limiterOn(await on(NORTH), name, budget);
    const south = limiterOn(await on(SOUTH), name, budget);

    expect(await north.consume('k')).toBe(true);
    expect(await north.consume('k')).toBe(false);
    expect(await south.consume('k')).toBe(true);
    expect(await south.consume('k')).toBe(false);
  });

  test('every key either wrote starts with its own namespace, and none with the default’s', async () => {
    const user = unique('user');
    const link = await on(NORTH);
    const directory = redisPresenceDirectory(link, 'node-north');
    await directory.join(user, AWAY_AFTER_MS);
    await limiterOn(link, unique('quota'), { perSecond: 1, burst: 5 }).consume('k');
    const keys = await link.send('KEYS', [`*${user}*`]);
    expect(keys).toEqual([`${NORTH}:online:${user}`]);
    const buckets = await link.send('KEYS', [`${NORTH}:rl:*`]);
    expect(Array.isArray(buckets) ? buckets.length : 0).toBeGreaterThan(0);
    expect(await link.send('EXISTS', [`purlay:online:${user}`])).toBe(0);
    await directory.leave(user);
  });

  test('a link with no namespace still writes the names it always has', async () => {
    const name = unique('compat');
    const link = await on();
    expect(link.names.bus).toBe('purlay:bus');
    expect(await limiterOn(link, name, { perSecond: 0.001, burst: 1 }).consume('k')).toBe(true);
    expect(await link.send('EXISTS', [`purlay:rl:${name}:k`])).toBe(1);
    await link.send('DEL', [`purlay:rl:${name}:k`]);
  });
});
