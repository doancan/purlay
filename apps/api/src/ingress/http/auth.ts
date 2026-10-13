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
export const abandonSignIn = (
  { config, log }: Pick<AuthDependencies, 'config' | 'log'>,
  error: unknown,
  code: ErrorCode,
): AuthResponse => {
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
