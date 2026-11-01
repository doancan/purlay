/**
 * GitHub, as the App speaks to it (D-246): the few calls the App makes, each built from parts — never an
 * address a person wrote — each within a deadline, never following a redirect, and each answer checked against
 * the little of it that is read. Every call names the credential it is made with: the App's own token
 * (`appJwt`), or a person's App user access token.
 *
 * What GitHub can answer instead is said as one of three errors, so a caller decides once what each means:
 *
 * - `GitHubRateLimited` — GitHub's primary or secondary limit, with how long to wait: `Retry-After`, or the
 *   reset of `x-ratelimit-remaining: 0`, or a minute when it says neither (GitHub's REST API best practices).
 * - `GitHubUnauthorized` — `401`: the token is not good any more (revoked, expired, the App removed).
 * - `GitHubUnavailable` — no answer within the deadline, a `5xx`, a redirect, or a body that is not what the
 *   call reads. The reason is for the log, and never carries a token.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/** What reaches GitHub. A redirect is answered, never followed (`redirect: 'manual'`, as `GithubFetch`). */
export type GitHubAppFetch = (
  url: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly redirect: 'manual';
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

/** The platform's own `fetch`, to GitHub's addresses: never redirected (the type requires it). */
export const platformAppFetch: GitHubAppFetch = async (url, init) => await fetch(url, init);

/** Where GitHub is: `GITHUB_URL` for the web flows, `GITHUB_API_URL` for the API (`CONFIG.md`). */
export interface GitHubAppUrls {
  readonly web: string;
  readonly api: string;
}

/** How long GitHub has to answer one call. */
const GITHUB_APP_TIMEOUT_MS = 10_000;
/** Waited when GitHub says it is limiting but not for how long (its best practices: at least a minute). */
const DEFAULT_WAIT_SECONDS = 60;

export class GitHubRateLimited extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`GitHub is limiting requests for ${String(retryAfterSeconds)}s`);
    this.name = 'GitHubRateLimited';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class GitHubUnauthorized extends Error {
  constructor() {
    super('GitHub did not take the token');
    this.name = 'GitHubUnauthorized';
  }
}

export class GitHubUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'GitHubUnavailable';
  }
}

/** A person's App user access token and, where the App's tokens expire, its refresh token (seconds). */
export interface UserTokens {
  readonly accessToken: string;
  readonly accessExpiresIn: number | null;
  readonly refreshToken: string | null;
  readonly refreshExpiresIn: number | null;
}

export interface GitHubAccount {
  readonly id: number;
  readonly login: string;
}

export interface GitHubInstallation {
  readonly id: number;
  readonly accountLogin: string;
  readonly accountType: 'User' | 'Organization';
  readonly suspended: boolean;
}

export interface GitHubAppApi {
  /** The App the token signs as: what `POST /api/server/github-app` compares with what was typed. */
  readonly app: (jwt: string) => Promise<{ id: number; slug: string; clientId: string }>;
  /** One installation of the App; `'missing'` when GitHub has none by that id. */
  readonly installation: (
    jwt: string,
    installationId: number,
  ) => Promise<GitHubInstallation | 'missing'>;
  /** A code from GitHub's callback redeemed; `'refused'` when GitHub will not (spent, expired, another app's). */
  readonly exchangeCode: (
    client: { readonly clientId: string; readonly clientSecret: string },
    grant: { readonly code: string; readonly redirectUri: string; readonly verifier?: string },
  ) => Promise<UserTokens | 'refused'>;
  /** Who a person's token is. */
  readonly user: (token: string) => Promise<GitHubAccount>;
  /** The App's installations this person can reach, by id (their first hundred: an owner's are few). */
  readonly userInstallationIds: (token: string) => Promise<readonly number[]>;
  /** A person's refresh token spent for new tokens; `'refused'` when GitHub will not (revoked, expired, spent). */
  readonly refresh: (
    client: { readonly clientId: string; readonly clientSecret: string },
    refreshToken: string,
  ) => Promise<UserTokens | 'refused'>;
  /** The installation's own short-lived token, for what everybody shares (D-246 §1). */
  readonly installationToken: (jwt: string, installationId: number) => Promise<string>;
  /**
   * The repositories of an installation this person's token reaches — both the person and the App can — a page
   * at a time, `null` when there is no such page. The person's own token: what it cannot see is not listed.
   */
  readonly userRepositories: (
    token: string,
    installationId: number,
    page: number,
  ) => Promise<readonly RepositoryOnGitHub[] | null>;
  /** An issue made, as the person: `refused` when GitHub says no to this request; anything unclear throws. */
  readonly createIssue: (
    token: string,
    repository: string,
    issue: { readonly title: string; readonly body: string },
  ) => Promise<CreatedIssue | { readonly refused: 'no-access' | 'issues-disabled' | 'invalid' }>;
  /** The newest issues of a repository since an instant (a hundred at most), as the installation reads them. */
  readonly issuesSince: (
    token: string,
    repository: string,
    since: Date,
  ) => Promise<readonly IssueOnGitHub[]>;
}

