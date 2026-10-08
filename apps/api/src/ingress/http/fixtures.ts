/**
 * A signed-in user for a test: a unique user row (`testing/users.ts`) and a
 * live session, carried the way a browser carries it.
 */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { issueSession } from '../../modules/auth/sessions';
import { aUserRow, type TestUser } from '../../testing/users';
import { SESSION_COOKIE } from './cookies';

export interface SignedInUser extends TestUser {
  /** The `Cookie` header value a signed-in browser sends. */
  readonly cookie: string;
}

export const aSignedInUser = async (
  executor: Executor,
  clock: Clock,
  name: string,
): Promise<SignedInUser> => {
  const user = await aUserRow(executor, name);
  const { token } = await issueSession(executor, clock, user.userId, 30);
  return { ...user, cookie: `${SESSION_COOKIE}=${token}` };
};
