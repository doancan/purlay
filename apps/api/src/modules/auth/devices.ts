/**
 * Where a person is signed in, and the means to end one place (D-193).
 *
 * A session is shown by its row id and by what the person chose to call it, and by nothing else: the token's
 * digest is a credential's shadow, the address and the user agent are for an operator (D-60, D-191). Ending one
 * is a delete by `(user_id, id)` in one statement, so a stranger's id and an unknown one are the same absence and
 * nothing is said about either.
 */
import type { Executor } from '@purlay/db';
import { DEVICE_SESSIONS_MAX, type DeviceSession } from '@purlay/types';
import { AppError } from '../../platform/errors';
import { SESSION_CLOCK } from './sessions';

/** The caller's live sessions, the one used last first; at most `DEVICE_SESSIONS_MAX`. */
export const deviceSessions = async (
  executor: Executor,
  userId: string,
  currentSessionId: string,
): Promise<readonly DeviceSession[]> => {
  const rows = await executor
    .selectFrom('sessions')
    .select(['id', 'device_name', 'created_at', 'last_used_at', 'expires_at'])
    .where('user_id', '=', userId)
    // Judged by the clock the library judges a session by (`SESSION_CLOCK`): a row it has let lapse is not a place
    // the person is signed in, whatever the sweep has or has not deleted yet.
    .where('expires_at', '>', SESSION_CLOCK.now())
    // The id breaks a tie, so two sessions used in one instant list in one order every time.
    .orderBy('last_used_at', 'desc')
    .orderBy('id', 'desc')
    .limit(DEVICE_SESSIONS_MAX)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    kind: row.device_name === null ? 'browser' : 'native',
    name: row.device_name,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    current: row.id === currentSessionId,
  }));
};

/**
 * Ends one of the caller's sessions. Its devices (push subscriptions) go with the row (0024's cascade). Returns
 * the id so the sockets it held can be told once this is committed (D-85); a session that is not the caller's, or
 * not there, is one refusal.
 */
export const endDeviceSession = async (
  executor: Executor,
  userId: string,
  sessionId: string,
): Promise<string> => {
  const ended = await executor
    .deleteFrom('sessions')
    .where('id', '=', sessionId)
    .where('user_id', '=', userId)
    .returning('id')
    .executeTakeFirst();
  if (ended === undefined) {
    throw new AppError({ code: 'SESSION_NOT_FOUND', message: 'That session is not there.' });
  }
  return ended.id;
};
