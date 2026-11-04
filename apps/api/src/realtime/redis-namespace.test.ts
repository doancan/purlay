/**
 * Every adapter of the shared Redis asks for the names of its link's namespace (`REDIS_KEY_PREFIX`, D-201),
 * and none asks for another: the bus, the limiter, typing, presence and the record of modules. What two
 * namespaces on one real Redis do not see of each other is `redis-namespace.redis.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import type { ServerFrame } from '@purlay/types';
import { fixedClock } from '../platform/clock';
import { channelTopic } from '../platform/events';
import { aRecordingLogger } from '../testing/doubles';
import { aFakeLink } from '../testing/redis';
import type { Timers } from './hub';
import { watchModuleSet } from './module-set';
import { inMemoryPresenceRegistry } from './presence';
import { inProcessRateLimiter } from './rate-limiter';
import { redisBackplane } from './redis-bus';
import { redisRateLimiter } from './redis-limiter';
import { redisPresenceDirectory, redisPresenceRegistry } from './redis-presence';

const frame: ServerFrame = { event: 'PINS_UPDATED', data: { channelId: 'c' }, ts: 1 };
const inertTimers: Timers = { set: () => 0, clear: () => undefined };

/** Every key an adapter sent to Redis, in the scripts and in the commands. */
const named = (link: ReturnType<typeof aFakeLink>): string[] => [
  ...link.scripts.flatMap((script) => [...script.keys, ...script.args]),
  ...link.sent.flatMap((sent) => sent.args),
];

describe('the adapters of a namespaced link', () => {
  test('the bus publishes on the namespace’s channel and hears nothing from the default one', async () => {
    const link = aFakeLink('staging');
    link.behaviour.send = (): number => 1;
    const heard: ServerFrame[] = [];
    const topic = channelTopic('c');
    const log = aRecordingLogger().log;
    const bus = redisBackplane(link, log).node((_socket, delivered) => heard.push(delivered), log);
    bus.subscribe(topic, 'socket');

    // The echo of its own publish comes back on `staging:bus`; a frame on `purlay:bus` is another's.
    await bus.publish(topic, frame);
    expect(link.sent.map((sent) => [sent.command, sent.args[0]])).toEqual([
      ['PUBLISH', 'staging:bus'],
    ]);
    const message = link.sent[0]?.args[1] ?? '';
    link.deliver('purlay:bus', message);
    expect(heard).toHaveLength(0);
    link.deliver('staging:bus', message);
    expect(heard).toHaveLength(1);
  });

  test('a limiter bucket is a key of the namespace', async () => {
    const link = aFakeLink('staging');
    link.behaviour.script = (): number => 1;
    link.behaviour.send = (): number => 1;
    const budget = { perSecond: 1, burst: 2 };
    const limiter = redisRateLimiter({
      link,
      name: 'writes',
      budget,
      local: inProcessRateLimiter(fixedClock(new Date('2026-09-09T12:00:00Z')), budget),
      log: aRecordingLogger().log,
    });
    await limiter.consume('user-1');
    limiter.forget('user-1');
    await Bun.sleep(0);
    expect(named(link)).toEqual([
      'staging:rl:writes:user-1',
      '1',
      '2',
      '1',
      'staging:rl:writes:user-1',
    ]);
  });

  test('typing, online records and both indexes are keys of the namespace', async () => {
    const link = aFakeLink('staging');
    link.behaviour.script = (): unknown => 1;
    link.behaviour.send = (): number => 1;
    const own = inMemoryPresenceRegistry(fixedClock(new Date('2026-09-09T12:00:00Z')));
    const typing = redisPresenceRegistry(link, aRecordingLogger().log, own);
    const directory = redisPresenceDirectory(link, 'node-a');
    await typing.startTyping('c1', 'u1', 5_000);
    typing.stopTyping('c1', 'u1');
    await directory.join('u1', 300_000);
    await directory.active('u1', 300_000);
    await directory.leave('u1');
    await directory.release(['u1']);
    await directory.retell('u1').catch(() => undefined);
    await directory.among(['u1', 'u2']).catch(() => undefined);
    await directory.sweep().catch(() => undefined);
    await Bun.sleep(0);

    const keys = [
      ...link.scripts.flatMap((script) => script.keys),
      ...link.sent.flatMap((sent) => sent.args),
    ];
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) expect(key).toStartWith('staging:');
    expect(link.scripts.at(-1)?.args[0]).toBe('staging:online:');
    expect(named(link).filter((word) => word.includes('purlay'))).toEqual([]);
  });

  test('the record of modules is the namespace’s hash', async () => {
    const link = aFakeLink('staging');
    link.behaviour.script = (): unknown => ['chat'];
    link.behaviour.send = (): number => 1;
    const watch = watchModuleSet({
      link,
      nodeId: 'node-a',
      set: 'chat',
      log: aRecordingLogger().log,
      timers: inertTimers,
    });
    await Bun.sleep(0);
    await watch.stop();
    expect(link.scripts[0]?.keys).toEqual(['staging:modules']);
    expect(link.sent).toEqual([{ command: 'HDEL', args: ['staging:modules', 'node-a'] }]);
  });

  test('a link with no namespace uses the one every deployment has always had', () => {
    expect(aFakeLink().names.bus).toBe('purlay:bus');
    expect(aFakeLink('purlay').names).toEqual(aFakeLink().names);
  });
});
