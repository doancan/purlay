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
 * The browser talks to one origin, so the callback GitHub is given is
 * `${APP_URL}/auth/github/callback` and the way home is `APP_URL` itself (D-61).
 */
import type { Executor } from '@purlay/db';
import type { Config } from '../../platform/config';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { authorizeUrl, type GitHubClient } from '../../modules/auth/github';
import { resolveIdentity } from '../../modules/auth/identity';
import { sessionTopic, type EventBus } from '../../platform/events';
import { joinOpenWorkspace } from '../../modules/workspaces/open-join';
import { issueState, verifyState } from '../../modules/auth/state';
import {
  issueSession,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from '../../modules/auth/sessions';
import { clearedSessionCookie, sessionCookie, sessionTokenFrom } from './cookies';

const STATE_COOKIE = 'purlay_oauth_state';

/**
 * `Path=/auth` so it is sent to the callback and nowhere else, and a ten-minute
 * `Max-Age` so an abandoned sign-in does not leave one behind.
 */
const stateCookie = (value: string): string =>
  `${STATE_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600`;

const clearedStateCookie = (): string =>
  `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0`;

const cookieFrom = (header: string | null, name: string): string | undefined => {
  if (header === null) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
};

export interface AuthDependencies {
  readonly config: Config;
  readonly database: Executor;
  readonly clock: Clock;
  readonly github: GitHubClient;
}

/** Signing out also reaches the sockets the revoked sessions hold. */
export interface SignOutDependencies extends AuthDependencies {
  readonly bus: EventBus;
}

/**
 * Announces the end of each revoked session on its topic, where every socket it
 * holds is listening — on this node or another. The hub delivers the frame and
 * closes the connection. Published after the revocation is written, so a socket
 * is never closed for a sign-out that did not happen (#194).
 */
const endConnections = async (
  { bus, clock }: SignOutDependencies,
  sessionIds: readonly string[],
): Promise<void> => {
  for (const sessionId of sessionIds) {
    await bus.publish(sessionTopic(sessionId), {
      event: 'SESSION_ENDED',
      data: { reason: 'signed-out' },
      ts: clock.now().getTime(),
    });
  }
};

/** What a handler decided. `location` set means a redirect; otherwise `204`. */
export interface AuthResponse {
  readonly setCookie: string;
  readonly location?: string;
}

export const startSignIn = async (dependencies: AuthDependencies): Promise<AuthResponse> => {
  const { config, clock } = dependencies;
  const { state, cookieValue } = await issueState(config.ENCRYPTION_KEY, clock);
  return {
    setCookie: stateCookie(cookieValue),
    location: authorizeUrl(
      {
        clientId: config.GITHUB_CLIENT_ID,
        clientSecret: config.GITHUB_CLIENT_SECRET,
        redirectUri: `${config.APP_URL}/auth/github/callback`,
      },
      state,
    ),
  };
};

export const completeSignIn = async (
  dependencies: AuthDependencies,
  request: Request,
): Promise<AuthResponse> => {
  const { config, database, clock, github } = dependencies;
  const url = new URL(request.url);
  const code = url.searchParams.get('code') ?? undefined;
  const returned = url.searchParams.get('state') ?? undefined;

  const valid = await verifyState(
    config.ENCRYPTION_KEY,
    clock,
    cookieFrom(request.headers.get('cookie'), STATE_COOKIE),
    returned,
  );
  if (!valid || code === undefined) {
    // One refusal for every way the handshake can be wrong. Telling a prober
    // which part failed describes the check to whoever is testing it.
    throw new AppError({
      code: 'OAUTH_STATE_INVALID',
      message: 'That sign-in link is no longer valid. Start again.',
    });
  }

  const accessToken = await github.exchangeCode(code);
  const [profile, emails] = await Promise.all([
    github.profile(accessToken),
    github.emails(accessToken),
  ]);

  const { userId } = await resolveIdentity(database, clock, profile, emails);
  if (config.WORKSPACE_OPEN_JOIN_SLUG !== undefined) {
    // Every outcome is a success; which one it was is the boot notice's to explain (D-37).
    await joinOpenWorkspace(database, clock, config.WORKSPACE_OPEN_JOIN_SLUG, userId);
  }
  const session = await issueSession(database, clock, userId, config.SESSION_TTL_DAYS, {
    userAgent: request.headers.get('user-agent') ?? undefined,
  });

  return { setCookie: sessionCookie(session), location: config.APP_URL };
};

/** Signing out with no session is not an error: the outcome asked for is already true. */
export const signOut = async (
  dependencies: SignOutDependencies,
  request: Request,
): Promise<AuthResponse> => {
  const token = sessionTokenFrom(request.headers.get('cookie'));
  if (token !== undefined) {
    const revoked = await revokeSession(dependencies.database, dependencies.clock, token);
    if (revoked !== undefined) await endConnections(dependencies, [revoked]);
  }
  return { setCookie: clearedSessionCookie() };
};

/** Signing out *everywhere* needs to know who you are, so it needs a live session. */
export const signOutEverywhere = async (
  dependencies: SignOutDependencies,
  request: Request,
): Promise<AuthResponse> => {
  const { database, clock } = dependencies;
  const token = sessionTokenFrom(request.headers.get('cookie'));
  const owner = token === undefined ? undefined : await resolveSession(database, clock, token);
  if (owner === undefined) {
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in first.' });
  }
  await endConnections(dependencies, await revokeAllSessions(database, clock, owner.userId));
  return { setCookie: clearedSessionCookie() };
};

/** Only for the state cookie's own tests; the name is not part of the contract. */
export const STATE_COOKIE_NAME = STATE_COOKIE;
export { clearedStateCookie };
