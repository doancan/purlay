/**
 * The Better Auth instance behind its factory (D-179). What is checked here is configuration that
 * needs no database: the secret, the cookie, the mapping onto Purlay's own tables, and what a
 * sign-up may and may not do. That the mapped tables answer is checked against Postgres in
 * `better-auth.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { isAPIError } from 'better-auth/api';
import { unconnectedDatabase } from '@purlay/db';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@purlay/types';
import {
  DEVELOPMENT_ENCRYPTION_KEY,
  GITHUB_API_URL_DEFAULT,
  GITHUB_URL_DEFAULT,
} from '../../platform/config';
import { clearedSessionCookie } from '../../platform/cookies';
import { createLogger } from '../../platform/logging';
import { outbox } from '../../platform/mail';
import { systemClock } from '../../platform/clock';
import type { EventBus } from '../../platform/events';
import {
  createAuth,
  deriveAuthSecret,
  type AuthDependencies,
  type AuthSettings,
  type GithubFetch,
} from './better-auth';

const log = createLogger({ level: 'silent' });
// A pool is lazy: nothing connects until a query runs, and none of these tests runs one.
const database = unconnectedDatabase();

/** A bus nobody hears on: no test here ends a session. */
const nobodyListening: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => true,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

const closedToGithub: AuthSettings = { github: undefined, oidc: undefined, signUp: 'open' };

const deps = (over: Partial<AuthDependencies> = {}): AuthDependencies => ({
  database,
  baseUrl: 'https://purlay.example.com',
  secret: deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY),
  mailer: outbox(() => Promise.resolve(), log),
  log,
  settings: closedToGithub,
  githubUrls: { web: GITHUB_URL_DEFAULT, api: GITHUB_API_URL_DEFAULT },
  sessionTtlDays: 30,
  bus: nobodyListening,
  clock: systemClock,
  ...over,
});

describe('deriveAuthSecret', () => {
  test('is the same for the same key, and 32 bytes or more', () => {
    const first = deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY);
    expect(deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY)).toBe(first);
    expect(Buffer.from(first, 'base64').length).toBeGreaterThanOrEqual(32);
  });

  test('is not the key it came from, and another key gives another secret', () => {
    const other = Buffer.alloc(32, 7).toString('base64');
    expect(deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY)).not.toBe(DEVELOPMENT_ENCRYPTION_KEY);
    expect(deriveAuthSecret(other)).not.toBe(deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY));
  });

  test('is not what the OAuth state or the credential cipher derive: the label separates uses', () => {
    const root = Buffer.from(DEVELOPMENT_ENCRYPTION_KEY, 'base64');
    const labelled = new Bun.CryptoHasher('sha256', root)
      .update('purlay:credential:v1')
      .digest('base64');
    expect(deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY)).not.toBe(labelled);
  });
});

