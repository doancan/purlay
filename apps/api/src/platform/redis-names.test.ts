/**
 * The names of a shared Redis (D-201): built from one namespace in one place, and written nowhere else.
 * The two deployments that would otherwise hear each other are held apart, against a real Redis, by
 * `redis-namespace.redis.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aRecordingLogger } from '../testing/doubles';
import { connectRedis } from './redis';
import { DEFAULT_REDIS_NAMESPACE, REDIS_NAMESPACE_PATTERN, redisNames } from './redis-names';

describe('the names in a namespace', () => {
  test('by default they are the ones every deployment has always had', () => {
    expect(DEFAULT_REDIS_NAMESPACE).toBe('purlay');
    expect(redisNames()).toEqual({
      bus: 'purlay:bus',
      moduleSet: 'purlay:modules',
      typingPrefix: 'purlay:typing:',
      onlinePrefix: 'purlay:online:',
      lapseIndex: 'purlay:online-lapse',
      idleIndex: 'purlay:online-idle',
      bucketPrefix: 'purlay:rl:',
    });
  });

  test('a namespace replaces the first word of every one of them, and only that', () => {
    const staging = redisNames('staging');
    const fallback = redisNames();
    expect(Object.keys(staging)).toEqual(Object.keys(fallback));
    const before = Object.values(fallback).map(String);
    Object.values(staging)
      .map(String)
      .forEach((name, index) => {
        expect(name).toBe((before[index] ?? '').replace(/^purlay:/, 'staging:'));
        expect(name).toStartWith('staging:');
      });
  });

  test('two namespaces share no name, and neither name starts the other’s', () => {
    const a = Object.values(redisNames('prod')).map(String);
    const b = Object.values(redisNames('prod-2')).map(String);
    for (const one of a) {
      for (const other of b) {
        expect(one).not.toBe(other);
        expect(one.startsWith(other) || other.startsWith(one)).toBe(false);
      }
    }
  });
});

describe('what a namespace may be', () => {
  const accepted = ['purlay', 'staging', 'a', 'Tenant_7', 'eu-west.1', '0prod', 'x'.repeat(32)];
  const refused = [
    '',
    ' ',
    'with space',
    'a:b',
    'staging:',
    '{tag}',
    '-leading',
    '.leading',
    '_leading',
    'x'.repeat(33),
    'çay',
    'new\nline',
    'star*',
    'a/b',
  ];

  test('letters, digits, dot, underscore and hyphen, 1 to 32, starting with a letter or digit', () => {
    for (const namespace of accepted) {
      expect(new RegExp(REDIS_NAMESPACE_PATTERN).test(namespace)).toBe(true);
      expect(redisNames(namespace).bus).toBe(`${namespace}:bus`);
    }
  });

  test('anything else is refused, by the pattern the configuration uses and by the function', () => {
    for (const namespace of refused) {
      expect(new RegExp(REDIS_NAMESPACE_PATTERN).test(namespace)).toBe(false);
      expect(() => redisNames(namespace)).toThrow('not a Redis namespace');
    }
  });

  test('a link refuses one before it opens any connection', () => {
    let opened = 0;
    expect(() =>
      connectRedis({
        create: () => {
          opened += 1;
          throw new Error('must not be reached');
        },
        log: aRecordingLogger().log,
        namespace: 'bad:one',
      }),
    ).toThrow('not a Redis namespace');
    expect(opened).toBe(0);
  });
});

/**
 * A name written out in another file is a name that ignores the namespace: it would be shared by every
 * deployment of one Redis, which is the failure this exists to prevent. Every name is built from
 * `link.names`; a new key goes into `redis-names.ts`.
 */
describe('no other file writes a name into Redis', () => {
  const root = join(import.meta.dir, '..');
  const sources = [...new Bun.Glob('**/*.ts').scanSync({ cwd: root })]
    .filter((file) => !file.endsWith('.test.ts') && !file.startsWith('testing/'))
    .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }));

  /** Code, not comment: a line that starts a comment may say what a name used to be. */
  const literals = (text: string): string[] =>
    text
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .filter((line) => /['"`]purlay:/.test(line));

  /**
   * These write `purlay:…` for something that is not in Redis: a key of the database's `rate_limits` table,
   * or the label a secret is derived under. Redis never sees them. A file added here says why.
   */
  const NOT_REDIS: ReadonlySet<string> = new Set([
    'platform/crypto.ts',
    'modules/auth/better-auth.ts',
    'modules/auth/magic-link.ts',
    'modules/auth/password-attempts.ts',
    'modules/workspaces/invitation-mail.ts',
  ]);

  test('the sources were found', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources.some(({ file }) => file === 'platform/redis-names.ts')).toBe(true);
  });

  test('a file that talks to Redis holds no `purlay:` literal', () => {
    const talksToRedis = /\bRedisLink\b|from '(\.\.?\/)+platform\/redis'|from '\.\/redis'/;
    const offenders = sources
      .filter(({ file }) => talksToRedis.test(readFileSync(join(root, file), 'utf8')))
      .filter(({ text }) => literals(text).length > 0)
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  test('a `purlay:` literal elsewhere is one of the few that are not Redis’s', () => {
    const unknown = sources
      .filter(({ text }) => literals(text).length > 0)
      .map(({ file }) => file)
      .filter((file) => !NOT_REDIS.has(file));
    expect(unknown).toEqual([]);
  });

  test('what is excused still writes one, so the list does not outlive its reason', () => {
    for (const file of NOT_REDIS) {
      const source = sources.find((each) => each.file === file);
      expect(source).toBeDefined();
      expect(literals(source?.text ?? '').length).toBeGreaterThan(0);
    }
  });
});
