/**
 * The loader refuses rather than guesses.
 *
 * A missing secret must fail at startup, never at 3am on the first request that
 * needs it (`CONFIG.md`). These check that it does — and that it fails usefully,
 * naming every problem at once and never quoting a credential back.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tlsFromEnvironment } from '@purlay/db';
import { CONFIGURED, ConfigurationError, DEVELOPMENT_ENCRYPTION_KEY, loadConfig } from './config';

const valid = {
  APP_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://purlay:purlay@localhost:5432/purlay',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
};

/** A key that is a real 32 bytes, and not the development one. */
const REAL_KEY = Buffer.from(
  '9f3ac1d27b05e84c61a9d03f5e2b7c84d1a6e90b3f58c27a4d6e1b09a3c75f82',
  'hex',
).toString('base64');

/** A production environment that is otherwise sound, so a test varies one thing. */
const production = {
  ...valid,
  NODE_ENV: 'production',
  APP_URL: 'https://purlay.app',
  ENCRYPTION_KEY: REAL_KEY,
  DATABASE_SSL: 'true',
  // The attachment bucket, which production does not start without (D-109).
  S3_ENDPOINT: 'http://garage:3900',
  S3_BUCKET: 'purlay-attachments',
  S3_ACCESS_KEY_ID: 'GK000000000000000000000001',
  S3_SECRET_ACCESS_KEY: 's'.repeat(64),
};

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** The same 32 bytes spelled differently: the last character's two unused low bits flipped. */
const aliasOf = (key: string): string => {
  const last = ALPHABET.indexOf(key.charAt(42));
  return `${key.slice(0, 42)}${ALPHABET.charAt(last ^ 1)}=`;
};