describe('createAuth', () => {
  test('refuses to build with a secret shorter than 32 bytes', () => {
    expect(() => createAuth(deps({ secret: 'short' }))).toThrow();
  });

  test('builds with the cookie name __Host-purlay_session', () => {
    expect(createAuth(deps()).options.advanced?.cookies?.['session_token']?.name).toBe(
      '__Host-purlay_session',
    );
  });

  test('names the session cookie __Host-purlay_session on the wire, without a __Secure- prefix', async () => {
    const context = await createAuth(deps()).$context;
    expect(context.authCookies.sessionToken.name).toBe('__Host-purlay_session');
    expect(context.authCookies.sessionToken.attributes.secure).toBe(true);
  });

  /**
   * A browser keys a cookie on name, domain and path. If the cookie that clears the session differs
   * from the one the library sets in any of them, it becomes a *second* cookie and the session
   * survives the sign-out — silently, which is the worst way for a sign-out to fail.
   */
  test('the cookie that clears the session matches the one the library sets, on everything a browser keys on', async () => {
    const { name, attributes } = (await createAuth(deps()).$context).authCookies.sessionToken;
    const cleared = clearedSessionCookie();
    const parts = cleared.split('; ');
    expect(parts[0]).toBe(`${name}=`);
    expect(parts).toContain(`Path=${attributes.path ?? '/'}`);
    expect(parts.includes('HttpOnly')).toBe(attributes.httpOnly === true);
    expect(parts.includes('Secure')).toBe(attributes.secure === true);
    expect(parts.map((part) => part.toLowerCase())).toContain(
      `samesite=${String(attributes.sameSite).toLowerCase()}`,
    );
    expect(new Date(cleared.split('Expires=')[1] ?? '').getTime()).toBeLessThan(Date.now());
  });

  test('never sends telemetry', () => {
    expect(createAuth(deps()).options.telemetry?.enabled).toBe(false);
  });

  test('maps users, sessions, accounts and verifications onto Purlay tables', () => {
    const { options } = createAuth(deps());
    expect(options.user?.modelName).toBe('users');
    expect(options.user?.fields).toMatchObject({ name: 'display_name', image: 'avatar_url' });
    expect(options.session?.modelName).toBe('sessions');
    expect(options.session?.fields).toMatchObject({
      token: 'token_hash',
      updatedAt: 'last_used_at',
    });
    expect(options.account?.modelName).toBe('accounts');
    expect(options.verification?.modelName).toBe('verifications');
    expect(options.rateLimit).toMatchObject({ storage: 'database', modelName: 'rate_limits' });
  });

  test('takes no username from a client: the OAuth callback needs the field open, so the routes that accept one are shut', () => {
    const { options } = createAuth(deps());
    const field = Object.entries(options.user?.additionalFields ?? {}).find(
      ([name]) => name === 'username',
    )?.[1];
    expect(field).toMatchObject({ required: true });
    expect(options.emailAndPassword?.disableSignUp).toBe(true);
    expect(options.disabledPaths).toContain('/update-user');
  });

  test('holds every password route of the library to the policy’s lengths, and lets nobody ask for a reset by mail', async () => {
    const auth = createAuth(deps());
    expect(auth.options.emailAndPassword).toMatchObject({
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    });
    expect(auth.options.emailAndPassword?.requireEmailVerification).toBeUndefined();
    expect(auth.options.emailAndPassword?.sendResetPassword).toBeUndefined();
    expect((await auth.$context).password.config).toEqual({
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    });
    expect(auth.options.disabledPaths).toContain('/request-password-reset');
  });

  test('throttles the password routes once, by our count: the library’s own rule for them is off', () => {
    expect(createAuth(deps()).options.rateLimit?.customRules).toEqual({
      '/sign-in/email': false,
      '/change-password': false,
    });
  });

  test('weighs no password outside a round: an API call that would go uncounted is refused', async () => {
    const auth = createAuth(deps());
    const refused = await auth.api
      .signInEmail({ body: { email: 'a@example.com', password: 'a password 1234' } })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(isAPIError(refused) && refused.statusCode).toBe(500);
  });

  test('nothing in the server calls the library’s setPassword: it has no route, so no hook holds it to the policy', async () => {
    // A server-only endpoint has no path, and the `before` hook that holds a new password to the policy
    // matches by path: a caller of `setPassword` would set any password at all. Route one through
    // `passwordProblem` before adding it here.
    const callers: string[] = [];
    for await (const file of new Bun.Glob('**/*.ts').scan({ cwd: `${import.meta.dir}/../..` })) {
      if (file.endsWith('.test.ts')) continue;
      const source = await Bun.file(`${import.meta.dir}/../../${file}`).text();
      if (/\.setPassword\b|\[.setPassword.\]/.test(source)) callers.push(file);
    }
    expect(callers).toEqual([]);
  });

  test('keeps no provider token: the account hooks null every one of them', async () => {
    const { account } = createAuth(deps()).options.databaseHooks ?? {};
    const given = {
      accessToken: 'a',
      refreshToken: 'r',
      idToken: 'i',
      accessTokenExpiresAt: new Date(),
      refreshTokenExpiresAt: new Date(),
      scope: 'read:user',
      providerId: 'another-provider',
    };
    for (const hook of [account?.create?.before, account?.update?.before]) {
      const result = (await hook?.(given as never, null)) as { data: Record<string, unknown> };
      expect(result.data).toMatchObject({
        accessToken: null,
        refreshToken: null,
        idToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: 'read:user',
        providerId: 'another-provider',
      });
    }
  });

  test('has no GitHub provider unless settings give one', async () => {
    expect((await createAuth(deps()).$context).socialProviders).toEqual([]);
    const withGithub = createAuth(
      deps({
        settings: {
          github: { clientId: 'id', clientSecret: 'secret' },
          oidc: undefined,
          signUp: 'open',
        },
      }),
    );
    const providers = (await withGithub.$context).socialProviders;
    expect(providers.map((provider) => provider.id)).toEqual(['github']);
    expect(providers[0]?.options?.clientId).toBe('id');
  });

  test('says whether it has a GitHub provider, so ingress never asks the library for one it lacks', () => {
    expect(createAuth(deps()).github).toBe(false);
    expect(
      createAuth(
        deps({
          settings: {
            github: { clientId: 'id', clientSecret: 's' },
            oidc: undefined,
            signUp: 'open',
          },
        }),
      ).github,
    ).toBe(true);
  });

  test('has no sign-in by link without a relay: no plugin, no routes, no handle', async () => {
    const without = createAuth(deps({ mailer: undefined }));
    expect(without.signInLinks).toBeUndefined();
    expect(without.options.plugins?.map((plugin) => plugin.id) ?? []).not.toContain('magic-link');
    const asked = await without.handler(
      new Request('https://purlay.example.com/auth/sign-in/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://purlay.example.com' },
        body: JSON.stringify({ email: 'ada@example.test' }),
      }),
    );
    expect(asked.status).toBe(404);
    const withRelay = createAuth(deps());
    expect(withRelay.options.plugins?.map((plugin) => plugin.id)).toContain('magic-link');
  });

  test('never trusts a provider to link by address alone', () => {
    const { options } = createAuth(
      deps({
        settings: {
          github: { clientId: 'id', clientSecret: 's' },
          oidc: undefined,
          signUp: 'open',
        },
      }),
    );
    expect(options.account?.accountLinking).not.toHaveProperty('trustedProviders');
    expect(options.account?.accountLinking?.enabled).toBe(true);
    // The local-address gate is the library's default and its option is being removed; that it holds
    // is shown by behaviour (the sign-in tests), and the mutations below turn it off to prove it.
  });

  test('closes sign-up by password; GitHub’s own switch is never on, the hook decides who may sign up (R51)', async () => {
    expect(createAuth(deps()).options.emailAndPassword?.disableSignUp).toBe(true);
    const closed = createAuth(
      deps({
        settings: {
          github: { clientId: 'id', clientSecret: 's' },
          oidc: undefined,
          signUp: 'invite-only',
        },
      }),
    );
    // Off on an invite-only server too: the provider would refuse before the passport hook could let an
    // invited newcomer in (`invitation-passport.integration.test.ts` shows the hook refusing the rest).
    expect((await closed.$context).socialProviders[0]?.options?.disableSignUp).toBe(false);
    const open = (
      await createAuth(
        deps({
          settings: {
            github: { clientId: 'id', clientSecret: 's' },
            oidc: undefined,
            signUp: 'open',
          },
        }),
      ).$context
    ).socialProviders[0];
    expect(open?.options?.disableSignUp).toBe(false);
  });

  // The session hook reads the account before it writes (a soft-deleted one starts no session), so
  // what it does with an empty address is asserted against the database:
  // `better-auth.integration.test.ts`, "writes a session … an empty address as null".

  // The user hook takes the first free username, which is a read: asserted against the database in
  // `better-auth.integration.test.ts`, "shapes every username …".

  test('lasts SESSION_TTL_DAYS from sign-in and is never slid forward by use (R25)', () => {
    const { options } = createAuth(deps({ sessionTtlDays: 7 }));
    expect(options.session?.expiresIn).toBe(7 * 24 * 60 * 60);
    expect(options.session?.disableSessionRefresh).toBe(true);
    expect(options.session?.cookieCache?.enabled).toBe(false);
  });

  test('answers under /auth, and sends a callback that fails before it has a state to the sign-in screen', async () => {
    const auth = createAuth(deps());
    expect(auth.options.basePath).toBe('/auth');
    expect(auth.options.onAPIError?.errorURL).toBe('https://purlay.example.com/sign-in');
    expect((await auth.$context).baseURL).toBe('https://purlay.example.com/auth');
  });

  test('names the OAuth state’s cookie __Host-purlay_oauth_state on the wire', async () => {
    const context = await createAuth(deps()).$context;
    const state = context.createAuthCookie('state');
    expect(state.name).toBe('__Host-purlay_oauth_state');
    expect(state.attributes).toMatchObject({ secure: true, path: '/', httpOnly: true });
    expect(state.attributes).not.toHaveProperty('domain');
  });

  test('reads a client’s address only from the header ingress decides', () => {
    expect(createAuth(deps()).options.advanced?.ipAddress?.ipAddressHeaders).toEqual([
      'x-purlay-client-address',
    ]);
  });
});

