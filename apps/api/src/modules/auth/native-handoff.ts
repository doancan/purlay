/**
 * Handing a signed-in person's session to the native application (D-191).
 *
 * The browser session is a cookie, and an application is not a browser: it cannot read one, and a
 * second way to sign in — a form of its own — would be a second place for identity to be decided
 * (D-179). So the person signs in where sign-in already is, in the system browser, and the server
 * gives the application a session of its own by a one-time code:
 *
 * 1. **Made** while the person is signed in and has said yes (`authorizeNative`): 32 random bytes, of
 *    which only the SHA-256 is kept, bound to a *challenge* — the SHA-256 of a verifier the application
 *    made and has not sent.
 * 2. **Spent** by the application, with the verifier (`exchangeNativeCode`): a session is minted for the
 *    person who authorised, as any other session is, and the code is spent by the same transaction.
 *
 * What each rule is for:
 *
 * - **The verifier**, because the code travels in a URL on the person's own machine, where a log, a
 *   screen share or another application registered for the scheme may read it. A code is of no use
 *   without the secret that never left the application that started the flow.
 * - **One answer** for a code that does not exist, one that is spent or expired or burnt, one whose
 *   person has been erased, and a wrong verifier: `undefined`. Nothing a caller sees tells them which
 *   (the stance of `SIGN_IN_LINK_NOT_FOUND`, D-138).
 * - **A wrong guess does not burn the code** until the fifth, and it is counted although it is refused
 *   (the transaction commits with the count). A code someone else has seen must not be a way to take
 *   it from the person it was made for; five guesses at a 256-bit value is what a stranger gets.
 * - **A spent code mints nothing and ends nothing.** A second spend, with whatever verifier, is the
 *   same refusal. It does not revoke the session the first one made: an application that sent the
 *   request twice (a retry racing its own answer) must not lose the sign-in it just made, and without
 *   the verifier nobody else could have made a second one.
 * - **At most five live per person**, the oldest making room (never a refusal, so a retry never locks
 *   anyone out), counted under a lock on the person's row so two requests at once cannot both take the
 *   sixth.
 * - **Two minutes**, on the server's clock. The application's clock decides nothing.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { randomToken, tokenDigest } from '../../platform/tokens';
import { atomicallyOn } from '../../platform/transactions';
import { issueSession, type IssuedSession, type IssueOptions } from './sessions';

/** How long a code lasts: long enough to go from the browser to the application, and no longer. */
export const NATIVE_CODE_TTL_MS = 2 * 60 * 1000;

/** How many unspent, unexpired codes one person may have at once. */
export const NATIVE_LIVE_CODES_PER_USER = 5;

/** How many wrong verifiers a code takes before it is burnt. */
export const NATIVE_WRONG_VERIFIERS_MAX = 5;

/** What a verifier is the digest of, as an application must compute it: SHA-256, base64url, no padding. */
const nativeChallengeOf = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

const sameChallenge = (stored: string, supplied: string): boolean => {
  const a = Buffer.from(stored);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * A code for this person, bound to the application's `challenge` (the caller has checked its shape).
 * The code is returned this once and never stored.
 */
export const authorizeNative = async (
  database: Executor,
  clock: Clock,
  { userId, challenge }: { readonly userId: string; readonly challenge: string },
): Promise<{ readonly code: string }> => {
  const code = randomToken();
  const digest = await tokenDigest(code);
  const now = clock.now();
  await atomicallyOn(database)(async (transaction) => {
    // The one lock every authorisation of this person is made under. `FOR NO KEY UPDATE` is compatible
    // with the key share the insert below takes on the same row, so it never waits on itself.
    await transaction
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const live = await transaction
      .selectFrom('native_authorizations')
      .select('id')
      .where('user_id', '=', userId)
      .where('spent_at', 'is', null)
      .where('expires_at', '>', now)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    // The newest four stay, and the one made now is the fifth.
    const makingRoom = live.slice(NATIVE_LIVE_CODES_PER_USER - 1).map((row) => row.id);
    if (makingRoom.length > 0) {
      await transaction.deleteFrom('native_authorizations').where('id', 'in', makingRoom).execute();
    }
    await transaction
      .insertInto('native_authorizations')
      .values({
        id: messageId(now),
        user_id: userId,
        code_digest: digest,
        challenge,
        created_at: now,
        expires_at: new Date(now.getTime() + NATIVE_CODE_TTL_MS),
      })
      .execute();
  });
  return { code };
};

/** What a session is minted with: the secret it is signed under and how long it lasts. */
export interface NativeSessionTerms {
  readonly secret: string;
  readonly sessionTtlDays: number;
}

/**
 * Spends a code for a session, or says nothing: `undefined` is every way it can fail, and is the same
 * for each. Infrastructure that fails — the database is down — is thrown, never read as a refusal.
 */
export const exchangeNativeCode = async (
  database: Executor,
  clock: Clock,
  terms: NativeSessionTerms,
  {
    code,
    verifier,
    userAgent,
    ipAddress,
  }: {
    readonly code: string;
    readonly verifier: string;
  } & IssueOptions,
): Promise<IssuedSession | undefined> => {
  // Before anything is looked up, so a code that does not exist costs the same hash as one that does.
  const supplied = nativeChallengeOf(verifier);
  const digest = await tokenDigest(code);
  const now = clock.now();

  return await atomicallyOn(database)(async (transaction) => {
    // Held to the end: of two spends of one code the second waits here, finds it spent and is refused.
    const found = await transaction
      .selectFrom('native_authorizations')
      .innerJoin('users', 'users.id', 'native_authorizations.user_id')
      .select([
        'native_authorizations.id',
        'native_authorizations.user_id',
        'native_authorizations.challenge',
        'native_authorizations.wrong_verifiers',
        'native_authorizations.expires_at',
        'native_authorizations.spent_at',
        'users.deleted_at',
      ])
      .where('native_authorizations.code_digest', '=', digest)
      .forUpdate(['native_authorizations'])
      .executeTakeFirst();
    if (found === undefined) return undefined;

    // Spent, expired, burnt, or its person erased: nothing is counted and nothing is made.
    const live =
      found.spent_at === null &&
      found.expires_at.getTime() > now.getTime() &&
      found.deleted_at === null;
    if (!live) return undefined;

    if (!sameChallenge(found.challenge, supplied)) {
      const wrong = found.wrong_verifiers + 1;
      // Committed with the refusal: a guess that rolled back with its own answer could be made forever.
      await transaction
        .updateTable('native_authorizations')
        .set({
          wrong_verifiers: wrong,
          ...(wrong >= NATIVE_WRONG_VERIFIERS_MAX ? { expires_at: now } : {}),
        })
        .where('id', '=', found.id)
        .execute();
      return undefined;
    }

    await transaction
      .updateTable('native_authorizations')
      .set({ spent_at: now })
      .where('id', '=', found.id)
      .execute();
    return await issueSession(
      transaction,
      clock,
      terms.secret,
      found.user_id,
      terms.sessionTtlDays,
      { userAgent, ipAddress },
    );
  });
};
