/**
 * Sign-in, as functions rather than as routes.
 *
 * Each one takes a request and returns what the response should be. Nothing here
 * knows which framework serves it, which means the whole handshake — including
 * every way it can be refused — is testable without a server, and the routing
 * stays in one file (`app.ts`).
 *
 * It also sidesteps a real constraint rather than fighting it: an application's
 * type is invariant in its routes, so a route group cannot be returned or passed
 * as a bare application, and the library's permissive alias launders `any` into
 * every handler (`docs/spikes/elysia.md`).
 *
 * They read the request, call the module that decides (`modules/auth/sign-in.ts`)
 * and turn its outcome into cookies and a redirect — nothing else. The way home
 * is `APP_URL` itself (D-61), and the way back from a sign-in that did not finish
 * is the sign-in screen with a reason from a closed set (D-121).
 */
import {
  ConnectGitHubRequest,
  EraseAccountRequest,
  connectGitHubHref,
  type ConnectGitHubOutcome,
  type ConnectGitHubResponse,
  type MySignIn,
} from '@purlay/types';
import { beginConnect, completeConnect, mySignIn } from '../../modules/auth/connect-github';
import { connectIntentOf, type ConnectIntent } from '../../modules/auth/state';
import { eraseAccount } from '../../modules/users/erasure';
import {
  publication,
  publishAfterCommit,
  publishUserDeleted,
  publishWorkspaceUpdated,
} from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { validated } from './validate';
import type { Executor } from '@purlay/db';
import { signInFailureHref, type ErrorCode, type SignInFailure } from '@purlay/types';
import type { Config } from '../../platform/config';
import type { Clock } from '../../platform/clock';
import { GitHubUnavailableError, type GitHubClient } from '../../modules/auth/github';
import type { Logger } from '../../platform/logging';
import type { EventBus } from '../../platform/events';
import {
  beginSignIn,
  completeSignIn as completeSignInFor,
  SIGN_IN_CALLBACK,
  signOut as signOutOf,
  signOutEverywhere as signOutEverywhereOf,
} from '../../modules/auth/sign-in';
import { requireSession } from './session';
import {
  clearedSessionCookie,
  clearedStateCookie,
  readCookie,
  sessionCookie,
  sessionTokenFrom,
  stateCookie,
  STATE_COOKIE,
} from '../../platform/cookies';

export interface AuthDependencies {
  readonly config: Config;
  readonly database: Executor;
  readonly clock: Clock;
  readonly github: GitHubClient;
  readonly log: Logger;
}

/** Signing out also reaches the sockets the revoked sessions hold. */
export interface SignOutDependencies extends AuthDependencies {
  readonly bus: EventBus;
}

/** What a handler decided. `location` set means a redirect; otherwise `204`. */
export interface AuthResponse {
  /** Each a separate `Set-Cookie` header. */
  readonly setCookie: readonly string[];
  readonly location?: string;
}

export const startSignIn = async (dependencies: AuthDependencies): Promise<AuthResponse> => {
  const { stateCookieValue, redirectTo } = await beginSignIn(dependencies);
  return { setCookie: [stateCookie(stateCookieValue)], location: redirectTo };
};

/**
 * GitHub's word for *the person pressed Cancel* (RFC 6749 §4.1.2.1). Any other
 * `error` it sends back is a misconfiguration of the OAuth app, not the person's
 * doing.
 */
const DECLINED = 'access_denied';

/** The longest piece of GitHub's `error` the log keeps: it arrived in a URL anyone can write. */
const LOGGED_ERROR_LENGTH = 64;

/** The answer to a sign-in that did not finish: the state spent, and the sign-in screen with why. */
const sentBack = (config: Pick<Config, 'APP_URL'>, failure: SignInFailure): AuthResponse => ({
  setCookie: [clearedStateCookie()],
  location: `${config.APP_URL}${signInFailureHref(failure)}`,
});

/** The answer to a connect that is over, either way: the state spent, and the page it began on. */
const connectSentBack = (
  config: Pick<Config, 'APP_URL'>,
  intent: ConnectIntent,
  outcome: ConnectGitHubOutcome,
): AuthResponse => ({
  setCookie: [clearedStateCookie()],
  location: `${config.APP_URL}${connectGitHubHref(intent.workspace, outcome)}`,
});

/** As `FAILURE_FOR_CODE`, for a connect (D-172): each refusal the person can act on, in words. */
const CONNECT_OUTCOME_FOR_CODE: Readonly<Partial<Record<ErrorCode, ConnectGitHubOutcome>>> = {
  OAUTH_STATE_INVALID: 'expired',
  UNAUTHENTICATED: 'session',
  GITHUB_ACCOUNT_TAKEN: 'taken',
  GITHUB_ALREADY_CONNECTED: 'already',
  RATE_LIMITED: 'busy',
  DATABASE_UNAVAILABLE: 'busy',
};

