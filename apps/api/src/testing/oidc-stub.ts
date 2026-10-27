/**
 * An OpenID Connect provider's side of a sign-in, strict enough to refuse what a provider refuses — for a
 * test's `fetch` and, served on a port, for a browser run with no provider to reach (D-200).
 *
 * It serves what the specifications say a provider serves: discovery (`/.well-known/openid-configuration`,
 * Discovery §4), the key set it signs with (`/jwks`, RFC 7517), an authorize endpoint and a token endpoint.
 * What it checks is what a provider checks (Core §3.1.2.1, §3.1.3.2, RFC 7636): the authorize request names a
 * client it knows, the exact `redirect_uri` registered for it, `response_type=code`, the `openid` scope, a
 * `state`, a `nonce`, and a PKCE `code_challenge` with `code_challenge_method=S256`; the token request carries
 * the client's credentials (in the header, or in the body when told to take them there), a code issued once and
 * not spent, the same `redirect_uri` and the `code_verifier` whose SHA-256 is the challenge. Anything else is
 * answered as RFC 6749 §5.2 answers it, so a client that forgets the verifier is refused here as it would be
 * there, and a test that passes is one a provider would pass.
 *
 * The `id_token` it signs is RS256 with a key it made, carrying the claims a provider carries; a test turns any
 * claim wrong (`claims`), signs it wrong (`tamper`), rotates the key (`rotate`) or makes any endpoint fail
 * (`behaviour`) — every way a hostile or broken provider can answer, which the real provider is not asked to.
 */
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { OidcFetch } from '../modules/auth/oidc';

/** The account a provider vouches for. */
export interface OidcPerson {
  readonly sub: string;
  readonly email: string;
  readonly name?: string | undefined;
}

/** How the stub answers, where a test needs a provider to fail or to lie. Read at every call: a test may change it. */
export interface OidcBehaviour {
  discovery?:
    | 'answers'
    | 'unreachable'
    | 'refuses'
    | 'redirects'
    | 'issuer-mismatch'
    | 'http-endpoints'
    | 'loopback-endpoints'
    | 'no-pkce'
    | 'hmac-only'
    | 'basic-refused'
    | 'post-only'
    | undefined;
  jwks?: 'answers' | 'unreachable' | 'garbage' | undefined;
  token?: 'gives' | 'unreachable' | 'refuses' | 'no-id-token' | 'redirects' | undefined;
  /**
   * Claims turned wrong. A value replaces the claim; `null` takes it out. Merged over the defaults at the moment
   * the token is made, so a test sets them before the token endpoint is called.
   */
  claims?: Readonly<Record<string, unknown>> | undefined;
  /** How the token is signed wrong, if it is. */
  tamper?: 'signed-by-another-key' | 'unsigned' | 'hmac' | 'other-algorithm' | undefined;
  /** Where the id_token's `nonce` comes from: the authorize request's (default), or another. */
  nonce?: 'echo' | 'other' | undefined;
}

interface OidcCalls {
  readonly urls: string[];
  readonly signals: boolean[];
}

interface Authorized {
  readonly code: string;
  readonly state: string;
  readonly redirectUri: string;
}

export const OIDC_STUB_CREDENTIALS = {
  clientId: 'purlay-client',
  clientSecret: 'purlay-client-secret',
};

/** The issuer a stub that is not served has: an address nothing answers, since `fetch` is its transport. */
const OIDC_STUB_ISSUER = 'https://idp.example.test';

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const random = (): string => crypto.randomUUID().replaceAll('-', '');
const challengeOf = (verifier: string): string =>
  new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');

export interface OidcStub {
  /** The issuer, as this stub's discovery document says it: where it is served, once it is. */
  readonly issuer: () => string;
  readonly behaviour: OidcBehaviour;
  /** The provider's authorize screen, the person pressing Allow: checks the request, issues a code. */
  readonly authorize: (location: string) => Authorized;
  /** Discovery, keys and token endpoint, as the `fetch` the sign-in is handed. */
  readonly fetch: OidcFetch;
  readonly calls: OidcCalls;
  /** Every token request the stub refused, with the OAuth `error`, for a test to read. */
  readonly refusals: string[];
  /** Every code a token request presented, issued or not, in order. */
  readonly presentedCodes: string[];
  /** The key ids published now, and a new key signed with from the next token on (the old one is published for `overlap`). */
  readonly rotate: (overlap?: boolean) => Promise<void>;
  /** The person the stub vouches for next; a test changes it between sign-ins. */
  person: OidcPerson;
  /** An `id_token` made now as the token endpoint would make it, for a test that hands one to the library whole. */
  readonly mint: (nonce: string | undefined) => Promise<string>;
  readonly serve: (
    port: number,
    hostname?: string,
  ) => { readonly url: string; readonly stop: () => void };
}

interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

const newKey = async (): Promise<SigningKey> => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = `key-${random().slice(0, 8)}`;
  return {
    kid,
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' },
  };
};

