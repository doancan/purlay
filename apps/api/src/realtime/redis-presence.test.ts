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
  IDLE_INDEX,
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
  test('join and leave send this node’s id, the claim’s lifetime and the quiet allowed; a version is what changed, 0 is nothing', async () => {
    const link = aFakeLink();
    const answers = [1_700_000_000_001, 0, 1_700_000_000_002];
    link.behaviour.script = (): unknown => answers.shift();
    const directory = redisPresenceDirectory(link, 'node-a');
    expect(await directory.join('u1', 300_000)).toBe(1_700_000_000_001);
    expect(await directory.join('u1', 300_000)).toBeNull();
    expect(await directory.leave('u1')).toBe(1_700_000_000_002);
    expect(link.scripts[0]?.keys).toEqual([`${ONLINE_PREFIX}u1`, LAPSE_INDEX, IDLE_INDEX]);
    expect(link.scripts[0]?.args).toEqual(['node-a', String(PRESENCE_NODE_TTL_MS), 'u1', '300000']);
    expect(link.scripts[2]?.keys).toEqual([`${ONLINE_PREFIX}u1`, LAPSE_INDEX, IDLE_INDEX]);
    expect(link.scripts[2]?.args).toEqual(['node-a', 'u1']);
  });

  test('a word names the person, the idle index and the quiet allowed; a version only when it ended a told idle', async () => {
    const link = aFakeLink();
    const answers = [0, 1_700_000_000_003];
    link.behaviour.script = (): unknown => answers.shift();
    const directory = redisPresenceDirectory(link, 'node-a');
    expect(await directory.active('u1', 300_000)).toBeNull();
    expect(await directory.active('u1', 300_000)).toBe(1_700_000_000_003);
    expect(link.scripts[0]?.keys).toEqual([`${ONLINE_PREFIX}u1`, IDLE_INDEX]);
    expect(link.scripts[0]?.args).toEqual(['u1', '300000']);
  });

  test('a retelling is the new version and the idleness when somebody holds them, nothing when nobody does', async () => {
    const link = aFakeLink();
    const answers: unknown[] = [
      [1_700_000_000_004, 1],
      [1_700_000_000_005, 0],
      [0, 0],
    ];
    link.behaviour.script = (): unknown => answers.shift();
    const directory = redisPresenceDirectory(link, 'node-a');
    expect(await directory.retell('u1')).toEqual({
      userId: 'u1',
      online: true,
      away: true,
      version: 1_700_000_000_004,
    });
    expect(await directory.retell('u1')).toEqual({
      userId: 'u1',
      online: true,
      away: false,
      version: 1_700_000_000_005,
    });
    expect(await directory.retell('u1')).toBeNull();
    expect(link.scripts[0]?.keys).toEqual([`${ONLINE_PREFIX}u1`]);
    link.behaviour.script = (): unknown => [1];
    expect(await refusedWith(directory.retell('u1'))).toContain('something else');
    link.behaviour.script = (): unknown => 'x';
    expect(await refusedWith(directory.active('u1', 1))).toContain('something else');
  });

  test('among reads every key in one call and keeps the people who are online, each at their version and idleness', async () => {
    const link = aFakeLink();
    link.behaviour.script = (): unknown => [0, 0, 42, 0, 0, 0, 43, 1];
    const directory = redisPresenceDirectory(link, 'node-a');
    expect(await directory.among(['a', 'b', 'c', 'd'])).toEqual([
      { userId: 'b', online: true, away: false, version: 42 },
      { userId: 'd', online: true, away: true, version: 43 },
    ]);
    expect(link.scripts).toHaveLength(1);
    expect(await directory.among([])).toEqual([]);
    expect(link.scripts).toHaveLength(1);
  });

  test('an answer of the wrong shape is a failure, not a guess', async () => {
    const link = aFakeLink();
    const directory = redisPresenceDirectory(link, 'n');
    link.behaviour.script = (): unknown => [1, 0];
    expect(await refusedWith(directory.among(['a', 'b']))).toContain('something else');
    link.behaviour.script = (): unknown => 'x';
    expect(await refusedWith(directory.join('a', 1))).toContain('something else');
    link.behaviour.script = (): unknown => [1, 0, 'x', 0];
    expect(await refusedWith(directory.among(['a', 'b']))).toContain('something else');
    link.behaviour.script = (): unknown => [1, 0, 2, 'x'];
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

  test('release and sweep name this node, the indexes and the claims’ prefix; a sweep returns each person once, offline or idle', async () => {
    const link = aFakeLink();
    const directory = redisPresenceDirectory(link, 'node-a');
    link.behaviour.script = (): unknown => 1;
    await directory.release(['u1', 'u2']);
    expect(link.scripts.map((script) => script.keys)).toEqual([
      [`${ONLINE_PREFIX}u1`, LAPSE_INDEX, IDLE_INDEX],
      [`${ONLINE_PREFIX}u2`, LAPSE_INDEX, IDLE_INDEX],
    ]);
    expect(link.scripts[0]?.args).toEqual(['node-a', 'u1']);
    link.behaviour.script = (): unknown => ['u1', 77, 0, 'u2', 78, 0, 'u3', 79, 1];
    expect(await directory.sweep()).toEqual([
      { userId: 'u1', online: false, away: false, version: 77 },
      { userId: 'u2', online: false, away: false, version: 78 },
      { userId: 'u3', online: true, away: true, version: 79 },
    ]);
    expect(link.scripts.at(-1)?.keys).toEqual([LAPSE_INDEX, IDLE_INDEX]);
    expect(link.scripts.at(-1)?.args[0]).toBe(ONLINE_PREFIX);
    link.behaviour.script = (): unknown => ['u1', 77];
    expect(await refusedWith(directory.sweep())).toContain('something else');
    link.behaviour.script = (): unknown => [1, 2, 0];
    expect(await refusedWith(directory.sweep())).toContain('something else');
    link.behaviour.script = (): unknown => ['u1', 77, 'x'];
    expect(await refusedWith(directory.sweep())).toContain('something else');
  });

  test('a Redis that is away rejects: the caller decides what that means', async () => {
    const link = aFakeLink();
    const directory = redisPresenceDirectory(link, 'n');
    expect(await refusedWith(directory.join('u', 1))).toContain('not connected');
    expect(await refusedWith(directory.leave('u'))).toContain('not connected');
    expect(await refusedWith(directory.active('u', 1))).toContain('not connected');
    expect(await refusedWith(directory.retell('u'))).toContain('not connected');
    expect(await refusedWith(directory.among(['u']))).toContain('not connected');
    expect(await refusedWith(directory.version())).toContain('not connected');
  });
});
