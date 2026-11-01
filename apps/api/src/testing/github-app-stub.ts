/**
 * GitHub's side of a GitHub App (D-246), strict enough to refuse what GitHub refuses — for a test's `fetch`, and,
 * through the GitHub stub it is part of (`github-stub.ts`), served on a port for a browser run that cannot reach
 * GitHub. It creates no App, credential or issue anywhere but in its own memory.
 *
 * What it checks is what GitHub's documentation says it checks: the App's own token is an RS256 JSON Web Token
 * signed by the App's key, issued for the App's client id, alive and lasting at most ten minutes ("Generating a
 * JSON Web Token (JWT) for a GitHub App"); a code is the App's, issued once and spent once, redeemed with the
 * App's client secret, the callback it was issued for and — when a challenge came with it — its PKCE verifier;
 * a refresh token is spent by the refresh that uses it ("Refreshing user access tokens"); a user access token
 * reaches only what both its person and the App can ("Authenticating with a GitHub App on behalf of a user").
 *
 * And it fails as GitHub fails, where a test asks it to: a limit with `Retry-After`, a `401` for a revoked
 * token, a create that is made and whose answer never comes back.
 */
import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';

/** What a key is written as: GitHub's PEM, named here once (a key's encoding is not one of the contract's formats). */
const PEM = 'pem';

/** One key pair for every App a run makes: generating one takes a while, and a test needs none of its own. */
const KEY_PAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: PEM },
  privateKeyEncoding: { type: 'pkcs1', format: PEM },
});

/** The App as its settings page on GitHub shows it; the private key as GitHub hands it over, PKCS#1. */
export const GITHUB_APP_STUB = {
  appId: 4242,
  slug: 'purlay-issues',
  clientId: 'Iv23.purlayissues',
  clientSecret: 'app-client-secret-4242',
  privateKey: KEY_PAIR.privateKey,
  webhookSecret: 'app-webhook-secret-4242',
} as const;

interface StubRepository {
  readonly id: number;
  /** `owner/name`, as GitHub spells it. */
  readonly fullName: string;
  readonly private: boolean;
}

interface StubInstallation {
  readonly id: number;
  readonly account: { readonly login: string; readonly type: 'User' | 'Organization' };
  readonly repositories: StubRepository[];
  suspended: boolean;
  /** Whether the stub's person can reach it — GitHub's `GET /user/installations`. */
  reachable: boolean;
}

interface StubItem {
  readonly id: number;
  readonly number: number;
  readonly kind: 'issue' | 'pull';
  readonly repositoryId: number;
  title: string;
  readonly body: string;
  state: 'open' | 'closed';
  merged: boolean;
  readonly creator: string;
  readonly createdAt: string;
  updatedAt: string;
}

/** How the App's calls are answered, where a test needs GitHub to fail. */
interface GitHubAppBehaviour {
  /** The next `times` API calls are refused as a limit, with `Retry-After: retryAfter`. */
  limit?: { times: number; retryAfter: number };
  /**
   * What `POST /repos/…/issues` does: makes it and answers (`creates`), or only after a moment (`slow`); makes it
   * and never answers, so the caller's deadline is all it hears (`creates-silently`); never answers and makes
   * nothing (`hangs`); or `502`.
   */
  create?: 'creates' | 'creates-silently' | 'hangs' | 'fails' | 'slow';
  /** Every call fails to connect. */
  unreachable?: boolean;
}

