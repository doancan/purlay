/**
 * The whole sign-in, driven through real requests against a real database.
 *
 * GitHub is a double — the point is not that `fetch` works, it is that the
 * handshake, the state check, the identity rules and the session all fit
 * together, including when one of them refuses.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import type { SignInFailure } from '@purlay/types';
import { createApp } from './app';
import { SESSION_COOKIE, STATE_COOKIE } from '../../platform/cookies';
import { NOW, aGitHubAccount, aRecordingLogger, testDependencies } from '../../testing/doubles';
import { GitHubUnavailableError, type GitHubClient } from '../../modules/auth/github';
import type { Config } from '../../platform/config';
import type { Logger } from '../../platform/logging';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';

const appFor = (
  database: Executor,
  github: GitHubClient = testDependencies().github,
  config = testDependencies().config,
  log: Logger = testDependencies().log,
): ReturnType<typeof createApp> => createApp(testDependencies({ database, github, config, log }));

/** Everything a browser would carry back from the redirect, in one place. */
const startAndCallback = async (
  database: Executor,
  options: {
    code?: string;
    tamperState?: boolean;
    github?: GitHubClient;
    config?: Config;
    log?: Logger;
  } = {},
): Promise<Response> => {
  const app = appFor(
    database,
    options.github ?? testDependencies().github,
    options.config ?? testDependencies().config,
    options.log ?? testDependencies().log,
  );

  const started = await app.handle(new Request(`${ORIGIN}/auth/github`));
  const stateCookie = started.headers.get('set-cookie') ?? '';
  const location = new URL(started.headers.get('location') ?? '');
  const state = location.searchParams.get('state') ?? '';

  // Deterministically different. Replacing the last character with a fixed one
  // is a no-op whenever it already is that character — a test that passes fifteen
  // times in sixteen, which is worse than one that never passes.
  const flipped = `${state.slice(0, -1)}${state.endsWith('0') ? '1' : '0'}`;
  const returned = options.tamperState === true ? flipped : state;
  return await app.handle(
    new Request(
      `${ORIGIN}/auth/github/callback?code=${options.code ?? 'a-valid-code'}&state=${returned}`,
      {
        headers: { cookie: stateCookie.split(';')[0] ?? '', 'user-agent': 'probe/1.0' },
      },
    ),
  );
};

/**
 * A sign-in that did not finish, as the browser receives it (D-121): a redirect to
 * the sign-in screen carrying this reason and nothing else, the state spent, and
 * no session. Never the API's JSON — that is the page the person was left on.
 */