describe('the GitHub address guard', () => {
  const TOKEN = 'gho_secret_token_value';
  const profile = {
    id: 4242,
    login: 'Ada-L',
    name: 'Ada Lovelace',
    avatar_url: 'https://avatars.example.com/ada',
  };
  const reply = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status });

  const lines: string[] = [];
  const recording = createLogger({ level: 'debug', write: (line) => lines.push(line) });

  const userInfoOf = async (answers: { user?: Response; emails: Response }): Promise<unknown> => {
    const get: GithubFetch = (url) =>
      Promise.resolve(
        url.endsWith('/emails') ? answers.emails : (answers.user ?? reply(200, profile)),
      );
    const auth = createAuth(
      deps({
        log: recording,
        fetch: get,
        settings: {
          github: { clientId: 'id', clientSecret: 's' },
          oidc: undefined,
          signUp: 'open',
        },
      }),
    );
    const provider = (await auth.$context).socialProviders[0];
    return await provider?.getUserInfo({ accessToken: TOKEN });
  };

  /** The status the provider's call failed with, when it throws rather than refusing. */
  const failureOf = async (answers: { user?: Response; emails: Response }): Promise<unknown> =>
    await userInfoOf(answers).then(
      () => 'answered',
      (error: unknown) => (isAPIError(error) ? error.statusCode : String(error)),
    );

  test('refuses an unverified primary address', async () => {
    expect(
      await userInfoOf({
        emails: reply(200, [{ email: 'a@x.io', primary: true, verified: false }]),
      }),
    ).toBeNull();
  });

  test('refuses a verified address that is not the primary', async () => {
    expect(
      await userInfoOf({
        emails: reply(200, [
          { email: 'a@x.io', primary: true, verified: false },
          { email: 'b@x.io', primary: false, verified: true },
        ]),
      }),
    ).toBeNull();
  });

  test('refuses an account with no addresses at all', async () => {
    expect(await userInfoOf({ emails: reply(200, []) })).toBeNull();
  });

  test('says GitHub failed for an addresses body that is not a list', async () => {
    expect(await failureOf({ emails: reply(200, { message: 'rate limited' }) })).toBe(502);
  });

  test('says GitHub failed when the user call fails, and logs no token', async () => {
    lines.length = 0;
    expect(
      await failureOf({
        user: reply(500, {}),
        emails: reply(200, [{ email: 'a@x.io', primary: true, verified: true }]),
      }),
    ).toBe(502);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  test('says GitHub failed when the addresses call fails', async () => {
    expect(await failureOf({ emails: reply(500, {}) })).toBe(502);
  });

  test('says GitHub failed for a profile that is not an identity', async () => {
    expect(
      await failureOf({
        user: reply(200, { login: 'no-id' }),
        emails: reply(200, [{ email: 'a@x.io', primary: true, verified: true }]),
      }),
    ).toBe(502);
  });

  test('refuses a primary verified address with a control character in it', async () => {
    expect(
      await userInfoOf({
        emails: reply(200, [{ email: 'a\u0000@x.io', primary: true, verified: true }]),
      }),
    ).toBeNull();
  });

  test('is served only inside the handler, where the GitHub columns are written', async () => {
    expect(
      await failureOf({ emails: reply(200, [{ email: 'a@x.io', primary: true, verified: true }]) }),
    ).toBe(500);
  });

  test('never asks for a token without the PKCE verifier its authorization was bound to', async () => {
    const asked: string[] = [];
    const auth = createAuth(
      deps({
        fetch: (url) => {
          asked.push(url);
          return Promise.resolve(Response.json({ access_token: 'gho_x' }));
        },
        settings: {
          github: { clientId: 'id', clientSecret: 's' },
          oidc: undefined,
          signUp: 'open',
        },
      }),
    );
    const provider = (await auth.$context).socialProviders[0];
    expect(await provider?.validateAuthorizationCode({ code: 'c', redirectURI: 'r' })).toBeNull();
    expect(asked).toEqual([]);
    expect(
      await provider?.validateAuthorizationCode({ code: 'c', codeVerifier: 'v', redirectURI: 'r' }),
    ).toMatchObject({ accessToken: 'gho_x' });
  });
});

