/**
 * GitHub's side of an OAuth sign-in, strict enough to refuse what GitHub refuses — for a test's `fetch`
 * and, served on a port, for a browser run that cannot reach GitHub.
 *
 * What it checks is what GitHub's documentation says it checks
 * (docs.github.com, "Authorizing OAuth apps", and "Troubleshooting OAuth app access token request
 * errors"): the authorize request names the app's `client_id`, a `redirect_uri`, a `state`, the
 * `user:email` scope, and a PKCE `code_challenge` with `code_challenge_method=S256`; the token request
 * carries the same `client_id`, the app's `client_secret`, a code issued once and not spent, the same
 * `redirect_uri`, and the `code_verifier` whose SHA-256 is the challenge. Anything else is answered as
 * GitHub answers it — `200` with `{ error, error_description }` — so a client that forgets the
 * verifier is refused here as it would be there, and a test that passes is one GitHub would pass. A
 * `client_id` it does not know is answered as github.com answers one (measured, not documented):
 * `404` and `{"error":"Not Found"}`; the setup's probe meets both refusals (D-179 §4.4).
 *
 * The API calls take only a token this stub issued, as `Authorization: Bearer`.
 */
import type { GithubFetch } from '../modules/auth/better-auth';
import type { GitHubAppFetch } from '../modules/integrations/github-app-api';
import { answeredWithin, type GitHubAppStub } from './github-app-stub';
import type { GitHubApi } from '../modules/integrations/unfurl';

/** A GitHub account as GitHub's API describes it. */
export interface GitHubPerson {
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  readonly email: string;
  /** Unset: `email`, primary and verified. */
  readonly emails?: readonly { email: string; primary: boolean; verified: boolean }[];
}

/** How the stub answers, where a test needs GitHub to fail. */
export interface GitHubBehaviour {
  readonly token?: 'gives' | 'refuses' | 'unreachable' | 'spent';
  readonly user?: 'answers' | 'fails' | 'unreachable';
}

/** Every call asked of the stub through `fetch`, in order, and whether each carried a deadline. */
export interface GitHubCalls {
  readonly urls: string[];
  readonly signals: boolean[];
}

/** What a test learns from GitHub's authorize screen: where it sends the browser back, and with what. */
interface Authorized {
  readonly code: string;
  readonly state: string;
  readonly redirectUri: string;
}

export interface GitHubStub {
  /** GitHub's authorize screen, the person pressing Authorize: checks the request, issues a code. */
  readonly authorize: (location: string) => Authorized;
  /** The token endpoint and the API, as a `fetch` the sign-in library is handed. */
  readonly fetch: GithubFetch;
  /** The same, as the GitHub App's calls are made (D-246): its App's answers first, when it plays one. */
  readonly appFetch: GitHubAppFetch;
  readonly calls: GitHubCalls;
  /** Every token request the stub refused, with GitHub's `error`, for a test to read. */
  readonly refusals: string[];
  /** Every code a token request presented, issued or not, in order. */
  readonly presentedCodes: string[];
  /**
   * The stub on a port, for a run with a real browser: authorize, token, user and emails. On the
   * loopback address unless another is named: a stub that hands out tokens is nobody else's to reach.
   */
  readonly serve: (
    port: number,
    hostname?: string,
  ) => { readonly url: string; readonly boundTo: string | undefined; readonly stop: () => void };
}

export const GITHUB_STUB_CREDENTIALS = { clientId: 'client-id', clientSecret: 'client-secret' };

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_PATH = '/login/oauth/access_token';

/** A code lasts ten minutes at GitHub (docs: "Authorizing OAuth apps"). */
const CODE_LIFETIME_MS = 10 * 60 * 1000;

const random = (): string => crypto.randomUUID().replaceAll('-', '');

/** S256: the base64url SHA-256 of the verifier, unpadded (RFC 7636 §4.2). */
const challengeOf = (verifier: string): string =>
  new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');

/** GitHub's refusal of a token request: `200`, and the reason in the body. */
const refused = (error: string, description: string): Response =>
  Response.json({
    error,
    error_description: description,
    error_uri:
      'https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors',
  });

const bodyOf = async (request: Request): Promise<Record<string, string>> => {
  const text = await request.text();
  if ((request.headers.get('content-type') ?? '').includes('application/json')) {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? Object.fromEntries(
          Object.entries(parsed).map(([key, value]) => [
            key,
            typeof value === 'string' ? value : '',
          ]),
        )
      : {};
  }
  return Object.fromEntries(new URLSearchParams(text));
};