export interface GitHubAppStub {
  readonly credentials: typeof GITHUB_APP_STUB;
  readonly installations: Map<number, StubInstallation>;
  readonly items: StubItem[];
  readonly behaviour: GitHubAppBehaviour;
  /** Every API call asked of it, as `METHOD path`, in order. */
  readonly calls: string[];
  /** The App's callback, as registered on GitHub; set by a test that knows its server's address. */
  callbackUrl: string;
  /** An installation of the App on an account, with its repositories. */
  readonly install: (
    id: number,
    login: string,
    repositories: readonly StubRepository[],
    options?: { readonly reachable?: boolean; readonly type?: 'User' | 'Organization' },
  ) => StubInstallation;
  /**
   * The owner on GitHub's installation screen, pressing Install for `installationId`: the address GitHub sends
   * the browser back to — the callback, with a code (the App asks for authorization during installation), the
   * installation and the state.
   */
  readonly installOnGitHub: (location: string, installationId: number) => string;
  /** The person on GitHub's authorization screen, pressing Authorize: the callback, with a code and the state. */
  readonly authorizeOnGitHub: (location: string) => string;
  /** A person who has authorized, without the trip: the tokens GitHub would have given them. */
  readonly grantUser: () => {
    readonly accessToken: string;
    readonly accessExpiresIn: number;
    readonly refreshToken: string;
    readonly refreshExpiresIn: number;
  };
  /** Every user access token and refresh token the stub gave is revoked, as revoking the App on GitHub does. */
  readonly revokeUser: () => void;
  /** Every user access token given so far has expired, its refresh token still good. */
  readonly expireUserTokens: () => void;
  /** Answers a request that is the App's; `undefined` for one that is not (the sign-in stub's, then). */
  readonly handle: (request: Request) => Promise<Response | undefined>;
  /** A delivery to the App's webhook, signed with its secret, as GitHub sends one. */
  readonly delivery: (
    event: string,
    body: unknown,
    deliveryId?: string,
  ) => { readonly headers: Record<string, string>; readonly body: string };
}

const random = (): string => crypto.randomUUID().replaceAll('-', '');

const challengeOf = (verifier: string): string =>
  new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');

/** GitHub's refusal of a token request: `200`, and the reason in the body. */
const refused = (error: string): Response => Response.json({ error, error_description: error });

/** User access tokens last eight hours, refresh tokens six months (GitHub's documentation). */
const ACCESS_SECONDS = 8 * 60 * 60;
const REFRESH_SECONDS = 15_897_600;