export interface RepositoryOnGitHub {
  readonly id: number;
  readonly fullName: string;
  readonly private: boolean;
}

export interface IssueOnGitHub {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly updatedAt: Date;
}

export type CreatedIssue = IssueOnGitHub;

const Login = Type.String({ minLength: 1, maxLength: 39 });

const AppBody = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  slug: Type.String({ minLength: 1 }),
  client_id: Type.String({ minLength: 1 }),
});

const InstallationBody = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  account: Type.Object({
    login: Login,
    type: Type.Union([Type.Literal('User'), Type.Literal('Organization')]),
  }),
  suspended_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const TokenBody = Type.Object({
  access_token: Type.String({ minLength: 1 }),
  expires_in: Type.Optional(Type.Integer({ minimum: 1 })),
  refresh_token: Type.Optional(Type.String({ minLength: 1 })),
  refresh_token_expires_in: Type.Optional(Type.Integer({ minimum: 1 })),
});

/** GitHub's refusal of a code: `200` and the reason in the body. */
const TokenRefusal = Type.Object({ error: Type.String() });

const UserBody = Type.Object({ id: Type.Integer({ minimum: 1 }), login: Login });

const InstallationTokenBody = Type.Object({ token: Type.String({ minLength: 1 }) });

const RepositoriesBody = Type.Object({
  repositories: Type.Array(
    Type.Object({
      id: Type.Integer({ minimum: 1 }),
      full_name: Type.String({ minLength: 3 }),
      private: Type.Boolean(),
    }),
  ),
});

const IssueBody = Type.Object({
  number: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  body: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  state: Type.Union([Type.Literal('open'), Type.Literal('closed')]),
  updated_at: Type.String({ format: 'date-time' }),
  pull_request: Type.Optional(Type.Unknown()),
});

const UserInstallationsBody = Type.Object({
  installations: Type.Array(Type.Object({ id: Type.Integer({ minimum: 1 }) })),
});

/**
 * How long GitHub asks to be left alone, when it does: a `429`, or a `403` that says it is a limit — by
 * `Retry-After`, or by `x-ratelimit-remaining: 0` and its reset. A `403` that says neither is a refusal.
 */
export const limitOf = (response: Response, now: Date): number | null => {
  if (response.status !== 429 && response.status !== 403) return null;
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null && /^[0-9]{1,6}$/.test(retryAfter))
    return Math.max(1, Number(retryAfter));
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const wait = Number.isFinite(reset) ? Math.ceil(reset - now.getTime() / 1000) : 0;
    return Math.max(1, wait > 0 ? wait : DEFAULT_WAIT_SECONDS);
  }
  return response.status === 429 ? DEFAULT_WAIT_SECONDS : null;
};

/** A body read as JSON and checked; anything else is GitHub unavailable, said without the body. */
const readChecked = async <T extends TSchema>(
  response: Response,
  schema: T,
  what: string,
): Promise<Static<T>> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GitHubUnavailable(`GitHub answered ${what} with a body that is not JSON`);
  }
  if (!Value.Check(schema, body)) {
    throw new GitHubUnavailable(`GitHub answered ${what} with something that is not one`);
  }
  return body;
};

