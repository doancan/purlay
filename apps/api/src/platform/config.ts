/**
 * Configuration, validated at boot.
 *
 * A missing secret must fail at startup, never at 3am on the first request that
 * needs it (`CONFIG.md`). So this refuses to produce a configuration object at
 * all unless every variable it reads is present and well-formed — and it reports
 * **every** problem at once, because fixing them one restart at a time is how a
 * first deployment becomes an afternoon.
 *
 * **A variable is read here when the feature that needs it is built.** Requiring
 * a secret nobody uses yet would work against D-37, which exists to make the
 * walking skeleton reachable. `CONFIG.md` publishes the whole set; this is the
 * part the application reads today, and a test checks it is a subset.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
// Side effect: registers the string formats. TypeBox rejects every value for a
// format it does not know — valid ones included — so this is not optional.
import '@purlay/types';

/**
 * The key the tests and a developer's laptop use. It is public — it is in this
 * repository — so a production that runs on it signs state and encrypts tokens
 * with a key the whole world knows. `loadConfig` refuses it there (#236).
 */
export const DEVELOPMENT_ENCRYPTION_KEY = 'ZGV2ZWxvcG1lbnQtb25seS1rZXktMzItYnl0ZXMhISE=';

export const Environment = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
    {
      default: 'development',
    },
  ),
  PORT: Type.Integer({ minimum: 1, maximum: 65_535, default: 3001 }),

  /** How much the structured log writes (#127). */
  LOG_LEVEL: Type.Union(
    [Type.Literal('debug'), Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')],
    { default: 'info' },
  ),

  /** The one public origin (D-61): the OAuth callback, and the `Origin` check on
   *  the socket upgrade that stops cross-site hijacking (D-39). There is no CORS. */
  APP_URL: Type.String({ format: 'uri' }),

  /** Behind exactly one reverse proxy that sets `X-Forwarded-For`. Without it the
   *  socket's peer is the client and the header is ignored — anyone can write it. */
  TRUST_PROXY: Type.Boolean({ default: false }),

  DATABASE_URL: Type.String({ minLength: 1 }),
  DATABASE_POOL_MAX: Type.Integer({ minimum: 1, maximum: 100, default: 10 }),
  DATABASE_SSL: Type.Boolean({ default: false }),
  /** Production refuses a database connection without TLS unless this says the
   *  operator knows: a database on the same private network, say (#236). */
  DATABASE_ALLOW_PLAINTEXT: Type.Boolean({ default: false }),
  /** A PEM file to trust instead of the system roots, for a private or managed CA (D-92). */
  DATABASE_SSL_CA_FILE: Type.Optional(Type.String({ minLength: 1 })),

  /** Apply pending migrations when the process starts. Several nodes starting together
   *  are serialised by the migrator's own lock (D-93). Unset is off: a developer's
   *  `dev:api` should not rewrite a database by being started. Optional rather than
   *  defaulted so the test configuration needs no new field. */
  MIGRATE_ON_START: Type.Optional(Type.Boolean()),

  /** Where `error`-level lines are also reported, as a Sentry-compatible DSN. Unset
   *  means off and nothing leaves the process; there is no default (D-44, D-96). */
  ERROR_TRACKING_DSN: Type.Optional(Type.String({ minLength: 1 })),

  GITHUB_CLIENT_ID: Type.String({ minLength: 1 }),
  GITHUB_CLIENT_SECRET: Type.String({ minLength: 1 }),

  /** 32 bytes, base64. The root secret; the OAuth state signing key is derived
   *  from it with domain separation rather than being a second variable (D-62).
   *  Decoded and checked in `loadConfig`: a length says nothing about entropy. */
  ENCRYPTION_KEY: Type.String({ minLength: 44 }),
  SESSION_TTL_DAYS: Type.Integer({ minimum: 1, maximum: 365, default: 30 }),

  /** The built client this process serves from the one origin (D-61), an absolute path.
   *  Unset means none is served: Vite serves it in development. Opened, and refused
   *  without an `index.html`, by the composition root (`ingress/http/client.ts`). */
  CLIENT_DIST: Type.Optional(Type.String({ minLength: 1 })),

  /** Phase 0 has no invitations, so without this a second person cannot join a
   *  workspace and the phase cannot reach its own exit criterion (D-37). */
  WORKSPACE_OPEN_JOIN_SLUG: Type.Optional(Type.String({ minLength: 1 })),
});

export type Config = Static<typeof Environment>;

/** Never printed, never logged, never included in an error. (`ARCHITECTURE.md` §10) */
const SECRETS: ReadonlySet<string> = new Set([
  'GITHUB_CLIENT_SECRET',
  'DATABASE_URL',
  'ENCRYPTION_KEY',
]);

/** The variables this application reads. `.env.example` is generated from it. */
export const CONFIGURED: readonly string[] = Object.keys(Environment.properties);

/** The variables declared as integers, read from the schema so a new one is covered. */
const INTEGERS: readonly string[] = Object.entries(Environment.properties)
  .filter(([, schema]) => Reflect.get(schema, 'type') === 'integer')
  .map(([key]) => key);

