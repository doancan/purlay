/**
 * What the shared presence asks of Redis and does with the answer (D-201). That its scripts decide
 * correctly across nodes is held against a real Redis (`shared.redis.integration.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { fixedClock } from '../platform/clock';
import { aRecordingLogger } from '../testing/doubles';
import { inMemoryPresenceRegistry } from './presence';
import { aFakeLink, refusedWith } from '../testing/redis';
import { PRESENCE_NODE_TTL_MS } from './online';
import {
  LAPSE_INDEX,
  ONLINE_PREFIX,
  TYPING_PREFIX,
  redisPresenceDirectory,
  redisPresenceRegistry,
} from './redis-presence';

const anOwnWindow = (): ReturnType<typeof inMemoryPresenceRegistry> =>
  inMemoryPresenceRegistry(fixedClock(new Date('2026-09-09T12:00:00Z')));

describe('typing, shared', () => {
  test('asks for the person’s window in the channel, with its length, and answers what Redis says', async () => {
    const link = aFakeLink();
    const answers = [1, 0];
    link.behaviour.script = (): unknown => answers.shift();
    const registry = redisPresenceRegistry(link, aRecordingLogger().log, anOwnWindow());
    expect(await registry.startTyping('c1', 'u1', 5_000)).toBe(true);
    expect(await registry.startTyping('c1', 'u1', 5_000)).toBe(false);
    expect(link.scripts[0]?.keys).toEqual([`${TYPING_PREFIX}c1:u1`]);
    expect(link.scripts[0]?.args).toEqual(['5000']);
  });

  test('with Redis away this node’s own window answers: still a frame per half window, never a flood', async () => {
    const link = aFakeLink();
    link.state.connected = false;
    const registry = redisPresenceRegistry(link, aRecordingLogger().log, anOwnWindow());
    expect(await registry.startTyping('c1', 'u1', 5_000)).toBe(true);
    expect(await registry.startTyping('c1', 'u1', 5_000)).toBe(false);
    registry.stopTyping('c1', 'u1');
    expect(await registry.startTyping('c1', 'u1', 5_000)).toBe(true);
  });

  test('an answer it does not understand tells the room too', async () => {
    const link = aFakeLink();
    link.behaviour.script = (): unknown => 'x';
    expect(
      await redisPresenceRegistry(link, aRecordingLogger().log, anOwnWindow()).startTyping(
        'c',
        'u',
        1,
      ),
    ).toBe(true);
  });

  test('stopping ends the window in Redis without waiting, and a failing Redis is no error', async () => {
    const link = aFakeLink();
    const registry = redisPresenceRegistry(link, aRecordingLogger().log, anOwnWindow());
    registry.stopTyping('c1', 'u1');
    await Promise.resolve();
    expect(link.sent).toEqual([{ command: 'DEL', args: [`${TYPING_PREFIX}c1:u1`] }]);
  });
});

describe('who is online, shared', () => {
  test('join and leave send this node’s id and the claim’s lifetime; a version is what changed, 0 is nothing', async () => {
    const link = aFakeLink();
    const answers = [1_700_000_000_001, 0, 1_700_000_000_002];
    link.behaviour.script = (): unknown => answers.shift();
    const directory = redisPresenceDirectory(link, 'node-a');
    expect(await directory.join('u1')).toBe(1_700_000_000_001);
    expect(await directory.join('u1')).toBeNull();
    expect(await directory.leave('u1')).toBe(1_700_000_000_002);
    expect(link.scripts[0]?.keys).toEqual([`${ONLINE_PREFIX}u1`, LAPSE_INDEX]);
    expect(link.scripts[0]?.args).toEqual(['node-a', String(PRESENCE_NODE_TTL_MS), 'u1']);
    expect(link.scripts[2]?.args).toEqual(['node-a', 'u1']);
  });

  test('among reads every key in one call and keeps the people who are online, each at their version', async () => {
    const link = aFakeLink();
    link.behaviour.script = (): unknown => [0, 42, 0, 43];
    const directory = redisPresenceDirectory(link, 'node-a');
    expect(await directory.among(['a', 'b', 'c', 'd'])).toEqual([
      { userId: 'b', online: true, version: 42 },
      { userId: 'd', online: true, version: 43 },
    ]);
    expect(link.scripts).toHaveLength(1);
    expect(await directory.among([])).toEqual([]);
    expect(link.scripts).toHaveLength(1);
  });

  test('an answer of the wrong shape is a failure, not a guess', async () => {
    const link = aFakeLink();
    const directory = redisPresenceDirectory(link, 'n');
    link.behaviour.script = (): unknown => [1];
    expect(await refusedWith(directory.among(['a', 'b']))).toContain('something else');
    link.behaviour.script = (): unknown => 'x';
    expect(await refusedWith(directory.join('a'))).toContain('something else');
    link.behaviour.script = (): unknown => [1, 'x'];
    expect(await refusedWith(directory.among(['a', 'b']))).toContain('something else');
  });

  test('the version is Redis’s clock in milliseconds, and an unreadable clock is a failure', async () => {
    const link = aFakeLink();
    const directory = redisPresenceDirectory(link, 'n');
    link.behaviour.send = (): unknown => ['1700000000', '123456'];
    expect(await directory.version()).toBe(1_700_000_000_123);
    link.behaviour.send = (): unknown => 'x';
    expect(await refusedWith(directory.version())).toContain('clock');
  });

  test('release and sweep name this node, the index and the claims’ prefix; a sweep returns each person once, offline', async () => {
    const link = aFakeLink();
    const directory = redisPresenceDirectory(link, 'node-a');
    link.behaviour.script = (): unknown => 1;
    await directory.release(['u1', 'u2']);
    expect(link.scripts.map((script) => script.keys)).toEqual([
      [`${ONLINE_PREFIX}u1`, LAPSE_INDEX],
      [`${ONLINE_PREFIX}u2`, LAPSE_INDEX],
    ]);
    expect(link.scripts[0]?.args).toEqual(['node-a', 'u1']);
    link.behaviour.script = (): unknown => ['u1', 77, 'u2', 78];
    expect(await directory.sweep()).toEqual([
      { userId: 'u1', online: false, version: 77 },
      { userId: 'u2', online: false, version: 78 },
    ]);
    expect(link.scripts.at(-1)?.keys).toEqual([LAPSE_INDEX]);
    expect(link.scripts.at(-1)?.args[0]).toBe(ONLINE_PREFIX);
    link.behaviour.script = (): unknown => ['u1'];
    expect(await refusedWith(directory.sweep())).toContain('something else');
    link.behaviour.script = (): unknown => [1, 2];
    expect(await refusedWith(directory.sweep())).toContain('something else');
  });

  test('a Redis that is away rejects: the caller decides what that means', async () => {
    const link = aFakeLink();
    const directory = redisPresenceDirectory(link, 'n');
    expect(await refusedWith(directory.join('u'))).toContain('not connected');
    expect(await refusedWith(directory.leave('u'))).toContain('not connected');
    expect(await refusedWith(directory.among(['u']))).toContain('not connected');
    expect(await refusedWith(directory.version())).toContain('not connected');
  });
});
