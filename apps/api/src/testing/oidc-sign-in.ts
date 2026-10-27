/**
 * A single sign-on for a test, through the sign-in library as a browser drives it (D-200): the provider is a
 * double at the `fetch` boundary the instance is handed (`oidc-stub.ts`), so everything between the button and
 * the session is the real thing — the library's state and nonce, its callback, its account rules, Purlay's own
 * hooks. As `github-sign-in.ts`, a test using this runs on a clone of the test database, since the library's
 * transactions need one.
 */
import type { Executor } from '@purlay/db';
import { OIDC_CALLBACK } from '@purlay/types';
import type { Auth, AuthDependencies } from '../modules/auth/better-auth';
import { cookiesFrom, mergedCookies, type StartedSignIn } from './github-sign-in';
import { OIDC_STUB_CREDENTIALS, type OidcStub } from './oidc-stub';
import { aTestAuth } from './signed-in';

/** The instance a test signs in through: a provider configured, answered by the double given. */
export const anOidcAuth = (
  database: Executor,
  stub: OidcStub,
  options: Partial<Omit<AuthDependencies, 'database' | 'fetch'>> & {
    readonly signUp?: 'open' | 'invite-only';
    readonly name?: string;
  } = {},
): Auth => {
  const { signUp, name, ...rest } = options;
  return aTestAuth(database, {
    settings: {
      github: undefined,
      oidc: { issuer: stub.issuer(), ...OIDC_STUB_CREDENTIALS, name },
      signUp: signUp ?? 'open',
    },
    fetch: stub.fetch,
    ...rest,
  });
};

interface Handles {
  readonly handle: (request: Request) => Promise<Response>;
}

/**
 * The button pressed: the redirect to the provider, the state it carries, the cookie it set — and, where the
 * test's provider was given, the code its authorize screen issued for this very request.
 */
export const startOidcSignIn = async (
  app: Handles,
  origin: string,
  stub?: OidcStub,
  cookie = '',
): Promise<StartedSignIn> => {
  const response = await app.handle(
    new Request(`${origin}/auth/oidc`, cookie === '' ? {} : { headers: { cookie } }),
  );
  const location = response.headers.get('location') ?? '';
  const state = location === '' ? '' : (new URL(location).searchParams.get('state') ?? '');
  const code = stub === undefined || location === '' ? 'a-code' : stub.authorize(location).code;
  return { response, state, cookie: mergedCookies(cookie, cookiesFrom(response)), code };
};

/** What the browser brings back to the callback; by default, the code and this browser's state. */
export const returnFromOidc = async (
  app: Handles,
  origin: string,
  started: StartedSignIn,
  query: Record<string, string> = { code: started.code, state: started.state },
  headers: Record<string, string> = {},
): Promise<Response> =>
  await app.handle(
    new Request(`${origin}${OIDC_CALLBACK}?${new URLSearchParams(query).toString()}`, {
      headers: { cookie: started.cookie, 'user-agent': 'probe/1.0', ...headers },
    }),
  );

/** The whole round trip, as one browser makes it, through this provider. */
export const signInWithOidc = async (
  app: Handles,
  origin: string,
  stub: OidcStub,
): Promise<Response> => await returnFromOidc(app, origin, await startOidcSignIn(app, origin, stub));
