/**
 * Doubles for driving the HTTP surface in a test.
 *
 * The application takes its dependencies as arguments, so a test supplies
 * exactly what the route under test is allowed to use — and, more usefully,
 * supplies things that *object* if a route reaches for what it should not.
 */
import type { Executor, Transaction } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { DEVELOPMENT_ENCRYPTION_KEY, type Config } from '../../platform/config';
import type { GitHubClient, GitHubEmail, GitHubProfile } from '../../modules/auth/github';
import type { Dependencies } from './app';
import type { RateBudget } from '../../realtime/rate-limiter';
import { createLogger, type Logger } from '../../platform/logging';

/** A logger whose lines a test can read back, parsed. */
export const aRecordingLogger = (): { log: Logger; lines: Record<string, unknown>[] } => {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    log: createLogger({
      level: 'debug',
      write: (line) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    }),
  };
};

/**
 * A database handle that fails loudly if anything touches it.
 *
 * This is how `/health` proves it is liveness rather than readiness wearing its
 * name: not by asserting that it did not query, but by making a query impossible.
 * The assertion lives in the double, so it holds for every test that uses it.
 */
export const aDatabaseThatMustNotBeTouched = (): Executor =>
  new Proxy(
    {},
    {
      get(_target, property): never {
        throw new Error(
          `the database was reached (\`${String(property)}\`) by something that must not touch it`,
        );
      },
    },
  ) as Executor;

/**
 * The same double, typed as the transaction `Atomically` hands its body. A test
 * that stands in for the boundary needs one; it throws on any use all the same.
 */
export const aTransactionThatMustNotBeTouched = (): Transaction =>
  aDatabaseThatMustNotBeTouched() as Transaction;

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  NODE_ENV: 'test',
  PORT: 3001,
  LOG_LEVEL: 'info',
  APP_URL: 'https://purlay.test',
  DATABASE_URL: 'postgres://unused',
  DATABASE_POOL_MAX: 10,
  TRUST_PROXY: false,
  DATABASE_SSL: false,
  DATABASE_ALLOW_PLAINTEXT: false,
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
  SESSION_TTL_DAYS: 30,
  ...overrides,
});

export interface GitHubDouble extends GitHubClient {
  /** Codes this double accepts. Anything else is refused the way GitHub refuses it. */
  readonly accepts: string;
}

export const aGitHubAccount = (
  profile: GitHubProfile,
  emails: readonly GitHubEmail[],
  accepts = 'a-valid-code',
): GitHubDouble => ({
  accepts,
  exchangeCode: async (code: string): Promise<string> => {
    if (code !== accepts) throw new Error('GitHub returned no access token');
    return await Promise.resolve('an-access-token');
  },
  profile: async (): Promise<GitHubProfile> => await Promise.resolve(profile),
  emails: async (): Promise<readonly GitHubEmail[]> => await Promise.resolve(emails),
});

export const NOW = new Date('2026-09-09T12:00:00.000Z');

const ROOMY: RateBudget = { perSecond: 1000, burst: 100_000 };

export const testDependencies = (overrides: Partial<Dependencies> = {}): Dependencies => ({
  config: testConfig(),
  database: aDatabaseThatMustNotBeTouched(),
  clock: fixedClock(NOW),
  github: aGitHubAccount({ id: 1, login: 'octocat', name: 'Mona', avatarUrl: null }, [
    { email: 'mona@example.test', primary: true, verified: true },
  ]),
  // Silent unless a test asks to read what was written (`aRecordingLogger`).
  log: createLogger({ level: 'silent' }),
  // Tests seed rows over HTTP by the hundred and share a clock that never moves,
  // so the production budget would refuse them. The tests of the limits say so
  // explicitly, and `rate-limit.test.ts` pins that the default is the real one.
  rateBudgets: { auth: ROOMY, writes: ROOMY },
  ...overrides,
});
