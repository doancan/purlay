/**
 * Where a GitHub sign-in goes (D-179, `CONFIG.md`: `GITHUB_URL`, `GITHUB_API_URL`): github.com and its
 * API unless the deployment names another — and, named, every call of the sign-in goes there and
 * nowhere else.
 *
 * The second half is a whole sign-in against the strict stand-in for GitHub served on a loopback port
 * (`testing/github-stub.ts`), through the platform's own `fetch`: nothing is handed to the library in
 * place of GitHub, and no address is rewritten on its way out. What reaches the stand-in is exactly
 * what a GitHub Enterprise Server at that address would be asked.
 *
 * On a clone of its own: the library's sign-up is a transaction of its own (`github-sign-in.ts`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase, CLONE_HOOK_MS } from '@purlay/db';
import { createApp } from './app';
import { DEVELOPMENT_ENCRYPTION_KEY, loadConfig } from '../../platform/config';
import { SESSION_COOKIE } from '../../platform/cookies';
import { testConfig, testDependencies } from '../../testing/doubles';
import {
  aGitHubPerson,
  cookiesFrom,
  returnFromGitHub,
  startGitHubSignIn,
} from '../../testing/github-sign-in';
import { aGitHubStub, GITHUB_STUB_CREDENTIALS, type GitHubStub } from '../../testing/github-stub';
import { aFloodingServer, aRedirectingServer } from '../../testing/hostile-servers';
import type { GithubFetch } from '../../modules/auth/better-auth';
import { aTestAuth } from '../../testing/signed-in';

const ORIGIN = 'https://purlay.test';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
});

/** GitHub's addresses as the configuration gives them, from this environment. */
const githubUrlsOf = (environment: Record<string, string>): { web: string; api: string } => {
  const config = loadConfig({
    APP_URL: ORIGIN,
    DATABASE_URL: 'postgres://unused',
    GITHUB_CLIENT_ID: GITHUB_STUB_CREDENTIALS.clientId,
    GITHUB_CLIENT_SECRET: GITHUB_STUB_CREDENTIALS.clientSecret,
    ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
    ...environment,
  });
  return { web: config.GITHUB_URL, api: config.GITHUB_API_URL };
};