/**
 * The connect this browser's state cookie was signed for, if it is one — whether or not it is still
 * good. Only where the person is sent back turns on it; whether the connect may finish is
 * `completeConnect`'s to decide, against the state that came back and the session signed in.
 */
const connectIntentIn = async (
  config: Pick<Config, 'ENCRYPTION_KEY'>,
  request: Request,
): Promise<ConnectIntent | undefined> =>
  await connectIntentOf(
    config.ENCRYPTION_KEY,
    readCookie(request.headers.get('cookie'), STATE_COOKIE),
  );

/**
 * The codes the callback can meet that the person can act on. Partial on purpose: any
 * other code reaching the callback is this server's surprise, and the person can only
 * retry — `failed`.
 */
const FAILURE_FOR_CODE: Readonly<Partial<Record<ErrorCode, SignInFailure>>> = {
  OAUTH_STATE_INVALID: 'expired',
  EMAIL_REQUIRED: 'email-required',
  ACCOUNT_EMAIL_CONFLICT: 'email-taken',
  RATE_LIMITED: 'busy',
  DATABASE_UNAVAILABLE: 'busy',
};

/**
 * What the person is told, from what went wrong. The codes come from the one
 * mapping every refusal goes through (`refusalFor`), so a lost race on the email
 * index reads as the conflict it is; GitHub's failures are told apart by type,
 * because they carry no code.
 */
const failureFor = (error: unknown, code: ErrorCode): SignInFailure =>
  error instanceof GitHubUnavailableError
    ? 'github-unavailable'
    : (FAILURE_FOR_CODE[code] ?? 'failed');

/**
 * The callback's answer to anything thrown while serving it, the rate limit
 * included. Never JSON: only a browser GitHub redirected ever arrives here, and a
 * JSON body would be the last thing the person sees (D-121).
 *
 * What the person is not told is written down instead — loudly for the
 * unexpected, as every other `INTERNAL` is, and at `warn` for GitHub, which is
 * somebody else's outage rather than this server's defect.
 */
export const abandonSignIn = async (
  { config, log }: Pick<AuthDependencies, 'config' | 'log'>,
  request: Request,
  error: unknown,
  code: ErrorCode,
): Promise<AuthResponse> => {
  // A connect that did not finish is said on the settings page it began on, not the sign-in screen:
  // the person is signed in, and the sign-in screen would only send them home without a word.
  const intent = await connectIntentIn(config, request);
  if (intent !== undefined) {
    const outcome =
      error instanceof GitHubUnavailableError
        ? 'github-unavailable'
        : (CONNECT_OUTCOME_FOR_CODE[code] ?? 'failed');
    if (outcome === 'github-unavailable') log.warn('GitHub failed a connect', { err: error });
    else if (code === 'INTERNAL')
      log.error('request failed', { err: error, path: SIGN_IN_CALLBACK });
    return connectSentBack(config, intent, outcome);
  }
  const failure = failureFor(error, code);
  if (failure === 'github-unavailable') log.warn('GitHub failed a sign-in', { err: error });
  else if (code === 'INTERNAL') log.error('request failed', { err: error, path: SIGN_IN_CALLBACK });
  return sentBack(config, failure);
};

export const completeSignIn = async (
  dependencies: AuthDependencies,
  request: Request,
  ipAddress?: string,
): Promise<AuthResponse> => {
  const url = new URL(request.url);
  const intent = await connectIntentIn(dependencies.config, request);
  if (intent !== undefined) return await finishConnect(dependencies, request, url, intent);
  // GitHub came back without a code: the person said no, or the OAuth app is
  // misconfigured. There is nothing to verify and nothing to exchange.
  const declined = url.searchParams.get('error');
  if (declined !== null) {
    if (declined === DECLINED) return sentBack(dependencies.config, 'cancelled');
    dependencies.log.warn('GitHub refused a sign-in', {
      githubError: declined.slice(0, LOGGED_ERROR_LENGTH),
    });
    return sentBack(dependencies.config, 'failed');
  }
  const session = await completeSignInFor(dependencies, {
    code: url.searchParams.get('code') ?? undefined,
    returnedState: url.searchParams.get('state') ?? undefined,
    stateCookie: readCookie(request.headers.get('cookie'), STATE_COOKIE),
    userAgent: request.headers.get('user-agent') ?? undefined,
    ipAddress,
  });
  // The state is spent: a callback consumes it, so it cannot be replayed (#199).
  return {
    setCookie: [sessionCookie(session), clearedStateCookie()],
    location: dependencies.config.APP_URL,
  };
};

