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
import { createECDH } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
// Side effect: registers the string formats. TypeBox rejects every value for a
// format it does not know — valid ones included — so this is not optional.
import { CONTRACT_VERSION, OIDC_NAME_MAX } from '@purlay/types';
import { oidcIssuerProblem, oidcNameProblem } from './oidc-address';
import { smtpUrlProblem } from './smtp-address';

/**
 * The key the tests and a developer's laptop use. It is public — it is in this
 * repository — so a production that runs on it signs state and encrypts tokens
 * with a key the whole world knows. `loadConfig` refuses it there (#236).
 */
export const DEVELOPMENT_ENCRYPTION_KEY = 'ZGV2ZWxvcG1lbnQtb25seS1rZXktMzItYnl0ZXMhISE=';

/** Where GitHub is, unless the deployment names another: github.com and its API (`CONFIG.md`). */
export const GITHUB_URL_DEFAULT = 'https://github.com';
export const GITHUB_API_URL_DEFAULT = 'https://api.github.com';

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

  /** A seed, read on the first start only, into the server's settings; ignored after (D-179 §6). Both or
   *  neither: neither is a server that waits in setup mode for the wizard to connect GitHub (R38). */
  GITHUB_CLIENT_ID: Type.Optional(Type.String({ minLength: 1 })),
  GITHUB_CLIENT_SECRET: Type.Optional(Type.String({ minLength: 1 })),
  /** A seed, as the GitHub app is (D-200): the OpenID Connect provider single sign-on goes through. The
   *  issuer, the client id and the client secret are all three or none; `OIDC_NAME` is the button's label.
   *  None is single sign-on off, and nothing is sent anywhere. */
  OIDC_ISSUER: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  OIDC_CLIENT_ID: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  OIDC_CLIENT_SECRET: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  OIDC_NAME: Type.Optional(Type.String({ minLength: 1, maxLength: OIDC_NAME_MAX })),
  /** Where a GitHub sign-in is sent and its code redeemed: another for a GitHub Enterprise Server, or
   *  a stand-in on this machine for a run that cannot reach GitHub. Checked in `loadConfig`. */
  GITHUB_URL: Type.String({ minLength: 1, default: GITHUB_URL_DEFAULT }),
  /** GitHub's API, where a sign-in reads the person and their addresses: `…/api/v3` on an Enterprise
   *  Server. Checked as `GITHUB_URL` is. */
  GITHUB_API_URL: Type.String({ minLength: 1, default: GITHUB_API_URL_DEFAULT }),

  /** 32 bytes, base64. The root secret; the OAuth state signing key is derived
   *  from it with domain separation rather than being a second variable (D-62).
   *  Decoded and checked in `loadConfig`: a length says nothing about entropy. */
  ENCRYPTION_KEY: Type.String({ minLength: 44 }),
  SESSION_TTL_DAYS: Type.Integer({ minimum: 1, maximum: 365, default: 30 }),

  /** Who may make a workspace (D-155): GitHub logins, comma-separated, any case; or `*`, anybody
   *  signed in. Unset is nobody but the first person to sign in, while the instance has none — the
   *  one-command install. Signing in stays open: an invited person must be able to. */
  WORKSPACE_CREATORS: Type.Optional(
    Type.String({
      pattern:
        '^\\s*(\\*|[A-Za-z0-9][A-Za-z0-9-]{0,38}(\\s*,\\s*[A-Za-z0-9][A-Za-z0-9-]{0,38})*)\\s*$',
    }),
  ),

  /** The built client this process serves from the one origin (D-61), an absolute path.
   *  Unset means none is served: Vite serves it in development. Opened, and refused
   *  without an `index.html`, by the composition root (`ingress/http/client.ts`). */
  CLIENT_DIST: Type.Optional(Type.String({ minLength: 1 })),

  /** The attachment bucket, S3-compatible — Garage in the deployment (D-16, D-109). All of
   *  them or none: none is a server that refuses every upload, loudly (`storage.ts`), which
   *  production does not start as. */
  S3_ENDPOINT: Type.Optional(Type.String({ format: 'uri' })),
  S3_REGION: Type.String({ minLength: 1, default: 'us-east-1' }),
  S3_BUCKET: Type.Optional(Type.String({ minLength: 1 })),
  S3_ACCESS_KEY_ID: Type.Optional(Type.String({ minLength: 1 })),
  S3_SECRET_ACCESS_KEY: Type.Optional(Type.String({ minLength: 1 })),
  /** A directory attachments are kept in instead of a bucket: development and the browser suite only
   *  (D-117). Production refuses it. */
  STORAGE_DIRECTORY: Type.Optional(Type.String({ minLength: 1 })),

  /** Web Push's application-server keys (RFC 8292, #78): the uncompressed P-256 public point and its
   *  32-byte private scalar, base64url, and who runs it (`mailto:` or `https:`). All three or none:
   *  none is push switched off — the API says so, and the in-app inbox is still the record (D-12).
   */
  VAPID_PUBLIC_KEY: Type.Optional(Type.String({ pattern: '^B[A-Za-z0-9_-]{86}$' })),
  VAPID_PRIVATE_KEY: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' })),
  VAPID_SUBJECT: Type.Optional(
    Type.String({ pattern: '^(mailto:[^\\s@]+@[^\\s@]+|https://\\S+)$' }),
  ),

  /** Where sign-in links are sent from (D-138): an SMTP server, `smtp://` or `smtps://`, with its
   *  credentials, and the address they come from. Both or neither: neither is email sign-in off — the
   *  API says so, and GitHub sign-in is all there is. */
  SMTP_URL: Type.Optional(Type.String({ pattern: '^smtps?://[^\\s]+$' })),
  MAIL_FROM: Type.Optional(Type.String({ format: 'email' })),
  /** Mail to a relay past this machine is sent only over TLS — `smtps://`, or STARTTLS on `smtp://` —
   *  unless this says the link is private (D-138 §6). */
  SMTP_ALLOW_PLAINTEXT: Type.Boolean({ default: false }),

  /** The lowest an installed macOS client may be and still be served (D-186): the wire contract it was
   *  built against, and its version in semantic-version order. Either or both; none is no limit. A
   *  client below either is answered `426 CLIENT_TOO_OLD`, with the download address if one is set.
   *  The contract may not be above the one this server speaks: that would refuse every client. */
  MIN_CLIENT_MACOS_CONTRACT: Type.Optional(Type.Integer({ minimum: 1 })),
  MIN_CLIENT_MACOS_VERSION: Type.Optional(
    Type.String({ pattern: '^\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$' }),
  ),
  /** Where a person is sent for a newer macOS client: shown by the app, so `https://` and nothing else. */
  MACOS_DOWNLOAD_URL: Type.Optional(Type.String({ format: 'uri' })),
});