describe('integration: GitHub’s addresses', () => {
  test('unset, a sign-in is sent to github.com and calls github.com and its API, nothing else', async () => {
    const person = aGitHubPerson();
    // The strict stand-in as the library's `fetch`: here only to record what a sign-in would call.
    const github = aGitHubStub(person);
    const app = createApp(
      testDependencies({
        database: cloned.db,
        config: testConfig({ APP_URL: ORIGIN }),
        auth: aTestAuth(cloned.db, {
          baseUrl: ORIGIN,
          settings: { github: GITHUB_STUB_CREDENTIALS, oidc: undefined, signUp: 'open' },
          githubUrls: githubUrlsOf({}),
          fetch: github.fetch,
        }),
      }),
    );
    const started = await startGitHubSignIn(app, ORIGIN, github);
    const location = new URL(started.response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(
      'https://github.com/login/oauth/authorize',
    );
    const back = await returnFromGitHub(app, ORIGIN, started);
    expect(back.headers.get('location')).toBe(ORIGIN);
    expect(github.calls.urls).toEqual([
      'https://github.com/login/oauth/access_token',
      'https://api.github.com/user',
      'https://api.github.com/user/emails',
    ]);
  });

  test('named, a whole sign-in runs against a GitHub on this machine, through the platform’s fetch', async () => {
    const person = aGitHubPerson();
    const github = aGitHubStub(person);
    const served = github.serve(0);
    try {
      const app = createApp(
        testDependencies({
          database: cloned.db,
          config: testConfig({ APP_URL: ORIGIN }),
          // No `fetch`: the library's calls leave through the platform's, to the addresses configured.
          auth: aTestAuth(cloned.db, {
            baseUrl: ORIGIN,
            settings: { github: GITHUB_STUB_CREDENTIALS, oidc: undefined, signUp: 'open' },
            githubUrls: githubUrlsOf({ GITHUB_URL: served.url, GITHUB_API_URL: `${served.url}/` }),
          }),
        }),
      );

      // The button: a redirect to the stand-in's authorize screen.
      const button = await app.handle(new Request(`${ORIGIN}/auth/github`));
      const authorize = button.headers.get('location') ?? '';
      expect(authorize.startsWith(`${served.url}/login/oauth/authorize?`)).toBe(true);

      // The person presses Authorize there: the stand-in checks the request and sends them back.
      const granted = await fetch(authorize, { redirect: 'manual' });
      expect(granted.status).toBe(302);
      const callback = new URL(granted.headers.get('location') ?? '');
      expect(`${callback.origin}${callback.pathname}`).toBe(`${ORIGIN}/auth/callback/github`);

      // Back at the callback with the browser's cookies: the code is redeemed and the person read,
      // over the network, at the stand-in.
      const back = await app.handle(
        new Request(callback.toString(), {
          headers: { cookie: cookiesFrom(button), 'user-agent': 'probe/1.0' },
        }),
      );
      expect(github.refusals).toEqual([]);
      expect(back.status).toBe(302);
      expect(back.headers.get('location')).toBe(ORIGIN);
      expect(
        back.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)),
      ).toBe(true);
      const user = await cloned.db
        .selectFrom('users')
        .select(['github_login', 'email_verified'])
        .where('email', '=', person.email)
        .executeTakeFirstOrThrow();
      expect(user).toEqual({ github_login: person.login, email_verified: true });
      // Nothing went through a `fetch` of the test's: the stub's own list is of injected calls only.
      expect(github.calls.urls).toEqual([]);
    } finally {
      served.stop();
    }
  });

  test('a stand-in that refuses the code is GitHub refusing it: the person is sent back, not signed in', async () => {
    const github = aGitHubStub(
      aGitHubPerson(),
      {},
      { clientId: 'client-id', clientSecret: 'other' },
    );
    const served = github.serve(0);
    try {
      const app = createApp(
        testDependencies({
          database: cloned.db,
          config: testConfig({ APP_URL: ORIGIN }),
          auth: aTestAuth(cloned.db, {
            baseUrl: ORIGIN,
            settings: { github: GITHUB_STUB_CREDENTIALS, oidc: undefined, signUp: 'open' },
            githubUrls: { web: served.url, api: served.url },
          }),
        }),
      );
      const started = await startGitHubSignIn(app, ORIGIN);
      const granted = await fetch(started.response.headers.get('location') ?? '', {
        redirect: 'manual',
      });
      const callback = new URL(granted.headers.get('location') ?? '');
      const back = await app.handle(
        new Request(callback.toString(), { headers: { cookie: started.cookie } }),
      );
      expect(github.refusals).toEqual(['incorrect_client_credentials']);
      expect(back.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=github-unavailable`);
    } finally {
      served.stop();
    }
  });
});

describe('integration: a GitHub that redirects, or floods (D-179 §4.4)', () => {
  /**
   * The library's `fetch`: the stub for every call, but those `hostile` names, which go — by the
   * platform's own `fetch`, with the init the sign-in gave — to a server that misbehaves.
   */
  const through =
    (hostile: string, paths: readonly string[], stub: GitHubStub): GithubFetch =>
    async (url, init) => {
      const { pathname } = new URL(url);
      return paths.includes(pathname)
        ? await fetch(`${hostile}${pathname}`, init)
        : await stub.fetch(url, init);
    };

  const signInThrough = async (fetchOf: (stub: GitHubStub) => GithubFetch): Promise<Response> => {
    const stub = aGitHubStub(aGitHubPerson());
    const app = createApp(
      testDependencies({
        database: cloned.db,
        config: testConfig({ APP_URL: ORIGIN }),
        auth: aTestAuth(cloned.db, {
          baseUrl: ORIGIN,
          settings: { github: GITHUB_STUB_CREDENTIALS, oidc: undefined, signUp: 'open' },
          fetch: fetchOf(stub),
        }),
      }),
    );
    return await returnFromGitHub(app, ORIGIN, await startGitHubSignIn(app, ORIGIN, stub));
  };

  const signedIn = (response: Response): boolean =>
    response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));

  test('a token endpoint that redirects is not followed: the secret and the code go nowhere else', async () => {
    const redirecting = aRedirectingServer(307);
    try {
      const back = await signInThrough((stub) =>
        through(redirecting.url, ['/login/oauth/access_token'], stub),
      );
      expect(redirecting.elsewhere).toEqual([]);
      expect(signedIn(back)).toBe(false);
      expect(back.headers.get('location')).not.toBe(ORIGIN);
    } finally {
      redirecting.stop();
    }
  });

  test('a profile or address list that redirects is not followed: the token goes nowhere else', async () => {
    const redirecting = aRedirectingServer(308);
    try {
      const back = await signInThrough((stub) =>
        through(redirecting.url, ['/user', '/user/emails'], stub),
      );
      expect(redirecting.elsewhere).toEqual([]);
      expect(signedIn(back)).toBe(false);
      expect(back.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=github-unavailable`);
    } finally {
      redirecting.stop();
    }
  });

  test('a profile that never ends is read no further than a bound', async () => {
    const flooding = aFloodingServer(300 * 1024 * 1024);
    try {
      const back = await signInThrough((stub) => through(flooding.url, ['/user'], stub));
      expect(signedIn(back)).toBe(false);
      await Bun.sleep(100);
      expect(flooding.written()).toBeLessThan(4 * 1024 * 1024);
    } finally {
      flooding.stop();
    }
  });
});
