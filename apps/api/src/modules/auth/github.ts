/**
 * GitHub, as a port.
 *
 * The three calls the handshake makes, behind an interface, so a test drives the
 * whole sign-in without a network — the same reason the executor is an argument
 * (D-46). The real implementation is the only thing here that knows about HTTP.
 *
 * **Scopes are `read:user user:email` and nothing more.** Repository access
 * belongs to the workspace-level integration token, never to a member's sign-in
 * (D-23, D-38).
 */
export const SCOPES = 'read:user user:email';

export interface GitHubProfile {
  /** The stable identity. A login can be renamed and re-taken; this cannot. */
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
}

export interface GitHubEmail {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
}

export interface GitHubClient {
  readonly exchangeCode: (code: string) => Promise<string>;
  readonly profile: (accessToken: string) => Promise<GitHubProfile>;
  readonly emails: (accessToken: string) => Promise<readonly GitHubEmail[]>;
}

export interface GitHubCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/** Where the browser is sent. `state` is verified on the way back (D-62). */
export const authorizeUrl = (credentials: GitHubCredentials, state: string): string => {
  const parameters = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: credentials.redirectUri,
    scope: SCOPES,
    state,
  });
  return `https://github.com/login/oauth/authorize?${parameters.toString()}`;
};

const json = async (response: Response, what: string): Promise<unknown> => {
  if (!response.ok)
    throw new Error(`GitHub refused the ${what} request: ${String(response.status)}`);
  return await response.json();
};

export const githubClient = (credentials: GitHubCredentials): GitHubClient => ({
  exchangeCode: async (code: string): Promise<string> => {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        redirect_uri: credentials.redirectUri,
        code,
      }),
    });
    const body = (await json(response, 'token')) as { access_token?: unknown };
    if (typeof body.access_token !== 'string') {
      // GitHub answers 200 with `{"error": …}` when the code is bad, so a status
      // check alone would let an empty token through into the next call.
      throw new Error('GitHub returned no access token');
    }
    return body.access_token;
  },

  profile: async (accessToken: string): Promise<GitHubProfile> => {
    const response = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json' },
    });
    const body = (await json(response, 'profile')) as {
      id?: unknown;
      login?: unknown;
      name?: unknown;
      avatar_url?: unknown;
    };
    if (typeof body.id !== 'number' || typeof body.login !== 'string') {
      throw new Error('GitHub returned a profile without an id or a login');
    }
    return {
      id: body.id,
      login: body.login,
      name: typeof body.name === 'string' ? body.name : null,
      avatarUrl: typeof body.avatar_url === 'string' ? body.avatar_url : null,
    };
  },

  /**
   * `/user/emails` rather than the profile's `email`, which is omitted for anyone
   * who has not made an address public — common among the developers this product
   * is for, and the reason the first such sign-in would otherwise fail on a
   * `NOT NULL` (D-38).
   */
  emails: async (accessToken: string): Promise<readonly GitHubEmail[]> => {
    const response = await fetch('https://api.github.com/user/emails', {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json' },
    });
    const body = (await json(response, 'emails')) as readonly {
      email?: unknown;
      primary?: unknown;
      verified?: unknown;
    }[];
    return body.flatMap((entry) =>
      typeof entry.email === 'string'
        ? [
            {
              email: entry.email,
              primary: entry.primary === true,
              verified: entry.verified === true,
            },
          ]
        : [],
    );
  },
});
