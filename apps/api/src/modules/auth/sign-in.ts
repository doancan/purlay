/**
 * Signing in and signing out, as the decisions they are.
 *
 * `ingress/http/auth.ts` reads a request, calls one of these and turns the outcome
 * into cookies and a redirect; nothing here knows a request exists (`ARCHITECTURE.md` §4).
 */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import { AppError } from '../../platform/errors';
import { publishSessionsEnded, type EventBus } from '../../platform/events';
import type { Logger } from '../../platform/logging';
import { atomicallyOn } from '../../platform/transactions';
import { authorizeUrl, type GitHubClient } from './github';
import { resolveIdentity } from './identity';
import { revokeAllSessions, revokeSession, issueSession, type IssuedSession } from './sessions';
import { issueState, verifyState } from './state';

export interface SignInDependencies {
  readonly config: Pick<
    Config,
    'APP_URL' | 'ENCRYPTION_KEY' | 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET' | 'SESSION_TTL_DAYS'
  >;
  readonly database: Executor;
  readonly clock: Clock;
  readonly github: GitHubClient;
  readonly log: Logger;
}

/**
 * Where GitHub sends the browser back to. Spelled once: the route serves it, the
 * redirect names it to GitHub, and a failure on it is answered as a redirect
 * rather than JSON, because only a browser ever arrives there (D-121).
 */
export const SIGN_IN_CALLBACK = '/auth/github/callback';

/**
 * The browser talks to one origin, so the callback GitHub is given is
 * `APP_URL` followed by `SIGN_IN_CALLBACK` (D-61).
 */
export const beginSignIn = async ({
  config,
  clock,
}: Pick<SignInDependencies, 'config' | 'clock'>): Promise<{
  readonly stateCookieValue: string;
  readonly redirectTo: string;
}> => {
  const { state, cookieValue } = await issueState(config.ENCRYPTION_KEY, clock);
  return {
    stateCookieValue: cookieValue,
    redirectTo: authorizeUrl(
      {
        clientId: config.GITHUB_CLIENT_ID,
        clientSecret: config.GITHUB_CLIENT_SECRET,
        redirectUri: `${config.APP_URL}${SIGN_IN_CALLBACK}`,
      },
      state,
    ),
  };
};

/** What the callback arrived with. */
export interface CallbackInput {
  readonly code: string | undefined;
  readonly returnedState: string | undefined;
  readonly stateCookie: string | undefined;
  readonly userAgent: string | undefined;
  readonly ipAddress: string | undefined;
}

export const completeSignIn = async (
  dependencies: SignInDependencies,
  input: CallbackInput,
): Promise<IssuedSession> => {
  const { config, database, clock, github } = dependencies;
  const valid = await verifyState(
    config.ENCRYPTION_KEY,
    clock,
    input.stateCookie,
    input.returnedState,
  );
  const code = input.code;
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

  // One boundary for the account and the session: a failure on either leaves no half-made
  // account to trip the next attempt.
  const { userId, usernameCollision, session } = await atomicallyOn(database)(
    async (transaction) => {
      const identity = await resolveIdentity(transaction, clock, profile, emails);
      const issued = await issueSession(
        transaction,
        clock,
        identity.userId,
        config.SESSION_TTL_DAYS,
        { userAgent: input.userAgent, ipAddress: input.ipAddress },
      );
      return { ...identity, session: issued };
    },
  );
  if (usernameCollision !== undefined) {
    // D-38: the account exists under another name than the one GitHub gave, and
    // somebody may need to know why.
    dependencies.log.warn('username taken; stored with a suffix', { userId, ...usernameCollision });
  }
  return session;
};

/** Signing out also reaches the sockets the revoked sessions hold. */
export interface SignOutDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly bus: EventBus;
}

/**
 * Revokes the session behind this token, if any. Signing out with no session is
 * not an error: the outcome asked for is already true.
 */
export const signOut = async (
  { database, clock, bus }: SignOutDependencies,
  token: string | undefined,
): Promise<void> => {
  if (token === undefined) return;
  const revoked = await revokeSession(database, clock, token);
  // After the revocation is written, so a socket is never closed for a sign-out
  // that did not happen (#194).
  if (revoked !== undefined) await publishSessionsEnded(bus, clock, [revoked]);
};

/** Signing out *everywhere* knows whose sessions to end, so it takes the owner. */
export const signOutEverywhere = async (
  { database, clock, bus }: SignOutDependencies,
  userId: string,
): Promise<void> => {
  await publishSessionsEnded(bus, clock, await revokeAllSessions(database, clock, userId));
};