const refusal = (environment: Record<string, string | undefined>): string => {
  try {
    loadConfig(environment);
  } catch (error) {
    if (error instanceof ConfigurationError) return error.message;
    throw error;
  }
  throw new Error('the configuration was accepted');
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
    expect(config.SESSION_TTL_DAYS).toBe(30);
    expect(config.DATABASE_SSL).toBe(false);
  });

  test('error tracking is off unless a DSN is given, and an empty one is the same as none', () => {
    expect(loadConfig(valid).ERROR_TRACKING_DSN).toBeUndefined();
    expect(loadConfig({ ...valid, ERROR_TRACKING_DSN: '' }).ERROR_TRACKING_DSN).toBeUndefined();
    expect(
      loadConfig({ ...valid, ERROR_TRACKING_DSN: 'https://k@errors.example.test/1' })
        .ERROR_TRACKING_DSN,
    ).toBe('https://k@errors.example.test/1');
  });

  test('migrating on start is off unless asked for, and a bad value is refused', () => {
    expect(loadConfig(valid).MIGRATE_ON_START).toBeUndefined();
    expect(loadConfig({ ...valid, MIGRATE_ON_START: 'true' }).MIGRATE_ON_START).toBe(true);
    expect(() => loadConfig({ ...valid, MIGRATE_ON_START: 'sometimes' })).toThrow(
      ConfigurationError,
    );
  });

  test('the migration CLI reads DATABASE_SSL exactly as the application does (D-91)', () => {
    for (const value of ['true', 'false', '1', '0', undefined]) {
      const environment = value === undefined ? {} : { DATABASE_SSL: value };
      expect(tlsFromEnvironment(environment).ssl).toBe(
        loadConfig({ ...valid, ...environment }).DATABASE_SSL,
      );
    }
    expect(() => tlsFromEnvironment({ DATABASE_SSL: 'yes' })).toThrow('DATABASE_SSL must be');
  });

  test('a CA file needs TLS, in the application and in the migration CLI alike (D-92)', () => {
    const certificate = new URL('../../../../packages/db/src/client.ts', import.meta.url).pathname;
    const withCa = { DATABASE_SSL: 'true', DATABASE_SSL_CA_FILE: certificate };
    expect(loadConfig({ ...valid, ...withCa }).DATABASE_SSL_CA_FILE).toBe(certificate);
    expect(tlsFromEnvironment(withCa).sslCa).toContain('createDatabase');

    const withoutTls = { DATABASE_SSL: 'false', DATABASE_SSL_CA_FILE: certificate };
    expect(() => loadConfig({ ...valid, ...withoutTls })).toThrow('needs DATABASE_SSL=true');
    expect(() => tlsFromEnvironment(withoutTls)).toThrow('needs DATABASE_SSL=true');
    expect(() =>
      tlsFromEnvironment({ DATABASE_SSL: 'true', DATABASE_SSL_CA_FILE: '/nonexistent/ca.pem' }),
    ).toThrow('cannot be read');
  });

  test('strings become the type they were declared as', () => {
    const config = loadConfig({ ...valid, PORT: '8080', DATABASE_SSL: 'true' });
    expect(config.PORT).toBe(8080);
    expect(config.DATABASE_SSL).toBe(true);
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
    expect(loadConfig({ ...production, APP_URL: 'https://purlay.app' })).toBeDefined();
  });

  test('the attachment bucket: all four settings or none, and production needs them', () => {
    const { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = production;
    const bucket = { S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY };
    // None, in development: a server that refuses uploads, loudly, when one is tried.
    expect(loadConfig(valid).S3_ENDPOINT).toBeUndefined();
    expect(loadConfig({ ...valid, ...bucket }).S3_BUCKET).toBe('purlay-attachments');
    expect(() => loadConfig({ ...valid, S3_ENDPOINT })).toThrow(/set all four, or none/);
    const without = Object.fromEntries(
      Object.entries(production).filter(([key]) => !key.startsWith('S3_')),
    );
    expect(() => loadConfig(without)).toThrow(
      /production refuses to start without the attachment bucket/,
    );
  });

  test('the bucket’s secret is never quoted back', () => {
    try {
      loadConfig({
        ...valid,
        S3_ENDPOINT: 'http://garage:3900',
        S3_SECRET_ACCESS_KEY: 'secret-value-x',
      });
      throw new Error('should have refused');
    } catch (error) {
      expect((error as ConfigurationError).message).not.toContain('secret-value-x');
    }
  });

  /** Regression for #200: the socket compares `Origin` to this, exactly. */
  test('APP_URL is an origin: a trailing slash is dropped, a path is refused', () => {
    expect(loadConfig({ ...valid, APP_URL: 'https://chat.example.com/' }).APP_URL).toBe(
      'https://chat.example.com',
    );
    expect(loadConfig({ ...valid, APP_URL: 'https://chat.example.com:8443' }).APP_URL).toBe(
      'https://chat.example.com:8443',
    );
    const refusal = (url: string): string | undefined => {
      try {
        loadConfig({ ...valid, APP_URL: url });
        return undefined;
      } catch (error) {
        return error instanceof ConfigurationError ? error.message : String(error);
      }
    };
    for (const url of [
      'https://example.com/chat',
      'https://example.com/?team=a',
      'https://example.com/#x',
    ]) {
      expect({ url, refused: refusal(url)?.includes('must be an origin') }).toEqual({
        url,
        refused: true,
      });
    }
  });

  /**
   * A session is a credential that lives this long. Both ends are limits a person
   * chose: a year is the longest a stolen cookie may be worth, and zero would mint
   * sessions that are expired when issued.
   */
  test('SESSION_TTL_DAYS is a whole number of days from one to 365', () => {
    expect(loadConfig({ ...valid, SESSION_TTL_DAYS: '1' }).SESSION_TTL_DAYS).toBe(1);
    expect(loadConfig({ ...valid, SESSION_TTL_DAYS: '365' }).SESSION_TTL_DAYS).toBe(365);
    const accepted = ['0', '366', '3650', '-1', 'a month'].filter((value) => {
      try {
        loadConfig({ ...valid, SESSION_TTL_DAYS: value });
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted).toEqual([]);
  });

  test('an invalid enumerated value is refused rather than coerced', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'staging' })).toThrow(ConfigurationError);
  });
});

