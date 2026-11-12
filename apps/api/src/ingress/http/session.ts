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
import {
  requireSessionFromHeaders,
  type SessionAuth,
  type SessionReach,
  type SessionOwner,
} from '../../modules/auth/sessions';
import { noteSession } from '../../platform/logging';
import { AppError } from '../../platform/errors';

type RequestSession = Pick<SessionOwner, 'userId' | 'sessionId' | 'companyWorkspaceId'>;

/**
 * A live session, refused `403 TWO_FACTOR_REQUIRED` while its person owes the server two-step verification
 * (D-239) — unless the route is one of the few turning it on needs (`'enrolment'`): `GET /api/me`,
 * `GET /api/me/sign-in` and signing out everywhere. Every other route takes the default, so a route added later
 * is held back too.
 */
export const requireSession = async (
  auth: Auth | SessionAuth,
  request: Request,
  reach: SessionReach = 'everything',
): Promise<RequestSession> => {
  const { userId, sessionId, companyWorkspaceId } = await requireSessionFromHeaders(
    auth,
    request.headers,
    reach,
  );
  // What the trail names as who acted, for whatever this request goes on to do (D-116).
  noteSession(
    sessionId,
    companyWorkspaceId === undefined ? undefined : { userId, workspaceId: companyWorkspaceId },
  );
  return { userId, sessionId, ...(companyWorkspaceId === undefined ? {} : { companyWorkspaceId }) };
};

/** Global account authority requires a sign-in independent of a workspace's identity provider. */
export const requireIndependentSession = async (
  auth: Auth | SessionAuth,
  request: Request,
  reach: SessionReach = 'everything',
): Promise<RequestSession> => {
  const owner = await requireSession(auth, request, reach);
  if (owner.companyWorkspaceId !== undefined)
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Sign in independently to manage this account.',
    });
  return owner;
};
