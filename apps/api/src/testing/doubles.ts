/**
 * Doubles for driving the HTTP surface in a test.
 *
 * The application takes its dependencies as arguments, so a test supplies
 * exactly what the route under test is allowed to use — and, more usefully,
 * supplies things that *object* if a route reaches for what it should not.
 */
import type { Executor, Transaction } from '@purlay/db';
import { fixedClock, type Clock } from '../platform/clock';
import {
  DEVELOPMENT_ENCRYPTION_KEY,
  GITHUB_API_URL_DEFAULT,
  GITHUB_URL_DEFAULT,
  type Config,
} from '../platform/config';
import type { Dependencies } from '../ingress/http/app';
import type { RateBudget } from '../realtime/rate-limiter';
import type { Timers } from '../realtime/hub';
import { nobodyActive } from '../platform/attention';
import { createLogger, type Logger } from '../platform/logging';
import { deriveAuthSecret, type Auth, type AuthSettings } from '../modules/auth/better-auth';
import type { MailMessage, Outbox } from '../platform/mail';
import { aTestAuth } from './signed-in';
import { inProcessBackplane } from '../realtime/bus';
import { NO_LOG } from '../platform/events';
import type { ObjectStore } from '../platform/storage';

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
export const aDatabaseThatMustNotBeTouched = (failure?: Error): Executor =>
  new Proxy(
    {},
    {
      get(_target, property): never {
        // A test of how a failure is reported hands the failure it wants reported.
        throw (
          failure ??
          new Error(
            `the database was reached (\`${String(property)}\`) by something that must not touch it`,
          )
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

/** The same, for the sessions seam: an instance any use of throws, naming what was reached. */
export const anAuthThatMustNotBeTouched = (failure?: Error): Auth =>
  new Proxy({} as Auth, {
    get(_target, property): never {
      // A test of how a failure is reported hands the failure it wants reported.
      throw (
        failure ??
        new Error(
          `Better Auth was reached (\`${String(property)}\`) by something that must not touch it`,
        )
      );
    },
  });

/** A store any use of throws: a test that reaches storage it was not given fails, naming the call. */
const aStoreThatMustNotBeTouched = (): ObjectStore => {
  const touched = (what: string) => (): never => {
    throw new Error(`the file store was reached (\`${what}\`) by something that must not touch it`);
  };
  return {
    put: touched('put'),
    putFile: touched('putFile'),
    get: touched('get'),
    delete: touched('delete'),
  };
};

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
  S3_REGION: 'us-east-1',
  SMTP_ALLOW_PLAINTEXT: false,
  GITHUB_URL: GITHUB_URL_DEFAULT,
  GITHUB_API_URL: GITHUB_API_URL_DEFAULT,
  ...overrides,
});

export const NOW = new Date('2026-09-09T12:00:00.000Z');

/** A clock the test moves by hand: time passes when the test says so, and only then. */
export const aMovableClock = (start: Date = NOW): Clock & { advance: (ms: number) => void } => {
  let now = start.getTime();
  return {
    now: (): Date => new Date(now),
    advance: (ms: number): void => {
      now += ms;
    },
  };
};

const ROOMY: RateBudget = { perSecond: 1000, burst: 100_000 };

/** An outbox that keeps what it was given, so a test reads a link back out of the mail. */
export const aRecordingOutbox = (): Outbox & { readonly posted: MailMessage[] } => {
  const posted: MailMessage[] = [];
  return {
    posted,
    post: (message): void => {
      posted.push(message);
    },
    flush: () => Promise.resolve(),
  };
};

/**
 * What a test may say of the sign-in library besides the application's own dependencies: the outbox
 * it mails through — absent, as on a server with no relay, there is no sign-in by link — and who may
 * make an account.
 */
export interface TestOverrides extends Partial<Dependencies> {
  readonly mail?: Outbox;
  readonly signUp?: AuthSettings['signUp'];
}

/**
 * The application's dependencies for a test. Its sessions are resolved through a Better Auth instance
 * over the test's own database, signing with the secret `testConfig`'s key derives (`signed-in.ts`),
 * unless the test hands one of its own.
 */
export const testDependencies = ({
  mail,
  signUp = 'invite-only',
  ...overrides
}: TestOverrides = {}): Dependencies => {
  const database = overrides.database ?? aDatabaseThatMustNotBeTouched();
  const config = overrides.config ?? testConfig();
  // One backplane for the application's sockets and the library's announcements, as in production,
  // so a session the library ends closes what the application holds.
  const backplane = overrides.backplane ?? inProcessBackplane();
  return {
    ...defaults(database, config),
    ...overrides,
    backplane,
    auth:
      overrides.auth ??
      // Built on first use: over the database that must not be touched, building it is a touch.
      onFirstUse(() =>
        aTestAuth(database, {
          baseUrl: config.APP_URL,
          secret: deriveAuthSecret(config.ENCRYPTION_KEY),
          sessionTtlDays: config.SESSION_TTL_DAYS,
          // As the composition root configures it; a test that signs in hands a GitHub of its own.
          settings: {
            github:
              config.GITHUB_CLIENT_ID === undefined || config.GITHUB_CLIENT_SECRET === undefined
                ? undefined
                : {
                    clientId: config.GITHUB_CLIENT_ID,
                    clientSecret: config.GITHUB_CLIENT_SECRET,
                  },
            oidc: undefined,
            signUp,
          },
          mailer: mail,
          fetch: aGitHubThatMustNotBeCalled,
          bus: backplane.node(() => undefined, NO_LOG),
          ...(overrides.clock === undefined ? {} : { clock: overrides.clock }),
        }),
      ),
  };
};

/** GitHub, for an instance no test signs in through: any call is a test reaching too far. */
const aGitHubThatMustNotBeCalled = (url: string): Promise<Response> =>
  Promise.reject(new Error(`GitHub was called (${url}) by a test that does not sign in`));

/**
 * The same dependencies, but who may make a workspace is what the application reads for itself — the
 * server's setting (D-179 §6) — instead of the double that lets anybody: for the creators' own tests.
 */
export const creatorsFromTheSetting = (dependencies: Dependencies): Dependencies => {
  const copy = { ...dependencies };
  delete copy.workspaceCreators;
  return copy;
};

const onFirstUse = (build: () => Auth): Auth => {
  let built: Auth | undefined;
  return new Proxy({} as Auth, {
    get: (_target, property): unknown => Reflect.get((built ??= build()), property),
  });
};

const defaults = (database: Executor, config: Config): Omit<Dependencies, 'auth'> => ({
  config,
  database,
  clock: fixedClock(NOW),
  // Silent unless a test asks to read what was written (`aRecordingLogger`).
  log: createLogger({ level: 'silent' }),
  // Tests seed rows over HTTP by the hundred and share a clock that never moves,
  // so the production budget would refuse them. The tests of the limits say so
  // explicitly, and `rate-limit.test.ts` pins that the default is the real one.
  rateBudgets: {
    auth: ROOMY,
    writes: ROOMY,
    costlyReads: ROOMY,
    setup: ROOMY,
    setupSecrets: ROOMY,
    nativeTokens: ROOMY,
  },
  storage: aStoreThatMustNotBeTouched(),
  // An export asked for is made by nobody, unless the test is about exports and says so.
  exportRunner: (): void => undefined,
  attention: nobodyActive,
  // Anybody may make a workspace, so a test makes the ones it needs; who may is the creators' own
  // tests' (D-155), which read the server's setting.
  workspaceCreators: () => Promise.resolve({ kind: 'anyone' }),
});

/**
 * Timers a test runs by hand (D-136's grace): nothing fires until the test says, and a timer cleared
 * never fires — so a grace can be passed, or come back inside, without a wait.
 */
export const aManualTimers = (): Timers & {
  /** Fires every timer armed and not cleared, as if their time had come. */
  readonly runAll: () => void;
  readonly pending: () => number;
} => {
  const armed = new Map<number, () => void>();
  let next = 0;
  return {
    set: (callback: () => void): number => {
      next += 1;
      armed.set(next, callback);
      return next;
    },
    clear: (handle: unknown): void => {
      if (typeof handle === 'number') armed.delete(handle);
    },
    runAll: (): void => {
      const due = [...armed];
      armed.clear();
      for (const [, fire] of due) fire();
    },
    pending: (): number => armed.size,
  };
};