/** Form fields as a token endpoint reads them, and the credentials as it takes them (RFC 6749 §2.3.1). */
const bodyOf = async (request: Request): Promise<Record<string, string>> =>
  Object.fromEntries(new URLSearchParams(await request.text()));

const basicCredentials = (request: Request): { id: string; secret: string } | undefined => {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) return undefined;
  const [id = '', secret = ''] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  return {
    id: decodeURIComponent(id.replaceAll('+', ' ')),
    secret: decodeURIComponent(secret.replaceAll('+', ' ')),
  };
};

export const anOidcStub = async (
  initial: OidcPerson,
  behaviour: OidcBehaviour = {},
  credentials: { readonly clientId: string; readonly clientSecret: string } = OIDC_STUB_CREDENTIALS,
  options: { readonly now?: () => number; readonly issuer?: string } = {},
): Promise<OidcStub> => {
  const now = options.now ?? Date.now;
  let issuer = options.issuer ?? OIDC_STUB_ISSUER;
  let signing = await newKey();
  let published: SigningKey[] = [signing];
  const stranger = await newKey();
  // A key of the provider's own, of an algorithm its discovery does not offer (ES256 beside RS256).
  const elliptic = await (async (): Promise<SigningKey> => {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    const kid = `ec-${random().slice(0, 8)}`;
    return {
      kid,
      privateKey,
      publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' },
    };
  })();
  const codes = new Map<
    string,
    {
      readonly challenge: string;
      readonly redirectUri: string;
      readonly nonce: string;
      readonly expiresAt: number;
      spent: boolean;
    }
  >();
  const calls: OidcCalls = { urls: [], signals: [] };
  const refusals: string[] = [];
  const presentedCodes: string[] = [];
  const stub: { person: OidcPerson } = { person: initial };

  const mint = async (nonce: string | undefined): Promise<string> => {
    const seconds = Math.floor(now() / 1000);
    const base: Record<string, unknown> = {
      iss: issuer,
      sub: stub.person.sub,
      aud: credentials.clientId,
      exp: seconds + 300,
      iat: seconds,
      ...(nonce === undefined ? {} : { nonce }),
      email: stub.person.email,
      email_verified: true,
      ...(stub.person.name === undefined ? {} : { name: stub.person.name }),
    };
    const claims = Object.fromEntries(
      Object.entries({ ...base, ...(behaviour.claims ?? {}) }).filter(
        ([, value]) => value !== null,
      ),
    );
    if (behaviour.tamper === 'unsigned') {
      const part = (value: unknown): string =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.`;
    }
    if (behaviour.tamper === 'hmac') {
      // Signed with a shared secret that happens to be the public modulus: the classic confusion.
      return await new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256', kid: signing.kid })
        .sign(new TextEncoder().encode(String(signing.publicJwk.n)));
    }
    if (behaviour.tamper === 'other-algorithm') {
      return await new SignJWT(claims)
        .setProtectedHeader({ alg: 'ES256', kid: elliptic.kid })
        .sign(elliptic.privateKey);
    }
    const key = behaviour.tamper === 'signed-by-another-key' ? stranger : signing;
    return await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: signing.kid })
      .sign(key.privateKey);
  };

  const discoveryDocument = (): Record<string, unknown> => {
    const mode = behaviour.discovery ?? 'answers';
    const secure =
      mode === 'http-endpoints' && issuer.startsWith('https:')
        ? issuer.replace('https:', 'http:')
        : mode === 'loopback-endpoints'
          ? 'http://127.0.0.1:1'
          : issuer;
    return {
      issuer: mode === 'issuer-mismatch' ? `${issuer}/other` : issuer,
      authorization_endpoint: `${secure}/authorize`,
      token_endpoint: `${secure}/token`,
      jwks_uri: `${secure}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: mode === 'hmac-only' ? ['HS256'] : ['RS256'],
      token_endpoint_auth_methods_supported:
        mode === 'post-only'
          ? ['client_secret_post']
          : ['client_secret_basic', 'client_secret_post'],
      grant_types_supported: ['authorization_code'],
      ...(mode === 'no-pkce'
        ? { code_challenge_methods_supported: ['plain'] }
        : { code_challenge_methods_supported: ['S256'] }),
    };
  };

  const authorize = (location: string): Authorized => {
    const url = new URL(location);
    const problem = (what: string): never => {
      throw new Error(`the OIDC stub refused the authorize request: ${what} (${location})`);
    };
    if (`${url.origin}${url.pathname}` !== `${issuer}/authorize`)
      problem('not the authorize endpoint');
    const get = (name: string): string => url.searchParams.get(name) ?? '';
    if (get('response_type') !== 'code') problem('response_type is not code');
    if (get('client_id') !== credentials.clientId) problem('client_id');
    if (!get('scope').split(' ').includes('openid')) problem('scope has no openid');
    if (get('state') === '') problem('no state');
    if (get('nonce') === '') problem('no nonce');
    if (get('redirect_uri') === '') problem('no redirect_uri');
    if (get('code_challenge_method') !== 'S256') problem('code_challenge_method is not S256');
    if (get('code_challenge').length !== 43) problem('code_challenge is not a SHA-256');
    const code = random();
    codes.set(code, {
      challenge: get('code_challenge'),
      redirectUri: get('redirect_uri'),
      nonce: get('nonce'),
      expiresAt: now() + CODE_LIFETIME_MS,
      spent: false,
    });
    return { code, state: get('state'), redirectUri: get('redirect_uri') };
  };

  const token = async (request: Request): Promise<Response> => {
    const body = await bodyOf(request);
    presentedCodes.push(body['code'] ?? '');
    const say = (error: string, status = 400): Response => {
      refusals.push(error);
      return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });
    };
    const basic = basicCredentials(request);
    const id = basic?.id ?? body['client_id'];
    const secret = basic?.secret ?? body['client_secret'];
    if (behaviour.discovery === 'basic-refused' && basic !== undefined)
      return say('invalid_client', 401);
    if (id !== credentials.clientId || secret !== credentials.clientSecret)
      return say('invalid_client', 401);
    if (body['grant_type'] !== 'authorization_code') return say('unsupported_grant_type');
    const issued = codes.get(body['code'] ?? '');
    if (issued === undefined || issued.spent || now() > issued.expiresAt)
      return say('invalid_grant');
    if (body['redirect_uri'] !== issued.redirectUri) return say('invalid_grant');
    if (challengeOf(body['code_verifier'] ?? '') !== issued.challenge) return say('invalid_grant');
    issued.spent = true;
    const nonce = behaviour.nonce === 'other' ? 'another-nonce' : issued.nonce;
    return Response.json(
      {
        access_token: `at_${random()}`,
        token_type: 'Bearer',
        expires_in: 300,
        ...(behaviour.token === 'no-id-token' ? {} : { id_token: await mint(nonce) }),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  };

  const answer = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === '/.well-known/openid-configuration') {
      const mode = behaviour.discovery ?? 'answers';
      if (mode === 'unreachable') throw new TypeError('fetch failed');
      if (mode === 'refuses') return new Response('nope', { status: 503 });
      if (mode === 'redirects') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example.test/' },
        });
      }
      return Response.json(discoveryDocument());
    }
    if (pathname === '/jwks') {
      if (behaviour.jwks === 'unreachable') throw new TypeError('fetch failed');
      if (behaviour.jwks === 'garbage') return new Response('<html>', { status: 200 });
      const extra = behaviour.tamper === 'other-algorithm' ? [elliptic] : [];
      return Response.json({ keys: [...published, ...extra].map((key) => key.publicJwk) });
    }
    if (pathname === '/token') {
      const mode = behaviour.token ?? 'gives';
      if (mode === 'unreachable') throw new TypeError('fetch failed');
      if (mode === 'refuses') return new Response('busy', { status: 503 });
      if (mode === 'redirects') {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://elsewhere.example.test/token' },
        });
      }
      return await token(request);
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  };

  const fetch: OidcFetch = async (url, init) => {
    calls.urls.push(url);
    calls.signals.push(init.signal instanceof AbortSignal);
    return await answer(
      new Request(url, {
        method: init.method ?? 'GET',
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
    );
  };

  const serve = (
    port: number,
    hostname = '127.0.0.1',
  ): { readonly url: string; readonly stop: () => void } => {
    const server = Bun.serve({
      port,
      hostname,
      fetch: async (request) => {
        const { pathname, search } = new URL(request.url);
        // A browser run turns the provider wrong from outside this process: `{ behaviour, person }`, merged.
        if (pathname === '/__control' && request.method === 'POST') {
          const change = (await request.json()) as {
            readonly behaviour?: OidcBehaviour;
            readonly person?: OidcPerson;
          };
          if (change.behaviour !== undefined) {
            for (const key of Object.keys(behaviour)) Reflect.deleteProperty(behaviour, key);
            Object.assign(behaviour, change.behaviour);
          }
          if (change.person !== undefined) stub.person = change.person;
          return new Response(null, { status: 204 });
        }
        if (pathname === '/authorize') {
          const { code, state, redirectUri } = authorize(`${issuer}/authorize${search}`);
          const back = new URL(redirectUri);
          back.searchParams.set('code', code);
          back.searchParams.set('state', state);
          return Response.redirect(back.toString(), 302);
        }
        return await answer(request);
      },
    });
    // A provider served is the issuer it names, and the port may be the system's choosing: set before a
    // request can ask, since nothing has the address to ask until this returns.
    issuer = `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${String(server.port)}`;
    return { url: issuer, stop: () => void server.stop(true) };
  };

  return {
    issuer: () => issuer,
    behaviour,
    authorize,
    fetch,
    calls,
    refusals,
    presentedCodes,
    rotate: async (overlap = false): Promise<void> => {
      const next = await newKey();
      published = overlap ? [signing, next] : [next];
      signing = next;
    },
    get person(): OidcPerson {
      return stub.person;
    },
    set person(value: OidcPerson) {
      stub.person = value;
    },
    mint,
    serve,
  };
};
