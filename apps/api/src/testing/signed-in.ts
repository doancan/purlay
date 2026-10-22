/**
 * A signed-in user for a test: a unique user row (`testing/users.ts`) and a live session, carried
 * the way a browser carries it — and the Better Auth instance that resolves it.
 *
 * The session is minted as the library would have written it: the row holds `SHA-256(token)` and
 * the cookie is the token signed with the secret the test's instance uses, so every test that signs
 * in this way goes through the real resolution (`sessionFromHeaders`), not around it.
 */
import { isTransaction, type Executor } from '@purlay/db';
import { systemClock, type Clock } from '../platform/clock';
import {
  DEVELOPMENT_ENCRYPTION_KEY,
  GITHUB_API_URL_DEFAULT,
  GITHUB_URL_DEFAULT,
} from '../platform/config';
import { createLogger } from '../platform/logging';
import {
  createAuth,
  deriveAuthSecret,
  type Auth,
  type AuthDependencies,
} from '../modules/auth/better-auth';
import { inProcessEventBus } from '../realtime/bus';
import { issueSession, type IssueOptions, type IssuedSession } from '../modules/auth/sessions';
import { aUserRow, type TestUser } from './users';
import { SESSION_COOKIE } from '../platform/cookies';

/** The secret a test's instance signs with: the one `testConfig`'s key derives, as in production. */
export const TEST_AUTH_SECRET = deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY);

const silent = createLogger({ level: 'silent' });

/**
 * The instance a test resolves sessions through, over the test's own executor. Inside a rolled-back
 * transaction the library's schema check is off, because it refuses a `Transaction`; on a database of
 * its own it runs, as in production.
 */
export const aTestAuth = (
  database: Executor,
  options: Partial<Omit<AuthDependencies, 'database'>> = {},
): Auth =>
  createAuth({
    database,
    baseUrl: 'https://purlay.test',
    secret: TEST_AUTH_SECRET,
    log: silent,
    settings: { github: undefined, signUp: 'invite-only' },
    // GitHub where the configuration puts it by default; a test of another address names its own.
    githubUrls: { web: GITHUB_URL_DEFAULT, api: GITHUB_API_URL_DEFAULT },
    sessionTtlDays: 30,
    // Heard by nobody, unless the test hands the bus its sockets hear on.
    bus: inProcessEventBus(() => undefined, silent),
    clock: systemClock,
    checkSchema: !isTransaction(database),
    ...options,
  });

/** A session for an existing user, signed as a test's instance accepts it. */
export const aSession = async (
  executor: Executor,
  clock: Clock,
  userId: string,
  ttlDays = 30,
  options: IssueOptions = {},
): Promise<IssuedSession> =>
  await issueSession(executor, clock, TEST_AUTH_SECRET, userId, ttlDays, options);

export interface SignedInUser extends TestUser {
  /** The `Cookie` header value a signed-in browser sends. */
  readonly cookie: string;
  readonly sessionId: string;
}

export const aSignedInUser = async (
  executor: Executor,
  clock: Clock,
  name: string,
): Promise<SignedInUser> => {
  const user = await aUserRow(executor, name);
  const { token, sessionId } = await aSession(executor, clock, user.userId);
  return { ...user, cookie: `${SESSION_COOKIE}=${token}`, sessionId };
};