export const aGitHubStub = (
  person: GitHubPerson,
  behaviour: GitHubBehaviour = {},
  credentials: {
    readonly clientId: string;
    readonly clientSecret: string;
  } = GITHUB_STUB_CREDENTIALS,
  options: {
    readonly now?: () => number;
    /** A GitHub App this GitHub also plays (`github-app-stub.ts`), answered on the same addresses. */
    readonly app?: GitHubAppStub;
  } = {},
): GitHubStub => {
  const now = options.now ?? Date.now;
  const codes = new Map<
    string,
    {
      readonly challenge: string;
      readonly redirectUri: string;
      readonly expiresAt: number;
      spent: boolean;
    }
  >();
  const tokens = new Set<string>();
  const calls: GitHubCalls = { urls: [], signals: [] };
  const refusals: string[] = [];
  const presentedCodes: string[] = [];

  const authorize = (location: string): Authorized => {
    const url = new URL(location);
    const problem = (what: string): never => {
      throw new Error(`the GitHub stub refused the authorize request: ${what} (${location})`);
    };
    if (`${url.origin}${url.pathname}` !== AUTHORIZE_URL) problem('not the authorize endpoint');
    const get = (name: string): string => url.searchParams.get(name) ?? '';
    if (get('client_id') !== credentials.clientId) problem('client_id');
    if (!get('scope').split(/[ ,]/).includes('user:email')) problem('scope has no user:email');
    if (get('state') === '') problem('no state');
    if (get('redirect_uri') === '') problem('no redirect_uri');
    if (get('code_challenge_method') !== 'S256') problem('code_challenge_method is not S256');
    if (get('code_challenge').length !== 43) problem('code_challenge is not a SHA-256');
    const code = random();
    codes.set(code, {
      challenge: get('code_challenge'),
      redirectUri: get('redirect_uri'),
      expiresAt: now() + CODE_LIFETIME_MS,
      spent: false,
    });
    return { code, state: get('state'), redirectUri: get('redirect_uri') };
  };

  const token = async (request: Request): Promise<Response> => {
    const body = await bodyOf(request);
    const say = (error: string, description: string): Response => {
      refusals.push(error);
      return refused(error, description);
    };
    presentedCodes.push(body['code'] ?? '');
    // An app GitHub does not know: not the documented `incorrect_client_credentials` but a `404`,
    // measured against github.com on 2026-10-22 (D-179 §4.4).
    if (body['client_id'] !== credentials.clientId) {
      refusals.push('Not Found');
      return Response.json({ error: 'Not Found' }, { status: 404 });
    }
    if (body['client_secret'] !== credentials.clientSecret) {
      return say(
        'incorrect_client_credentials',
        'The client_id and/or client_secret passed are incorrect.',
      );
    }
    const issued = codes.get(body['code'] ?? '');
    if (issued === undefined || issued.spent || now() > issued.expiresAt) {
      return say('bad_verification_code', 'The code passed is incorrect or expired.');
    }
    if (body['redirect_uri'] !== issued.redirectUri) {
      return say(
        'redirect_uri_mismatch',
        'The redirect_uri MUST match the registered callback URL for this application.',
      );
    }
    if (challengeOf(body['code_verifier'] ?? '') !== issued.challenge) {
      return say('bad_verification_code', 'The code passed is incorrect or expired.');
    }
    issued.spent = true;
    const accessToken = `gho_${random()}`;
    tokens.add(accessToken);
    return Response.json({
      access_token: accessToken,
      token_type: 'bearer',
      scope: 'read:user,user:email',
    });
  };

  const api = (request: Request, path: string): Response => {
    const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
    if (!tokens.has(bearer)) return Response.json({ message: 'Bad credentials' }, { status: 401 });
    if (path === '/user/emails') {
      return Response.json(
        person.emails ?? [{ email: person.email, primary: true, verified: true }],
      );
    }
    if (path === '/user') {
      return Response.json({
        id: person.id,
        login: person.login,
        name: person.name,
        avatar_url: `https://avatars.example/${String(person.id)}`,
      });
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  };

  const fetch: GithubFetch = async (url, init) => {
    calls.urls.push(url);
    calls.signals.push(init.signal instanceof AbortSignal);
    const request = new Request(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if (options.app !== undefined) {
      const answered = await answeredWithin(options.app.handle(request), init.signal);
      if (answered !== undefined) return answered;
    }
    const { pathname } = new URL(url);
    if (pathname === TOKEN_PATH) {
      switch (behaviour.token ?? 'gives') {
        case 'unreachable':
          throw new TypeError('fetch failed');
        case 'refuses':
          return new Response('busy', { status: 503 });
        case 'spent':
          return refused('bad_verification_code', 'The code passed is incorrect or expired.');
        case 'gives':
          return await token(request);
      }
    }
    if ((behaviour.user ?? 'answers') === 'unreachable') throw new TypeError('fetch failed');
    if (behaviour.user === 'fails') return new Response('', { status: 502 });
    return api(request, pathname);
  };

  const serve = (
    port: number,
    hostname = '127.0.0.1',
  ): { readonly url: string; readonly boundTo: string | undefined; readonly stop: () => void } => {
    const server = Bun.serve({
      port,
      hostname,
      fetch: async (request) => {
        const { pathname, search } = new URL(request.url);
        const app = options.app;
        if (app !== undefined) {
          // GitHub's installation screen, and its authorization screen for the App: the person presses the
          // button at once, for the first installation they can reach.
          if (pathname === `/apps/${app.credentials.slug}/installations/new`) {
            const reachable = [...app.installations.values()].find((each) => each.reachable);
            if (reachable === undefined) return new Response('no installation', { status: 404 });
            return Response.redirect(app.installOnGitHub(request.url, reachable.id), 302);
          }
          if (
            pathname === '/login/oauth/authorize' &&
            new URL(request.url).searchParams.get('client_id') === app.credentials.clientId
          ) {
            return Response.redirect(app.authorizeOnGitHub(request.url), 302);
          }
          const answered = await app.handle(request);
          if (answered !== undefined) return answered;
        }
        if (pathname === '/login/oauth/authorize') {
          const { code, state, redirectUri } = authorize(`${AUTHORIZE_URL}${search}`);
          const back = new URL(redirectUri);
          back.searchParams.set('code', code);
          back.searchParams.set('state', state);
          return Response.redirect(back.toString(), 302);
        }
        if (pathname === TOKEN_PATH) return await token(request);
        return api(request, pathname);
      },
    });
    return {
      url: `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${String(server.port)}`,
      // What the socket is bound to, as the server reports it — not the address built above.
      boundTo: server.hostname,
      stop: () => void server.stop(true),
    };
  };

  const appFetch: GitHubAppFetch = async (url, init) =>
    await fetch(url, {
      ...(init.method === 'POST' ? { method: 'POST' } : {}),
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: 'manual',
      signal: init.signal,
    });

  return { authorize, fetch, appFetch, calls, refusals, presentedCodes, serve };
};

/**
 * GitHub's REST API for a workspace's token, served on a port (the sign-in's side is `aGitHubStub`): the
 * calls the unfurl and the token check make, and what GitHub says when it is not well (#884).
 *
 * A call carries a bearer token this stub was told of (`accept`) or is `401 Bad credentials`, as
 * GitHub answers a revoked one. `/rate_limit` answers `200` with `X-OAuth-Scopes` for a classic token
 * and none for a fine-grained one; a repository's pull request or issue is one fixed item; `/graphql`
 * is one fixed rollup. `answer` replaces answers — a `403` with `x-ratelimit-remaining: 0`, a `429` with
 * `Retry-After`, a `503` — until it is given `null`. No call leaves the machine.
 */
export interface GitHubApiStub {
  readonly url: string;
  /** Every call, in order, with the token it carried. */
  readonly requests: { readonly path: string; readonly token: string }[];
  /** GitHub knows this token; `scopes` is its `X-OAuth-Scopes` (`null`: a fine-grained token sends none). */
  readonly accept: (token: string, scopes?: string | null) => void;
  /** GitHub no longer knows it: `401` from now on. */
  readonly revoke: (token: string) => void;
  /** Answers replaced by this one's, until `null`; where it gives `null` for a path, GitHub answers as usual. */
  readonly answer: (response: ((path: string) => Response | null) | null) => void;
  readonly stop: () => Promise<void>;
}

const STUB_PULL = {
  title: 'Retry the socket with backoff',
  state: 'open',
  merged_at: null,
  user: { login: 'octo', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
};

const STUB_CHECKS = {
  data: {
    repository: {
      pullRequest: {
        reviewDecision: 'APPROVED',
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
      },
    },
  },
};

export const aGitHubApiStub = (): GitHubApiStub => {
  const known = new Map<string, string | null>();
  const requests: { path: string; token: string }[] = [];
  let replaced: ((path: string) => Response | null) | null = null;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
      requests.push({ path: pathname, token });
      const instead = replaced?.(pathname) ?? null;
      if (instead !== null) return instead;
      if (!known.has(token)) return Response.json({ message: 'Bad credentials' }, { status: 401 });
      if (pathname === '/rate_limit') {
        const scopes = known.get(token) ?? null;
        return Response.json(
          { resources: {} },
          { headers: scopes === null ? {} : { 'x-oauth-scopes': scopes } },
        );
      }
      if (pathname === '/graphql') return Response.json(STUB_CHECKS);
      if (/^\/repos\/[^/]+\/[^/]+\/(pulls|issues)\/\d+$/.test(pathname)) {
        return Response.json(STUB_PULL);
      }
      return Response.json({ message: 'Not Found' }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    requests,
    accept: (token, scopes = null): void => void known.set(token, scopes),
    revoke: (token): void => void known.delete(token),
    answer: (response): void => {
      replaced = response;
    },
    stop: async (): Promise<void> => {
      await server.stop(true);
    },
  };
};

/**
 * The GitHub client for a test that saves a token and asks nothing else of GitHub: every token is
 * good, and a card is a call a test did not mean to make.
 */
export const aGitHubApiThatOnlyChecksTokens: GitHubApi = {
  item: () =>
    Promise.reject(new Error('GitHub’s API was asked for an item by a test that does not unfurl')),
  checks: () =>
    Promise.reject(new Error('GitHub’s API was asked for checks by a test that does not unfurl')),
  check: () => Promise.resolve({ scopes: null }),
};
