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

export const Environment = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
    {
      default: 'development',
    },
  ),
  PORT: Type.Integer({ minimum: 1, maximum: 65_535, default: 3001 }),

  /** Public origin of the web client. Used for OAuth redirects, CORS, and the
   *  `Origin` check on the socket upgrade that stops cross-site hijacking (D-39). */
  APP_URL: Type.String({ format: 'uri' }),

  LOG_LEVEL: Type.Union(
    [Type.Literal('debug'), Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')],
    { default: 'info' },
  ),
  /** Behind a reverse proxy, so the address recorded on a session is the real one. */
  TRUST_PROXY: Type.Boolean({ default: false }),

  DATABASE_URL: Type.String({ minLength: 1 }),
  DATABASE_POOL_MAX: Type.Integer({ minimum: 1, maximum: 100, default: 10 }),
  DATABASE_SSL: Type.Boolean({ default: false }),

  GITHUB_CLIENT_ID: Type.String({ minLength: 1 }),
  GITHUB_CLIENT_SECRET: Type.String({ minLength: 1 }),

  /** 32 bytes, base64. The root secret; the OAuth state signing key is derived
   *  from it with domain separation rather than being a second variable (D-62). */
  ENCRYPTION_KEY: Type.String({ minLength: 44 }),
  SESSION_TTL_DAYS: Type.Integer({ minimum: 1, maximum: 365, default: 30 }),

  /** Phase 0 has no invitations, so without this a second person cannot join a
   *  workspace and the phase cannot reach its own exit criterion (D-37). */
  WORKSPACE_OPEN_JOIN_SLUG: Type.Optional(Type.String({ minLength: 1 })),

  DEFAULT_LOCALE: Type.Union([Type.Literal('en'), Type.Literal('tr')], { default: 'en' }),
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
  const coerced = Value.Default(Environment, Value.Convert(Environment, present));

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

  // An origin, not a URL. The socket's `Origin` check is an equality against it
  // and the browser sends an origin — no path, no trailing slash — so
  // `https://chat.example.com/` would refuse every connection. A trailing slash
  // means the same place and is dropped; a path, a query or a fragment means a
  // deployment this product does not support — one public origin, cookies at
  // `Path=/` (D-61) — and is refused rather than silently cut off (#200).
  const appUrl = new URL(loaded.APP_URL);
  if (appUrl.pathname !== '/' || appUrl.search !== '' || appUrl.hash !== '') {
    throw new ConfigurationError([
      `APP_URL: must be an origin, without a path, query or fragment (${appUrl.origin})`,
    ]);
  }
  const config: Config = { ...loaded, APP_URL: appUrl.origin };

  if (config.NODE_ENV === 'production' && !config.APP_URL.startsWith('https://')) {
    throw new ConfigurationError(['APP_URL: must be https:// in production']);
  }

  return config;
};
