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
import type { Auth } from '../../modules/auth/better-auth';
import { requireSessionFromHeaders } from '../../modules/auth/sessions';
import { noteSession } from '../../platform/logging';

export const requireSession = async (
  auth: Auth,
  request: Request,
): Promise<{ readonly userId: string; readonly sessionId: string }> => {
  const { userId, sessionId } = await requireSessionFromHeaders(auth, request.headers);
  // What the trail names as who acted, for whatever this request goes on to do (D-116).
  noteSession(sessionId);
  return { userId, sessionId };
};