/**
 * The callback, for a connect this server signed (D-172): GitHub's no is said as one, and anything
 * else is `completeConnect`'s to accept or refuse — a refusal reaches `abandonSignIn` and is said on
 * the same page.
 */
const finishConnect = async (
  dependencies: AuthDependencies,
  request: Request,
  url: URL,
  intent: ConnectIntent,
): Promise<AuthResponse> => {
  const declined = url.searchParams.get('error');
  if (declined !== null) {
    if (declined === DECLINED) return connectSentBack(dependencies.config, intent, 'cancelled');
    dependencies.log.warn('GitHub refused a connect', {
      githubError: declined.slice(0, LOGGED_ERROR_LENGTH),
    });
    return connectSentBack(dependencies.config, intent, 'failed');
  }
  const connected = await completeConnect(dependencies, {
    code: url.searchParams.get('code') ?? undefined,
    returnedState: url.searchParams.get('state') ?? undefined,
    stateCookie: readCookie(request.headers.get('cookie'), STATE_COOKIE),
    sessionToken: sessionTokenFrom(request.headers.get('cookie')),
  });
  return connectSentBack(dependencies.config, connected, 'connected');
};

/** What `POST /api/me/github/connect` answers: where to send the browser, and the state's cookie. */
export interface ConnectStart {
  readonly setCookie: readonly string[];
  readonly body: ConnectGitHubResponse;
}

/**
 * `POST /api/me/github/connect` — from a signed-in session, a same-origin `POST` (D-39 §2): a page on
 * another site can neither make it nor read where it says to go (D-172).
 */
export const startConnectGitHub = async (
  dependencies: AuthDependencies,
  request: Request,
  body: unknown,
): Promise<ConnectStart> => {
  const { userId, sessionId } = await requireSession(
    dependencies.database,
    dependencies.clock,
    request,
  );
  const { workspace } = validated(ConnectGitHubRequest, body);
  const { stateCookieValue, redirectTo } = await beginConnect(dependencies, {
    userId,
    sessionId,
    workspace,
  });
  return { setCookie: [stateCookie(stateCookieValue)], body: { location: redirectTo } };
};

/** `GET /api/me/sign-in` — the ways the caller signs in, their own only (D-172). */
export const readMySignIn = async (
  dependencies: Pick<AuthDependencies, 'database' | 'clock'>,
  request: Request,
): Promise<MySignIn> => {
  const { userId } = await requireSession(dependencies.database, dependencies.clock, request);
  return await mySignIn(dependencies.database, userId);
};

export const signOut = async (
  dependencies: SignOutDependencies,
  request: Request,
): Promise<AuthResponse> => {
  await signOutOf(dependencies, sessionTokenFrom(request.headers.get('cookie')));
  return { setCookie: [clearedSessionCookie()] };
};

/** Signing out *everywhere* needs to know who you are, so it needs a live session. */
export const signOutEverywhere = async (
  dependencies: SignOutDependencies,
  request: Request,
): Promise<AuthResponse> => {
  const { userId } = await requireSession(dependencies.database, dependencies.clock, request);
  await signOutEverywhereOf(dependencies, userId);
  return { setCookie: [clearedSessionCookie()] };
};

/**
 * `POST /api/me/erase` — the person erases their own account (D-139 §5): `204`, the cookie cleared, and
 * after the commit their sockets ended and each workspace they were in told to read its members again.
 */
export const eraseMyAccount = async (
  dependencies: SignOutDependencies,
  request: Request,
  body: unknown,
): Promise<AuthResponse> => {
  const { database, clock, bus } = dependencies;
  const caller = await requireSession(database, clock, request);
  const { confirm } = validated(EraseAccountRequest, body);
  const erased = await atomicallyOn(database)(
    async (transaction) => await eraseAccount(transaction, clock, caller, confirm),
  );
  // Each told on its own: one that fails is logged, and the rest are still told. The person's sockets
  // first — every one, whatever session it holds — then each workspace's members (D-139 §5).
  await publishAfterCommit(dependencies.log, [
    [publication('SESSION_ENDED', () => publishUserDeleted(bus, clock, erased.userId))],
    erased.workspaces.map((workspace) =>
      publication('WORKSPACE_UPDATED', () =>
        publishWorkspaceUpdated(bus, clock, workspace.memberIds, workspace.id),
      ),
    ),
  ]);
  return { setCookie: [clearedSessionCookie()] };
};
