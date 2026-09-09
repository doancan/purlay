/**
 * The loader refuses rather than guesses.
 *
 * A missing secret must fail at startup, never at 3am on the first request that
 * needs it (`CONFIG.md`). These check that it does — and that it fails usefully,
 * naming every problem at once and never quoting a credential back.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONFIGURED, ConfigurationError, loadConfig } from './config';

const valid = {
  APP_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://purlay:purlay@localhost:5432/purlay',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  ENCRYPTION_KEY: 'ZGV2ZWxvcG1lbnQtb25seS10aGlydHktdHdvLWJ5dGVzIQ==',
};

describe('loading configuration', () => {
  test('a complete environment produces a configuration', () => {
    const config = loadConfig(valid);
    expect(config.APP_URL).toBe('http://localhost:5173');
    expect(config.NODE_ENV).toBe('development');
  });

  test('defaults are applied, so an unset optional is not a failure', () => {
    const config = loadConfig(valid);
    expect(config.PORT).toBe(3001);
    expect(config.DATABASE_POOL_MAX).toBe(10);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.DEFAULT_LOCALE).toBe('en');
  });

  test('strings become the type they were declared as', () => {
    const config = loadConfig({ ...valid, PORT: '8080', TRUST_PROXY: 'true' });
    expect(config.PORT).toBe(8080);
    expect(config.TRUST_PROXY).toBe(true);
  });

  test('a missing required variable refuses the whole configuration', () => {
    expect(() => loadConfig({})).toThrow(ConfigurationError);
  });

  /**
   * Reporting one problem per restart is how a first deployment becomes an
   * afternoon. S-2 is a stranger self-hosting it from the README.
   */
  test('every problem is reported at once, not the first one', () => {
    try {
      loadConfig({});
      throw new Error('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const { problems } = error as ConfigurationError;
      expect(problems.length).toBeGreaterThanOrEqual(4);
      expect(problems.join(' ')).toContain('APP_URL');
      expect(problems.join(' ')).toContain('GITHUB_CLIENT_SECRET');
    }
  });

  /** A bad DATABASE_URL is still a credential. (`ARCHITECTURE.md` §10) */
  test('a secret is never quoted back in the failure', () => {
    try {
      loadConfig({ ...valid, DATABASE_URL: '' });
      throw new Error('should have refused');
    } catch (error) {
      const message = (error as ConfigurationError).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('value withheld');
      expect(message).not.toContain(valid.GITHUB_CLIENT_SECRET);
    }
  });

  test('production insists on https, because the session cookie is Secure', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow(/https/);
    expect(
      loadConfig({ ...valid, NODE_ENV: 'production', APP_URL: 'https://purlay.app' }),
    ).toBeDefined();
  });

  test('an invalid enumerated value is refused rather than coerced', () => {
    expect(() => loadConfig({ ...valid, LOG_LEVEL: 'chatty' })).toThrow(ConfigurationError);
  });
});

describe('the loader and the document agree', () => {
  /**
   * One direction only. `CONFIG.md` publishes every variable the product will
   * ever read, including the ones whose features are later phases; the loader
   * reads the ones that exist today. What must never happen is the loader
   * reading something the document does not describe.
   */
  test('every variable the loader reads is described in CONFIG.md', () => {
    const document = readFileSync('docs/CONFIG.md', 'utf8');
    for (const name of CONFIGURED) {
      expect(document).toContain(`\`${name}\``);
    }
  });

  test('the example file lists exactly what the loader reads', () => {
    const example = readFileSync('.env.example', 'utf8');
    for (const name of CONFIGURED) {
      expect(example).toMatch(new RegExp(`^#? ?${name}=`, 'm'));
    }
  });
});
