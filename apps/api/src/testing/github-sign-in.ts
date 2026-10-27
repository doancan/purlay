/**
 * A GitHub sign-in for a test, through the sign-in library as a browser drives it (D-179).
 *
 * GitHub is a double at the `fetch` boundary the library is handed — the token endpoint and both API
 * calls — so everything between the button and the session is the real thing: the library's state,
 * its callback, its account rules, and Purlay's own columns written beside them. The library's
 * transactions need a database rather than a rolled-back transaction, so a test using this runs on a
 * clone (`cloneIntegrationDatabase`) or a database it cleans up.
 */
import type { Executor } from '@purlay/db';
import { SIGN_IN_CALLBACK } from '@purlay/types';
import type { Auth, AuthDependencies, GithubFetch } from '../modules/auth/better-auth';
import { aTestAuth } from './signed-in';
import {
  GITHUB_STUB_CREDENTIALS,
  aGitHubStub,
  type GitHubBehaviour,
  type GitHubPerson,
  type GitHubStub,
} from './github-stub';

export type { GitHubBehaviour, GitHubCalls, GitHubPerson, GitHubStub } from './github-stub';

const unique = (): string => crypto.randomUUID().slice(0, 8);

/** An account nobody else has, its address primary and verified. */
export const aGitHubPerson = (
  login = `Ada-${unique()}`,
  over: Partial<GitHubPerson> = {},
): GitHubPerson => ({
  id: Math.floor(Math.random() * 1_000_000_000) + 1,
  login,
  name: 'Ada Lovelace',
  email: `${login.toLowerCase()}@example.test`,
  ...over,
});

/** GitHub, answering for this person as told, and as strict as GitHub (`github-stub.ts`). */
export const aGitHubFor = (person: GitHubPerson, behaviour: GitHubBehaviour = {}): GitHubStub =>
  aGitHubStub(person, behaviour);

/** The instance a test signs in through: GitHub configured, answered by the double given. */
export const aGitHubAuth = (
  database: Executor,
  fetch: GithubFetch,
  options: Partial<Omit<AuthDependencies, 'database' | 'fetch'>> & {
    readonly signUp?: 'open' | 'invite-only';
  } = {},
): Auth => {
  const { signUp, ...rest } = options;
  return aTestAuth(database, {
    settings: {
      github: GITHUB_STUB_CREDENTIALS,
      oidc: undefined,
      signUp: signUp ?? 'open',
    },
    fetch,
    ...rest,
  });
};

/** The `Cookie` header a browser would send back, from what a response set. */
export const cookiesFrom = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='))
    .join('; ');

/** Two `Cookie` headers as one, a later value of a name replacing an earlier one, as a browser keeps them. */
export const mergedCookies = (...headers: readonly string[]): string => {
  const jar = new Map<string, string>();
  for (const header of headers) {
    for (const pair of header.split(';')) {
      const trimmed = pair.trim();
      const at = trimmed.indexOf('=');
      if (at > 0) jar.set(trimmed.slice(0, at), trimmed.slice(at + 1));
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
};

interface Handles {
  readonly handle: (request: Request) => Promise<Response>;
}

/**
 * The button pressed: the redirect to GitHub, the state it carries, the cookie it set — and, where
 * the test's GitHub was given, the code its authorize screen issued for this very request.
 */
export interface StartedSignIn {
  readonly response: Response;
  readonly state: string;
  readonly cookie: string;
  readonly code: string;
}

export const startGitHubSignIn = async (
  app: Handles,
  origin: string,
  github?: GitHubStub,
  cookie = '',
): Promise<StartedSignIn> => {
  const response = await app.handle(
    new Request(`${origin}/auth/github`, cookie === '' ? {} : { headers: { cookie } }),
  );
  const location = response.headers.get('location') ?? '';
  const state = location === '' ? '' : (new URL(location).searchParams.get('state') ?? '');
  const code = github === undefined || location === '' ? 'a-code' : github.authorize(location).code;
  return { response, state, cookie: mergedCookies(cookie, cookiesFrom(response)), code };
};

/** What the browser brings back to the callback; by default, the code and this browser's state. */
export const returnFromGitHub = async (
  app: Handles,
  origin: string,
  started: StartedSignIn,
  query: Record<string, string> = { code: started.code, state: started.state },
  headers: Record<string, string> = {},
): Promise<Response> =>
  await app.handle(
    new Request(`${origin}${SIGN_IN_CALLBACK}?${new URLSearchParams(query).toString()}`, {
      headers: { cookie: started.cookie, 'user-agent': 'probe/1.0', ...headers },
    }),
  );

/** The whole round trip, as one browser makes it, through this GitHub. */
export const signInWithGitHub = async (
  app: Handles,
  origin: string,
  github: GitHubStub,
): Promise<Response> =>
  await returnFromGitHub(app, origin, await startGitHubSignIn(app, origin, github));