export const aGitHubAppStub = (
  person: { readonly id: number; readonly login: string },
  options: { readonly now?: () => number } = {},
): GitHubAppStub => {
  const now = options.now ?? Date.now;
  const installations = new Map<number, StubInstallation>();
  const items: StubItem[] = [];
  const behaviour: GitHubAppBehaviour = {};
  const calls: string[] = [];
  const codes = new Map<
    string,
    { readonly redirectUri: string; readonly challenge: string | null; spent: boolean }
  >();
  const userTokens = new Map<string, { expiresAt: number }>();
  const refreshTokens = new Set<string>();
  const installationTokens = new Map<string, number>();
  let nextItemId = 9000;

  const stub: GitHubAppStub = {
    credentials: GITHUB_APP_STUB,
    installations,
    items,
    behaviour,
    calls,
    callbackUrl: 'https://purlay.test/api/github-app/callback',
    install: (id, login, repositories, installOptions = {}) => {
      const installation: StubInstallation = {
        id,
        account: { login, type: installOptions.type ?? 'Organization' },
        repositories: [...repositories],
        suspended: false,
        reachable: installOptions.reachable ?? true,
      };
      installations.set(id, installation);
      return installation;
    },
    installOnGitHub: (location, installationId) => {
      const url = new URL(location);
      if (!url.pathname.endsWith(`/apps/${GITHUB_APP_STUB.slug}/installations/new`)) {
        throw new Error(`the GitHub App stub refused the installation screen: ${location}`);
      }
      const state = url.searchParams.get('state') ?? '';
      if (state === '') throw new Error('the installation screen was opened without a state');
      const code = random();
      codes.set(code, { redirectUri: stub.callbackUrl, challenge: null, spent: false });
      const back = new URL(stub.callbackUrl);
      back.searchParams.set('code', code);
      back.searchParams.set('installation_id', String(installationId));
      back.searchParams.set('setup_action', 'install');
      back.searchParams.set('state', state);
      return back.toString();
    },
    authorizeOnGitHub: (location) => {
      const url = new URL(location);
      const get = (name: string): string => url.searchParams.get(name) ?? '';
      const problem = (what: string): never => {
        throw new Error(`the GitHub App stub refused the authorize request: ${what}`);
      };
      if (!url.pathname.endsWith('/login/oauth/authorize')) problem('not the authorize screen');
      if (get('client_id') !== GITHUB_APP_STUB.clientId) problem('client_id');
      if (get('redirect_uri') !== stub.callbackUrl) problem('redirect_uri is not the callback');
      if (get('state') === '') problem('no state');
      if (get('code_challenge_method') !== 'S256' || get('code_challenge').length !== 43) {
        problem('no S256 code_challenge');
      }
      const code = random();
      codes.set(code, {
        redirectUri: get('redirect_uri'),
        challenge: get('code_challenge'),
        spent: false,
      });
      const back = new URL(stub.callbackUrl);
      back.searchParams.set('code', code);
      back.searchParams.set('state', get('state'));
      return back.toString();
    },
    grantUser: () => {
      const given = mint();
      return {
        accessToken: given.access_token,
        accessExpiresIn: given.expires_in,
        refreshToken: given.refresh_token,
        refreshExpiresIn: given.refresh_token_expires_in,
      };
    },
    revokeUser: () => {
      userTokens.clear();
      refreshTokens.clear();
    },
    expireUserTokens: () => {
      for (const token of userTokens.values()) token.expiresAt = 0;
    },
    handle: async (request) => await handle(request),
    delivery: (event, body, deliveryId = crypto.randomUUID()) => {
      const text = JSON.stringify(body);
      const signature = createHmac('sha256', GITHUB_APP_STUB.webhookSecret)
        .update(text)
        .digest('hex');
      return {
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(text)),
          'x-github-event': event,
          'x-github-delivery': deliveryId,
          'x-hub-signature-256': `sha256=${signature}`,
        },
        body: text,
      };
    },
  };

  /** The App's own token, checked as GitHub checks it; the reason it is not one, or nothing. */
  const appTokenProblem = (bearer: string): string | undefined => {
    const [header, payload, signature] = bearer.split('.');
    if (header === undefined || payload === undefined || signature === undefined)
      return 'not a JWT';
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(KEY_PAIR.publicKey, Buffer.from(signature, 'base64url'));
    if (!verified) return 'not signed by the App’s key';
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      iat?: number;
      exp?: number;
      iss?: string;
    };
    const seconds = now() / 1000;
    if (claims.iss !== GITHUB_APP_STUB.clientId && claims.iss !== String(GITHUB_APP_STUB.appId)) {
      return 'issued for another App';
    }
    if (claims.iat === undefined || claims.exp === undefined) return 'no iat or exp';
    if (claims.iat > seconds + 60 || claims.exp <= seconds) return 'not alive';
    if (claims.exp - claims.iat > 600) return 'lasts longer than ten minutes';
    return undefined;
  };

  const userOf = (request: Request): boolean => {
    const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
    const token = userTokens.get(bearer);
    return token !== undefined && token.expiresAt > now();
  };

  const bearerOf = (request: Request): string =>
    (request.headers.get('authorization') ?? '').replace(/^Bearer /i, '');

  const mint = (): {
    access_token: string;
    expires_in: number;
    refresh_token: string;
    refresh_token_expires_in: number;
    token_type: string;
    scope: string;
  } => {
    const accessToken = `ghu_${random()}`;
    const refreshToken = `ghr_${random()}`;
    userTokens.set(accessToken, { expiresAt: now() + ACCESS_SECONDS * 1000 });
    refreshTokens.add(refreshToken);
    return {
      access_token: accessToken,
      expires_in: ACCESS_SECONDS,
      refresh_token: refreshToken,
      refresh_token_expires_in: REFRESH_SECONDS,
      token_type: 'bearer',
      scope: '',
    };
  };
  const issueTokens = (): Response => Response.json(mint());

  const token = async (request: Request): Promise<Response | undefined> => {
    const text = await request.clone().text();
    const body = (
      (request.headers.get('content-type') ?? '').includes('application/json')
        ? (JSON.parse(text) as Record<string, string>)
        : Object.fromEntries(new URLSearchParams(text))
    ) as Record<string, string | undefined>;
    // Another app's token request: the sign-in stub's to answer.
    if (body['client_id'] !== GITHUB_APP_STUB.clientId) return undefined;
    if (body['client_secret'] !== GITHUB_APP_STUB.clientSecret) {
      return refused('incorrect_client_credentials');
    }
    if (body['grant_type'] === 'refresh_token') {
      const presented = body['refresh_token'] ?? '';
      if (!refreshTokens.delete(presented)) return refused('bad_refresh_token');
      return issueTokens();
    }
    const issued = codes.get(body['code'] ?? '');
    if (issued === undefined || issued.spent) return refused('bad_verification_code');
    if (body['redirect_uri'] !== issued.redirectUri) return refused('redirect_uri_mismatch');
    if (
      issued.challenge !== null &&
      challengeOf(body['code_verifier'] ?? '') !== issued.challenge
    ) {
      return refused('bad_verification_code');
    }
    issued.spent = true;
    return issueTokens();
  };

  const repositoryOf = (owner: string, name: string): StubRepository | undefined => {
    const fullName = `${owner}/${name}`.toLowerCase();
    for (const installation of installations.values()) {
      const found = installation.repositories.find(
        (repository) => repository.fullName.toLowerCase() === fullName,
      );
      if (found !== undefined) return found;
    }
    return undefined;
  };

  /** Whether the person can reach the repository through an installation they can reach, not suspended. */
  const userReaches = (repository: StubRepository): boolean =>
    [...installations.values()].some(
      (installation) =>
        installation.reachable &&
        !installation.suspended &&
        installation.repositories.some((candidate) => candidate.id === repository.id),
    );

  /** Whether an installation token reaches the repository: its installation holds it. */
  const installationReaches = (bearer: string, repository: StubRepository): boolean => {
    const installationId = installationTokens.get(bearer);
    const installation =
      installationId === undefined ? undefined : installations.get(installationId);
    return (
      installation !== undefined &&
      !installation.suspended &&
      installation.repositories.some((candidate) => candidate.id === repository.id)
    );
  };

  const itemJson = (item: StubItem, repository: StubRepository): Record<string, unknown> => ({
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    html_url: `https://github.com/${repository.fullName}/${item.kind === 'pull' ? 'pull' : 'issues'}/${String(item.number)}`,
    user: { login: item.creator },
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    ...(item.kind === 'pull'
      ? { merged_at: item.merged ? item.updatedAt : null, merged: item.merged }
      : {}),
  });

  const notFound = (): Response => Response.json({ message: 'Not Found' }, { status: 404 });
  const badCredentials = (): Response =>
    Response.json({ message: 'Bad credentials' }, { status: 401 });

  const createIssue = async (request: Request, repository: StubRepository): Promise<Response> => {
    if (!userOf(request)) return badCredentials();
    if (!userReaches(repository)) return notFound();
    const body = (await request.json()) as { title?: unknown; body?: unknown };
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      return Response.json({ message: 'Validation Failed' }, { status: 422 });
    }
    const mode = behaviour.create ?? 'creates';
    if (mode === 'fails') return new Response('', { status: 502 });
    const make = (): StubItem => {
      const at = new Date(now()).toISOString();
      const item: StubItem = {
        id: nextItemId++,
        number: items.filter((existing) => existing.repositoryId === repository.id).length + 1,
        kind: 'issue',
        repositoryId: repository.id,
        title: body.title as string,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        merged: false,
        creator: person.login,
        createdAt: at,
        updatedAt: at,
      };
      items.push(item);
      return item;
    };
    // Answered, but only after a moment: the time in which a second click can arrive.
    if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 150));
    if (mode === 'creates-silently') make();
    if (mode === 'creates-silently' || mode === 'hangs') {
      // Never answered: the caller's deadline is the only end it has.
      return await new Promise<Response>(() => undefined);
    }
    return Response.json(itemJson(make(), repository), { status: 201 });
  };

  const handle = async (request: Request): Promise<Response | undefined> => {
    if (behaviour.unreachable === true) throw new TypeError('fetch failed');
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/login/oauth/access_token') return await token(request);
    const bearer = bearerOf(request);
    const isApp = bearer.startsWith('ey');
    const isUser = bearer.startsWith('ghu_');
    const isInstallation = bearer.startsWith('ghs_');
    // Not the App's: the sign-in stub's own token, or no token at all.
    if (!isApp && !isUser && !isInstallation) return undefined;
    calls.push(`${request.method} ${path}`);
    if (behaviour.limit !== undefined && behaviour.limit.times > 0) {
      behaviour.limit.times -= 1;
      return Response.json(
        { message: 'You have exceeded a secondary rate limit.' },
        { status: 403, headers: { 'retry-after': String(behaviour.limit.retryAfter) } },
      );
    }
    if (isApp) {
      const problem = appTokenProblem(bearer);
      if (problem !== undefined) return Response.json({ message: problem }, { status: 401 });
      if (path === '/app') {
        return Response.json({
          id: GITHUB_APP_STUB.appId,
          slug: GITHUB_APP_STUB.slug,
          client_id: GITHUB_APP_STUB.clientId,
          name: 'Purlay issues',
        });
      }
      const installation = /^\/app\/installations\/([0-9]+)(\/access_tokens)?$/.exec(path);
      const found = installation === null ? undefined : installations.get(Number(installation[1]));
      if (found === undefined) return notFound();
      if (installation?.[2] !== undefined) {
        if (request.method !== 'POST') return notFound();
        if (found.suspended) {
          return Response.json(
            { message: 'This installation has been suspended' },
            { status: 403 },
          );
        }
        const issued = `ghs_${random()}`;
        installationTokens.set(issued, found.id);
        return Response.json(
          { token: issued, expires_at: new Date(now() + 60 * 60 * 1000).toISOString() },
          { status: 201 },
        );
      }
      return Response.json({
        id: found.id,
        account: found.account,
        repository_selection: 'selected',
        suspended_at: found.suspended ? new Date(now()).toISOString() : null,
      });
    }
    if (isUser && !userOf(request)) return badCredentials();
    if (isInstallation && !installationTokens.has(bearer)) return badCredentials();
    if (path === '/user' && isUser) {
      return Response.json({ id: person.id, login: person.login });
    }
    if (path === '/user/installations' && isUser) {
      return Response.json({
        total_count: [...installations.values()].filter((each) => each.reachable).length,
        installations: [...installations.values()]
          .filter((each) => each.reachable)
          .map((each) => ({ id: each.id, account: each.account })),
      });
    }
    const userRepositories = /^\/user\/installations\/([0-9]+)\/repositories$/.exec(path);
    if (userRepositories !== null && isUser) {
      const found = installations.get(Number(userRepositories[1]));
      if (!found?.reachable) return notFound();
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      const visible = found.suspended ? [] : found.repositories;
      return Response.json({
        total_count: visible.length,
        repositories: visible.slice((page - 1) * perPage, page * perPage).map((repository) => ({
          id: repository.id,
          full_name: repository.fullName,
          private: repository.private,
        })),
      });
    }
    const repositoryPath = /^\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)(?:\/([0-9]+))?$/.exec(path);
    if (repositoryPath === null) return notFound();
    const [, owner = '', name = '', collection, number] = repositoryPath;
    const repository = repositoryOf(owner, name);
    if (repository === undefined) return notFound();
    const reaches = isUser ? userReaches(repository) : installationReaches(bearer, repository);
    if (collection === 'issues' && number === undefined && request.method === 'POST') {
      return await createIssue(request, repository);
    }
    if (!reaches) return notFound();
    if (number !== undefined) {
      const item = items.find(
        (candidate) =>
          candidate.repositoryId === repository.id &&
          candidate.number === Number(number) &&
          (collection === 'pulls' ? candidate.kind === 'pull' : true),
      );
      return item === undefined ? notFound() : Response.json(itemJson(item, repository));
    }
    // A list of the repository's issues: by their creator, since an instant, newest first, as asked.
    const creator = url.searchParams.get('creator');
    const since = url.searchParams.get('since');
    const listed = items
      .filter((item) => item.repositoryId === repository.id && item.kind === 'issue')
      .filter((item) => creator === null || item.creator === creator)
      .filter((item) => since === null || item.updatedAt >= since)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return Response.json(listed.map((item) => itemJson(item, repository)));
  };

  return stub;
};

/** What `handle` answers for a `fetch` that may fail to connect, or hang until its signal ends it. */
export const answeredWithin = async (
  answer: Promise<Response | undefined>,
  signal: AbortSignal | undefined,
): Promise<Response | undefined> => {
  if (signal === undefined) return await answer;
  return await new Promise<Response | undefined>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    answer.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
};
