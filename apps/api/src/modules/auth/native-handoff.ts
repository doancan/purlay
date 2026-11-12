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
import { sql, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { randomToken, tokenDigest } from '../../platform/tokens';
import { atomicallyOn } from '../../platform/transactions';
import {
  issueSession,
  requireLiveSession,
  type IssuedSession,
  type IssueOptions,
} from './sessions';
import { lockCompanyIdentityMember } from '../workspaces/identity/authority';
import { liveCompanySessionProof } from '../../platform/company-session';
import { AppError } from '../../platform/errors';

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

/** Older readers cannot exchange a company grant as an independent native session. */
const companyCodeDigest = async (code: string): Promise<string> =>
  await tokenDigest(`company-native-code@purlay/v1:${code}`);

/**
 * A code for this person, bound to the application's `challenge` (the caller has checked its shape).
 * The code is returned this once and never stored.
 */
export const authorizeNative = async (
  database: Executor,
  clock: Clock,
  {
    userId,
    challenge,
    sourceSessionId,
  }: { readonly userId: string; readonly challenge: string; readonly sourceSessionId?: string },
): Promise<{ readonly code: string }> => {
  const code = randomToken();
  const digest = await tokenDigest(code);
  const companyDigest = await companyCodeDigest(code);
  const now = clock.now();
  await atomicallyOn(database)(async (transaction) => {
    let companyWorkspaceId: string | undefined;
    if (sourceSessionId !== undefined) {
      const source = await requireLiveSession(transaction, clock, sourceSessionId);
      if (source.userId !== userId)
        throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in first.' });
      companyWorkspaceId = source.companyWorkspaceId;
      if (companyWorkspaceId !== undefined) {
        await lockCompanyIdentityMember(transaction, companyWorkspaceId, userId, false);
        await requireLiveSession(transaction, clock, sourceSessionId);
      }
    }
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
      .select(['id', 'company_workspace_id'])
      .where('user_id', '=', userId)
      .where('spent_at', 'is', null)
      .where('expires_at', '>', now)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    // The newest four stay, and the one made now is the fifth.
    const excess = Math.max(0, live.length - NATIVE_LIVE_CODES_PER_USER + 1);
    const eligible =
      companyWorkspaceId === undefined
        ? live
        : live.filter((row) => row.company_workspace_id === companyWorkspaceId);
    if (eligible.length < excess)
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'Sign in independently to make room for this native sign-in.',
      });
    const makingRoom = eligible.slice(eligible.length - excess).map((row) => row.id);
    if (makingRoom.length > 0) {
      await transaction.deleteFrom('native_authorizations').where('id', 'in', makingRoom).execute();
    }
    await transaction
      .insertInto('native_authorizations')
      .values({
        id: messageId(now),
        user_id: userId,
        code_digest: companyWorkspaceId === undefined ? digest : companyDigest,
        ...(companyWorkspaceId === undefined
          ? {}
          : {
              company_workspace_id: companyWorkspaceId,
              company_source_session_id: sourceSessionId,
            }),
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
 * Why a code did not open, for an operator's log and for nobody else: the person is told one thing whichever it was,
 * and a client that guesses learns nothing from the difference.
 */
export type NativeRefusal =
  | 'unknown'
  | 'spent'
  | 'expired'
  | 'burnt'
  | 'erased'
  | 'suspended'
  | 'wrong-verifier'
  | 'company-source-ended';

export interface NativeIssuedSession extends IssuedSession {
  readonly companyWorkspaceId?: string;
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
    deviceName,
    refused,
  }: {
    readonly code: string;
    readonly verifier: string;
    /** Told why when the code does not open; never given the code, its digest or the person. */
    readonly refused?: (reason: NativeRefusal) => void;
  } & IssueOptions,
): Promise<NativeIssuedSession | undefined> => {
  // Before anything is looked up, so a code that does not exist costs the same hash as one that does.
  const supplied = nativeChallengeOf(verifier);
  const digest = await tokenDigest(code);
  const companyDigest = await companyCodeDigest(code);

  return await atomicallyOn(database)(async (transaction) => {
    // Classify immutable provenance before locking the grant. Company operations lock source,
    // workspace and person before a grant row, matching enrollment and cap pruning.
    const grant = transaction
      .selectFrom('native_authorizations')
      .innerJoin('users', 'users.id', 'native_authorizations.user_id')
      .select([
        'native_authorizations.id',
        'native_authorizations.user_id',
        'native_authorizations.challenge',
        'native_authorizations.wrong_verifiers',
        'native_authorizations.expires_at',
        'native_authorizations.spent_at',
        'native_authorizations.company_workspace_id',
        'native_authorizations.company_source_session_id',
        'users.deleted_at',
        'users.suspended_at',
      ])
      .where((eb) =>
        eb.or([
          eb.and([
            eb('native_authorizations.code_digest', '=', digest),
            eb('native_authorizations.company_workspace_id', 'is', null),
          ]),
          eb.and([
            eb('native_authorizations.code_digest', '=', companyDigest),
            eb('native_authorizations.company_workspace_id', 'is not', null),
          ]),
        ]),
      );
    const origin = await grant.executeTakeFirst();
    if (origin === undefined) {
      refused?.('unknown');
      return undefined;
    }

    let proof:
      | {
          connection_id: string;
          binding_reference: string;
          authentication_revision: string;
          authenticated_at: Date;
        }
      | undefined;
    if (origin.company_workspace_id !== null) {
      const sourceId = origin.company_source_session_id;
      if (sourceId === null) {
        refused?.('company-source-ended');
        return undefined;
      }
      try {
        const source = await requireLiveSession(transaction, clock, sourceId);
        if (
          source.userId !== origin.user_id ||
          source.companyWorkspaceId !== origin.company_workspace_id
        ) {
          refused?.('company-source-ended');
          return undefined;
        }
        await lockCompanyIdentityMember(
          transaction,
          origin.company_workspace_id,
          origin.user_id,
          false,
        );
        await requireLiveSession(transaction, clock, sourceId);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        refused?.('company-source-ended');
        return undefined;
      }
      proof = await transaction
        .selectFrom('workspace_identity_sessions')
        .select([
          'connection_id',
          'binding_reference',
          'authentication_revision',
          'authenticated_at',
        ])
        .where('session_id', '=', sourceId)
        .where('workspace_id', '=', origin.company_workspace_id)
        .where(
          liveCompanySessionProof(
            sourceId,
            origin.company_workspace_id,
            origin.user_id,
            sql<string>`workspace_identity_sessions.connection_id`,
          ),
        )
        .executeTakeFirst();
      if (proof === undefined) {
        refused?.('company-source-ended');
        return undefined;
      }
    }

    // Reread and hold the same grant after source authority is locked. A concurrent spend or
    // prune cannot be mistaken for the earlier snapshot, and old readers cannot change its kind.
    const found = await grant
      .where('native_authorizations.id', '=', origin.id)
      .forUpdate(['native_authorizations'])
      .executeTakeFirst();
    if (
      found?.user_id !== origin.user_id ||
      found.company_workspace_id !== origin.company_workspace_id ||
      found.company_source_session_id !== origin.company_source_session_id
    ) {
      refused?.('unknown');
      return undefined;
    }
    const now = clock.now();

    // Spent, expired, burnt, or its person erased or suspended (D-233): nothing is counted and nothing is made.
    const live =
      found.spent_at === null &&
      found.expires_at.getTime() > now.getTime() &&
      found.deleted_at === null &&
      found.suspended_at === null;
    if (!live) {
      refused?.(
        found.spent_at !== null
          ? 'spent'
          : found.deleted_at !== null
            ? 'erased'
            : found.suspended_at !== null
              ? 'suspended'
              : found.wrong_verifiers >= NATIVE_WRONG_VERIFIERS_MAX
                ? 'burnt'
                : 'expired',
      );
      return undefined;
    }

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
      refused?.(wrong >= NATIVE_WRONG_VERIFIERS_MAX ? 'burnt' : 'wrong-verifier');
      return undefined;
    }

    await transaction
      .updateTable('native_authorizations')
      .set({ spent_at: now })
      .where('id', '=', found.id)
      .execute();
    const issued = await issueSession(
      transaction,
      clock,
      terms.secret,
      found.user_id,
      terms.sessionTtlDays,
      {
        userAgent,
        ipAddress,
        deviceName,
        companyWorkspaceId: found.company_workspace_id ?? undefined,
      },
    );
    if (proof !== undefined && found.company_workspace_id !== null) {
      await transaction
        .insertInto('workspace_identity_sessions')
        .values({
          ...proof,
          session_id: issued.sessionId,
          workspace_id: found.company_workspace_id,
        })
        .execute();
      return { ...issued, companyWorkspaceId: found.company_workspace_id };
    }
    return issued;
  });
};
