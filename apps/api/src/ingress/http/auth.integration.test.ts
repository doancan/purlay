/**
 * The whole sign-in, driven through real requests against a real database.
 *
 * GitHub is a double — the point is not that `fetch` works, it is that the
 * handshake, the state check, the identity rules and the session all fit
 * together, including when one of them refuses.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { ErrorResponse } from '@purlay/types';
import { createApp } from './app';
import { SESSION_COOKIE, STATE_COOKIE } from './cookies';
import { NOW, aGitHubAccount, testConfig, testDependencies } from './testing';
import type { Config } from '../../platform/config';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';

const appFor = (
  database: Executor,
  github = testDependencies().github,
  config = testDependencies().config,
): ReturnType<typeof createApp> => createApp(testDependencies({ database, github, config }));

/** Everything a browser would carry back from the redirect, in one place. */
const startAndCallback = async (
  database: Executor,
  options: {
    code?: string;
    tamperState?: boolean;
    github?: ReturnType<typeof aGitHubAccount>;
    config?: Config;
  } = {},
): Promise<Response> => {
  const app = appFor(
    database,
    options.github ?? testDependencies().github,
    options.config ?? testDependencies().config,
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
      expect(signedIn.status).toBe(302);
      expect(spent(signedIn)).toBe(true);

      const refused = await startAndCallback(db, { tamperState: true });
      expect(refused.status).toBe(400);
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

  test('a tampered state is refused, and no account is created', async () => {
    await withRollback(async (db) => {
      const response = await startAndCallback(db, { tamperState: true });

      expect(response.status).toBe(400);
      const body: unknown = await response.json();
      expect(Value.Check(ErrorResponse, body)).toBe(true);
      expect(body).toMatchObject({ error: { code: 'OAUTH_STATE_INVALID' } });

      expect(await accountsFor(db, 'mona@example.test')).toHaveLength(0);
    });
  });

  test('a callback with no cookie at all is refused', async () => {
    await withRollback(async (db) => {
      const response = await appFor(db).handle(
        new Request(`${ORIGIN}/auth/github/callback?code=a-valid-code&state=anything`),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'OAUTH_STATE_INVALID' } });
    });
  });

  test('an account with no verified address is refused, and nothing is written', async () => {
    await withRollback(async (db) => {
      const response = await startAndCallback(db, {
        github: aGitHubAccount({ id: 7, login: 'ghost', name: null, avatarUrl: null }, [
          { email: 'ghost@example.test', primary: true, verified: false },
        ]),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'EMAIL_REQUIRED' } });
      expect(await accountsFor(db, 'ghost@example.test')).toHaveLength(0);
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
      expect((await startAndCallback(db)).status).toBe(302);
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

/**
 * Phase 0's exit criterion, up to the socket: two different GitHub users end up
 * in one workspace through the real sign-in path, with no fixture and no bypass
 * (D-37). Without open join the second user has no way in at all.
 */
describe('integration: open join on sign-in', () => {
  const hubot = aGitHubAccount({ id: 2, login: 'hubot', name: 'Hubot', avatarUrl: null }, [
    { email: 'hubot@example.test', primary: true, verified: true },
  ]);

  const sessionFrom = (response: Response): string =>
    (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  const asJson = async (
    db: Executor,
    config: Config,
    method: string,
    path: string,
    cookie: string,
    body?: unknown,
  ): Promise<Response> =>
    await appFor(db, undefined, config).handle(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          cookie,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  /** Mona signs in and creates the workspace; then Hubot signs in. */
  const twoUsers = async (
    db: Executor,
    config: Config,
  ): Promise<{ hubot: string; workspaceId: string; channelId: string }> => {
    const mona = sessionFrom(await startAndCallback(db, { config }));
    const created = await asJson(db, config, 'POST', '/api/workspaces', mona, {
      name: 'Phase zero',
      slug: 'phase-zero',
    });
    expect(created.status).toBe(201);
    const workspaceId = ((await created.json()) as { id: string }).id;
    const channel = await asJson(
      db,
      config,
      'POST',
      `/api/workspaces/${workspaceId}/channels`,
      mona,
      {
        name: 'general',
      },
    );
    expect(channel.status).toBe(201);
    const channelId = ((await channel.json()) as { id: string }).id;

    const signedIn = await startAndCallback(db, { config, github: hubot });
    expect(signedIn.status).toBe(302);
    return { hubot: sessionFrom(signedIn), workspaceId, channelId };
  };

  test('with the slug set, a second GitHub user lands in the workspace and can join its channel', async () => {
    await withRollback(async (db) => {
      const config = testConfig({ WORKSPACE_OPEN_JOIN_SLUG: 'phase-zero' });
      const { hubot: cookie, workspaceId, channelId } = await twoUsers(db, config);

      const mine = await asJson(db, config, 'GET', '/api/workspaces', cookie);
      expect(await mine.json()).toMatchObject([{ workspace: { id: workspaceId }, role: 'member' }]);

      const joined = await asJson(db, config, 'POST', `/api/channels/${channelId}/join`, cookie);
      expect(joined.ok).toBe(true);
    });
  });

  test('unset, the instance is closed: the same second user has no way in', async () => {
    await withRollback(async (db) => {
      const config = testConfig();
      const { hubot: cookie, channelId } = await twoUsers(db, config);

      const mine = await asJson(db, config, 'GET', '/api/workspaces', cookie);
      expect(await mine.json()).toEqual([]);

      const joined = await asJson(db, config, 'POST', `/api/channels/${channelId}/join`, cookie);
      expect(joined.status).toBe(404);
    });
  });
});
