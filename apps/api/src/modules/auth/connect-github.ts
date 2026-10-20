/**
 * Connecting GitHub to an account made by an email link, from a session signed in as it (D-172).
 *
 * This is the account-takeover surface D-5 and D-138 §3 warned about, so it is deliberate at every
 * step and silent at none:
 *
 * - **Begun only by the person, signed in.** The start is a same-origin `POST` (D-39 §2); the state it
 *   issues names the user and the session that asked, signed under a key of its own (`state.ts`).
 * - **Finished only in that session.** The callback is refused unless the session signed in in this
 *   browser is still the one that asked, and still live as the account is written — a sign-out, or
 *   another person signing in on the same browser between the two halves, ends it.
 * - **Never merged, never moved.** A GitHub account another Purlay account signs in with is refused,
 *   and so is an account that has one already. Nothing about the address is consulted: what is
 *   connected is the GitHub account GitHub vouched for, never one the browser names.
 * - **Nothing else changes.** The address, the username and the display name stay the person's; the
 *   login is held as every GitHub sign-in holds it (D-169 §2), and the picture is GitHub's (D-11).
 *
 * The executor is an argument, so this runs inside a rolled-back transaction in a test (D-46).
 */
import type { MySignIn } from '@purlay/types';
import { sql, type Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import { atomicallyOn } from '../../platform/transactions';
import { madeByGitHub } from './email-sign-in';
import { authorizeUrl, type GitHubClient } from './github';
import { cleanedProfile, holdLogin } from './identity';
import { requireLiveSession, resolveSession } from './sessions';
import { SIGN_IN_CALLBACK, type SignInDependencies } from './sign-in';
import { issueConnectState, verifyConnectState, type ConnectIntent } from './state';

const alreadyConnected = (): AppError =>
  new AppError({
    code: 'GITHUB_ALREADY_CONNECTED',
    message: 'This account has a GitHub account connected already.',
  });

/** The answer whichever way a connect finds its session gone or somebody else's. */
const notThisSession = (): AppError =>
  new AppError({
    code: 'UNAUTHENTICATED',
    message: 'The session that started connecting GitHub is not signed in here any more.',
  });

/**
 * `POST /api/me/github/connect`: the state for GitHub, bound to who asked and from which session. An
 * account that has GitHub already is told so now, before the person is sent anywhere.
 */
export const beginConnect = async (
  { config, clock, database }: Pick<SignInDependencies, 'config' | 'clock' | 'database'>,
  intent: ConnectIntent,
): Promise<{ readonly stateCookieValue: string; readonly redirectTo: string }> => {
  const account = await database
    .selectFrom('users')
    .select('github_id')
    .where('id', '=', intent.userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (account === undefined) throw notThisSession();
  if (account.github_id !== null) throw alreadyConnected();
  const { state, cookieValue } = await issueConnectState(config.ENCRYPTION_KEY, clock, intent);
  return {
    stateCookieValue: cookieValue,
    redirectTo: authorizeUrl(
      {
        clientId: config.GITHUB_CLIENT_ID,
        clientSecret: config.GITHUB_CLIENT_SECRET,
        // The one callback GitHub knows (D-61); the cookie says which handshake it finishes.
        redirectUri: `${config.APP_URL}${SIGN_IN_CALLBACK}`,
      },
      state,
    ),
  };
};

/** What the callback arrived with, for a connect. */
export interface ConnectCallbackInput {
  readonly code: string | undefined;
  readonly returnedState: string | undefined;
  readonly stateCookie: string | undefined;
  /** The session cookie this browser carries now — the one that must still be the one that asked. */
  readonly sessionToken: string | undefined;
}

export interface ConnectDependencies {
  readonly config: SignInDependencies['config'];
  readonly database: Executor;
  readonly clock: Clock;
  readonly github: GitHubClient;
  readonly log: Logger;
}

/**
 * Finishes a connect: the state is this browser's and unexpired, the session that asked is the one
 * signed in here, GitHub vouches for an account, and that account is nobody else's. Answers the
 * workspace to send the person back to.
 */
export const completeConnect = async (
  { config, database, clock, github, log }: ConnectDependencies,
  input: ConnectCallbackInput,
): Promise<ConnectIntent> => {
  const intent = await verifyConnectState(
    config.ENCRYPTION_KEY,
    clock,
    input.stateCookie,
    input.returnedState,
  );
  const code = input.code;
  if (intent === undefined || code === undefined) {
    throw new AppError({
      code: 'OAUTH_STATE_INVALID',
      message: 'That sign-in link is no longer valid. Start again.',
    });
  }
  // Before GitHub is asked anything: a connect whose session is gone has nothing to connect to, and
  // its code is never spent.
  const signedIn =
    input.sessionToken === undefined
      ? undefined
      : await resolveSession(database, clock, input.sessionToken);
  if (signedIn?.sessionId !== intent.sessionId || signedIn.userId !== intent.userId) {
    throw notThisSession();
  }

  const accessToken = await github.exchangeCode(code);
  const profile = cleanedProfile(await github.profile(accessToken));
  const githubId = String(profile.id);

  await atomicallyOn(database)(async (transaction) => {
    // Live until this commits: a sign-out racing the write waits for it, or is seen here (D-85).
    await requireLiveSession(transaction, clock, intent.sessionId);
    // One connect of this GitHub account at a time, so two accounts asking for it at once cannot both
    // find it free; the unique index stands behind it (`errors.ts`).
    await sql`select pg_advisory_xact_lock(hashtextextended(${`github-connect:${githubId}`}, 0))`.execute(
      transaction,
    );
    const account = await transaction
      .selectFrom('users')
      .select(['github_id', 'deleted_at'])
      .where('id', '=', intent.userId)
      .forUpdate()
      .executeTakeFirst();
    if (account?.deleted_at !== null) throw notThisSession();
    if (account.github_id !== null) throw alreadyConnected();
    const owner = await transaction
      .selectFrom('users')
      .select('id')
      .where('github_id', '=', githubId)
      .executeTakeFirst();
    if (owner !== undefined) {
      // Said without either account's id in the words: the person is told it is somebody's, not whose.
      log.warn('GitHub connect refused: the GitHub account is another account’s', {
        userId: intent.userId,
      });
      throw new AppError({
        code: 'GITHUB_ACCOUNT_TAKEN',
        message: 'That GitHub account already signs in to another Purlay account.',
      });
    }
    const now = clock.now();
    await transaction
      .updateTable('users')
      .set({
        github_id: githubId,
        github_connected_at: now,
        avatar_url: profile.avatarUrl,
        updated_at: now,
      })
      .where('id', '=', intent.userId)
      .where('github_id', 'is', null)
      .where('deleted_at', 'is', null)
      .execute();
    await holdLogin(transaction, githubId, profile.login);
  });
  log.info('GitHub connected to an account made by email', {
    userId: intent.userId,
    sessionId: intent.sessionId,
  });
  return intent;
};

/**
 * The ways an account signs in (D-172): its address, whether a link to it signs in — an account made
 * by email, connected or not, and never one GitHub made (D-138 §2) — and its GitHub account, if any.
 */
export const mySignIn = async (executor: Executor, userId: string): Promise<MySignIn> => {
  const row = await executor
    .selectFrom('users')
    .select(['email', 'github_id', 'github_login', 'github_connected_at'])
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined) throw notThisSession();
  return {
    email: row.email,
    emailLinks: !madeByGitHub(row),
    github: row.github_id === null ? null : { login: row.github_login },
  };
};