describe('a configuration that is unsafe is refused, by variable, without quoting a secret', () => {
  test('a sound production environment is accepted (the baseline the refusals vary)', () => {
    expect(loadConfig(production).NODE_ENV).toBe('production');
  });

  test('ENCRYPTION_KEY: 44 repeated letters are not a key', () => {
    const message = refusal({ ...valid, ENCRYPTION_KEY: `${'a'.repeat(43)}=` });
    expect(message).toContain('ENCRYPTION_KEY');
    expect(message).not.toContain('aaaaaaaa');
  });

  test('ENCRYPTION_KEY: it must decode to exactly 32 bytes', () => {
    for (const bytes of [16, 31, 33, 64]) {
      const key = Buffer.alloc(bytes, 'xy').toString('base64');
      expect(refusal({ ...valid, ENCRYPTION_KEY: key })).toContain('ENCRYPTION_KEY');
    }
    // 44 characters that are not base64 at all.
    expect(refusal({ ...valid, ENCRYPTION_KEY: `${'!?'.repeat(21)}==` })).toContain(
      'ENCRYPTION_KEY',
    );
  });

  test('ENCRYPTION_KEY: 32 identical bytes, zero included, are refused', () => {
    for (const byte of [0, 0x41, 0xff]) {
      const key = Buffer.alloc(32, byte).toString('base64');
      const message = refusal({ ...valid, ENCRYPTION_KEY: key });
      expect(message).toContain('ENCRYPTION_KEY');
      expect(message).not.toContain(key);
    }
  });

  test('ENCRYPTION_KEY: a genuine key is accepted', () => {
    expect(loadConfig({ ...valid, ENCRYPTION_KEY: REAL_KEY }).ENCRYPTION_KEY).toBe(REAL_KEY);
  });

  test('production refuses the development key, and does not print it', () => {
    const message = refusal({ ...production, ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY });
    expect(message).toContain('ENCRYPTION_KEY');
    expect(message).toContain('development');
    expect(message).not.toContain(DEVELOPMENT_ENCRYPTION_KEY);
  });

  /** Found by attack: the last base64 character carries two bits that decoding drops. */
  test('a non-canonical spelling of the development key is the development key, not another key', () => {
    const variants = [aliasOf(DEVELOPMENT_ENCRYPTION_KEY)];
    // Same bytes, different string: the alias this closes.
    expect(
      Buffer.from(variants[0] ?? '', 'base64').equals(
        Buffer.from(DEVELOPMENT_ENCRYPTION_KEY, 'base64'),
      ),
    ).toBe(true);
    for (const key of variants) {
      expect(refusal({ ...production, ENCRYPTION_KEY: key })).toContain('ENCRYPTION_KEY');
    }
  });

  test('a key is its canonical spelling: decoding then encoding gives back what was set', () => {
    const message = refusal({ ...valid, ENCRYPTION_KEY: aliasOf(REAL_KEY) });
    expect(message).toContain('ENCRYPTION_KEY');
    expect(message).not.toContain(REAL_KEY);
  });

  test('a low-entropy key is refused: a short pattern, a sequence, few distinct bytes', () => {
    const keys: Record<string, Buffer> = {
      'abcd repeated': Buffer.from('abcd'.repeat(8)),
      'bytes 0..31': Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
      'bytes 31..0': Buffer.from(Array.from({ length: 32 }, (_, i) => 31 - i)),
      'step of seven': Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)),
      'a 16-byte pattern twice': Buffer.concat([
        Buffer.from(REAL_KEY, 'base64').subarray(0, 16),
        Buffer.from(REAL_KEY, 'base64').subarray(0, 16),
      ]),
      'three distinct bytes': Buffer.from(Array.from({ length: 32 }, (_, i) => (i * i) % 3)),
    };
    for (const [name, bytes] of Object.entries(keys)) {
      const key = bytes.toString('base64');
      const message = refusal({ ...valid, ENCRYPTION_KEY: key });
      expect({ name, named: message.includes('ENCRYPTION_KEY') }).toEqual({ name, named: true });
      expect(message).not.toContain(key);
    }
  });

  test('outside production the development key is what tests and a laptop use', () => {
    expect(loadConfig({ ...valid, NODE_ENV: 'test' }).ENCRYPTION_KEY).toBe(
      DEVELOPMENT_ENCRYPTION_KEY,
    );
  });

  test('production refuses plaintext database transport, by default and when set false', () => {
    for (const ssl of [undefined, 'false']) {
      const message = refusal({ ...production, DATABASE_SSL: ssl });
      expect(message).toContain('DATABASE_SSL');
      expect(message).toContain('DATABASE_ALLOW_PLAINTEXT');
    }
  });

  test('production accepts plaintext transport only when it is explicitly acknowledged', () => {
    const config = loadConfig({
      ...production,
      DATABASE_SSL: 'false',
      DATABASE_ALLOW_PLAINTEXT: 'true',
    });
    expect(config.DATABASE_SSL).toBe(false);
  });

  test('the acknowledgement does not turn plaintext on, and is not needed in development', () => {
    expect(loadConfig(valid).DATABASE_SSL).toBe(false);
    expect(loadConfig({ ...valid, DATABASE_ALLOW_PLAINTEXT: 'true' }).DATABASE_SSL).toBe(false);
  });

  test('APP_URL: only http and https are schemes of an origin we serve', () => {
    for (const url of ['ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd']) {
      expect(refusal({ ...valid, APP_URL: url })).toContain('APP_URL');
    }
  });

  test('every refusal in one production environment is reported at once', () => {
    const message = refusal({
      ...production,
      ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
      DATABASE_SSL: undefined,
      APP_URL: 'http://purlay.app',
    });
    for (const name of ['ENCRYPTION_KEY', 'DATABASE_SSL', 'APP_URL']) {
      expect(message).toContain(name);
    }
  });
});

