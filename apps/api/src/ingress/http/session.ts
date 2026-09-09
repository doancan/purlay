/**
 * Who is calling.
 *
 * Every `/api/*` endpoint requires a valid session cookie (`API.md` §1). This is
 * where that requirement becomes a refusal, and it is the only place that reads
 * the cookie for an API call.
 *
 * A missing cookie and an invalid one produce the same `401`. There is nothing
 * useful in telling them apart, and a caller who could would learn whether a
 * token they hold was ever real (D-60).
 */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { resolveSession } from '../../modules/auth/sessions';
import { sessionTokenFrom } from './cookies';

export const requireSession = async (
  database: Executor,
  clock: Clock,
  request: Request,
): Promise<{ readonly userId: string }> => {
  const token = sessionTokenFrom(request.headers.get('cookie'));
  const owner = token === undefined ? undefined : await resolveSession(database, clock, token);
  if (owner === undefined) {
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in first.' });
  }
  return { userId: owner.userId };
};
