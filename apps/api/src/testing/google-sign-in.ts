/**
 * Sign in with Google for a test, through the sign-in library as a browser drives it (D-251): Google is the strict
 * OIDC double at the `fetch` boundary (`oidc-stub.ts`), standing at Google's own issuer, so everything between the
 * button and the session is the real thing — the library's state and nonce, its callback, its account rules, the
 * Google definition's issuers and address rules, Purlay's own hooks. As `oidc-sign-in.ts`, a test using this runs
 * on a clone of the test database, since the library's transactions need one.
 */
import type { Executor } from '@purlay/db';
import { GOOGLE_CALLBACK, GOOGLE_ISSUER } from '@purlay/types';
import type { Auth, AuthDependencies } from '../modules/auth/better-auth';
import { cookiesFrom, mergedCookies, type StartedSignIn } from './github-sign-in';
import { anOidcStub, OIDC_STUB_CREDENTIALS, type OidcPerson, type OidcStub } from './oidc-stub';
import { aTestAuth } from './signed-in';

/** Google, as the double plays it: at `https://accounts.google.com`, where a sign-in finds it unless told. */
export const aGoogleStub = async (
  person: OidcPerson,
  options: { readonly now?: () => number } = {},
): Promise<OidcStub> =>
  await anOidcStub(person, {}, undefined, { ...options, issuer: GOOGLE_ISSUER });

/** The instance a test signs in through: Google connected, answered by the double given. */
export const aGoogleAuth = (
  database: Executor,
  stub: OidcStub,
  options: Partial<Omit<AuthDependencies, 'database' | 'fetch'>> & {
    readonly signUp?: 'open' | 'invite-only';
  } = {},
): Auth => {
  const { signUp, ...rest } = options;
  return aTestAuth(database, {
    settings: {
      github: undefined,
      oidc: undefined,
      google: OIDC_STUB_CREDENTIALS,
      signUp: signUp ?? 'open',
    },
    googleIssuer: stub.issuer(),
    fetch: stub.fetch,
    ...rest,
  });
};

interface Handles {
  readonly handle: (request: Request) => Promise<Response>;
}

/** The button pressed: the redirect to Google, the state it carries, the cookie it set, and Google's code. */
export const startGoogleSignIn = async (
  app: Handles,
  origin: string,
  stub: OidcStub,
  cookie = '',
): Promise<StartedSignIn> => {
  const response = await app.handle(
    new Request(`${origin}/auth/google`, cookie === '' ? {} : { headers: { cookie } }),
  );
  const location = response.headers.get('location') ?? '';
  const state = location === '' ? '' : (new URL(location).searchParams.get('state') ?? '');
  const code = location === '' ? 'a-code' : stub.authorize(location).code;
  return { response, state, cookie: mergedCookies(cookie, cookiesFrom(response)), code };
};

/** What the browser brings back to the callback: the code and this browser's state. */
export const returnFromGoogle = async (
  app: Handles,
  origin: string,
  started: StartedSignIn,
): Promise<Response> =>
  await app.handle(
    new Request(
      `${origin}${GOOGLE_CALLBACK}?${new URLSearchParams({ code: started.code, state: started.state }).toString()}`,
      { headers: { cookie: started.cookie, 'user-agent': 'probe/1.0' } },
    ),
  );

/** The whole round trip, as one browser makes it, through Google. */
export const signInWithGoogle = async (
  app: Handles,
  origin: string,
  stub: OidcStub,
  cookie = '',
): Promise<Response> =>
  await returnFromGoogle(app, origin, await startGoogleSignIn(app, origin, stub, cookie));
