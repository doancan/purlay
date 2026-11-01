/**
 * The loader refuses rather than guesses.
 *
 * A missing secret must fail at startup, never at 3am on the first request that
 * needs it (`CONFIG.md`). These check that it does — and that it fails usefully,
 * naming every problem at once and never quoting a credential back.
 */
import { createECDH, generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tlsFromEnvironment } from '@purlay/db';
import { CONTRACT_VERSION } from '@purlay/types';
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
      expect(problems.length).toBeGreaterThanOrEqual(3);
      expect(problems.join(' ')).toContain('APP_URL');
      expect(problems.join(' ')).toContain('ENCRYPTION_KEY');
    }
  });

  /** Two lines for one missing variable read as two problems in `docker compose logs api` (#683). */
  test('each variable is named once, with the first reason', () => {
    try {
      loadConfig({});
      throw new Error('should have refused');
    } catch (error) {
      const { problems } = error as ConfigurationError;
      const named = problems.map((problem) => problem.slice(0, problem.indexOf(':')));
      expect(named).toEqual([...new Set(named)]);
      expect(problems).toContain('APP_URL: Expected required property');
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

  test('who may make a workspace: logins, comma-separated, or `*`; anything else is refused (D-155)', () => {
    expect(loadConfig(valid).WORKSPACE_CREATORS).toBeUndefined();
    expect(loadConfig({ ...valid, WORKSPACE_CREATORS: '' }).WORKSPACE_CREATORS).toBeUndefined();
    for (const value of ['*', 'dogancan', ' Alice, bob-2 ,carol ']) {
      expect(loadConfig({ ...valid, WORKSPACE_CREATORS: value }).WORKSPACE_CREATORS).toBe(value);
    }
    for (const value of [
      '@alice',
      'alice bob',
      'alice,,bob',
      '-alice',
      'alice,*',
      'a'.repeat(40),
    ]) {
      expect(refusal({ ...valid, WORKSPACE_CREATORS: value })).toContain('WORKSPACE_CREATORS');
    }
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

/** A real pair, base64url: the 65-byte uncompressed point and its 32-byte scalar. */
const aVapidPair = (): { publicKey: string; privateKey: string } => {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  return {
    publicKey: pair.getPublicKey().toString('base64url'),
    // Padded: ECDH drops a leading zero byte, about one key in two hundred.
    privateKey: Buffer.from(pair.getPrivateKey().toString('hex').padStart(64, '0'), 'hex').toString(
      'base64url',
    ),
  };
};

describe('Web Push keys (#78)', () => {
  const one = aVapidPair();
  const other = aVapidPair();
  const vapid = {
    VAPID_PUBLIC_KEY: one.publicKey,
    VAPID_PRIVATE_KEY: one.privateKey,
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

  test('are one pair: halves of two pairs, or a scalar that is no key, refuse to start', () => {
    const mixed = refusal({ ...valid, ...vapid, VAPID_PRIVATE_KEY: other.privateKey });
    expect(mixed).toContain('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: not one pair');
    // Never the values: the private key is a secret.
    expect(mixed).not.toContain(other.privateKey);
    // The same bytes spelled a second way: 87 characters carry 522 bits for 520, and the last
    // character's lowest bit is one decoding drops.
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = ALPHABET.indexOf(one.publicKey.slice(-1));
    const respelled = `${one.publicKey.slice(0, -1)}${ALPHABET[last | 1] ?? ''}`;
    expect(respelled).not.toBe(one.publicKey);
    expect(
      Buffer.from(respelled, 'base64url').equals(Buffer.from(one.publicKey, 'base64url')),
    ).toBe(true);
    expect(refusal({ ...valid, ...vapid, VAPID_PUBLIC_KEY: respelled })).toContain(
      'VAPID_PUBLIC_KEY: not canonical base64url',
    );
    // Zero is not a private key, though it has the shape of one.
    expect(refusal({ ...valid, ...vapid, VAPID_PRIVATE_KEY: 'A'.repeat(43) })).toContain(
      'VAPID_PRIVATE_KEY: not a P-256 private key',
    );
  });
});

describe('sign-in mail (D-138 §6)', () => {
  const mail = {
    SMTP_URL: 'smtps://purlay:pw@mail.example.com:465',
    MAIL_FROM: 'purlay@example.com',
  };

  test('both or neither: neither is email sign-in off, in production too', () => {
    expect(loadConfig(valid).SMTP_URL).toBeUndefined();
    expect(() => loadConfig(production)).not.toThrow();
    expect(loadConfig({ ...valid, ...mail }).MAIL_FROM).toBe('purlay@example.com');
    expect(refusal({ ...valid, SMTP_URL: mail.SMTP_URL })).toContain(
      'SMTP_URL, MAIL_FROM: set both, or neither',
    );
    expect(refusal({ ...valid, MAIL_FROM: mail.MAIL_FROM })).toContain(
      'SMTP_URL, MAIL_FROM: set both, or neither',
    );
  });

  test('not an SMTP address, or not an address to send from, is refused; the URL is never quoted', () => {
    expect(refusal({ ...valid, ...mail, SMTP_URL: 'https://mail.example.com' })).toContain(
      'SMTP_URL',
    );
    expect(refusal({ ...valid, ...mail, MAIL_FROM: 'not an address' })).toContain('MAIL_FROM');
    const message = refusal({ ...valid, SMTP_URL: 'smtps://purlay:secret-pw-x@mail.example.com' });
    expect(message).not.toContain('secret-pw-x');
  });
});

describe('the shared Redis (D-201)', () => {
  test('is off when unset or empty, in production too: a self-hosted instance needs no broker', () => {
    expect(loadConfig(valid).REDIS_URL).toBeUndefined();
    expect(loadConfig({ ...valid, REDIS_URL: '' }).REDIS_URL).toBeUndefined();
    expect(() => loadConfig(production)).not.toThrow();
  });

  test('takes redis:// and rediss:// with credentials, and nothing else', () => {
    for (const REDIS_URL of ['redis://localhost:6379', 'rediss://u:pw@cache.example.com:6380/2']) {
      expect(loadConfig({ ...valid, REDIS_URL }).REDIS_URL).toBe(REDIS_URL);
    }
    for (const REDIS_URL of ['http://cache.example.com', 'redis://', 'redis://with space']) {
      expect(refusal({ ...valid, REDIS_URL })).toContain('REDIS_URL');
    }
  });

  test('is a secret: a refusal names the variable and never the address, which holds a password', () => {
    for (const REDIS_URL of ['redis://:secret-pw-r@', 'http://u:secret-pw-r@cache.example.com']) {
      const message = refusal({ ...valid, REDIS_URL });
      expect(message).toContain('REDIS_URL');
      if (REDIS_URL.startsWith('http')) expect(message).toContain('(value withheld)');
      expect(message).not.toContain('secret-pw-r');
    }
  });
});

describe('the metrics token (D-221)', () => {
  const TOKEN = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  test('is off when unset or empty, in production too: no page is served without it', () => {
    expect(loadConfig(valid).METRICS_TOKEN).toBeUndefined();
    expect(loadConfig({ ...valid, METRICS_TOKEN: '' }).METRICS_TOKEN).toBeUndefined();
    expect(loadConfig(production).METRICS_TOKEN).toBeUndefined();
  });

  test('takes a token as `openssl rand` writes one, hex or base64, from 32 characters to 512', () => {
    const base64 = Buffer.from(TOKEN, 'hex').toString('base64');
    for (const METRICS_TOKEN of [
      TOKEN,
      base64,
      'a'.repeat(32),
      'a'.repeat(512),
      'A1._~+/-'.repeat(4),
    ]) {
      expect(loadConfig({ ...valid, METRICS_TOKEN }).METRICS_TOKEN).toBe(METRICS_TOKEN);
    }
  });

  test('refuses one short enough to guess, too long, or with what a header cannot carry in a bearer', () => {
    for (const METRICS_TOKEN of [
      'a'.repeat(31),
      'a'.repeat(513),
      `${'a'.repeat(32)} b`,
      `${'a'.repeat(32)}"`,
      'ş'.repeat(32),
      `=${'a'.repeat(32)}`,
    ]) {
      expect({ METRICS_TOKEN, refused: refusal({ ...valid, METRICS_TOKEN }) }).toMatchObject({
        refused: expect.stringContaining('METRICS_TOKEN') as unknown as string,
      });
    }
  });

  test('is a secret: a refusal names the variable and never quotes the token', () => {
    const METRICS_TOKEN = `secret-metrics-${'x'.repeat(10)}`;
    const message = refusal({ ...valid, METRICS_TOKEN });
    expect(message).toContain('METRICS_TOKEN');
    expect(message).toContain('(value withheld)');
    expect(message).not.toContain('secret-metrics');
  });
});

describe('GitHub sign-in is a setting, not a requirement (D-179, R38)', () => {
  const without = (environment: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(environment).filter(([key]) => !key.startsWith('GITHUB_CLIENT_')),
    );
  const bare = without(valid);
  const github = { GITHUB_CLIENT_ID: 'Iv1.app', GITHUB_CLIENT_SECRET: 'gh-secret-value' };

  test('a fresh server boots with no GitHub variable at all, in production too', () => {
    const config = loadConfig(bare);
    expect(config.GITHUB_CLIENT_ID).toBeUndefined();
    expect(config.GITHUB_CLIENT_SECRET).toBeUndefined();
    expect(() => loadConfig(without(production))).not.toThrow();
  });

  test('both are read when both are set', () => {
    const config = loadConfig({ ...bare, ...github });
    expect([config.GITHUB_CLIENT_ID, config.GITHUB_CLIENT_SECRET]).toEqual([
      'Iv1.app',
      'gh-secret-value',
    ]);
  });

  test('one without the other is refused, naming both variables and never the value', () => {
    const message = 'GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET: set both, or neither';
    expect(refusal({ ...bare, GITHUB_CLIENT_ID: github.GITHUB_CLIENT_ID })).toContain(message);
    const secretOnly = refusal({ ...bare, GITHUB_CLIENT_SECRET: github.GITHUB_CLIENT_SECRET });
    expect(secretOnly).toContain(message);
    expect(secretOnly).not.toContain('gh-secret-value');
  });

  test('empty strings are unset, as a compose file passes them', () => {
    const config = loadConfig({ ...bare, GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' });
    expect([config.GITHUB_CLIENT_ID, config.GITHUB_CLIENT_SECRET]).toEqual([undefined, undefined]);
    // An empty one beside a set one is still one without the other.
    expect(refusal({ ...bare, GITHUB_CLIENT_ID: 'Iv1.app', GITHUB_CLIENT_SECRET: '' })).toContain(
      'set both, or neither',
    );
  });
});

describe('GitHub’s addresses (D-179)', () => {
  test('default to github.com and its API, as the production sign-in calls them', () => {
    const config = loadConfig(valid);
    expect(config.GITHUB_URL).toBe('https://github.com');
    expect(config.GITHUB_API_URL).toBe('https://api.github.com');
  });

  test('may name a GitHub Enterprise Server, its API under a path; a trailing slash is dropped', () => {
    const config = loadConfig({
      ...production,
      GITHUB_URL: 'https://github.example.com/',
      GITHUB_API_URL: 'https://github.example.com/api/v3/',
    });
    expect(config.GITHUB_URL).toBe('https://github.example.com');
    expect(config.GITHUB_API_URL).toBe('https://github.example.com/api/v3');
  });

  test('are https, but for a GitHub on this machine, which may be http in any environment', () => {
    for (const host of ['127.0.0.1:4010', 'localhost:4010', '[::1]:4010']) {
      const config = loadConfig({
        ...production,
        GITHUB_URL: `http://${host}`,
        GITHUB_API_URL: `http://${host}`,
      });
      expect(config.GITHUB_URL).toBe(`http://${host}`);
    }
    for (const name of ['GITHUB_URL', 'GITHUB_API_URL']) {
      expect(refusal({ ...valid, [name]: 'http://github.example.com' })).toContain(
        `${name}: must be https://, or http:// to this machine`,
      );
      // A name that only looks like this machine is somebody else's.
      expect(refusal({ ...valid, [name]: 'http://localhost.example.com' })).toContain(name);
      expect(refusal({ ...valid, [name]: 'http://127.0.0.1.nip.io' })).toContain(name);
      expect(refusal({ ...valid, [name]: 'ftp://github.example.com' })).toContain(name);
      expect(refusal({ ...valid, [name]: 'not a url' })).toContain(name);
    }
  });

  test('carry no credentials, query or fragment, and never quote one back', () => {
    for (const name of ['GITHUB_URL', 'GITHUB_API_URL']) {
      const message = refusal({ ...valid, [name]: 'https://user:hunter2@github.example.com' });
      expect(message).toContain(`${name}: an address without credentials, query or fragment`);
      expect(message).not.toContain('hunter2');
      expect(refusal({ ...valid, [name]: 'https://github.example.com/?x=1' })).toContain(name);
      expect(refusal({ ...valid, [name]: 'https://github.example.com/#x' })).toContain(name);
    }
  });
});

describe('the SMTP address is one a transport can be built from (D-179 §6)', () => {
  test('a password with an unescaped `#`, `/`, `?` or a broken escape refuses to start, naming the variable and never the value', () => {
    for (const SMTP_URL of [
      'smtp://u:pa#ss@mail.example.com',
      'smtp://u:pa/ss@mail.example.com',
      'smtp://u:pa?ss@mail.example.com',
      'smtps://u:pa%zzss@mail.example.com',
      'smtps://:pass@mail.example.com',
      'smtp://',
    ]) {
      const message = refusal({ ...valid, SMTP_URL, MAIL_FROM: 'purlay@example.com' });
      expect({ SMTP_URL, says: message.includes('SMTP_URL:') }).toEqual({ SMTP_URL, says: true });
      expect(message).not.toContain('pa#ss');
      expect(message).not.toContain('pa%zzss');
    }
    expect(
      loadConfig({
        ...valid,
        SMTP_URL: 'smtps://u:pa%23ss@mail.example.com',
        MAIL_FROM: 'purlay@example.com',
      }).SMTP_URL,
    ).toBe('smtps://u:pa%23ss@mail.example.com');
  });
});

describe('the minimum native client', () => {
  const minimum = {
    MIN_CLIENT_MACOS_CONTRACT: '1',
    MIN_CLIENT_MACOS_VERSION: '0.2.0',
    MACOS_DOWNLOAD_URL: 'https://example.test/purlay',
  };

  test('is no limit, with none of it set', () => {
    const config = loadConfig(valid);
    expect(config.MIN_CLIENT_MACOS_CONTRACT).toBeUndefined();
    expect(config.MIN_CLIENT_MACOS_VERSION).toBeUndefined();
    expect(config.MACOS_DOWNLOAD_URL).toBeUndefined();
  });

  test('is read as written, the contract as a number', () => {
    const config = loadConfig({ ...valid, ...minimum });
    expect(config.MIN_CLIENT_MACOS_CONTRACT).toBe(1);
    expect(config.MIN_CLIENT_MACOS_VERSION).toBe('0.2.0');
    expect(config.MACOS_DOWNLOAD_URL).toBe('https://example.test/purlay');
  });

  test('may be any one of the three', () => {
    expect(
      loadConfig({ ...valid, MIN_CLIENT_MACOS_VERSION: '1.0.0' }).MIN_CLIENT_MACOS_VERSION,
    ).toBe('1.0.0');
    expect(loadConfig({ ...valid, MIN_CLIENT_MACOS_CONTRACT: '1' }).MIN_CLIENT_MACOS_CONTRACT).toBe(
      1,
    );
  });

  // A minimum above what this very server speaks would refuse every client there is, and it would be
  // found by the first person who tried to sign in: refused at boot instead (CONFIG.md).
  test('refuses a contract higher than the one this server speaks', () => {
    const message = refusal({ ...valid, MIN_CLIENT_MACOS_CONTRACT: '999' });
    expect(message).toContain('MIN_CLIENT_MACOS_CONTRACT');
  });

  test('accepts the contract this server speaks, and refuses the next one up', () => {
    expect(
      loadConfig({ ...valid, MIN_CLIENT_MACOS_CONTRACT: String(CONTRACT_VERSION) })
        .MIN_CLIENT_MACOS_CONTRACT,
    ).toBe(CONTRACT_VERSION);
    expect(
      refusal({ ...valid, MIN_CLIENT_MACOS_CONTRACT: String(CONTRACT_VERSION + 1) }),
    ).toContain('MIN_CLIENT_MACOS_CONTRACT');
  });

  test.each(['0', '-1', '1.5', 'one', '1e3'])('refuses a contract of %s', (value) => {
    expect(refusal({ ...valid, MIN_CLIENT_MACOS_CONTRACT: value })).toContain(
      'MIN_CLIENT_MACOS_CONTRACT',
    );
  });

  test.each(['1.0', 'v1.0.0', '1.0.0.0', 'latest', '1.0.0 ', '1.0.0-'])(
    'refuses a version of %j',
    (value) => {
      expect(refusal({ ...valid, MIN_CLIENT_MACOS_VERSION: value })).toContain(
        'MIN_CLIENT_MACOS_VERSION',
      );
    },
  );

  test.each([
    'http://example.test/x',
    'ftp://example.test/x',
    'example.test/x',
    'javascript:alert(1)',
  ])('refuses a download address of %j: a person is sent there by the app', (value) => {
    expect(refusal({ ...valid, MACOS_DOWNLOAD_URL: value })).toContain('MACOS_DOWNLOAD_URL');
  });
});

describe('single sign-on is a setting, off while unset (D-200)', () => {
  const oidc = {
    OIDC_ISSUER: 'https://login.example.com/tenant-1',
    OIDC_CLIENT_ID: 'purlay-client',
    OIDC_CLIENT_SECRET: 'sso-secret-value',
  };

  test('a server boots with none of it, in production too: off, nothing to send anywhere', () => {
    const config = loadConfig(valid);
    expect([config.OIDC_ISSUER, config.OIDC_CLIENT_ID, config.OIDC_CLIENT_SECRET]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(() => loadConfig(production)).not.toThrow();
  });

  test('all three are read when all three are set, the label with them', () => {
    const config = loadConfig({ ...valid, ...oidc, OIDC_NAME: 'Acme SSO' });
    expect([config.OIDC_ISSUER, config.OIDC_CLIENT_ID, config.OIDC_NAME]).toEqual([
      oidc.OIDC_ISSUER,
      oidc.OIDC_CLIENT_ID,
      'Acme SSO',
    ]);
  });

  test.each(Object.keys(oidc))(
    'without %s alone it is refused, naming the three and never the value',
    (left) => {
      const partial = Object.fromEntries(Object.entries(oidc).filter(([key]) => key !== left));
      const message = refusal({ ...valid, ...partial });
      expect(message).toContain(
        'OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET: set all three, or none',
      );
      expect(message).not.toContain('sso-secret-value');
    },
  );

  test('empty strings are unset, as a compose file passes them', () => {
    const config = loadConfig({
      ...valid,
      OIDC_ISSUER: '',
      OIDC_CLIENT_ID: '',
      OIDC_CLIENT_SECRET: '',
    });
    expect(config.OIDC_ISSUER).toBeUndefined();
  });

  test.each([
    ['not an address', 'login.example.com'],
    ['plain http to another machine', 'http://login.example.com'],
    ['a query', 'https://login.example.com/?tenant=1'],
    ['a fragment', 'https://login.example.com/#x'],
    ['credentials', 'https://user:pass@login.example.com'],
  ])('an issuer that is %s is refused', (_what, issuer) => {
    expect(refusal({ ...valid, ...oidc, OIDC_ISSUER: issuer })).toContain('OIDC_ISSUER:');
  });

  test('an issuer is kept exactly as written: the token carries it byte for byte', () => {
    for (const issuer of ['https://login.example.com/', 'https://login.example.com/tenant-1']) {
      expect(loadConfig({ ...valid, ...oidc, OIDC_ISSUER: issuer }).OIDC_ISSUER).toBe(issuer);
    }
  });

  test('http is allowed to this machine, for a provider run beside the server', () => {
    expect(() =>
      loadConfig({ ...valid, ...oidc, OIDC_ISSUER: 'http://127.0.0.1:9000' }),
    ).not.toThrow();
    expect(() =>
      loadConfig({ ...valid, ...oidc, OIDC_ISSUER: 'http://localhost:9000' }),
    ).not.toThrow();
  });

  test.each([
    ['a control character', 'Ac\u0000me'],
    ['a direction override', 'Acme‮'],
    ['more than forty characters', 'x'.repeat(41)],
    ['space around it', ' Acme'],
  ])('a label with %s is refused', (_what, name) => {
    expect(refusal({ ...valid, ...oidc, OIDC_NAME: name })).toContain('OIDC_NAME:');
  });

  test('a label with no provider is refused: it would be dropped at the first start without a word', () => {
    expect(refusal({ ...valid, OIDC_NAME: 'Acme' })).toContain('OIDC_NAME: set with OIDC_ISSUER');
  });
});

describe('the GitHub App is a setting, off while unset (D-246)', () => {
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  const app = {
    GITHUB_APP_ID: '4242',
    GITHUB_APP_SLUG: 'purlay-issues',
    GITHUB_APP_CLIENT_ID: 'Iv23.purlay',
    GITHUB_APP_CLIENT_SECRET: 'app-secret-value',
    GITHUB_APP_PRIVATE_KEY: key.trim().replaceAll('\n', '\\n'),
    GITHUB_APP_WEBHOOK_SECRET: 'hook-secret-value',
  };

  test('a server boots with none of it, in production too', () => {
    expect(loadConfig(valid).GITHUB_APP_ID).toBeUndefined();
    expect(() => loadConfig(production)).not.toThrow();
  });

  test('all six are read, the id as a number and the key with its line breaks written out', () => {
    const config = loadConfig({ ...valid, ...app });
    expect([config.GITHUB_APP_ID, config.GITHUB_APP_SLUG]).toEqual([4242, 'purlay-issues']);
  });

  test.each(Object.keys(app))('without %s alone it is refused, never quoting a secret', (left) => {
    const partial = Object.fromEntries(Object.entries(app).filter(([name]) => name !== left));
    const message = refusal({ ...valid, ...partial });
    expect(message).toContain('set all six, or none');
    for (const secret of ['app-secret-value', 'hook-secret-value', 'PRIVATE KEY']) {
      expect(message).not.toContain(secret);
    }
  });

  test('a key this server could not sign with is refused, and a slug that is not GitHub’s', () => {
    expect(refusal({ ...valid, ...app, GITHUB_APP_PRIVATE_KEY: 'not a key' })).toContain(
      'GITHUB_APP_PRIVATE_KEY: is not a PEM private key',
    );
    expect(refusal({ ...valid, ...app, GITHUB_APP_SLUG: 'Not A Slug' })).toContain(
      'GITHUB_APP_SLUG',
    );
  });
});