export interface GitHubAppCaller {
  /** One call: its answer, or one of the three errors for a limit, a `401`, or no usable answer. */
  readonly call: (
    url: string,
    init: {
      readonly method: 'GET' | 'POST';
      readonly token?: string;
      readonly body?: unknown;
      /** The token endpoint answers JSON only when asked for it by name; the API takes GitHub's own type. */
      readonly accept?: 'application/json';
    },
  ) => Promise<Response>;
}

/** The one way a call is made: the headers GitHub asks for, the deadline, the manual redirect, the errors. */
export const githubAppCaller = (
  fetch: GitHubAppFetch,
  now: () => Date,
  timeoutMs = GITHUB_APP_TIMEOUT_MS,
): GitHubAppCaller => ({
  call: async (url, { method, token, body, accept }): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          accept: accept ?? 'application/vnd.github+json',
          'user-agent': 'purlay',
          'x-github-api-version': '2022-11-28',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      throw new GitHubUnavailable(
        name === 'TimeoutError' || name === 'AbortError'
          ? 'GitHub did not answer in time'
          : 'GitHub could not be reached',
      );
    }
    const wait = limitOf(response, now());
    if (wait !== null) {
      await response.body?.cancel();
      throw new GitHubRateLimited(wait);
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new GitHubUnauthorized();
    }
    if (response.status >= 500 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new GitHubUnavailable(`GitHub answered ${String(response.status)}`);
    }
    return response;
  },
});

const ok = async (response: Response, what: string): Promise<void> => {
  if (response.ok) return;
  await response.body?.cancel();
  throw new GitHubUnavailable(`GitHub answered ${what} with ${String(response.status)}`);
};

const tokensOf = (body: Static<typeof TokenBody>): UserTokens => ({
  accessToken: body.access_token,
  accessExpiresIn: body.expires_in ?? null,
  refreshToken: body.refresh_token ?? null,
  refreshExpiresIn: body.refresh_token_expires_in ?? null,
});

/** The token endpoint's answer: tokens, or GitHub's refusal of the grant. */
export const tokenAnswer = async (response: Response): Promise<UserTokens | 'refused'> => {
  if (response.status === 404) {
    // An app GitHub does not know is answered `404` (measured, D-179 §4.4): this grant is refused.
    await response.body?.cancel();
    return 'refused';
  }
  await ok(response, 'a token request');
  const body = await readChecked(
    response,
    Type.Union([TokenBody, TokenRefusal]),
    'a token request',
  );
  return 'access_token' in body ? tokensOf(body) : 'refused';
};

