/**
 * The Better Auth instance (D-179), behind a factory that takes everything as an argument: it never
 * reads the environment, so a test builds one with a secret of its own and the composition root
 * decides where the real ones come from.
 *
 * Better Auth owns sign-in and sessions; Purlay's tables are what it reads and writes, through the
 * mapping below, so nothing about users, workspaces or messages moves. Every session is resolved
 * through it (`sessions.ts`), and its routes answer under `AUTH_BASE_PATH` (`ingress/http/app.ts`).
 *
 * Two mechanisms of ours keep D-11's property under the library (D-179 §3): the Kysely instance it
 * is handed hashes every `sessions.token_hash` it binds (`sessionTokenHashing`), and
 * `/revoke-other-sessions` is answered by row id (`revoke-other-sessions.ts`), since the built-in
 * one is a silent no-op under the hashing.
 *
 * What GitHub says during a sign-in reaches the columns that are Purlay's own — `github_id`,
 * `github_login`, the names an account GitHub made takes from it (D-38, D-169, D-176) — through a
 * place kept for the one request (`signInRounds`): the library hands its hooks no profile, so the
 * provider's call writes it there and the session hook reads it back (`recordGitHubSignIn`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { hkdfSync } from 'node:crypto';
import {
  betterAuth,
  getCurrentAdapter,
  type BetterAuthOptions,
  type BetterAuthPlugin,
  type InferAPI,
  type OAuth2Tokens,
} from 'better-auth';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import type { OAuthProvider } from '@better-auth/core/oauth2';
import { magicLink } from 'better-auth/plugins/magic-link';
import { twoFactor } from 'better-auth/plugins/two-factor';
import type { GithubOptions, GithubProfile } from 'better-auth/social-providers';
import { runWithTransaction } from '@better-auth/core/context';
import {
  AUTH_BASE_PATH,
  NATIVE_CHALLENGE_PATTERN,
  NATIVE_STATE_PATTERN,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  SIGN_IN_LINK_TTL_MINUTES,
  SIGN_IN_PATH,
  TWO_FACTOR_CHALLENGE_MINUTES,
  TWO_FACTOR_FAILURES_BEFORE_LOCK,
  TWO_FACTOR_LOCK_MINUTES,
  type PasswordOwner,
} from '@purlay/types';
import { isTransaction, sessionTokenDigest, sessionTokenHashing, type Executor } from '@purlay/db';
import { readCapped } from '../../platform/http-body';
import type { Clock } from '../../platform/clock';
import {
  INVITE_COOKIE,
  readCookie,
  SESSION_COOKIE,
  STATE_COOKIE,
  TWO_FACTOR_COOKIE,
} from '../../platform/cookies';
import {
  publication,
  publishAfterCommit,
  publishSessionsEnded,
  type EventBus,
} from '../../platform/events';
import type { Logger } from '../../platform/logging';
import type { Outbox } from '../../platform/mail';
import { randomToken } from '../../platform/tokens';
import type { GitHubProfile } from './github';
import {
  availableUsername,
  cleanedProfile,
  githubDisplayName,
  githubUsernameWanted,
  livingName,
  recordGitHubSignIn,
  shapedUsername,
  usernameFrom,
} from './identity';
import { countAttempt, giveBack, type Attempt } from './password-attempts';
import { revokeOtherSessionsById } from './revoke-other-sessions';
import { linkLetter, type SignInLocale } from './sign-in-letters';
import { heldTransaction, rememberingTransactions } from './sign-up-transaction';
import { consumePassport, passportAllows } from '../workspaces/invitation-passport';
import {
  createOidcProvider,
  OIDC_PROVIDER_ID,
  type OidcCredentials,
  type OidcProfile,
} from './oidc';

/** What the instance reads from the server's own settings, so a change takes a restart, not a deploy. */
export interface AuthSettings {
  readonly github: { readonly clientId: string; readonly clientSecret: string } | undefined;
  /**
   * The organisation's single sign-on provider (D-200): `undefined` is off — nothing is registered, and nothing
   * is sent to anybody. `name` labels the sign-in button; `undefined` is `Single sign-on`.
   */
  readonly oidc: (OidcCredentials & { readonly name: string | undefined }) | undefined;
  readonly signUp: 'invite-only' | 'open';
}

export interface AuthDependencies {
  readonly database: Executor;
  readonly baseUrl: string;
  /** Already derived: see `deriveAuthSecret`. Never the root key, never an editable setting. */
  readonly secret: string;
  /**
   * Where the library's mail goes. Absent on a server with no relay: nothing it does can mail, and
   * signing in by link is not installed at all (D-138 §6).
   */
  readonly mailer?: Outbox | undefined;
  readonly log: Logger;
  readonly settings: AuthSettings;
  /**
   * Where GitHub is (`GITHUB_URL`, `GITHUB_API_URL`): github.com and its API, an Enterprise Server, or
   * a stand-in on this machine. The deployment's, never a setting (D-179).
   */
  readonly githubUrls: GitHubUrls;
  /** How long a session lasts from sign-in, never extended by use (`SESSION_TTL_DAYS`, D-60). */
  readonly sessionTtlDays: number;
  /**
   * Where a session the library ends is announced, so the sockets it holds close as they do for a
   * sign-out of ours (D-85): the node's bus, or one on the same backplane.
   */
  readonly bus: EventBus;
  readonly clock: Clock;
  /** What reaches GitHub; a test passes its own. Unset is the platform's `fetch`. */
  readonly fetch?: GithubFetch;
  /**
   * Whether `schemaProblem` may compare the database with the mapping. On, always, but inside a
   * test's rolled-back transaction: the check refuses a Kysely `Transaction`. A test of its own
   * asserts the check (`better-auth.integration.test.ts`).
   */
  readonly checkSchema?: boolean;
}

/** GitHub's two bases: the site a person authorises on, and the API a sign-in reads them from. */
export interface GitHubUrls {
  /** `https://github.com`: `/login/oauth/authorize` and `/login/oauth/access_token` under it. */
  readonly web: string;
  /** `https://api.github.com`: `/user` and `/user/emails` under it. */
  readonly api: string;
}

/**
 * Every address a GitHub sign-in reaches, from the two bases: one place, so no call is left on the old —
 * the setup's probe of an app included (`modules/setup/probes.ts`).
 */
export const githubEndpoints = (
  urls: GitHubUrls,
): { authorize: string; token: string; user: string; emails: string } => ({
  authorize: `${urls.web}/login/oauth/authorize`,
  token: `${urls.web}/login/oauth/access_token`,
  user: `${urls.api}/user`,
  emails: `${urls.api}/user/emails`,
});

type GitHubEndpoints = ReturnType<typeof githubEndpoints>;

/**
 * What reaches GitHub. `redirect: 'manual'` is required by the type: a redirect is answered, never
 * followed — a `307` or `308` would re-send a body that carries the client secret, to wherever the
 * `Location` points (found in review: the token request went to another origin, and that origin's
 * answer decided the sign-in). A redirect is a reply GitHub does not give these endpoints, and is a
 * failure like any other.
 */
