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
 * is `APP_URL` itself (D-61).
 */
import type { Executor } from '@purlay/db';
import type { Config } from '../../platform/config';
import type { Clock } from '../../platform/clock';
import type { GitHubClient } from '../../modules/auth/github';
import type { Logger } from '../../platform/logging';
import type { EventBus } from '../../platform/events';
import {
  beginSignIn,
  completeSignIn as completeSignInFor,
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

export const completeSignIn = async (
  dependencies: AuthDependencies,
  request: Request,
  ipAddress?: string,
): Promise<AuthResponse> => {
  const url = new URL(request.url);
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
