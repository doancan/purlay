/**
 * With `REDIS_URL` unset nothing connects anywhere, and the node is what it was before Redis (D-201, D-7,
 * #114): a self-hosted instance is broker-free permanently.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../platform/config';
import { createApp } from '../ingress/http/app';
import { createSocketLifecycle } from '../ingress/ws/socket';
import { testConfig, testDependencies } from '../testing/doubles';
import { aFakeLink } from '../testing/redis';
import { fixedClock } from '../platform/clock';
import { createLogger } from '../platform/logging';
import { sharedRealtime } from './shared';

const SOURCE = join(import.meta.dir, '..');

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });

describe('without REDIS_URL', () => {
  const real = Bun.RedisClient;
  const opened: string[] = [];
  afterEach(() => {
    Reflect.set(Bun, 'RedisClient', real);
    opened.length = 0;
  });

  test('building the application and its sockets constructs no Redis client and starts no connection', async () => {
    Reflect.set(Bun, 'RedisClient', function RefusedClient(): never {
      opened.push('a Redis client was constructed');
      throw new Error('a Redis client was constructed');
    });
    const dependencies = testDependencies();
    const app = createApp(dependencies);
    createSocketLifecycle({
      ...dependencies,
      userWrites: { consume: () => Promise.resolve(true), forget: () => undefined },
    });
    const health = await app.handle(new Request('http://localhost/health'));
    expect(health.status).toBe(200);
    expect(opened).toEqual([]);
  });

  test('the configuration without it has none, and says so in the loader’s own terms', () => {
    expect(loadConfig({ ...testEnvironment() }).REDIS_URL).toBeUndefined();
    expect(loadConfig({ ...testEnvironment(), REDIS_URL: '' }).REDIS_URL).toBeUndefined();
  });

  test('only the link opens a client, and only the composition root asks for the link', () => {
    const files = sourceFiles(SOURCE);
    const mentions = (needle: string): string[] =>
      files
        .filter((file) => readFileSync(file, 'utf8').includes(needle))
        .map((file) => file.slice(SOURCE.length + 1))
        .sort();
    expect(mentions('Bun.RedisClient')).toEqual(['platform/redis.ts']);
    expect(mentions('connectRedis(')).toEqual(['index.ts', 'testing/redis.ts']);
    expect(mentions('bunRedisClient')).toEqual([
      'index.ts',
      'platform/redis.ts',
      'testing/redis.ts',
    ]);
  });

  test('the composition root connects only behind the address: unset, there is no link and no shared state', () => {
    const index = readFileSync(join(SOURCE, 'index.ts'), 'utf8');
    expect(index).toContain('const redisUrl = config.REDIS_URL;\n');
    expect(index).toContain('redisUrl === undefined\n    ? undefined\n    : connectRedis(');
    expect(index).toContain('const sharing = redis === undefined ? undefined : sharedRealtime(');
  });
});

describe('with a shared record', () => {
  test('every limiter the application makes is a named one, so two budgets never share a bucket', () => {
    const link = aFakeLink();
    const { shared } = sharedRealtime(
      link,
      fixedClock(new Date()),
      createLogger({ level: 'silent' }),
    );
    link.behaviour.script = (): unknown => 1;
    return Promise.all([
      shared.limiters('auth', { perSecond: 1, burst: 1 }).consume('k'),
      shared.limiters('writes', { perSecond: 1, burst: 1 }).consume('k'),
    ]).then(() => {
      const keys = link.scripts.map((script) => script.keys[0]);
      expect(new Set(keys).size).toBe(2);
    });
  });

  test('the node is not ready until Redis has been reached once, and ready after, however it goes on', () => {
    const link = {
      ...aFakeLink(),
      problem: (): string | undefined => 'redis has not been reached since start',
    };
    const { shared } = sharedRealtime(
      link,
      fixedClock(new Date()),
      createLogger({ level: 'silent' }),
    );
    expect(shared.problem()).toBe('redis has not been reached since start');
  });
});

const testEnvironment = (): Record<string, string> => {
  const config = testConfig();
  return {
    APP_URL: config.APP_URL,
    DATABASE_URL: config.DATABASE_URL,
    ENCRYPTION_KEY: config.ENCRYPTION_KEY,
    GITHUB_CLIENT_ID: 'x',
    GITHUB_CLIENT_SECRET: 'y',
  };
};