export type GithubFetch = (
  url: string,
  init: {
    readonly method?: 'POST';
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly redirect: 'manual';
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

/** The most of a GitHub reply a sign-in reads: a token, a profile, a list of addresses. */
const GITHUB_REPLY_MAX_BYTES = 64 * 1024;

/**
 * How long GitHub may take to answer any call of a sign-in. The person is waiting on a redirect:
 * past this the sign-in fails, rather than holding a connection open on GitHub's worst day.
 */
const GITHUB_TIMEOUT_MS = 10_000;

/**
 * How long a schema mismatch is answered without looking again. A drifted server is asked by readiness
 * every second; a fresh look is a whole instance of the library. Ten seconds is short beside a
 * migration an operator runs by hand, and the first look after it is the verdict.
 */
const SCHEMA_RECHECK_MS = 10_000;

const SECRET_BYTES = 32;
const SECRET_LABEL = 'purlay:better-auth:secret:v1';

/**
 * The secret Better Auth signs cookies with, derived from `ENCRYPTION_KEY` by HKDF under a label of
 * its own — as the credential cipher and the OAuth state each derive theirs — so a leak of one use
 * is not a leak of the root or of the others. Rotating `ENCRYPTION_KEY` signs everyone out
 * (`CONFIG.md`).
 */
export const deriveAuthSecret = (encryptionKey: string): string =>
  Buffer.from(
    hkdfSync('sha256', Buffer.from(encryptionKey, 'base64'), '', SECRET_LABEL, SECRET_BYTES),
  ).toString('base64');

/**
 * One request through the library, as far as Purlay's own columns care: the GitHub account the
 * provider's call vouched for, and whether the library made an account for it.
 */
interface SignInRound {
  profile: GitHubProfile | undefined;
  /** The single sign-on account a verified token vouched for, as the library keeps it (D-200). */
  oidcAccountId?: string | undefined;
  made: boolean;
  /** The person a request that ends sessions acts for, and the sessions they had before it ran. */
  ending?: { readonly userId: string; readonly sessionIds: readonly string[] };
  /** A change of password: the caller's own session, kept while the person's others end after it. */
  keeping?: { readonly userId: string; readonly sessionId: string } | undefined;
  /** A password weighed in this request, counted until it proves not to have been a wrong guess. */
  attempt?: Attempt | undefined;
  /**
   * Turning two-step verification on or off (D-236): the id of the caller's session, which the library would
   * replace with a new one. Kept, and the new one undone after the request, so the session stays the same row.
   */
  unrotated?: string | undefined;
}

/** Opened around every request the handler serves; nothing outside it can carry a GitHub sign-in. */
const signInRounds = new AsyncLocalStorage<SignInRound>();

interface GithubEmail {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
}

/** C0, DEL and C1: an address carrying one is not an address, and is never repaired (D-38). */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * GitHub failed the sign-in itself — unreachable, refusing, or answering something that is not an
 * identity. Thrown out of the provider's call, which the library does not catch there, so the
 * callback answers `502` and the person is told GitHub did not answer (D-121 §5), never that their
 * account has no address.
 */
const githubUnavailable = (): APIError =>
  new APIError('BAD_GATEWAY', {
    code: 'GITHUB_UNAVAILABLE',
    message: 'GitHub did not answer the sign-in.',
  });

const GITHUB_HEADERS = (accessToken: string | undefined): Record<string, string> => ({
  'User-Agent': 'purlay',
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${accessToken ?? ''}`,
});

/** A GitHub call that failed to arrive at all is GitHub's failure, said once in the log. */
const reach = async (
  get: GithubFetch,
  log: Logger,
  url: string,
  init: Parameters<GithubFetch>[1],
): Promise<Response> => {
  try {
    return await get(url, init);
  } catch (error) {
    log.warn('github sign-in: GitHub could not be reached', { url, err: error });
    throw githubUnavailable();
  }
};

/** A reply's JSON, read no further than `GITHUB_REPLY_MAX_BYTES`; nothing, for one too long or not JSON. */
const jsonOf = async (response: Response): Promise<unknown> => {
  try {
    const body = await readCapped(response, GITHUB_REPLY_MAX_BYTES);
    return 'text' in body ? (JSON.parse(body.text) as unknown) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The code for a token, through the same `fetch` and timeout as the rest of a sign-in. The
 * library's own exchange takes the platform's `fetch` and waits for as long as GitHub does. Any
 * failure is `null`: the library answers it as `invalid_code`, which says GitHub did not take the
 * code — unreachable, refusing, or the code spent — and the person can only start again.
 *
 * **With the PKCE verifier.** The library sends GitHub a `code_challenge` (S256) with every
 * authorization, and GitHub then requires the `code_verifier` it came from with the code
 * (docs.github.com, "Authorizing OAuth apps"): without it every real sign-in is refused, and a code
 * taken from somebody else's authorization could be redeemed here. No verifier, no request.
 */
const exchangeCode =
  (
    credentials: { readonly clientId: string; readonly clientSecret: string },
    tokenUrl: string,
    get: GithubFetch,
    log: Logger,
  ) =>
  async ({
    code,
    codeVerifier,
    redirectURI,
  }: {
    readonly code: string;
    readonly codeVerifier?: string | undefined;
    readonly redirectURI: string;
  }): Promise<OAuth2Tokens | null> => {
    if (codeVerifier === undefined || codeVerifier === '') {
      log.error('github sign-in: the library gave no PKCE verifier for the code');
      return null;
    }
    let response: Response;
    try {
      response = await get(tokenUrl, {
        method: 'POST',
        headers: {
          'User-Agent': 'purlay',
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          code,
          redirect_uri: redirectURI,
          code_verifier: codeVerifier,
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (error) {
      log.warn('github sign-in: the token endpoint could not be reached', { err: error });
      return null;
    }
    const body = await jsonOf(response);
    const token =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['access_token']
        : undefined;
    if (!response.ok || typeof token !== 'string') {
      // GitHub answers 200 with `{"error": …}` for a spent code; only its name goes to the log.
      const githubError =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)['error']
          : undefined;
      log.warn('github sign-in: GitHub gave no token for the code', {
        status: response.status,
        ...(typeof githubError === 'string' ? { githubError: githubError.slice(0, 64) } : {}),
      });
      return null;
    }
    return { accessToken: token, tokenType: 'bearer' };
  };

/**
 * The GitHub provider's token exchange, replaced by `exchangeCode`. A plugin's `init` may hand the
 * context its own values (concepts/plugins); the provider is the library's in every other respect.
 */
const githubExchange = (exchange: ReturnType<typeof exchangeCode>): BetterAuthPlugin => ({
  id: 'purlay-github-exchange',
  init: (context) => ({
    context: {
      socialProviders: context.socialProviders.map((provider) =>
        provider.id === 'github' ? { ...provider, validateAuthorizationCode: exchange } : provider,
      ),
    },
  }),
});

/**
 * Registers the single sign-on provider with the library, beside GitHub's: a plugin's `init` may hand the context
 * its own values, and the library serves `/sign-in/social` and `/callback/:id` for whatever providers it holds.
 */
const oidcRegistration = (provider: OAuthProvider<OidcProfile>): BetterAuthPlugin => ({
  id: 'purlay-oidc',
  init: (context) => ({
    context: { socialProviders: [...context.socialProviders, provider] },
  }),
});

type GithubUserInfo = NonNullable<GithubOptions['getUserInfo']>;

/** The GitHub provider: sign-in by the primary verified address only, never a guessed one. */
const githubOptions = (
  credentials: { readonly clientId: string; readonly clientSecret: string },
  endpoints: GitHubEndpoints,
  database: Executor,
  log: Logger,
  get: GithubFetch,
): GithubOptions => ({
  clientId: credentials.clientId,
  clientSecret: credentials.clientSecret,
  // The provider's own option for where it sends the browser; its default is github.com, written in.
  // Declared by the library's `ProviderOptions` ("Custom authorization endpoint URL … for testing with
  // local OAuth servers"); the provider's documentation page does not list it (1.7.12).
  authorizationEndpoint: endpoints.authorize,
  // Never the provider's own switch: it would refuse a newcomer before the one place that decides who may
  // make an account on an invite-only server — `databaseHooks.user.create.before`, which lets one in on
  // an invitation passport and answers the rest `signup_disabled` (D-179 §5, R51).
  disableSignUp: false,
  // Only the primary address, and only when GitHub says it is verified. The default
  // takes the first address if none is primary, and the profile's public one unchecked.
  // Overriding this skips the library's own `mapProfileToUser`, so the username is made here.
  getUserInfo: async (token): ReturnType<GithubUserInfo> => {
    const headers = GITHUB_HEADERS(token.accessToken);
    const [profileResponse, emailsResponse] = await Promise.all([
      reach(get, log, endpoints.user, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      }),
      reach(get, log, endpoints.emails, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      }),
    ]);
    if (!profileResponse.ok || !emailsResponse.ok) {
      log.warn('github sign-in: profile or addresses not readable', {
        profile: profileResponse.status,
        emails: emailsResponse.status,
      });
      throw githubUnavailable();
    }
    const body = await jsonOf(profileResponse);
    const emails = await jsonOf(emailsResponse);
    const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    if (
      typeof raw['id'] !== 'number' ||
      typeof raw['login'] !== 'string' ||
      !Array.isArray(emails)
    ) {
      log.warn('github sign-in: GitHub answered something that is not an identity');
      throw githubUnavailable();
    }
    const primary = (emails as readonly GithubEmail[]).find(
      (address) =>
        address.primary &&
        address.verified &&
        typeof address.email === 'string' &&
        !CONTROL.test(address.email),
    );
    // No address to anchor the account on: the library answers `unable_to_get_user_info`, which
    // the sign-in screen says as "add or verify a primary address" (D-38).
    if (primary === undefined) return null;

    // Past every refusal: only a sign-in the library will act on needs a round and a name.
    const round = signInRounds.getStore();
    if (round === undefined) {
      // Outside the handler nothing would write the GitHub columns, and an account without its
      // login is refused by `WORKSPACE_CREATORS` for no reason anybody could see (D-169).
      throw new APIError('INTERNAL_SERVER_ERROR', {
        message: 'A GitHub sign-in is served only through the handler.',
      });
    }
    const profile = cleanedProfile({
      id: raw['id'],
      login: raw['login'],
      name: typeof raw['name'] === 'string' ? raw['name'] : null,
      avatarUrl: typeof raw['avatar_url'] === 'string' ? raw['avatar_url'] : null,
    });
    round.profile = profile;
    return {
      user: {
        name: githubDisplayName(profile),
        // Lower-case ASCII at the boundary, as the column compares it (D-40).
        email: primary.email.toLowerCase(),
        ...(profile.avatarUrl === null ? {} : { image: profile.avatarUrl }),
        emailVerified: true,
        // The OAuth path checks required fields before any hook runs; the user hook settles it.
        username: await availableUsername(database, githubUsernameWanted(profile), undefined),
      },
      data: raw as unknown as GithubProfile,
    };
  },
});

/**
 * Whose sessions a request that ends some acts for: the session its cookie names, or — for a password
 * reset, which comes with no session — the person the reset token was issued to. Read with a
 * statement of ours (aliased, so a test can tell it from the library's).
 */
const personEnding = async (
  database: Executor,
  path: string,
  headers: Headers | undefined,
  body: unknown,
): Promise<string | undefined> => {
  if (path === '/reset-password') {
    const token =
      typeof body === 'object' && body !== null
        ? (body as Readonly<Record<string, unknown>>)['token']
        : undefined;
    if (typeof token !== 'string' || token === '') return undefined;
    const row = await database
      .selectFrom('verifications')
      .select('value')
      .where('identifier', '=', `reset-password:${token}`)
      .executeTakeFirst();
    return row?.value;
  }
  return (await callerSession(database, headers))?.userId;
};

/**
 * The session a request's cookie names, as its row: the id and the person. The cookie is the client's
 * and unverified — one that does not decode, or names no row, names nobody. Read with a statement of
 * ours (aliased, so a test can tell it from the library's).
 */
const callerSession = async (
  database: Executor,
  headers: Headers | undefined,
): Promise<{ readonly id: string; readonly userId: string } | undefined> => {
  const cookie = readCookie(headers?.get('cookie') ?? null, SESSION_COOKIE);
  if (cookie === undefined) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(cookie);
  } catch {
    return undefined;
  }
  const [raw = ''] = decoded.split('.');
  const row = await database
    .selectFrom('sessions as sessions_ended')
    .select(['sessions_ended.id', 'sessions_ended.user_id'])
    .where('sessions_ended.token_hash', '=', sessionTokenDigest(raw))
    .executeTakeFirst();
  return row === undefined ? undefined : { id: row.id, userId: row.user_id };
};

/** Every session of the person, by the person: one indexed read, however many they hold. */
const sessionIdsOf = async (database: Executor, userId: string): Promise<string[]> =>
  (
    await database
      .selectFrom('sessions as sessions_ended')
      .select('sessions_ended.id')
      .where('sessions_ended.user_id', '=', userId)
      .execute()
  ).map((row) => row.id);

/** An address in free text: the library's messages and the errors it passes carry them unasked. */
const ADDRESS = /[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[^\s@"'<>(),;:]+/g;

const scrubbed = (text: string): string => text.replace(ADDRESS, '[redacted]');

/**
 * The library's own log lines, through ours (D-78, `ARCHITECTURE.md` §10). It logs at `warn` and
 * above with whatever it holds as arguments — a database error whose detail names an address, the
 * conditions of a query with a user's values, a state — so only its message and the errors among the
 * arguments are kept: each error made legible by our logger (name, message, stack, cause; a driver's
 * `detail` is not among them), and any address in the text replaced. Everything else is counted, not
 * written.
 */
const libraryLogger =
  (log: Logger) =>
  (level: string, message: string, ...args: readonly unknown[]): void => {
    const clean = (error: Error): Error => {
      const copy = new Error(scrubbed(error.message), {
        ...(error.cause instanceof Error ? { cause: clean(error.cause) } : {}),
      });
      copy.name = error.name;
      copy.stack = scrubbed(error.stack ?? '');
      // The driver's code (`23505`) says what failed and names nobody; its `detail` is not copied.
      const code: unknown = 'code' in error ? error.code : undefined;
      return typeof code === 'string' || typeof code === 'number'
        ? Object.assign(copy, { code })
        : copy;
    };
    const kept = args.find((arg): arg is Error => arg instanceof Error);
    const unwritten = args.length - (kept === undefined ? 0 : 1);
    const fields = {
      said: scrubbed(message).slice(0, 200),
      ...(kept === undefined ? {} : { err: clean(kept) }),
      ...(unwritten > 0 ? { unwritten } : {}),
    };
    if (level === 'error') log.error('the sign-in library said', fields);
    else if (level === 'warn') log.warn('the sign-in library said', fields);
    else log.info('the sign-in library said', fields);
  };

/** What an `accounts` row may not carry: the tokens a provider handed over at sign-in. */
const TOKEN_FIELDS: ReadonlySet<string> = new Set([
  'accessToken',
  'refreshToken',
  'idToken',
  'accessTokenExpiresAt',
  'refreshTokenExpiresAt',
]);

const withoutTokens = <T extends object>(account: T): T =>
  Object.fromEntries(
    Object.entries(account).map(([field, value]) => [
      field,
      TOKEN_FIELDS.has(field) ? null : value,
    ]),
  ) as T;

/**
 * The library's routes, read off its endpoint table: literal paths and the patterns with a
 * parameter (`/reset-password/:token`, `/callback/:id`). An endpoint without a path is for callers
 * of the API alone (`setPassword`) and has no route.
 */
const routesOf = (api: Readonly<Record<string, unknown>>): readonly string[] =>
  Object.values(api).flatMap((endpoint) => {
    const path =
      typeof endpoint === 'function' || (typeof endpoint === 'object' && endpoint !== null)
        ? (endpoint as { readonly path?: unknown }).path
        : undefined;
    return typeof path === 'string' ? [path] : [];
  });

/** What a log line names a path under the library's base by when the table has no route for it. */
const LIBRARY_ROUTE_UNKNOWN = `${AUTH_BASE_PATH}/*`;

/**
 * The route of the library's that `pathname` reaches, as its table spells it — a parameter left as
 * `:token`, never as the caller filled it — or `/auth/*` for a path it has no route for: a segment
 * more, a parameter left empty, another case. The answer is always one of the table's strings or
 * the placeholder, so nothing a caller wrote is in it: a path segment is theirs to write, and a
 * reset's token travels in one (D-179 §3, `ARCHITECTURE.md` §10).
 */
const libraryRoute = (routes: readonly string[], pathname: string): string => {
  if (!pathname.startsWith(`${AUTH_BASE_PATH}/`)) return LIBRARY_ROUTE_UNKNOWN;
  const got = pathname.slice(AUTH_BASE_PATH.length).split('/');
  const found = routes.find((route) => {
    const want = route.split('/');
    return (
      want.length === got.length &&
      want.every((segment, at) =>
        segment.startsWith(':') ? (got[at] ?? '') !== '' : segment === got[at],
      )
    );
  });
  return found === undefined ? LIBRARY_ROUTE_UNKNOWN : `${AUTH_BASE_PATH}${found}`;
};

/**
 * The library's routes that end sessions. Each is watched whole — every session the person had
 * before it, read again after it — because the library's own delete hooks see only the rows it read
 * first, at most a hundred (`defaultFindManyLimit`), and a failure of that read is swallowed while the
 * delete goes ahead: past either, sessions were ended and nobody told their sockets (D-85).
 * `/change-password` is not here: it ends nothing itself (`revokeOtherSessions` is forced off, so the
 * caller's own session is never replaced) and the person's others are ended by `endOtherSessions`
 * after it, which tells exactly the ids it deleted.
 */
const ENDING_PATHS: ReadonlySet<string> = new Set([
  '/sign-out',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/reset-password',
]);

/**
 * Routes the library would serve that Purlay has no use for, each one a way in nobody decided on:
 *
 * - `/update-user` would take a `username` from a client (the field is open, below); a profile is
 *   edited through Purlay's own endpoint (D-131).
 * - `/link-social` and `/unlink-account`: an account is joined to GitHub by one verified address
 *   (D-179 §5), never by a request, and an account GitHub made has no other way in to keep (D-176).
 * - `/get-access-token`, `/refresh-token` and `/account-info` hand out or use a provider's token,
 *   and none is ever kept (`withoutTokens`).
 */
const CLOSED_PATHS = [
  '/update-user',
  '/link-social',
  '/unlink-account',
  '/get-access-token',
  '/refresh-token',
  '/account-info',
  // The magic link's own two routes. Asking takes a `name` for the account it makes and decides
  // nothing of who may be sent a link; spending is a `GET`, so a mail scanner that opened the link
  // would sign in and spend it. Both are reached only from Purlay's routes, through the API
  // (`SignInLinks`), which these paths do not close (D-138 §4).
  '/sign-in/magic-link',
  '/magic-link/verify',
  // Routes that weigh a password Purlay does not count: `/verify-password` answers whether a password
  // is the session holder's, so a stolen session would guess the password behind it unthrottled;
  // `/delete-user` takes one too, and an account is erased by Purlay's own route (D-139 §5). Every route
  // of the library's whose path or body names a password is closed here or counted
  // (`password-sign-in.integration.test.ts` reads the endpoint table).
  '/verify-password',
  '/delete-user',
  // Asking for a password reset by mail. Without `sendResetPassword` it refuses anyway; closed, so it is
  // not a route at all. A password is reset on the server (`bun run admin:reset-password`, D-179 §4).
  '/request-password-reset',
  // Routes nothing of Purlay's reaches and that do nothing here: no address is changed or sent a
  // verification by the library (an address is verified by GitHub or by a link of ours), a session
  // carries no data of the library's to update, and the account list is read by our own
  // `GET /api/me/sign-in`.
  '/change-email',
  '/send-verification-email',
  '/verify-email',
  '/update-session',
  '/delete-user/callback',
  '/list-accounts',
  // Two-step verification's routes nothing of Purlay's reaches (D-236): the key is shown once, when it is
  // made, and never read back — `/two-factor/get-totp-uri` would hand it to a stolen session for a password;
  // codes by mail or message are not offered, so their two routes would only answer that they are not.
  '/two-factor/get-totp-uri',
  '/two-factor/send-otp',
  '/two-factor/verify-otp',
];

/** The route through which the library spends a link, as its hooks see it named. */
const LINK_SPEND_PATH = '/magic-link/verify';

/** What a database hook is told of the request it runs for: the route, and the request's headers. */
interface HookContext {
  readonly path?: string | undefined;
  readonly headers?: Headers | undefined;
  readonly request?: { readonly headers: Headers } | undefined;
}

/**
 * On an invite-only server, whether the account a sign-in is about to make may be made (D-179 §5, R51):
 * only with an invitation passport, spent here, in the transaction that makes the account.
 *
 * - **Only the paths a newcomer comes by**: GitHub's callback, whose passport is the `__Host-purlay_invite`
 *   cookie the browser carries back, and the spend of an email link, whose passport is for the address the
 *   account is made for. Anything else that makes an account — the setup's administrator, whose creation
 *   runs outside a request, or a route the library has that Purlay closes — is not decided here.
 * - **The hook's context** is Better Auth's `GenericEndpointContext` of the request the database write is
 *   made for (`database hooks` receive `(data, context)`; `null` outside a request): `path` names the
 *   route and `headers` the request's.
 * - **Refused as the provider's own switch refused**: `signup_disabled`, which the callback maps to
 *   `signup-closed` and a link's spend answers as a link that does not open.
 */
export const admittedByPassport = async (
  deps: Pick<AuthDependencies, 'database' | 'clock'>,
  email: string,
  context: HookContext | null | undefined,
): Promise<void> => {
  const path = context?.path;
  const byEmail = path === LINK_SPEND_PATH;
  const byGitHub = path?.startsWith('/callback/') === true;
  // Fail closed: only a creation outside any request (the setup's administrator) is not decided here.
  // Every request-bound creation that is not one of the two passport paths — a later plugin, provider,
  // idToken path or admin route — is refused, as the provider's own switch refused by default.
  if (context === null || context === undefined) return;
  if (!byEmail && !byGitHub) throw signupClosed();
  const headers = context.headers ?? context.request?.headers;
  const presented = byEmail
    ? { email }
    : { cookie: readCookie(headers?.get('cookie') ?? null, INVITE_COOKIE) };
  // The library's own transaction: the passport is spent with the account, or not at all. Over a test's
  // rolled-back transaction the library opens none, and the database is the transaction already.
  const held = heldTransaction();
  if (held === undefined && !isTransaction(deps.database)) {
    throw new Error('The sign-up ran outside the library transaction the passport is spent in.');
  }
  const executor = held ?? deps.database;
  const id = await passportAllows(executor, deps.clock, presented);
  if (id === undefined || !(await consumePassport(executor, id, deps.clock))) {
    throw signupClosed();
  }
};

/**
 * Whom a provider's account may be added to (D-200 §3, §6), decided where the library makes the row:
 *
 * - **An account has one single sign-on identity.** The library links a callback it does not know to the
 *   account whose address matches, and never asks whether that account already has an identity at the
 *   provider: a new subject carrying a recycled or changed address would be added beside the old one and sign
 *   in as the person who left. The subject decides, not the address — a second subject is refused.
 * - **GitHub is not a way past it.** An account single sign-on is linked to is signed into by it alone, as an
 *   emailed link is refused it (`magic-link.ts`): GitHub is not linked to one by address.
 *
 * Thrown, so the callback answers a reason of the library's (`identity_conflict`) and nothing is written.
 */
const refusedIdentityConflict = async (
  database: Executor,
  account: { readonly userId: string; readonly providerId: string; readonly accountId: string },
): Promise<void> => {
  if (account.providerId !== OIDC_PROVIDER_ID && account.providerId !== 'github') return;
  const held = await database
    .selectFrom('accounts')
    .select('account_id')
    .where('user_id', '=', account.userId)
    .where('provider_id', '=', OIDC_PROVIDER_ID)
    .execute();
  const conflict =
    account.providerId === OIDC_PROVIDER_ID
      ? held.some((row) => row.account_id !== account.accountId)
      : held.length > 0;
  if (conflict) {
    throw new APIError('FORBIDDEN', {
      code: 'identity_conflict',
      message: 'That account signs in another way.',
    });
  }
};

/** Refused as the provider's own switch refused: the callback maps it to `signup-closed`. */
const signupClosed = (): APIError =>
  new APIError('FORBIDDEN', {
    code: 'signup_disabled',
    message: 'Sign-up on this server is by invitation.',
  });

/**
 * Refuses, inside the library, what spending a link would do to an account whose address was never
 * proven: remove every account linked to it — a password among them — end its sessions and mark it
 * verified (`revokeUnprovenAccountAccess`, measured on 1.7.12; D-179 §4). Purlay refuses such a link
 * before the library is asked (`magic-link.ts`); this is the second lock, for whatever reaches it.
 * Thrown, never `false`: a `false` skips one delete and lets the rest of the promotion go on.
 */
const refusedWhileSpendingALink = (context: { readonly path?: string } | null): void => {
  if (context?.path === LINK_SPEND_PATH) {
    throw new APIError('FORBIDDEN', {
      code: 'UNPROVEN_ACCOUNT',
      message: 'A sign-in link does not take over an account whose address was never proven.',
    });
  }
};

/**
 * The library's routes left open that weigh or set a password: an attempt at one is counted
 * (`password-attempts.ts`), a new one is held to the policy. The rest are closed (`CLOSED_PATHS`).
 */
const SIGN_IN_WITH_PASSWORD = '/sign-in/email';
const CHANGE_PASSWORD = '/change-password';
/** The code of the answer to a change of password whose other sessions could not be ended. */
const OTHER_SESSIONS_NOT_ENDED = 'OTHER_SESSIONS_NOT_ENDED';
const RESET_PASSWORD = '/reset-password';

/** Two-step verification's routes (D-236), as the library's hooks see them named. */
const ENABLE_TWO_FACTOR = '/two-factor/enable';
const DISABLE_TWO_FACTOR = '/two-factor/disable';
const NEW_BACKUP_CODES = '/two-factor/generate-backup-codes';
const VERIFY_CODE = '/two-factor/verify-totp';
const VERIFY_BACKUP_CODE = '/two-factor/verify-backup-code';

/**
 * The routes that weigh the password of the person a session names: each attempt counted with the sign-in's
 * wrong guesses for the same address and client (D-179 §4, D-236).
 */
const SESSION_PASSWORD_PATHS: ReadonlySet<string> = new Set([
  CHANGE_PASSWORD,
  ENABLE_TWO_FACTOR,
  DISABLE_TWO_FACTOR,
  NEW_BACKUP_CODES,
]);

/**
 * The routes on which the library replaces the caller's session with a new one: the code that turns two-step
 * verification on, and turning it off. Nothing here needs a new session — no session is cached in a cookie —
 * and a new one would end the old: its sockets told the session ended, the devices push reaches through it
 * gone with its row, its lifetime started again (D-60). So the old one is kept and the new one undone (D-236).
 */
const ROTATING_PATHS: ReadonlySet<string> = new Set([VERIFY_CODE, DISABLE_TWO_FACTOR]);

/** What the library answers a wrong password with, on each route that weighs one: a guess, counted. */
const WRONG_GUESSES: ReadonlySet<string> = new Set([
  'INVALID_EMAIL_OR_PASSWORD',
  'INVALID_PASSWORD',
]);

const fieldOf = (body: unknown, field: string): unknown =>
  typeof body === 'object' && body !== null
    ? (body as Readonly<Record<string, unknown>>)[field]
    : undefined;

/**
 * Whose password a request sets: the person its session cookie names (a change) or its reset token was
 * issued to (a reset), as their address and name — what the policy says a password may not contain.
 */
const ownerSetting = async (
  database: Executor,
  path: string,
  headers: Headers | undefined,
  body: unknown,
): Promise<(PasswordOwner & { readonly id: string }) | undefined> => {
  const userId = await personEnding(database, path, headers, body);
  if (userId === undefined) return undefined;
  const row = await database
    .selectFrom('users')
    .select(['id', 'email', 'display_name'])
    .where('id', '=', userId)
    .executeTakeFirst();
  return row === undefined ? undefined : { id: row.id, email: row.email, name: row.display_name };
};

/**
 * A new password the policy refuses (`passwordProblem`, D-179 §4), on the routes that set one. Its
 * length is the library's to refuse, by the same numbers (`minPasswordLength`, `maxPasswordLength`),
 * with its own codes; the rest is ours. Said to the account's own holder, so the reason is no secret.
 */
const refusedPassword = (password: unknown, owner: PasswordOwner): APIError | undefined => {
  if (typeof password !== 'string') return undefined;
  const problem = passwordProblem(password, owner);
  if (problem === undefined || problem === 'too-short' || problem === 'too-long') return undefined;
  return new APIError('BAD_REQUEST', {
    code: 'PASSWORD_TOO_WEAK',
    message: 'Choose another password: that one is too easy to guess.',
    reason: problem,
  });
};

/**
 * What a client does not choose about two-step verification (D-236), set here whatever it sent: a code from an
 * authenticator app, never another method, under the server's own name (`issuer`); no device trusted to skip
 * the step from then on (`trustDevice`); and no backup code spent without the session it was spent for
 * (`disableSession`). A body that is not an object is left to the library's refusal.
 */
const twoFactorBody = (
  path: string,
  body: unknown,
  issuer: string,
): { context: { body: Record<string, unknown> } } | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const sent = body as Readonly<Record<string, unknown>>;
  // Each field set to a value: the library merges what a hook returns over the body, and skips an undefined.
  if (path === ENABLE_TWO_FACTOR) return { context: { body: { ...sent, method: 'totp', issuer } } };
  if (path === VERIFY_CODE) return { context: { body: { ...sent, trustDevice: false } } };
  if (path === VERIFY_BACKUP_CODE) {
    return { context: { body: { ...sent, trustDevice: false, disableSession: false } } };
  }
  return undefined;
};

/** A unique index refused a write: in a link's spend, a new account another spend made first. */
const uniqueViolation = (error: unknown): boolean => {
  for (let at: unknown = error; at instanceof Error; at = at.cause) {
    if ((at as { readonly code?: unknown }).code === '23505') return true;
  }
  return false;
};

/** What the person who asked for a link said that its message carries: their language, an invitation. */
interface LinkLetter {
  readonly locale: SignInLocale;
  readonly invitation?: string;
  /** The native application's challenge and state, which ride in the link's fragment (D-191). */
  readonly native?: { readonly challenge: string; readonly state: string };
}

/** The language and invitation a link's message was asked with, as the library hands them back. */
const letterOf = (metadata: Readonly<Record<string, unknown>> | undefined): LinkLetter => {
  const invitation = metadata?.['invitation'];
  const native = metadata?.['native'];
  const challenge =
    typeof native === 'object' && native !== null
      ? (native as Readonly<Record<string, unknown>>)['challenge']
      : undefined;
  const state =
    typeof native === 'object' && native !== null
      ? (native as Readonly<Record<string, unknown>>)['state']
      : undefined;
  return {
    locale: metadata?.['locale'] === 'tr' ? 'tr' : 'en',
    // Only a token's shape: nothing an asker wrote reaches the mail (D-138 §4).
    ...(typeof invitation === 'string' && /^[0-9a-f]{64}$/.test(invitation) ? { invitation } : {}),
    // The same, for the pair the application sends: the contract's own patterns, so a value that is not a
    // base64url word never becomes part of an address a person opens.
    ...(typeof challenge === 'string' &&
    typeof state === 'string' &&
    new RegExp(NATIVE_CHALLENGE_PATTERN).test(challenge) &&
    new RegExp(NATIVE_STATE_PATTERN).test(state)
      ? { native: { challenge, state } }
      : {}),
  };
};

/**
 * Signing in by link, as the library does it — the token made, kept as its digest, mailed as Purlay's
 * link, spent once — with only what Purlay asks of it in reach (`magic-link.ts` decides when).
 */
export interface SignInLinks {
  /** Who an address no account has may become: an account, where sign-up is open. */
  readonly signUp: AuthSettings['signUp'];
  /**
   * Whether single sign-on is connected now (D-200 §6): an account it is linked to is signed into by it alone
   * only while it is — disconnected, the account's other ways back in are not closed by a provider that is gone.
   */
  readonly oidc: boolean;
  /** Where the library's mail goes, for the one message about signing in that is not a link. */
  readonly outbox: Outbox;
  /** A link to `email`, made by the library and mailed as `APP_URL/sign-in/email#<token>`. */
  readonly issue: (email: string, letter: LinkLetter) => Promise<void>;
  /**
   * The link spent and a session opened, in one transaction: the session's cookies — or nothing, for a
   * link the library would not spend. A spend that fails leaves the link as it was.
   */
  readonly spend: (token: string, headers: Headers) => Promise<readonly string[] | undefined>;
}

/** The two calls of the magic link's API this file makes, typed as the library types them. */
type LinkApi = InferAPI<ReturnType<typeof magicLink>['endpoints']>;

/**
 * The one header the library reads a client's address from. Ingress always sets it to the address
 * it decided on and drops whatever a client sent under the name, so the library's own default —
 * `X-Forwarded-For`, believed from anybody — never chooses a rate-limit key or a session's address.
 */
export const CLIENT_ADDRESS_HEADER = 'x-purlay-client-address';

/** The library's response, and whether it was a GitHub sign-up lost to the same account made at once. */
export interface AuthAnswer {
  readonly response: Response;
  readonly lostSignUpRace: boolean;
}

/**
 * The library's instance, typed as its own default so a caller sees the options as a whole, not as
 * this literal — and `schemaProblem`, the one question of ours asked of it.
 */
export type Auth = ReturnType<typeof betterAuth> & {
  /**
   * A request through the library, with what Purlay needs to know of a GitHub sign-up it lost: two
   * tabs of the same person made the account at once, the other's committed, and this one's insert
   * lost on a unique index — the account it wanted now exists (D-78). The handler is this, answer
   * only.
   */
  readonly answer: (request: Request) => Promise<AuthAnswer>;
  /**
   * Whether the database is the one the library expects, as its own check sees it, in words — or
   * nothing. See `createAuth` for why the serving instance does not ask it of itself.
   */
  readonly schemaProblem: () => Promise<string | undefined>;
  /**
   * The route of its own that a path under `AUTH_BASE_PATH` reaches, as its endpoint table spells it
   * (`/auth/reset-password/:token`: a parameter as the pattern, never as the caller filled it), or
   * `/auth/*` for a path it has no route for. What a log line names such a path by (D-179 §3).
   */
  readonly routeOf: (pathname: string) => string;
  /** Signing in by link; absent where the server has no relay to mail one (D-138 §6). */
  readonly signInLinks: SignInLinks | undefined;
  /**
   * Whether a GitHub app is connected, so the provider is registered. `signInSocial` throws for a
   * provider it does not have, so what starts a GitHub sign-in asks this first (R38, D-179 §4).
   */
  readonly github: boolean;
  /**
   * The single sign-on provider's button, where one is connected: the name it carries, `undefined` for the
   * default the client words in the person's language (D-200). `undefined` where none is connected, and then
   * `GET /auth/oidc` is the route that does not exist.
   */
  readonly oidc: { readonly name: string | undefined } | undefined;
  /** Who may make an account here: anybody (`open`) or only an invitation's holder (`invite-only`). */
  readonly signUp: AuthSettings['signUp'];
  /**
   * The library's password sign-in (`/sign-in/email`), from a route of ours rather than its handler —
   * the setup signs its administrator in with it (`modules/setup/admin.ts`). The library's answer as a
   * `Response`, its session cookie in it: a session of the library's making, hashed at rest as every
   * other. Counted and throttled as the route is (`password-attempts.ts`); `headers` carry the
   * client's address under `CLIENT_ADDRESS_HEADER`, as ingress sets it.
   */
  readonly passwordSignIn: (email: string, password: string, headers: Headers) => Promise<Response>;
};

export const createAuth = (deps: AuthDependencies): Auth => {
  if (Buffer.byteLength(deps.secret) < SECRET_BYTES) {
    throw new Error(`the auth secret must be at least ${String(SECRET_BYTES)} bytes`);
  }
  const { settings, log, mailer } = deps;
  const get = deps.fetch ?? fetch;
  const endpoints = githubEndpoints(deps.githubUrls);

  /**
   * Every session the library ends, told to the sockets it holds once the end is committed, as our
   * own sign-out does (D-85, #194). Never thrown: the end is already written.
   */
  const sessionsEnded = async (sessionIds: readonly string[]): Promise<void> => {
    // One publication a session: one that fails is logged, and the rest are still told.
    await publishAfterCommit(log, [
      sessionIds.map((sessionId) =>
        publication('SESSION_ENDED', () => publishSessionsEnded(deps.bus, deps.clock, [sessionId])),
      ),
    ]);
  };

  /**
   * After a password changed: every other session of the person ends, in one statement — one
   * transaction — that names the rows it deleted, and exactly those are told to their sockets. Never
   * the caller's own. The password is already changed when this runs, so a failure is not silent: it is
   * written down (redacted) and answered with a typed error that says what is true — the password
   * changed, the other sessions stand — and what to do.
   */
  const endOtherSessions = async (keeping: {
    readonly userId: string;
    readonly sessionId: string;
  }): Promise<void> => {
    let ended: string[];
    try {
      ended = (
        await deps.database
          .deleteFrom('sessions')
          .where('user_id', '=', keeping.userId)
          .where('id', '<>', keeping.sessionId)
          .returning('id')
          .execute()
      ).map((row) => row.id);
    } catch (error) {
      log.error('the password changed but the other sessions could not be ended', { err: error });
      throw new APIError('INTERNAL_SERVER_ERROR', {
        code: OTHER_SESSIONS_NOT_ENDED,
        message:
          'Your password changed, but your other sessions could not be signed out. Use "Sign out everywhere".',
      });
    }
    await sessionsEnded(ended);
  };

  /**
   * After a route on which the library replaces the caller's session (`ROTATING_PATHS`, D-236): the caller's
   * own was kept by the delete hook; the one the library made in its place is deleted by its row — nobody
   * holds it, so nothing is told — and its cookie taken out of the answer, so the browser keeps the session it
   * has. A delete that fails is thrown: the answer would otherwise sign the browser into a session it then
   * loses.
   */
  const sessionUnrotated = async (
    kept: string,
    made: { readonly session: { readonly id: string } } | null,
    answer: Headers | undefined,
  ): Promise<void> => {
    if (made === null || made.session.id === kept) return;
    await deps.database.deleteFrom('sessions').where('id', '=', made.session.id).execute();
    const cookies = answer?.getSetCookie() ?? [];
    answer?.delete('set-cookie');
    for (const line of cookies) {
      if (!line.startsWith(`${SESSION_COOKIE}=`)) answer?.append('set-cookie', line);
    }
  };

  /**
   * Before a route that weighs or sets a password (D-179 §4): a new one held to the policy, and an
   * attempt at the current one counted — refused with `429` and `Retry-After` past the throttle, before
   * the library hashes anything. Turning two-step verification on or off and new backup codes weigh the
   * session holder's password as a change does, and are counted with it (D-236). A change of password
   * always ends the person's other sessions: the
   * library's `revokeOtherSessions`, set here whatever the client sent. Only through a round
   * (`answer`, `passwordSignIn`), which carries the attempt to the hook after; outside one it refuses,
   * so nothing weighs a password uncounted.
   */
  const passwordWeighed = async (
    path: string,
    headers: Headers | undefined,
    body: unknown,
    weighing: SignInRound | undefined,
  ): Promise<{ context: { body: Record<string, unknown> } } | undefined> => {
    if (
      path !== SIGN_IN_WITH_PASSWORD &&
      path !== RESET_PASSWORD &&
      !SESSION_PASSWORD_PATHS.has(path)
    ) {
      return undefined;
    }
    let address: string;
    if (path === SIGN_IN_WITH_PASSWORD) {
      const email = fieldOf(body, 'email');
      const password = fieldOf(body, 'password');
      // Not a guess the library will weigh: its own refusal, before any hashing, and nothing counted.
      if (typeof email !== 'string' || typeof password !== 'string') return undefined;
      if (password.length > PASSWORD_MAX_LENGTH) return undefined;
      // As the library looks the account up.
      address = email.toLowerCase();
    } else {
      const owner = await ownerSetting(deps.database, path, headers, body);
      // Nobody's: the library refuses it as it would — no session, no such reset.
      if (owner === undefined) return undefined;
      const refused = refusedPassword(fieldOf(body, 'newPassword'), owner);
      if (refused !== undefined) throw refused;
      // A reset is weighed by its token, not a password: nothing to count.
      if (path === RESET_PASSWORD) return undefined;
      address = owner.email;
    }
    if (weighing === undefined) {
      throw new APIError('INTERNAL_SERVER_ERROR', {
        message: 'A password is weighed only through the handler.',
      });
    }
    const attempt = await countAttempt(
      deps.database,
      deps.clock,
      address,
      headers?.get(CLIENT_ADDRESS_HEADER) ?? undefined,
    );
    if ('retryAfterSeconds' in attempt) {
      throw new APIError(
        'TOO_MANY_REQUESTS',
        { code: 'RATE_LIMITED', message: 'Too many wrong passwords. Wait, then try again.' },
        { 'Retry-After': String(attempt.retryAfterSeconds) },
      );
    }
    weighing.attempt = attempt;
    return path === CHANGE_PASSWORD
      ? {
          context: {
            body: { ...(body as Readonly<Record<string, unknown>>), revokeOtherSessions: false },
          },
        }
      : undefined;
  };

  /** The name an authenticator app files the key under (D-236): this server's, so two servers' keys differ. */
  const issuer = `Purlay (${new URL(deps.baseUrl).host})`;

  // Built from the settings and connected to nothing: the provider is asked nothing until somebody presses the
  // button (D-200 §2). Unset, there is no provider, no plugin and no route.
  const oidcProvider =
    settings.oidc === undefined
      ? undefined
      : createOidcProvider(settings.oidc, settings.oidc.name ?? 'Single sign-on', {
          fetch: get,
          clock: deps.clock,
          log,
          onIdentity: (accountId): void => {
            const round = signInRounds.getStore();
            if (round !== undefined) round.oidcAccountId = accountId;
          },
        });

  const options: BetterAuthOptions = {
    baseURL: deps.baseUrl,
    basePath: AUTH_BASE_PATH,
    secret: deps.secret,
    telemetry: { enabled: false },
    logger: { level: 'warn', log: libraryLogger(log) },
    // A callback that fails before it knows where to send the person (no state at all) lands on
    // the sign-in screen too; `ingress/http/auth.ts` turns the library's reason into ours (D-121).
    // `throw`: an error that is not one of its own answers is thrown to us, never printed. Left to
    // itself, the library's router writes `# SERVER_ERROR` and the raw error to the console —
    // a driver error's `detail` with it, which names an address — past every redaction of ours
    // (D-78). Its own refusals still come back as its answers; ours log and answer the rest.
    onAPIError: { errorURL: `${deps.baseUrl}${SIGN_IN_PATH}`, throw: true },
    // The instance handed over hashes the session token on every statement on `sessions` (D-11).
    database: {
      db: rememberingTransactions(deps.database.withPlugin(sessionTokenHashing())),
      type: 'postgres',
      // A sign-up, a link's spend, all in one transaction — but for an instance over a test's
      // rolled-back transaction, which is the transaction already: Kysely refuses one inside it.
      transaction: !isTransaction(deps.database),
    },
    advanced: {
      // `__Host-` needs `Secure`, and Better Auth would prefix `__Secure-` in front of it: so it is
      // told not to, and the attribute is set by hand.
      useSecureCookies: false,
      ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
      defaultCookieAttributes: { secure: true },
      cookies: {
        session_token: { name: SESSION_COOKIE },
        // The OAuth state's cookie, `__Host-` like the session's, so a sibling subdomain cannot
        // plant its own and sign the victim into the planter's account (#199, D-62).
        state: { name: STATE_COOKIE },
        // The challenge a right password opens when the account asks for a second step (D-236).
        two_factor: { name: TWO_FACTOR_COOKIE },
      },
      // The library's own check is asked by `schemaProblem`, not by this instance. The library runs it
      // the moment an instance is built and keeps a mismatch for the life of the process: a server
      // that migrates on start builds its instance first, so the check saw the tables before the
      // migration made them, and refused every sign-in until a restart (measured:
      // `migrate-on-start.integration.test.ts`). Asked on a fresh instance once the schema is in,
      // it is a verdict on the database as it is.
      // `joins`: a session and its user are read in one statement. Read as two, a failure of the
      // second is written to the console raw by the library's adapter, which no option quiets.
      database: { generateId: 'uuid', validateSchema: false, joins: true },
    },
    user: {
      modelName: 'users',
      fields: {
        name: 'display_name',
        image: 'avatar_url',
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      additionalFields: {
        // `input: true`, because the OAuth callback drops the fields marked `input: false` from a
        // provider's profile and then fails the sign-in for the missing one (found against the real
        // callback). A value a client manages to send is never stored as sent: the user hook below
        // shapes every username and takes the first free one (R23).
        username: { type: 'string', required: true, input: true, fieldName: 'username' },
        // GitHub's id and login, written by the user hook as the library makes an account from a
        // GitHub sign-in — inside the transaction that makes it, so an account GitHub made is never,
        // even for a moment, one that looks made by email (D-176). `input: false`: no client and no
        // provider profile writes them; `returned: false`: no session payload carries them.
        githubId: {
          type: 'string',
          required: false,
          input: false,
          returned: false,
          fieldName: 'github_id',
        },
        githubLogin: {
          type: 'string',
          required: false,
          input: false,
          returned: false,
          fieldName: 'github_login',
        },
        // Read so the session seam can refuse a soft-deleted account (D-139 §5, ARCHITECTURE.md); never
        // written by the library, and never taken from a client.
        deletedAt: { type: 'date', required: false, input: false, fieldName: 'deleted_at' },
        // Read so neither a sign-in nor the seam lets a suspended account in (D-233); written by the
        // server's administrator alone (`modules/users/suspension.ts`), never by the library or a client.
        suspendedAt: { type: 'date', required: false, input: false, fieldName: 'suspended_at' },
      },
    },
    session: {
      // A fixed lifetime from sign-in, never slid forward by use: what D-60's sessions always were.
      expiresIn: deps.sessionTtlDays * 24 * 60 * 60,
      disableSessionRefresh: true,
      // Off, and said so: a cached session outlives its revocation until the cache expires
      // (concepts/session-management), and D-60 refuses a revoked session on the next request.
      cookieCache: { enabled: false },
      modelName: 'sessions',
      fields: {
        userId: 'user_id',
        token: 'token_hash',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'last_used_at',
      },
    },
    account: {
      modelName: 'accounts',
      fields: {
        userId: 'user_id',
        accountId: 'account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      // An address a provider vouches for links to an existing account only when the local one is
      // verified too; no provider is trusted to skip that. The library's own default is that gate
      // and its option is being removed, so it is not set here.
      accountLinking: { enabled: true },
    },
    verification: {
      modelName: 'verifications',
      fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'rate_limits',
      fields: { lastRequest: 'last_request' },
      // The two routes that weigh a password have one throttle, ours (`password-attempts.ts`): wrong
      // guesses by address and client, a `429` with `Retry-After`. The library's own rule for them —
      // three requests in ten seconds from an address, successes counted, answered with
      // `X-Retry-After` — would be a second limit with another answer.
      customRules: { [SIGN_IN_WITH_PASSWORD]: false, [CHANGE_PASSWORD]: false },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      // The policy's numbers (`@purlay/types`): every route of the library's that takes a password —
      // sign-in, change, reset — refuses outside them before any hashing.
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      // A reset is what someone does when the password is no longer theirs alone: every session the
      // old one opened ends with it (D-179 §3; the library's default keeps them).
      revokeSessionsOnPasswordReset: true,
    },
    disabledPaths: CLOSED_PATHS,
    hooks: {
      // Every session the person had before a request that ends sessions … The watch never stands
      // between a person and signing out: a read of ours that fails is written down and the request
      // goes on, told by the library's own hooks alone.
      before: createAuthMiddleware(async (ctx) => {
        const round = signInRounds.getStore();
        const changed = await passwordWeighed(ctx.path, ctx.headers, ctx.body, round);
        if (round !== undefined && ctx.path === CHANGE_PASSWORD) {
          const caller = await callerSession(deps.database, ctx.headers);
          if (caller !== undefined) round.keeping = { userId: caller.userId, sessionId: caller.id };
        }
        if (round !== undefined && ROTATING_PATHS.has(ctx.path)) {
          const caller = await callerSession(deps.database, ctx.headers);
          if (caller !== undefined) round.unrotated = caller.id;
        }
        if (round !== undefined && ENDING_PATHS.has(ctx.path)) {
          try {
            const userId = await personEnding(deps.database, ctx.path, ctx.headers, ctx.body);
            if (userId !== undefined) {
              round.ending = { userId, sessionIds: await sessionIdsOf(deps.database, userId) };
            }
          } catch (error) {
            log.warn('the sessions a sign-out ends could not be read first', { err: error });
          }
        }
        return changed ?? twoFactorBody(ctx.path, ctx.body, issuer);
      }),
      // … and every one of them gone after it, told — once its transaction has committed, as the
      // request is answered; one rolled back left its rows, and nothing is told. Read again by the
      // person and compared here, never as a list of ids in the statement, so its size is the
      // person's and not a parameter limit's. Never thrown: what it ended is already ended.
      after: createAuthMiddleware(async (ctx) => {
        // A password weighed: counted only if it was wrong. A failure to give it back is written down,
        // and costs the person one guess of their allowance, never the answer they were given.
        const round = signInRounds.getStore();
        const attempt = round?.attempt;
        if (round !== undefined && attempt !== undefined) {
          round.attempt = undefined;
          const returned: unknown = ctx.context.returned;
          const code = isAPIError(returned) ? fieldOf(returned.body, 'code') : undefined;
          if (typeof code !== 'string' || !WRONG_GUESSES.has(code)) {
            try {
              await giveBack(deps.database, deps.clock, attempt);
            } catch (error) {
              log.error('a password attempt that was no wrong guess could not be given back', {
                err: error,
              });
            }
          }
        }
        const keeping = round?.keeping;
        if (round !== undefined && keeping !== undefined) {
          round.keeping = undefined;
          if (!isAPIError(ctx.context.returned)) await endOtherSessions(keeping);
        }
        const unrotated = round?.unrotated;
        if (round !== undefined && unrotated !== undefined) {
          round.unrotated = undefined;
          await sessionUnrotated(unrotated, ctx.context.newSession, ctx.context.responseHeaders);
        }
        const ending = round?.ending;
        if (ending === undefined) return;
        try {
          const left = new Set(await sessionIdsOf(deps.database, ending.userId));
          const gone = ending.sessionIds.filter((id) => !left.has(id));
          await sessionsEnded(gone);
        } catch (error) {
          log.error('the sessions a request ended could not all be told', { err: error });
        }
      }),
    },
    plugins: [
      revokeOtherSessionsById(sessionsEnded),
      // Two-step verification for an account with a password (D-236): a code from an authenticator app after
      // the password, or a backup code. What a client may not choose is set by `twoFactorBody`; the routes
      // that weigh a password are counted (`passwordWeighed`); the session is never replaced (`unrotated`).
      twoFactor({
        issuer,
        schema: {
          user: { fields: { twoFactorEnabled: 'two_factor_enabled' } },
          twoFactor: {
            modelName: 'two_factors',
            fields: {
              userId: 'user_id',
              backupCodes: 'backup_codes',
              failedVerificationCount: 'failed_verification_count',
              lockedUntil: 'locked_until',
            },
          },
        },
        // Sealed under the server's derived secret, as the key is: a copy of the table spends no code.
        backupCodeOptions: { storeBackupCodes: 'encrypted' },
        // The library's own numbers, said here so a change of its defaults is not a change of ours: ten wrong
        // codes in a row at sign-in, across challenges, lock the second step for fifteen minutes.
        accountLockout: {
          enabled: true,
          maxFailedAttempts: TWO_FACTOR_FAILURES_BEFORE_LOCK,
          durationSeconds: TWO_FACTOR_LOCK_MINUTES * 60,
        },
        twoFactorCookieMaxAge: TWO_FACTOR_CHALLENGE_MINUTES * 60,
      }),
      // Sign-in by link, only where there is a relay to send one (D-138 §6). The library's link
      // (`url`, a `GET` to its own route with the token in the query) is never sent: Purlay's page
      // carries the token in its fragment, shows the address, and spends it only on *Sign in*.
      ...(mailer === undefined
        ? []
        : [
            magicLink({
              expiresIn: SIGN_IN_LINK_TTL_MINUTES * 60,
              storeToken: 'hashed',
              // Who a link may make an account for is decided in `fateOf` (`magic-link.ts`), before the
              // library is asked to spend, and held once more by `admittedByPassport` as the account is
              // made: the library's own switch here would refuse an invited address before either.
              disableSignUp: false,
              // Purlay's bearer tokens, one scheme for all (`platform/tokens.ts`): 64 hex digits,
              // the shape the page reads from the fragment.
              generateToken: () => randomToken(),
              sendMagicLink: ({ email, token, metadata }) => {
                const { locale, invitation, native } = letterOf(metadata);
                // `<token>`, then `.<invitation>` if one rode along, then `~<challenge>~<state>` if the native
                // application asked: none of it reaches a server's log (D-138 §4, D-191). `~` is in neither hex
                // nor base64url, so the parts cannot be mistaken for one another.
                const url = `${deps.baseUrl}${SIGN_IN_PATH}/email#${token}${invitation === undefined ? '' : `.${invitation}`}${native === undefined ? '' : `~${native.challenge}~${native.state}`}`;
                mailer.post(linkLetter(email, locale, url), 'sign-in');
                return Promise.resolve();
              },
            }),
          ]),
      ...(oidcProvider === undefined ? [] : [oidcRegistration(oidcProvider.provider)]),
      ...(settings.github === undefined
        ? []
        : [githubExchange(exchangeCode(settings.github, endpoints.token, get, log))]),
    ],
    socialProviders:
      settings.github === undefined
        ? {}
        : {
            github: githubOptions(settings.github, endpoints, deps.database, log, get),
          },
    databaseHooks: {
      // The library has no option to keep a provider's tokens out of `accounts` (`encryptOAuthTokens` only
      // encrypts them), and Purlay never calls GitHub on a person's behalf, so a token kept would be a
      // credential held for nothing. The columns exist because the schema check demands them.
      account: {
        create: {
          before: async (account) => {
            await refusedIdentityConflict(deps.database, account);
            return { data: withoutTokens(account) };
          },
        },
        update: { before: (account) => Promise.resolve({ data: withoutTokens(account) }) },
        delete: {
          before: (_account, context) => {
            refusedWhileSpendingALink(context);
            return Promise.resolve();
          },
        },
      },
      user: {
        // Spending a link updates an account only to mark an unproven address verified, after it has
        // stripped the account: refused, so the transaction the spend runs in undoes all of it.
        update: {
          before: (_user, context) => {
            refusedWhileSpendingALink(context);
            return Promise.resolve();
          },
        },
        create: {
          before: async (user, context) => {
            if (settings.signUp === 'invite-only') {
              await admittedByPassport(deps, user.email, context);
            }
            const supplied: unknown = (user as Readonly<Record<string, unknown>>)['username'];
            // Whatever asked for a name — GitHub's login, a client's body, nothing at all — it is
            // shaped and then the first one free is taken: nobody chooses another person's (R23).
            // Nothing to make a name of: a random one, not `user-1` … `user-99`, which a hundred such
            // addresses would use up for good (D-138 §5).
            const wanted =
              (typeof supplied === 'string' ? shapedUsername(supplied) : null) ??
              usernameFrom(user.email) ??
              `user-${randomToken().slice(0, 6)}`;
            const username = await availableUsername(deps.database, livingName(wanted), undefined);
            const round = signInRounds.getStore();
            const github = round?.profile;
            if (round !== undefined && github !== undefined) round.made = true;
            return {
              data: {
                ...user,
                // An account a link makes is named as its username is (D-138 §5); GitHub's, and the
                // administrator's, come with a name.
                name: (user.name as string | undefined) ? user.name : username,
                username,
                // Whatever a client sent under these names is overwritten: they come from GitHub alone.
                githubId: github === undefined ? null : String(github.id),
                githubLogin: github === undefined ? null : github.login,
              },
            };
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            // A soft-deleted account starts no session, by any sign-in of the library: refused here,
            // where every one of them creates its row (D-139 §5). The seam refuses one that slipped
            // past — a sign-in that committed after an erasure's last delete.
            // Through the library's adapter of the moment, so a sign-up that makes the account and its
            // session in one transaction reads the account it has not committed yet.
            const adapter = await getCurrentAdapter((await instance.$context).adapter);
            const owner = await adapter.findOne<{
              deletedAt?: Date | null;
              suspendedAt?: Date | null;
            }>({
              model: 'user',
              where: [{ field: 'id', value: session.userId }],
              select: ['deletedAt', 'suspendedAt'],
            });
            // No account, one erased, or one suspended (D-233): refused by every way in the library has —
            // GitHub, a password, a link, single sign-on, the second step (D-236). Thrown as the 401 the
            // library answers a refused create with, not `return false`: the second step reads a false as
            // its own failure and answers 500 (#857).
            const refused =
              owner === null ||
              (owner.deletedAt !== null && owner.deletedAt !== undefined) ||
              (owner.suspendedAt !== null && owner.suspendedAt !== undefined);
            if (refused) {
              throw new APIError('UNAUTHORIZED', {
                message: 'Failed to create session',
                code: 'FAILED_TO_CREATE_SESSION',
              });
            }
            // A GitHub sign-in: the columns that are ours, written before its session exists.
            const profile = signInRounds.getStore()?.profile;
            if (profile !== undefined) {
              const identity = await recordGitHubSignIn(deps.database, deps.clock, {
                userId: session.userId,
                profile,
                made: signInRounds.getStore()?.made ?? false,
              });
              // D-38: the account exists under another name than the one GitHub gave.
              if (identity.usernameCollision !== undefined) {
                log.warn('username taken; stored with a suffix', {
                  userId: session.userId,
                  ...identity.usernameCollision,
                });
              }
            }
            return {
              data: {
                ...session,
                // sessions.ip_address is INET, which refuses the empty string Better Auth writes when
                // it has no address to give.
                ipAddress:
                  session.ipAddress === undefined || session.ipAddress === ''
                    ? null
                    : session.ipAddress,
              },
            };
          },
        },
        // Sign-out, a revoke, a change of password with `revokeOtherSessions`, a reset: every row the
        // library deletes, after its transaction commits and never for one rolled back (the library
        // queues these behind the commit; concepts/database).
        delete: {
          // The caller's session the library would replace while turning two-step verification on or off
          // (D-236): kept (returning false skips the delete), and the replacement undone after the request.
          before: (session) => Promise.resolve(signInRounds.getStore()?.unrotated !== session.id),
          after: async (session) => {
            await sessionsEnded([session.id]);
          },
        },
      },
    },
  };
  const instance = betterAuth(options);

  /** Once the schema has passed, it is not asked again: nothing in this process changes it. */
  let passed = false;
  /** The last mismatch, kept a while: building a checker is a whole instance, and readiness asks often. */
  let lastProblem: { readonly at: number; readonly problem: string } | undefined;
  const schemaProblem = async (): Promise<string | undefined> => {
    if (passed || deps.checkSchema === false) return undefined;
    if (
      lastProblem !== undefined &&
      deps.clock.now().getTime() - lastProblem.at < SCHEMA_RECHECK_MS
    ) {
      return lastProblem.problem;
    }
    // A fresh instance, so its check reads the database as it is now; the library keeps the first
    // verdict an instance reaches for good. Its own log stays quiet: the answer is ours to say.
    const checker = betterAuth({
      ...options,
      logger: { disabled: true },
      advanced: {
        ...options.advanced,
        database: { ...options.advanced?.database, validateSchema: true },
      },
    });
    const check = (await checker.$context).checkSchema;
    if (check === undefined) return 'the sign-in library has no schema check for this database';
    try {
      await check();
      passed = true;
      lastProblem = undefined;
      return undefined;
    } catch (error) {
      const problem = `the sign-in library's tables are not what it expects: ${error instanceof Error ? error.message : String(error)}`;
      lastProblem = { at: deps.clock.now().getTime(), problem };
      return problem;
    }
  };

  /**
   * The library answered `unable_to_create_user` for a GitHub sign-in, and the account this round's
   * GitHub id signs in with exists now: another request of the same person made it in the meantime.
   */
  const lostSignUpRace = async (round: SignInRound, response: Response): Promise<boolean> => {
    const location = response.headers.get('location');
    const key =
      round.profile !== undefined
        ? { providerId: 'github', accountId: String(round.profile.id) }
        : round.oidcAccountId !== undefined
          ? { providerId: OIDC_PROVIDER_ID, accountId: round.oidcAccountId }
          : undefined;
    if (key === undefined || location === null) return false;
    if (new URL(location, deps.baseUrl).searchParams.get('error') !== 'unable_to_create_user') {
      return false;
    }
    const won = await deps.database
      .selectFrom('accounts')
      .select('id')
      .where('provider_id', '=', key.providerId)
      .where('account_id', '=', key.accountId)
      .executeTakeFirst();
    return won !== undefined;
  };

  // Each request in a round of its own, so what one GitHub sign-in learnt is never another's.
  const answer = async (request: Request): Promise<AuthAnswer> => {
    const round: SignInRound = { profile: undefined, made: false };
    return await signInRounds.run(round, async () => {
      const response = await instance.handler(request);
      return { response, lostSignUpRace: await lostSignUpRace(round, response) };
    });
  };

  // Read once: the table is the instance's and does not change.
  const routes = routesOf(instance.api);

  const signInLinks = ((): SignInLinks | undefined => {
    if (mailer === undefined) return undefined;
    // The plugin's endpoints, present on the instance because it was installed above; the instance's
    // type is the library's default and does not name them.
    const api = instance.api as unknown as LinkApi;
    return {
      signUp: settings.signUp,
      oidc: settings.oidc !== undefined,
      outbox: mailer,
      issue: async (email, letter): Promise<void> => {
        await api.signInMagicLink({
          body: { email, metadata: { ...letter } },
          headers: new Headers(),
        });
      },
      spend: async (token, headers): Promise<readonly string[] | undefined> => {
        const { adapter } = await instance.$context;
        // Twice at most: a spend that lost a unique index to another made at once — the same new
        // address by its other link, or another new address wanting the same name — was undone
        // whole, its link left as it was, and the second try finds the account or the next name.
        for (let tried = 0; ; tried += 1) {
          try {
            const { headers: answered } = await runWithTransaction(
              adapter,
              async () =>
                await api.magicLinkVerify({ query: { token }, headers, returnHeaders: true }),
            );
            return answered.getSetCookie();
          } catch (error) {
            if (tried === 0 && uniqueViolation(error)) continue;
            // The guard above: something past every check of Purlay's reached it, and is said.
            if (isAPIError(error) && error.body?.code === 'UNPROVEN_ACCOUNT') {
              log.error('a sign-in link reached an account whose address was never proven');
              return undefined;
            }
            // A link the library will not spend — unknown, spent, expired, or an account it may not
            // make — is answered by a redirect carrying its reason, which nobody is sent to.
            if (isAPIError(error) && error.status === 'FOUND') return undefined;
            throw error;
          }
        }
      },
    };
  })();

  return {
    ...instance,
    handler: async (request: Request): Promise<Response> => (await answer(request)).response,
    answer,
    schemaProblem,
    routeOf: (pathname: string): string => libraryRoute(routes, pathname),
    signInLinks,
    github: settings.github !== undefined,
    oidc: settings.oidc === undefined ? undefined : { name: settings.oidc.name },
    signUp: settings.signUp,
    passwordSignIn: async (email, password, headers): Promise<Response> => {
      const round: SignInRound = { profile: undefined, made: false };
      return await signInRounds.run(
        round,
        async () =>
          await instance.api.signInEmail({ body: { email, password }, headers, asResponse: true }),
      );
    },
  };
};