/**
 * Variables the product read once and reads no longer, each with what replaced it. Set, they are
 * refused rather than ignored: an operator who left one in expects what it used to do, and an
 * ignored variable would never say that it does nothing.
 */
const RETIRED: Readonly<Record<string, string>> = {
  WORKSPACE_OPEN_JOIN_SLUG:
    'retired by D-115: nobody is joined on sign-in any more; an owner or an admin invites people ' +
    'with a link (Invite people… in the workspace menu). Remove the variable.',
};

export type Config = Static<typeof Environment>;

/** Never printed, never logged, never included in an error. (`ARCHITECTURE.md` §10) */
const SECRETS: ReadonlySet<string> = new Set([
  'GITHUB_CLIENT_SECRET',
  'OIDC_CLIENT_SECRET',
  'DATABASE_URL',
  'ENCRYPTION_KEY',
  'S3_SECRET_ACCESS_KEY',
  'VAPID_PRIVATE_KEY',
  'SMTP_URL',
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
  const retired = Object.entries(RETIRED)
    .filter(([key]) => (environment[key] ?? '') !== '')
    .map(([key, why]) => `${key}: ${why}`);
  if (retired.length > 0) throw new ConfigurationError(retired);
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
    // TypeBox yields every rule a path broke — a missing variable is "required" and then "not a
    // string" — so each is named once, with its first reason (#683).
    const first = new Map<string, string>();
    for (const error of Value.Errors(Environment, coerced)) {
      const key = error.path.replace(/^\//, '');
      if (!first.has(key)) first.set(key, error.message);
    }
    const problems = [...first].map(([key, message]) =>
      // The value is never quoted back: a bad DATABASE_URL is still a credential.
      SECRETS.has(key) ? `${key}: ${message} (value withheld)` : `${key}: ${message}`,
    );
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
  const github = githubAddress('GITHUB_URL', loaded.GITHUB_URL);
  const githubApi = githubAddress('GITHUB_API_URL', loaded.GITHUB_API_URL);
  for (const checked of [github, githubApi]) {
    if ('problem' in checked) problems.push(checked.problem);
  }
  const config: Config = {
    ...loaded,
    APP_URL: appUrl.origin,
    ...('address' in github ? { GITHUB_URL: github.address } : {}),
    ...('address' in githubApi ? { GITHUB_API_URL: githubApi.address } : {}),
  };
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

  const storage = [
    config.S3_ENDPOINT,
    config.S3_BUCKET,
    config.S3_ACCESS_KEY_ID,
    config.S3_SECRET_ACCESS_KEY,
  ].filter((value) => value !== undefined).length;
  if (storage !== 0 && storage !== 4) {
    problems.push(
      'S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY: set all four, or none',
    );
  } else if (production && storage === 0) {
    problems.push('S3_ENDPOINT: production refuses to start without the attachment bucket');
  }
  const vapid = [config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY, config.VAPID_SUBJECT].filter(
    (value) => value !== undefined,
  ).length;
  if (vapid !== 0 && vapid !== 3) {
    problems.push('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT: set all three, or none');
  } else if (config.VAPID_PUBLIC_KEY !== undefined && config.VAPID_PRIVATE_KEY !== undefined) {
    problems.push(...vapidProblems(config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY));
  }
  problems.push(...mailProblems(config));
  problems.push(...githubAppProblems(config));
  problems.push(...oidcProblems(config));
  problems.push(...nativeClientProblems(config));
  if (config.STORAGE_DIRECTORY !== undefined) {
    if (production) {
      problems.push(
        'STORAGE_DIRECTORY: production keeps attachments in the bucket, never in a directory (D-117)',
      );
    } else if (storage !== 0) {
      problems.push('STORAGE_DIRECTORY: one store or the other — a directory or the S3 bucket');
    }
  }

  if (problems.length > 0) throw new ConfigurationError(problems);
  return config;
};

/**
 * The macOS minimum (D-186). A contract above the one this server speaks refuses every client there
 * is, and is found by the first person who tries to sign in; a download address that is not `https://`
 * sends a person somewhere a network can rewrite. Both are refused at boot, never quoting the value.
 */
const nativeClientProblems = (config: Config): string[] => {
  const problems: string[] = [];
  if (
    config.MIN_CLIENT_MACOS_CONTRACT !== undefined &&
    config.MIN_CLIENT_MACOS_CONTRACT > CONTRACT_VERSION
  ) {
    problems.push(
      `MIN_CLIENT_MACOS_CONTRACT: this server speaks contract ${String(CONTRACT_VERSION)}; a higher minimum would refuse every client`,
    );
  }
  if (config.MACOS_DOWNLOAD_URL !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(config.MACOS_DOWNLOAD_URL);
    } catch {
      url = undefined;
    }
    if (url?.protocol !== 'https:') {
      problems.push('MACOS_DOWNLOAD_URL: must be an https:// address');
    }
  }
  return problems;
};

/** A host that is this machine, spelled as a URL's hostname spells it. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * One of GitHub's addresses (Ruling R36): `https://`, or `http://` to this machine alone — a stand-in
 * for GitHub run beside the server, as an acceptance run does, which carries the sign-in's code and
 * client secret over nothing but the loopback, in any environment. A path is kept (an Enterprise
 * Server's API is under `/api/v3`), a trailing slash dropped; credentials, a query or a fragment are
 * refused, since each call appends a path to it. Never quotes the value.
 */
const githubAddress = (
  name: string,
  value: string,
): { readonly address: string } | { readonly problem: string } => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: `${name}: not an absolute address` };
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return { problem: `${name}: an address without credentials, query or fragment` };
  }
  const secure = url.protocol === 'https:';
  if (!secure && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    return { problem: `${name}: must be https://, or http:// to this machine` };
  }
  return { address: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
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
 * The two push keys are one pair: the public key is the private key's point. Two halves of
 * different pairs start, are handed to browsers, and have every delivery refused — so it is found
 * here (D-126). Never quotes either value.
 */
/** Sign-in mail (D-138 §6): both or neither. How the connection is held to TLS is the sender's. */
const mailProblems = (config: Config): string[] => {
  if ((config.SMTP_URL === undefined) !== (config.MAIL_FROM === undefined)) {
    return ['SMTP_URL, MAIL_FROM: set both, or neither'];
  }
  // Refused here, before the first start copies it into the settings, where it would stop every
  // start after (D-179 §6). The reason, never the value: it holds a password.
  const problem = config.SMTP_URL === undefined ? undefined : smtpUrlProblem(config.SMTP_URL);
  return problem === undefined ? [] : [`SMTP_URL: ${problem}`];
};

/** The GitHub app (D-179 §6): both variables or neither. Half of one is no app, and is said so. */
const githubAppProblems = (config: Config): string[] =>
  (config.GITHUB_CLIENT_ID === undefined) !== (config.GITHUB_CLIENT_SECRET === undefined)
    ? ['GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET: set both, or neither']
    : [];

/**
 * The single sign-on provider (D-200): the issuer, the client id and the secret are all three or none, the
 * issuer one this server can sign in through, the name one a button can carry. Refused here, before the
 * first start copies it into the settings, where it would stop every start after. Never quotes a value.
 */
const oidcProblems = (config: Config): string[] => {
  const given = [config.OIDC_ISSUER, config.OIDC_CLIENT_ID, config.OIDC_CLIENT_SECRET];
  const problems: string[] = [];
  if (given.some((value) => value === undefined) && given.some((value) => value !== undefined)) {
    problems.push('OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET: set all three, or none');
  } else if (config.OIDC_ISSUER !== undefined) {
    const problem = oidcIssuerProblem(config.OIDC_ISSUER);
    if (problem !== undefined) problems.push(`OIDC_ISSUER: ${problem}`);
  }
  if (config.OIDC_NAME !== undefined && given.every((value) => value === undefined)) {
    // A label with no provider would be dropped at the first start without a word.
    problems.push(
      'OIDC_NAME: set with OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET, or not at all',
    );
  }
  if (config.OIDC_NAME !== undefined) {
    const problem = oidcNameProblem(config.OIDC_NAME, OIDC_NAME_MAX);
    if (problem !== undefined) problems.push(`OIDC_NAME: ${problem}`);
  }
  return problems;
};

const vapidProblems = (publicKey: string, privateKey: string): string[] => {
  // One spelling: the browser hands back the key it was given, and a second spelling of the same
  // bytes would read as a key the operator replaced, re-subscribing every device on every load.
  for (const [name, value] of [
    ['VAPID_PUBLIC_KEY', publicKey],
    ['VAPID_PRIVATE_KEY', privateKey],
  ] as const) {
    if (Buffer.from(value, 'base64url').toString('base64url') !== value) {
      return [`${name}: not canonical base64url; copy it as \`bun run push:keys\` printed it`];
    }
  }
  const pair = createECDH('prime256v1');
  try {
    pair.setPrivateKey(Buffer.from(privateKey, 'base64url'));
  } catch (error) {
    // Refused as a point on the curve: the answer to what is being checked, said as a problem.
    if (error instanceof Error) return ['VAPID_PRIVATE_KEY: not a P-256 private key'];
    throw error;
  }
  return pair.getPublicKey().equals(Buffer.from(publicKey, 'base64url'))
    ? []
    : ['VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: not one pair; generate both together'];
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