const expectSentBack = (response: Response, failure: SignInFailure): void => {
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=${failure}`);
  expect(response.headers.get('content-type') ?? '').not.toContain('json');
  const cookies = response.headers.getSetCookie();
  expect(cookies.some((cookie) => cookie.startsWith(`${STATE_COOKIE}=;`))).toBe(true);
  expect(cookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
};

/** GitHub, failing every call with this error. */
const aFailingGitHub = (error: Error): GitHubClient => ({
  exchangeCode: async (): Promise<string> => await Promise.reject(error),
  profile: async (): Promise<never> => await Promise.reject(error),
  emails: async (): Promise<never> => await Promise.reject(error),
});

/** A GitHub the test must not reach: a cancelled sign-in has nothing to exchange. */
const aGitHubThatMustNotBeCalled = (): GitHubClient =>
  aFailingGitHub(new Error('GitHub was called for a sign-in that carried no code'));

/** What the browser brings back when GitHub returns it with an `error` instead of a code. */
const returnedWithError = async (
  database: Executor,
  error: string,
  log: Logger = testDependencies().log,
): Promise<Response> => {
  const app = appFor(database, aGitHubThatMustNotBeCalled(), testDependencies().config, log);
  const started = await app.handle(new Request(`${ORIGIN}/auth/github`));
  const state = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';
  return await app.handle(
    new Request(
      `${ORIGIN}/auth/github/callback?error=${error}&error_description=The+user+has+denied&state=${state}`,
      { headers: { cookie: (started.headers.get('set-cookie') ?? '').split(';')[0] ?? '' } },
    ),
  );
};

/**
 * Scoped to the address under test. `withRollback` rolls back *this test's*
 * writes; it does not empty the database, and a machine that has run the
 * application has rows in it.
 */
const accountsFor = async (db: Executor, email: string): Promise<{ id: string }[]> =>
  await db.selectFrom('users').select('id').where('email', '=', email).execute();

/** Live sessions belonging to one account, for the same reason. */
const liveSessionsFor = async (db: Executor, email: string): Promise<{ id: string }[]> =>
  await db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select('sessions.id')
    .where('users.email', '=', email)
    .where('sessions.revoked_at', 'is', null)
    .execute();

describe('integration: signing in with GitHub', () => {
  test('the redirect asks for exactly the scopes D-38 allows, and nothing else', async () => {
    await withRollback(async (db) => {
      const response = await appFor(db).handle(new Request(`${ORIGIN}/auth/github`));
      expect(response.status).toBe(302);

      const location = new URL(response.headers.get('location') ?? '');
      expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
      expect(location.searchParams.get('scope')).toBe('read:user user:email');
      expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/github/callback`);
      expect(location.searchParams.get('state')).toHaveLength(32);

      const cookie = response.headers.get('set-cookie') ?? '';
      expect(cookie).toStartWith(`${STATE_COOKIE}=`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
    });
  });

  /**
   * Regression for #199. A sibling subdomain can set a cookie for this origin
   * unless its name carries `__Host-`, which a browser accepts only with `Secure`,
   * `Path=/` and no `Domain`. Each of those is asserted, because dropping any one
   * makes the browser ignore the prefix's guarantee — or the cookie itself.
   */
  test('both cookies are ones a sibling subdomain cannot plant', async () => {
    await withRollback(async (db) => {
      const started = await appFor(db).handle(new Request(`${ORIGIN}/auth/github`));
      const signedIn = await startAndCallback(db);
      const cookies = [...started.headers.getSetCookie(), ...signedIn.headers.getSetCookie()];
      expect(cookies.map((c) => c.split('=')[0])).toEqual([
        STATE_COOKIE,
        SESSION_COOKIE,
        STATE_COOKIE,
      ]);
      for (const cookie of cookies) {
        const attributes = cookie
          .split(';')
          .slice(1)
          .map((part) => part.trim());
        expect({ cookie, prefixed: cookie.startsWith('__Host-') }).toEqual({
          cookie,
          prefixed: true,
        });
        expect(attributes).toContain('Secure');
        expect(attributes).toContain('Path=/');
        expect(attributes.some((a) => a.toLowerCase().startsWith('domain'))).toBe(false);
      }
    });
  });

  test('a callback spends its state whatever the outcome', async () => {
    await withRollback(async (db) => {
      const spent = (response: Response): boolean =>
        response.headers
          .getSetCookie()
          .some((cookie) => cookie.startsWith(`${STATE_COOKIE}=;`) && cookie.includes('Max-Age=0'));

      const signedIn = await startAndCallback(db);
      expect(signedIn.headers.get('location')).toBe(ORIGIN);
      expect(spent(signedIn)).toBe(true);

      const refused = await startAndCallback(db, { tamperState: true });
      expect(refused.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=expired`);
      expect(spent(refused)).toBe(true);
    });
  });

  test('a completed handshake creates the account and issues a session', async () => {
    await withRollback(async (db) => {
      const response = await startAndCallback(db);

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(ORIGIN);

      const cookie = response.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(`${SESSION_COOKIE}=`);
      expect(cookie).toContain('HttpOnly');

      const user = await db
        .selectFrom('users')
        .selectAll()
        .where('email', '=', 'mona@example.test')
        .executeTakeFirstOrThrow();
      const sessions = await db
        .selectFrom('sessions')
        .selectAll()
        .where('user_id', '=', user.id)
        .execute();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.user_agent).toBe('probe/1.0');

      // The cookie carries the token; the database carries only its hash.
      const token = cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'));
      expect(JSON.stringify(sessions[0])).not.toContain(token);
    });
  });

  test('a tampered state is sent back as expired, and no account is created', async () => {
    await withRollback(async (db) => {
      const response = await startAndCallback(db, { tamperState: true });

      expectSentBack(response, 'expired');
      expect(await accountsFor(db, 'mona@example.test')).toHaveLength(0);
    });
  });

  test('a callback with no state cookie at all is sent back as expired', async () => {
    await withRollback(async (db) => {
      const response = await appFor(db).handle(
        new Request(`${ORIGIN}/auth/github/callback?code=a-valid-code&state=anything`),
      );
      expectSentBack(response, 'expired');
    });
  });

  test('an account with no verified address is sent back saying so, and nothing is written', async () => {
    await withRollback(async (db) => {
      const response = await startAndCallback(db, {
        github: aGitHubAccount({ id: 7, login: 'ghost', name: null, avatarUrl: null }, [
          { email: 'ghost@example.test', primary: true, verified: false },
        ]),
      });

      expectSentBack(response, 'email-required');
      expect(await accountsFor(db, 'ghost@example.test')).toHaveLength(0);
    });
  });

  test('an address another account holds is sent back as taken, and is not linked (D-38)', async () => {
    await withRollback(async (db) => {
      expect((await startAndCallback(db)).headers.get('location')).toBe(ORIGIN);
      const holder = await accountsFor(db, 'mona@example.test');
      expect(holder).toHaveLength(1);

      // A different GitHub account, verified on the same address.
      const response = await startAndCallback(db, {
        github: aGitHubAccount({ id: 8, login: 'impostor', name: null, avatarUrl: null }, [
          { email: 'mona@example.test', primary: true, verified: true },
        ]),
      });

      expectSentBack(response, 'email-taken');
      expect(await accountsFor(db, 'mona@example.test')).toEqual(holder);
    });
  });

  test('cancelling on GitHub is sent back as cancelled, without calling GitHub', async () => {
    await withRollback(async (db) => {
      const response = await returnedWithError(db, 'access_denied');

      // Had `aGitHubThatMustNotBeCalled` been reached, this would read `failed`.
      expectSentBack(response, 'cancelled');
      expect(await accountsFor(db, 'mona@example.test')).toHaveLength(0);
    });
  });

  test('any other error GitHub returns with is sent back as failed, and written down', async () => {
    await withRollback(async (db) => {
      const { log, lines } = aRecordingLogger();
      const response = await returnedWithError(db, 'redirect_uri_mismatch', log);

      expectSentBack(response, 'failed');
      expect(lines.find((line) => line['msg'] === 'GitHub refused a sign-in')).toMatchObject({
        level: 'warn',
        githubError: 'redirect_uri_mismatch',
      });
    });
  });

  test('a GitHub that cannot be reached is sent back as unavailable, and written down', async () => {
    await withRollback(async (db) => {
      const { log, lines } = aRecordingLogger();
      const response = await startAndCallback(db, {
        github: aFailingGitHub(new GitHubUnavailableError('GitHub could not be reached')),
        log,
      });

      expectSentBack(response, 'github-unavailable');
      expect(lines.find((line) => line['msg'] === 'GitHub failed a sign-in')).toMatchObject({
        level: 'warn',
      });
      expect(await accountsFor(db, 'mona@example.test')).toHaveLength(0);
    });
  });

  test('a failure nobody anticipated is sent back as failed, and its cause is logged as an error', async () => {
    await withRollback(async (db) => {
      const { log, lines } = aRecordingLogger();
      const response = await startAndCallback(db, {
        github: aFailingGitHub(new Error('a defect, not an outage')),
        log,
      });

      expectSentBack(response, 'failed');
      const failure = lines.find((line) => line['msg'] === 'request failed');
      expect(failure).toMatchObject({ level: 'error', path: '/auth/github/callback' });
      expect(JSON.stringify(failure)).toContain('a defect, not an outage');
    });
  });

  test('signing out revokes the session and clears the cookie', async () => {
    await withRollback(async (db) => {
      const signedIn = await startAndCallback(db);
      const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

      const response = await appFor(db).handle(
        new Request(`${ORIGIN}/auth/logout`, { method: 'POST', headers: { cookie } }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=;`);

      expect(await liveSessionsFor(db, 'mona@example.test')).toHaveLength(0);
    });
  });

  test('signing out everywhere needs a session, and revokes every one of them', async () => {
    await withRollback(async (db) => {
      const first = await startAndCallback(db);
      await startAndCallback(db); // the same person, a second device
      const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

      const withoutSession = await appFor(db).handle(
        new Request(`${ORIGIN}/auth/logout-all`, { method: 'POST' }),
      );
      expect(withoutSession.status).toBe(401);

      const response = await appFor(db).handle(
        new Request(`${ORIGIN}/auth/logout-all`, { method: 'POST', headers: { cookie } }),
      );
      expect(response.status).toBe(204);

      expect(await liveSessionsFor(db, 'mona@example.test')).toHaveLength(0);
    });
  });

  test('the session the handshake issued actually expires when it should', async () => {
    await withRollback(async (db) => {
      expect((await startAndCallback(db)).headers.get('location')).toBe(ORIGIN);
      // The session belonging to *this* account. `selectAll().executeTakeFirst()`
      // reads whichever row the database returns first, which on a machine that
      // has run the application is somebody else's.
      const session = await db
        .selectFrom('sessions')
        .innerJoin('users', 'users.id', 'sessions.user_id')
        .select('sessions.expires_at')
        .where('users.email', '=', 'mona@example.test')
        .executeTakeFirstOrThrow();
      const expected = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
      expect(new Date(session.expires_at).toISOString()).toBe(expected.toISOString());
    });
  });
});