describe('the route a path under /auth reaches, as a log line names it', () => {
  const auth = createAuth(deps());

  test('is the library’s own route, read from its endpoint table, for a path it serves', () => {
    for (const route of [
      '/sign-in/social',
      '/get-session',
      '/sign-out',
      '/revoke-sessions',
      '/revoke-other-sessions',
      '/reset-password',
      '/update-user',
      '/sign-in/email',
      '/change-password',
      '/ok',
    ]) {
      expect(auth.routeOf(`/auth${route}`)).toBe(`/auth${route}`);
    }
  });

  test('keeps a parameter as the pattern spells it, never as the caller filled it', () => {
    const token = `reset-${'f'.repeat(32)}`;
    expect(auth.routeOf(`/auth/reset-password/${token}`)).toBe('/auth/reset-password/:token');
    expect(auth.routeOf('/auth/callback/github')).toBe('/auth/callback/:id');
  });

  test('is /auth/* for a path it has no route for: another segment, a parameter left empty, another case', () => {
    expect(auth.routeOf(`/auth/${crypto.randomUUID()}/${crypto.randomUUID()}`)).toBe('/auth/*');
    expect(auth.routeOf('/auth/nobody')).toBe('/auth/*');
    expect(auth.routeOf('/auth/revoke-sessions/extra')).toBe('/auth/*');
    expect(auth.routeOf('/auth/reset-password/')).toBe('/auth/*');
    expect(auth.routeOf('/auth/callback/github/more')).toBe('/auth/*');
    expect(auth.routeOf('/auth/REVOKE-SESSIONS')).toBe('/auth/*');
    expect(auth.routeOf('/auth/')).toBe('/auth/*');
    expect(auth.routeOf('/auth')).toBe('/auth/*');
    expect(auth.routeOf('/elsewhere/revoke-sessions')).toBe('/auth/*');
  });
});
