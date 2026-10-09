/**
 * Sessions: an opaque token in the user's cookie, only its hash in the database.
 *
 * Chosen over a stateless token because revocation — *sign out everywhere*, *this
 * device was stolen* — matters more here than saving a database round-trip the
 * request makes anyway (D-11).
 *
 * **The raw token exists in exactly two places: the response that issues it, and
 * the user's cookie.** Everything stored is `SHA-256(token)`, so a database dump
 * hands over no live session. Nothing in this module logs, returns or stores the
 * raw value except the one function whose job is to hand it to the caller.
 *
 * Lookup is by hash, and the hash is derived from 256 bits of randomness the
 * attacker does not have — so an indexed equality is not a timing oracle: there
 * is no prefix to guess your way along.
 *
 * The executor is an argument, so this runs inside a rolled-back transaction in a
 * test and never opens a connection of its own (D-46).
 */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { sessionTokenFrom } from '../../platform/cookies';

/** 32 bytes, hex-encoded. The cookie value. */
const TOKEN_BYTES = 32;

/**
 * How stale `last_used_at` may get before a resolve refreshes it.
 *
 * Writing it on every request would put an `UPDATE` on the hottest path in the
 * system to maintain a column whose only consumer is a device list nobody has
 * built yet. An hour is precise enough for *when was this device last seen* and
 * costs one write per session per hour. (D-60)
 */
const LAST_USED_STALE_AFTER_MS = 60 * 60 * 1000;

export interface IssuedSession {
  readonly sessionId: string;
  /** The only place the raw token is ever returned. It is never stored. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface SessionOwner {
  readonly sessionId: string;
  readonly userId: string;
  /** When it stops resolving, so a long-lived connection can end on time. */
  readonly expiresAt: Date;
}

export interface IssueOptions {
  readonly userAgent?: string | undefined;
  readonly ipAddress?: string | undefined;
}

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const randomToken = (): string => {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const issueSession = async (
  executor: Executor,
  clock: Clock,
  userId: string,
  ttlDays: number,
  options: IssueOptions = {},
): Promise<IssuedSession> => {
  const token = randomToken();
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  const row = await executor
    .insertInto('sessions')
    .values({
      user_id: userId,
      token_hash: await sha256(token),
      // From the clock, never the column default: `resolveSession` compares
      // `last_used_at` against `clock.now()`, and two clocks in one comparison
      // made the staleness check depend on the wall date the test ran on.
      created_at: now,
      last_used_at: now,
      expires_at: expiresAt,
      ...(options.userAgent === undefined ? {} : { user_agent: options.userAgent }),
      ...(options.ipAddress === undefined ? {} : { ip_address: options.ipAddress }),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { sessionId: row.id, token, expiresAt };
};

/**
 * Resolves a token to its owner, or to nothing.
 *
 * Every reason to refuse produces the same answer: expired, revoked, unknown, or
 * belonging to a user who has been deleted. A caller that could tell them apart
 * could use this endpoint to ask questions about accounts it does not own.
 */
export const resolveSession = async (
  executor: Executor,
  clock: Clock,
  token: string,
): Promise<SessionOwner | undefined> => {
  const now = clock.now();
  const row = await executor
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select([
      'sessions.id as sessionId',
      'sessions.user_id as userId',
      'sessions.last_used_at',
      'sessions.expires_at',
    ])
    .where('sessions.token_hash', '=', await sha256(token))
    .where('sessions.revoked_at', 'is', null)
    .where('sessions.expires_at', '>', now)
    .where('users.deleted_at', 'is', null)
    .executeTakeFirst();

  if (row === undefined) return undefined;

  if (now.getTime() - new Date(row.last_used_at).getTime() > LAST_USED_STALE_AFTER_MS) {
    await executor
      .updateTable('sessions')
      .set({ last_used_at: now })
      .where('id', '=', row.sessionId)
      .execute();
  }

  return { sessionId: row.sessionId, userId: row.userId, expiresAt: new Date(row.expires_at) };
};

/**
 * Inside a transaction that is about to write on a session's behalf: the session
 * must still be live, and stays live until this transaction ends.
 *
 * A socket authenticates once and keeps the identity. A sign-out that raced a
 * send let a write commit *after* `revoked_at`. `FOR SHARE` closes that: the
 * revocation updates this row, so it waits for the transaction that holds the
 * lock — the write commits before the revocation does — and a revocation that
 * committed first is seen here. One primary-key read, compatible with every
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
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', clock.now())
    .forShare()
    .executeTakeFirst();
  if (live === undefined) {
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in first.' });
  }
};

/** Sign out, on this device. Revoking is a stamp, never a delete: the row is evidence. */
export const revokeSession = async (
  executor: Executor,
  clock: Clock,
  token: string,
): Promise<string | undefined> => {
  const revoked = await executor
    .updateTable('sessions')
    .set({ revoked_at: clock.now() })
    .where('token_hash', '=', await sha256(token))
    .where('revoked_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return revoked?.id;
};

/**
 * Sign out everywhere. Returns the ids of the sessions that were live, so the
 * caller can end the connections they hold — a revoked session with an open
 * socket is not signed out (#194).
 */
export const revokeAllSessions = async (
  executor: Executor,
  clock: Clock,
  userId: string,
): Promise<readonly string[]> => {
  const revoked = await executor
    .updateTable('sessions')
    .set({ revoked_at: clock.now() })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute();
  return revoked.map((row) => row.id);
};

/**
 * Who a request's `Cookie` header says is calling, or nobody.
 *
 * The one place a header becomes a session, for both doors: an HTTP request and
 * a socket upgrade carry the same cookie and must resolve it the same way.
 * Missing, malformed, expired and revoked all answer `undefined`.
 */
export const sessionFromCookie = async (
  executor: Executor,
  clock: Clock,
  cookieHeader: string | null,
): Promise<SessionOwner | undefined> => {
  const token = sessionTokenFrom(cookieHeader);
  return token === undefined ? undefined : await resolveSession(executor, clock, token);
};

/**
 * The same, as a refusal. A missing cookie and an invalid one produce the same
 * `401`: telling them apart would tell a caller whether a token they hold was
 * ever real (D-60).
 */
export const requireSessionFromCookie = async (
  executor: Executor,
  clock: Clock,
  cookieHeader: string | null,
): Promise<SessionOwner> => {
  const owner = await sessionFromCookie(executor, clock, cookieHeader);
  if (owner === undefined) {
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in first.' });
  }
  return owner;
};