export class ConfigurationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`configuration is invalid:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigurationError';
    this.problems = problems;
  }
}

/**
 * Reads the environment and either returns a configuration or refuses.
 *
 * Takes the environment as an argument rather than reaching for `process.env`,
 * so it can be tested without one — the same reason services take their executor
 * as an argument (D-46).
 */
export const loadConfig = (environment: Record<string, string | undefined>): Config => {
  const present: Record<string, unknown> = {};
  for (const key of CONFIGURED) {
    const raw = environment[key];
    if (raw !== undefined && raw !== '') present[key] = raw;
  }

  // Convert strings to the declared types before checking, so `PORT=3001` is an
  // integer rather than a failure to be an integer.
  const conversion = Value.Convert(Environment, present);
  const converted: Record<string, unknown> =
    typeof conversion === 'object' && conversion !== null ? { ...conversion } : {};
  // Conversion truncates `1.5` to `1`, so `SESSION_TTL_DAYS=1.5` would be a day and
  // say nothing. An integer is written as digits; anything else stays a string and
  // fails the check below, naming the variable.
  for (const key of INTEGERS) {
    // From the environment: `Convert` rewrites `present` in place.
    const raw = environment[key];
    if (raw !== undefined && raw !== '' && !/^-?\d+$/.test(raw)) converted[key] = raw;
  }
  const coerced = Value.Default(Environment, converted);

  if (!Value.Check(Environment, coerced)) {
    const problems = [...Value.Errors(Environment, coerced)].map((error) => {
      const key = error.path.replace(/^\//, '');
      // The value is never quoted back: a bad DATABASE_URL is still a credential.
      return SECRETS.has(key)
        ? `${key}: ${error.message} (value withheld)`
        : `${key}: ${error.message}`;
    });
    throw new ConfigurationError(problems);
  }

  const loaded = coerced satisfies Config;
  const problems: string[] = [];

  // An origin, not a URL. The socket's `Origin` check is an equality against it
  // and the browser sends an origin — no path, no trailing slash — so
  // `https://chat.example.com/` would refuse every connection. A trailing slash
  // means the same place and is dropped; a path, a query or a fragment means a
  // deployment this product does not support — one public origin, cookies at
  // `Path=/` (D-61) — and is refused rather than silently cut off (#200).
  const appUrl = new URL(loaded.APP_URL);
  if (appUrl.protocol !== 'http:' && appUrl.protocol !== 'https:') {
    problems.push('APP_URL: the scheme must be http or https');
  } else if (appUrl.pathname !== '/' || appUrl.search !== '' || appUrl.hash !== '') {
    problems.push(
      `APP_URL: must be an origin, without a path, query or fragment (${appUrl.origin})`,
    );
  }
  const config: Config = { ...loaded, APP_URL: appUrl.origin };
  const production = config.NODE_ENV === 'production';

  if (production && appUrl.protocol !== 'https:') {
    problems.push('APP_URL: must be https:// in production');
  }

  if (config.DATABASE_SSL_CA_FILE !== undefined && !config.DATABASE_SSL) {
    problems.push('DATABASE_SSL_CA_FILE: needs DATABASE_SSL=true');
  }

  problems.push(...keyProblems(config.ENCRYPTION_KEY, production));

  if (production && !config.DATABASE_SSL && !config.DATABASE_ALLOW_PLAINTEXT) {
    problems.push(
      'DATABASE_SSL: production refuses a database connection without TLS; set it to true, ' +
        'or set DATABASE_ALLOW_PLAINTEXT=true to say the link is private',
    );
  }

  if (problems.length > 0) throw new ConfigurationError(problems);
  return config;
};

/** Fewer distinct bytes than this is not a CSPRNG's output. Measured: 2,000,000 random
 *  keys had at least 22 distinct bytes; the chance of one below 16 is under 1 in 10^12. */
const MIN_DISTINCT_BYTES = 16;

/** The longest pattern whose repetition is called out; a random key repeats none. */
const MAX_PERIOD = 16;

/** True when the bytes are a short pattern repeated, e.g. `abcd` thirty-two bytes long. */
const isPeriodic = (bytes: Buffer): boolean => {
  for (let period = 1; period <= MAX_PERIOD; period += 1) {
    if (bytes.every((byte, i) => i < period || byte === bytes[i - period])) return true;
  }
  return false;
};

/** True when each byte is the last plus a constant (mod 256): 0..31, 31..0, every seventh. */
const isSequence = (bytes: Buffer): boolean => {
  const step = ((bytes[1] ?? 0) - (bytes[0] ?? 0) + 256) % 256;
  return bytes.every((byte, i) => i === 0 || byte === (((bytes[i - 1] ?? 0) + step) & 255));
};

/**
 * What a key must also be. Never quotes the value.
 *
 * A length check accepts 44 repeated letters; this decodes. The spelling must be
 * canonical (decode then encode gives back the input): the last base64 character
 * carries two bits decoding drops, so `...E=` and `...F=` are one key, and a
 * comparison of strings would call the second one different from the public
 * development key. The development key is compared as bytes for the same reason.
 */
const keyProblems = (key: string, production: boolean): string[] => {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) {
    return ['ENCRYPTION_KEY: must be 32 bytes encoded as base64 (44 characters)'];
  }
  const bytes = Buffer.from(key, 'base64');
  if (bytes.length !== 32) return ['ENCRYPTION_KEY: must decode to exactly 32 bytes'];
  if (bytes.toString('base64') !== key) {
    return ['ENCRYPTION_KEY: must be canonical base64, as `openssl rand -base64 32` writes it'];
  }
  if (new Set(bytes).size < MIN_DISTINCT_BYTES || isPeriodic(bytes) || isSequence(bytes)) {
    return ['ENCRYPTION_KEY: looks like a pattern, not random bytes; generate it with a CSPRNG'];
  }
  if (production && bytes.equals(Buffer.from(DEVELOPMENT_ENCRYPTION_KEY, 'base64'))) {
    return ['ENCRYPTION_KEY: production refuses the development key, which is public'];
  }
  return [];
};