describe('integers are integers', () => {
  test('SESSION_TTL_DAYS=1.5 is refused rather than truncated to a day', () => {
    for (const days of ['1.5', '0.5', '30.2']) {
      expect(refusal({ ...valid, SESSION_TTL_DAYS: days })).toContain('SESSION_TTL_DAYS');
    }
    expect(loadConfig({ ...valid, SESSION_TTL_DAYS: '7' }).SESSION_TTL_DAYS).toBe(7);
  });

  test('the same for the other integers: PORT and DATABASE_POOL_MAX', () => {
    expect(refusal({ ...valid, PORT: '3001.9' })).toContain('PORT');
    expect(refusal({ ...valid, DATABASE_POOL_MAX: '10.5' })).toContain('DATABASE_POOL_MAX');
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

/**
 * A variable the product no longer reads is refused, by name and with what replaced it: left set,
 * an operator would expect what it used to do, and nothing would say it does nothing (D-115).
 */
describe('a retired variable', () => {
  test('open join is refused with where invitations live now', () => {
    const message = refusal({ ...valid, WORKSPACE_OPEN_JOIN_SLUG: 'acme' });
    expect(message).toContain('WORKSPACE_OPEN_JOIN_SLUG');
    expect(message).toContain('D-115');
  });

  test('set to nothing, as an example file leaves it, is not set', () => {
    expect(() => loadConfig({ ...valid, WORKSPACE_OPEN_JOIN_SLUG: '' })).not.toThrow();
  });
});

describe('the directory store (D-117)', () => {
  test('is a development store: production refuses it, as it refuses to run without the bucket', () => {
    expect(
      refusal({
        ...valid,
        NODE_ENV: 'production',
        APP_URL: 'https://chat.example.com',
        DATABASE_SSL: 'true',
        ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        STORAGE_DIRECTORY: '/var/purlay/files',
      }),
    ).toContain('STORAGE_DIRECTORY: production keeps attachments in the bucket');
  });

  test('is one store or the other, never both', () => {
    expect(
      refusal({
        ...valid,
        STORAGE_DIRECTORY: '/tmp/files',
        S3_ENDPOINT: 'http://127.0.0.1:9000',
        S3_BUCKET: 'b',
        S3_ACCESS_KEY_ID: 'k',
        S3_SECRET_ACCESS_KEY: 's',
      }),
    ).toContain('STORAGE_DIRECTORY: one store or the other');
    expect(loadConfig({ ...valid, STORAGE_DIRECTORY: '/tmp/files' }).STORAGE_DIRECTORY).toBe(
      '/tmp/files',
    );
  });
});

describe('Web Push keys (#78)', () => {
  // A real pair's shape: a 65-byte uncompressed P-256 point and a 32-byte scalar, base64url.
  const vapid = {
    VAPID_PUBLIC_KEY: `B${'A'.repeat(86)}`,
    VAPID_PRIVATE_KEY: 'A'.repeat(43),
    VAPID_SUBJECT: 'mailto:ops@example.com',
  };

  test('are all three or none: none is push switched off, in production too', () => {
    expect(loadConfig(valid).VAPID_PUBLIC_KEY).toBeUndefined();
    expect(() => loadConfig(production)).not.toThrow();
    expect(loadConfig({ ...valid, ...vapid }).VAPID_SUBJECT).toBe('mailto:ops@example.com');
    expect(refusal({ ...valid, VAPID_PUBLIC_KEY: vapid.VAPID_PUBLIC_KEY })).toContain(
      'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT: set all three, or none',
    );
  });

  test('have the shapes a push service accepts', () => {
    expect(refusal({ ...valid, ...vapid, VAPID_PUBLIC_KEY: 'short' })).toContain(
      'VAPID_PUBLIC_KEY',
    );
    expect(refusal({ ...valid, ...vapid, VAPID_PRIVATE_KEY: 'A'.repeat(44) })).toContain(
      'VAPID_PRIVATE_KEY',
    );
    expect(refusal({ ...valid, ...vapid, VAPID_SUBJECT: 'ops@example.com' })).toContain(
      'VAPID_SUBJECT',
    );
    expect(
      loadConfig({ ...valid, ...vapid, VAPID_SUBJECT: 'https://chat.example.com' }).VAPID_SUBJECT,
    ).toBe('https://chat.example.com');
  });
});
