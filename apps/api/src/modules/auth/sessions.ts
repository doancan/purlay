/**
 * Sessions: an opaque token in the user's cookie, only its hash in the database (D-11), resolved
 * by Better Auth (D-179).
 *
 * Chosen over a stateless token because revocation — *sign out everywhere*, *this device was
 * stolen* — matters more here than saving a database round-trip the request makes anyway.
 *
 * **One seam turns a request into a session, for both doors**: `sessionFromHeaders`, which asks the
 * library (`auth.api.getSession`). The cookie is the library's — the raw token and its HMAC under
 * the secret — and the row it is looked up by holds `SHA-256(token)`, kept so by the hashing plugin
 * on the library's database handle (`sessionTokenHashing`). A dump is not a session, and neither is
 * a dump signed with the secret.
 *
 * **Ending a session deletes its row**, as the library does on its own sign-out and revoke, so every
 * path ends one the same way and nothing else has to be consulted to know it is over: `revoked_at`
 * stays in the schema and is not written (D-179 §3). The row's deletion sets `audit_log.session_id`
 * to `NULL` (D-116) and takes the session's push subscriptions with it (0024).
 *
 * The executor is an argument, so this runs inside a rolled-back transaction in a test and never
 * opens a connection of its own (D-46).
 */
import { makeSignature } from 'better-auth/crypto';
import { isAPIError } from 'better-auth/api';
import { sessionTokenDigest, type Executor } from '@purlay/db';
import { systemClock, type Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { readCookie, SESSION_COOKIE } from '../../platform/cookies';
import { randomToken } from '../../platform/tokens';
import type { Auth } from './better-auth';
import { ACTIVITY_STALE_AFTER_MS, fixedEnd } from './session-lifetime';

/**
 * The clock a session's expiry is judged by. Better Auth compares `expires_at` with the wall clock
 * and takes no other, so whatever arms or mints an expiry beside it reads the same one; a test's
 * fixed clock in the past would otherwise mint sessions the library has already let lapse.
 */
export const SESSION_CLOCK: Clock = systemClock;

export interface IssuedSession {
  readonly sessionId: string;
  /** The cookie's value: the raw token and its signature. The only place the raw token leaves. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface SessionOwner {
  readonly sessionId: string;
  readonly userId: string;
  /**
   * When it stops resolving whatever is done with it — its expiry, or the server's maximum age if that is sooner
   * (D-244) — so a long-lived connection can end on time. An idle timeout moves with use, and is the sweep's.
   */
  readonly expiresAt: Date;
}

export interface IssueOptions {
  readonly userAgent?: string | undefined;
  readonly ipAddress?: string | undefined;
  /** What a device list calls this session: set for the native application's, never for a browser's (D-193). */
  readonly deviceName?: string | undefined;
}

/** What the library accepts as `__Host-purlay_session`: the token, a dot, its HMAC; URI-encoded. */
const signedSessionCookieValue = async (secret: string, token: string): Promise<string> =>
  encodeURIComponent(`${token}.${await makeSignature(token, secret)}`);

/**
 * A session made without the library, for the sign-in flows that predate it and the command-line
 * tools that sign a person in to drive the real server: the row the library would have written,
 * stored hashed, and the cookie it would have set.
 */
export const issueSession = async (
  executor: Executor,
  clock: Clock,
  secret: string,
  userId: string,
  ttlDays: number,
  options: IssueOptions = {},
): Promise<IssuedSession> => {
  const token = randomToken();
  const now = clock.now();
  const expiresAt = new Date(SESSION_CLOCK.now().getTime() + ttlDays * 24 * 60 * 60 * 1000);

  const row = await executor
    .insertInto('sessions')
    .values({
      user_id: userId,
      token_hash: sessionTokenDigest(token),
      created_at: now,
      last_used_at: now,
      expires_at: expiresAt,
      ...(options.userAgent === undefined ? {} : { user_agent: options.userAgent }),
      ...(options.ipAddress === undefined ? {} : { ip_address: options.ipAddress }),
      ...(options.deviceName === undefined ? {} : { device_name: options.deviceName }),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { sessionId: row.id, token: await signedSessionCookieValue(secret, token), expiresAt };
};

/**
 * How stale `last_used_at` may get before a resolve refreshes it.
 *
 * Writing it on every request would put an `UPDATE` on the hottest path in the system to maintain a
 * column whose only consumer is a device list nobody has built yet; not writing it at all would make
 * it fiction. An hour is precise enough for *when was this device last seen* and costs one write per
 * session per hour. (D-60)
 */
const LAST_USED_STALE_AFTER_MS = 60 * 60 * 1000;

/** A `users` column the library maps (`deletedAt`, `suspendedAt`); absent reads as never set. */
const markOf = (user: object, field: 'deletedAt' | 'suspendedAt'): unknown => {
  const value: unknown = (user as Readonly<Record<string, unknown>>)[field];
  return value ?? null;
};

/**
 * Refreshes `last_used_at` (the library's `updatedAt`) by row id when it is stale, through the
 * library's adapter, so nothing about the token is touched and the library's own refresh, which the
 * seam turns off, is not needed for it. Where the server signs out an unused session, stale sooner:
 * the column is then what the idle timeout is judged by (D-244).
 */
const touch = async (auth: Auth, sessionId: string, lastUsed: Date): Promise<void> => {
  const now = SESSION_CLOCK.now();
  const staleAfter =
    auth.sessionLifetime.sessionIdleTimeoutHours === null
      ? LAST_USED_STALE_AFTER_MS
      : ACTIVITY_STALE_AFTER_MS;
  if (now.getTime() - lastUsed.getTime() <= staleAfter) return;
  const { adapter } = await auth.$context;
  await adapter.update({
    model: 'session',
    where: [{ field: 'id', value: sessionId }],
    update: { updatedAt: now },
  });
};

/**
 * Who a request's headers say is calling, or nobody.
 *
 * The one place a header becomes a session, for both doors: an HTTP request and a socket upgrade
 * carry the same cookie and resolve it here. Missing, malformed, tampered, expired, revoked and
 * unknown all answer `undefined`: a caller that could tell them apart could ask questions about
 * sessions it does not hold (D-60). A failure that is not about the session — the database is down
 * — is thrown, never read as *signed out*. A session the server's lifetime policy ended is one of
 * them: the library's read of it is where it is ended (`lapsedCallerEnded` in `better-auth.ts`, D-244).
 */
export const sessionFromHeaders = async (
  auth: Auth,
  headers: Headers,
): Promise<SessionOwner | undefined> => {
  // Nothing to look up: an anonymous request costs the database nothing.
  if (readCookie(headers.get('cookie'), SESSION_COOKIE) === undefined) return undefined;
  try {
    // Read, never written: a refresh here would extend the row while the browser's cookie kept its
    // old lifetime, and put a write on every request. The library's own `/get-session` refreshes.
    const found = await auth.api.getSession({ headers, query: { disableRefresh: true } });
    if (found === null) return undefined;
    // A soft-deleted account keeps no live session, whatever row is left (ARCHITECTURE.md, D-139 §5).
    if (markOf(found.user, 'deletedAt') !== null) return undefined;
    // Nor a suspended one (D-233): its sessions were deleted when it was suspended, and this refuses one
    // that a sign-in committed in the same instant.
    if (markOf(found.user, 'suspendedAt') !== null) return undefined;
    await touch(auth, found.session.id, new Date(found.session.updatedAt));
    return {
      sessionId: found.session.id,
      userId: found.user.id,
      expiresAt: fixedEnd(auth.sessionLifetime, {
        createdAt: new Date(found.session.createdAt),
        expiresAt: new Date(found.session.expiresAt),
      }),
    };
  } catch (error) {
    // A refresh that found its row deleted under it: the library's word for a session that ended
    // while it was being read.
    if (isAPIError(error) && error.statusCode === 401) return undefined;
    // The library wraps what failed under it; the cause is what says whether to try again (a pool
    // out of connections is a 503, not a 500).
    if (isAPIError(error) && error.cause instanceof Error) throw error.cause;
    throw error;
  }
};

/**
 * What a session may reach while its person owes the server two-step verification (D-239): `everything` is
 * refused until it is on; `enrolment` is only what turning it on needs — who they are, how they sign in, and
 * signing out everywhere.
 */
export type SessionReach = 'everything' | 'enrolment';

/** The refusal of a session whose person must turn on two-step verification first (D-239). */
export const twoFactorRequired = (): AppError =>
  new AppError({
    code: 'TWO_FACTOR_REQUIRED',
    message: 'Turn on two-step verification first.',
  });

/**
 * The same, as a refusal. A missing cookie and an invalid one produce the same `401`: telling them
 * apart would tell a caller whether a token they hold was ever real (D-60). A session whose person owes
 * two-step verification is `403 TWO_FACTOR_REQUIRED` (D-239), unless what it asks is part of turning it on.
 */
export const requireSessionFromHeaders = async (
  auth: Auth,
  headers: Headers,
  reach: SessionReach = 'everything',
): Promise<SessionOwner> => {
  const owner = await sessionFromHeaders(auth, headers);
  if (owner === undefined) {
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in first.' });
  }
  if (reach === 'everything' && (await auth.owesTwoFactor(owner.userId))) {
    throw twoFactorRequired();
  }
  return owner;
};

/**
 * Inside a transaction that is about to write on a session's behalf: the session must still be
 * live, and stays live until this transaction ends.
 *
 * A socket authenticates once and keeps the identity. A sign-out that raced a send let a write
 * commit after it. `FOR SHARE` closes that: ending a session deletes this row, so the delete waits
 * for the transaction that holds the lock — the write commits before the sign-out does — and a
 * sign-out that committed first leaves no row to find. One primary-key read, compatible with every
 * other sender's share lock on the same session. (D-85)
 */
export const requireLiveSession = async (
  transaction: Executor,
  clock: Clock,
  sessionId: string,
): Promise<void> => {
  const live = await transaction
    .selectFrom('sessions')
    .select('id')
    .where('id', '=', sessionId)
    .where('expires_at', '>', clock.now())
    .forShare()
    .executeTakeFirst();
  if (live === undefined) {
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in first.' });
  }
};

/**
 * Sign out, on this device: the session the request resolved to, by its row. Never by a token, so
 * nothing a caller can read back — a listed digest — can end a session (D-179 §3).
 */
export const revokeSession = async (
  executor: Executor,
  sessionId: string,
): Promise<string | undefined> => {
  const revoked = await executor
    .deleteFrom('sessions')
    .where('id', '=', sessionId)
    .returning('id')
    .executeTakeFirst();
  return revoked?.id;
};

/**
 * Sign out everywhere. Returns the ids of the sessions that were live, so the caller can end the
 * connections they hold — a revoked session with an open socket is not signed out (#194).
 */
export const revokeAllSessions = async (
  executor: Executor,
  userId: string,
): Promise<readonly string[]> => {
  const revoked = await executor
    .deleteFrom('sessions')
    .where('user_id', '=', userId)
    .returning('id')
    .execute();
  return revoked.map((row) => row.id);
};