export const githubAppApi = (caller: GitHubAppCaller, urls: GitHubAppUrls): GitHubAppApi => ({
  app: async (jwt): Promise<{ id: number; slug: string; clientId: string }> => {
    const response = await caller.call(`${urls.api}/app`, { method: 'GET', token: jwt });
    await ok(response, 'the App');
    const body = await readChecked(response, AppBody, 'the App');
    return { id: body.id, slug: body.slug, clientId: body.client_id };
  },
  installation: async (jwt, installationId): Promise<GitHubInstallation | 'missing'> => {
    const response = await caller.call(`${urls.api}/app/installations/${String(installationId)}`, {
      method: 'GET',
      token: jwt,
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return 'missing';
    }
    await ok(response, 'an installation');
    const body = await readChecked(response, InstallationBody, 'an installation');
    return {
      id: body.id,
      accountLogin: body.account.login,
      accountType: body.account.type,
      suspended: body.suspended_at != null,
    };
  },
  exchangeCode: async (client, grant) =>
    await tokenAnswer(
      await caller.call(`${urls.web}/login/oauth/access_token`, {
        method: 'POST',
        accept: 'application/json',
        body: {
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code: grant.code,
          redirect_uri: grant.redirectUri,
          ...(grant.verifier === undefined ? {} : { code_verifier: grant.verifier }),
        },
      }),
    ),
  user: async (token): Promise<GitHubAccount> => {
    const response = await caller.call(`${urls.api}/user`, { method: 'GET', token });
    await ok(response, 'the person');
    const body = await readChecked(response, UserBody, 'the person');
    return { id: body.id, login: body.login };
  },
  refresh: async (client, refreshToken): Promise<UserTokens | 'refused'> =>
    await tokenAnswer(
      await caller.call(`${urls.web}/login/oauth/access_token`, {
        method: 'POST',
        accept: 'application/json',
        body: {
          client_id: client.clientId,
          client_secret: client.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        },
      }),
    ),
  installationToken: async (jwt, installationId): Promise<string> => {
    const response = await caller.call(
      `${urls.api}/app/installations/${String(installationId)}/access_tokens`,
      { method: 'POST', token: jwt, body: {} },
    );
    await ok(response, 'an installation token');
    return (await readChecked(response, InstallationTokenBody, 'an installation token')).token;
  },
  userRepositories: async (
    token,
    installationId,
    page,
  ): Promise<readonly RepositoryOnGitHub[] | null> => {
    const response = await caller.call(
      `${urls.api}/user/installations/${String(installationId)}/repositories?per_page=100&page=${String(page)}`,
      { method: 'GET', token },
    );
    // An installation the person cannot reach is no page at all.
    if (response.status === 404 || response.status === 403) {
      await response.body?.cancel();
      return null;
    }
    await ok(response, 'the repositories');
    const body = await readChecked(response, RepositoriesBody, 'the repositories');
    return body.repositories.map((repository) => ({
      id: repository.id,
      fullName: repository.full_name,
      private: repository.private,
    }));
  },
  createIssue: async (
    token,
    repository,
    issue,
  ): Promise<CreatedIssue | { readonly refused: 'no-access' | 'issues-disabled' | 'invalid' }> => {
    const response = await caller.call(`${urls.api}/repos/${repository}/issues`, {
      method: 'POST',
      token,
      body: { title: issue.title, body: issue.body },
    });
    // GitHub's own words for "no": not found or forbidden is no access, gone is issues turned off, 422 is the text.
    if (response.status === 404 || response.status === 403) {
      await response.body?.cancel();
      return { refused: 'no-access' };
    }
    if (response.status === 410) {
      await response.body?.cancel();
      return { refused: 'issues-disabled' };
    }
    if (response.status === 422 || response.status === 400) {
      await response.body?.cancel();
      return { refused: 'invalid' };
    }
    // Anything else that is not a creation is not clear: whether it was made is not known.
    if (response.status !== 201) {
      await response.body?.cancel();
      throw new GitHubUnavailable(`GitHub answered a create with ${String(response.status)}`);
    }
    const body = await readChecked(response, IssueBody, 'a created issue');
    return {
      number: body.number,
      title: body.title,
      body: body.body ?? '',
      state: body.state,
      updatedAt: new Date(body.updated_at),
    };
  },
  issuesSince: async (token, repository, since): Promise<readonly IssueOnGitHub[]> => {
    const query = new URLSearchParams({
      since: since.toISOString(),
      state: 'all',
      sort: 'created',
      direction: 'desc',
      per_page: '100',
    });
    const response = await caller.call(
      `${urls.api}/repos/${repository}/issues?${query.toString()}`,
      {
        method: 'GET',
        token,
      },
    );
    await ok(response, 'the issues');
    const body = await readChecked(response, Type.Array(IssueBody), 'the issues');
    // A pull request is an issue to this list, and is not what was asked for.
    return body
      .filter((item) => item.pull_request === undefined)
      .map((item) => ({
        number: item.number,
        title: item.title,
        body: item.body ?? '',
        state: item.state,
        updatedAt: new Date(item.updated_at),
      }));
  },
  userInstallationIds: async (token): Promise<readonly number[]> => {
    const response = await caller.call(`${urls.api}/user/installations?per_page=100`, {
      method: 'GET',
      token,
    });
    await ok(response, 'the installations');
    const body = await readChecked(response, UserInstallationsBody, 'the installations');
    return body.installations.map((installation) => installation.id);
  },
});
