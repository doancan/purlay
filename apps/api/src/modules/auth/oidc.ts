/**
 * Single sign-on by an OpenID Connect provider (D-200): the provider the sign-in library is handed beside
 * GitHub's, and everything it takes on trust is checked here rather than assumed of the library or of the
 * provider.
 *
 * **Authorization code with PKCE, and nothing else.** The browser is sent to the provider with `state` (the
 * library's, in its own cookie), a `nonce` and an S256 `code_challenge`; what comes back is a code, which this
 * server redeems itself — with its client secret, over a connection it bounds and never lets be redirected —
 * for an `id_token`. The access token is never used and never kept.
 *
 * **The `id_token` is the only identity, and it is believed only whole** (`verified`): its signature is checked
 * against the provider's published keys, with an algorithm from an allow-list of asymmetric ones — never the
 * token's own say, never `none`, never a shared secret — and `iss` must be the configured issuer, `aud` this
 * server's client id (with `azp` agreeing when there are several), `exp` and `iat` sane within thirty seconds of
 * skew, the token no older than ten minutes, and `nonce` exactly the one this very sign-in made. A token missing
 * any of `iss`, `sub`, `aud`, `exp`, `iat` is refused. Nothing is read from the userinfo endpoint: an identity
 * is what a signed token says, never what an unsigned answer does.
 *
 * **The provider is what discovery says it is, and only if it says the issuer it was asked** (`discover`): its
 * metadata is fetched from the issuer's own well-known address, the `issuer` in it must equal the configured one
 * byte for byte (Discovery §4.3 — a mismatch is how a mix-up is made), every endpoint must be `https` (or `http`
 * to this machine, where the issuer is), and a provider that cannot do the code flow with S256, or signs with
 * nothing this server will verify, is refused. Fetched when a sign-in needs it, never when the server starts or
 * the setting is saved: while no provider is set, **nothing is sent anywhere**.
 *
 * **Keys are cached and rotate** (`keysOf`): the provider's JWKS is kept ten minutes, and a token signed by a
 * key not in it fetches it again once — at most one fetch in thirty seconds, so a stream of forged `kid`s is not
 * a stream of requests to the provider.
 *
 * **Who the account is**: the issuer and the `sub`, joined (`accountSubject`) — a `sub` is unique only within
 * its issuer, so a server pointed at another provider later cannot be signed into somebody else's account by a
 * `sub` that happens to repeat. **Whether its address may be trusted**: `email_verified` must be `true`, or the
 * sign-in is refused (`OIDC_EMAIL_UNVERIFIED`) — the library then links an existing account only if that
 * account's own address is verified too (D-200 §3).
 *
 * Everything that reaches the network goes through `fetch`, an argument, so a test stands a provider of its own
 * in place of the real one (`testing/fake-oidc-provider.ts`).
 */
import { APIError } from 'better-auth/api';
import type { OAuth2Tokens } from 'better-auth';
import { createAuthorizationURL, type OAuthProvider } from '@better-auth/core/oauth2';
import {
  createLocalJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';
import { normalisedMailbox } from '@purlay/types';
import { readCapped } from '../../platform/http-body';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import { isFetchableAddress, oidcDiscoveryAddress } from '../../platform/oidc-address';
import { randomToken } from '../../platform/tokens';
import { oidcDisplayName, usernameFrom } from './identity';
import type { GithubFetch } from './better-auth';

/** Where the sign-in provider is, and who this server is to it (D-200). */
export interface OidcCredentials {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** What reaches the provider: never redirected (a redirect re-sends a body that carries the client secret). */
export type OidcFetch = GithubFetch;

/** The provider's identifier in the library's tables: `accounts.provider_id` (D-200 §3). */
export const OIDC_PROVIDER_ID = 'oidc';

/** The scopes asked for: the identity, and the address and name it carries — nothing that grants anything. */
const SCOPES: readonly string[] = ['openid', 'email', 'profile'];

/** How long any one call to the provider may take: the person is waiting on a redirect. */
const OIDC_TIMEOUT_MS = 10_000;

/** The most of a provider's reply that is read: a discovery document, a key set, a token response. */
const REPLY_MAX_BYTES = 256 * 1024;

/** How long a discovery document is believed before it is fetched again. */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** How long a key set is believed, and the shortest time between two fetches of it. */
const KEYS_TTL_MS = 10 * 60 * 1000;
const KEYS_COOLDOWN_MS = 30 * 1000;

/** The most keys a set may hold: a provider has a handful, and a larger set is not one. */
const KEYS_MAX = 100;

/** Skew allowed on `exp` and `iat`, and the oldest an `id_token` may be: a sign-in takes seconds. */
const CLOCK_TOLERANCE_SECONDS = 30;
const TOKEN_MAX_AGE = '10m';

/**
 * The signature algorithms an `id_token` may carry: the asymmetric ones, and only those. `none` and the `HS*`
 * family are absent on purpose — a token signed with a shared secret proves nothing about who holds the key.
 */
const ASYMMETRIC: ReadonlySet<string> = new Set([
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
]);

/** A subject is at most 255 ASCII characters (Core §2); one longer is not a subject. */
const SUBJECT_MAX = 255;

/** Why a provider could not be used, in the closed set the probe and the log both speak. */
export type OidcFailure =
  'unreachable' | 'unexpected-reply' | 'issuer-mismatch' | 'discovery-invalid';

/** A provider that cannot be used, said by `reason`; `cause` carries what the transport said. */
export class OidcDiscoveryError extends Error {
  readonly reason: OidcFailure;

  constructor(reason: OidcFailure, detail: string, cause?: unknown) {
    super(
      `OpenID Connect discovery failed (${reason}): ${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'OidcDiscoveryError';
    this.reason = reason;
  }
}

/** What a sign-in needs to know of the provider, from its discovery document. */
export interface Discovery {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  /** The algorithms this server will accept an `id_token` in: the provider's, narrowed to `ASYMMETRIC`. */
  readonly algorithms: readonly string[];
  /** How the client secret goes to the token endpoint (RFC 6749 §2.3.1: the header is the one every provider takes). */
  readonly tokenAuth: 'basic' | 'post';
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;

/** One call to the provider: bounded, never redirected, its reply read no further than `REPLY_MAX_BYTES`. */
const call = async (
  get: OidcFetch,
  url: string,
  init: {
    readonly method?: 'POST';
    readonly headers: Record<string, string>;
    readonly body?: string;
  },
): Promise<{ readonly status: number; readonly json: unknown }> => {
  let response: Response;
  try {
    response = await get(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OidcDiscoveryError('unreachable', 'the provider could not be reached', error);
  }
  let json: unknown;
  let body: Awaited<ReturnType<typeof readCapped>>;
  try {
    body = await readCapped(response, REPLY_MAX_BYTES);
  } catch (error) {
    // Headers came and the body did not: a stall past the deadline or a reset is the provider not answering,
    // never a document that was answered and was wrong.
    throw new OidcDiscoveryError('unreachable', 'the reply could not be read to its end', error);
  }
  try {
    // Too long, or not JSON, is a reply that is not a provider's: `json` is nothing, and the status says the rest.
    json = 'text' in body ? (JSON.parse(body.text) as unknown) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
};

/** An endpoint of the provider's: a string, an address, over the same security as the issuer's own. */
const endpointOf = (
  document: Readonly<Record<string, unknown>>,
  name: string,
  issuer: URL,
): string => {
  const value = document[name];
  let url: URL | undefined;
  try {
    url = typeof value === 'string' ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  if (value === undefined || typeof value !== 'string' || url === undefined) {
    throw new OidcDiscoveryError('discovery-invalid', `${name} is missing or not an address`);
  }
  // An `https` issuer never sends the browser, or the client secret, anywhere that is not `https`.
  if (!isFetchableAddress(url) || (issuer.protocol === 'https:' && url.protocol !== 'https:')) {
    throw new OidcDiscoveryError('discovery-invalid', `${name} is not https`);
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new OidcDiscoveryError('discovery-invalid', `${name} carries credentials or a fragment`);
  }
  return url.toString();
};

/**
 * The provider's metadata, believed only as far as it checks out (see the module's header). Throws
 * `OidcDiscoveryError` with the reason; the sign-in answers it as the provider being unavailable and the probe
 * says the reason to the operator.
 */
export const discover = async (issuer: string, get: OidcFetch): Promise<Discovery> => {
  const { status, json } = await call(get, oidcDiscoveryAddress(issuer), {
    headers: { Accept: 'application/json', 'User-Agent': 'purlay' },
  });
  if (status !== 200 || !isRecord(json)) {
    throw new OidcDiscoveryError(
      'discovery-invalid',
      `the discovery document answered HTTP ${String(status)}`,
    );
  }
  if (json['issuer'] !== issuer) {
    throw new OidcDiscoveryError(
      'issuer-mismatch',
      'the issuer in the discovery document is another',
    );
  }
  const base = new URL(issuer);
  const authorizationEndpoint = endpointOf(json, 'authorization_endpoint', base);
  const tokenEndpoint = endpointOf(json, 'token_endpoint', base);
  const jwksUri = endpointOf(json, 'jwks_uri', base);
  // What is absent is the default of the specification (Discovery §3), which each of these satisfies; what is
  // present and leaves out what this server does is a provider it cannot sign in through.
  const responseTypes = json['response_types_supported'];
  if (responseTypes !== undefined && !(strings(responseTypes) ?? []).includes('code')) {
    throw new OidcDiscoveryError('discovery-invalid', 'the provider does not offer the code flow');
  }
  const challenges = json['code_challenge_methods_supported'];
  if (challenges !== undefined && !(strings(challenges) ?? []).includes('S256')) {
    throw new OidcDiscoveryError('discovery-invalid', 'the provider does not offer PKCE with S256');
  }
  const grants = json['grant_types_supported'];
  if (grants !== undefined && !(strings(grants) ?? []).includes('authorization_code')) {
    throw new OidcDiscoveryError(
      'discovery-invalid',
      'the provider does not offer the authorization code grant',
    );
  }
  const offered = json['id_token_signing_alg_values_supported'];
  const algorithms =
    offered === undefined
      ? ['RS256']
      : (strings(offered) ?? []).filter((algorithm) => ASYMMETRIC.has(algorithm));
  if (algorithms.length === 0) {
    throw new OidcDiscoveryError(
      'discovery-invalid',
      'the provider signs with no algorithm this server accepts',
    );
  }
  const methods = json['token_endpoint_auth_methods_supported'];
  const offeredMethods = methods === undefined ? ['client_secret_basic'] : (strings(methods) ?? []);
  const tokenAuth = offeredMethods.includes('client_secret_basic')
    ? 'basic'
    : offeredMethods.includes('client_secret_post')
      ? 'post'
      : undefined;
  if (tokenAuth === undefined) {
    throw new OidcDiscoveryError(
      'discovery-invalid',
      'the provider takes no client secret this server can send',
    );
  }
  return { issuer, authorizationEndpoint, tokenEndpoint, jwksUri, algorithms, tokenAuth };
};

/** The provider's key set as it publishes it: an object holding a bounded array of keys. */
const keySetOf = (json: unknown): JSONWebKeySet | undefined => {
  if (!isRecord(json) || !Array.isArray(json['keys']) || json['keys'].length > KEYS_MAX)
    return undefined;
  return { keys: json['keys'].filter(isRecord) };
};

/**
 * The authorization code, redeemed at the token endpoint (RFC 6749 §4.1.3) with the PKCE verifier and this
 * server's client secret, sent the way the provider says it takes it. The one place the secret leaves this
 * process: bounded, never redirected, and the reply read no further than `REPLY_MAX_BYTES`. The probe
 * (`modules/setup/probes.ts`) sends it a code nobody was ever given, to learn whether the client is known.
 */
export const tokenRequest = async (
  metadata: Discovery,
  { clientId, clientSecret }: OidcCredentials,
  grant: { readonly code: string; readonly codeVerifier: string; readonly redirectURI: string },
  get: OidcFetch,
): Promise<{ readonly status: number; readonly json: unknown }> => {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: grant.code,
    redirect_uri: grant.redirectURI,
    code_verifier: grant.codeVerifier,
  });
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'purlay',
  };
  if (metadata.tokenAuth === 'basic') {
    // RFC 6749 §2.3.1: each part form-encoded before the two are joined.
    headers['Authorization'] =
      `Basic ${Buffer.from(`${formEncoded(clientId)}:${formEncoded(clientSecret)}`).toString('base64')}`;
  } else {
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
  }
  return await call(get, metadata.tokenEndpoint, {
    method: 'POST',
    headers,
    body: form.toString(),
  });
};

export interface OidcDependencies {
  readonly fetch: OidcFetch;
  readonly clock: Clock;
  readonly log: Logger;
  /**
   * Told the account a verified sign-in is for, before the library goes on to make or link it — so the one
   * request can say, after, that its sign-up lost a race to the same account made at once (`better-auth.ts`).
   */
  readonly onIdentity: (accountId: string) => void;
}

/** The provider, as the sign-in library takes one (`OAuthProvider`): everything it does is below. */
export interface OidcProvider {
  readonly id: typeof OIDC_PROVIDER_ID;
  readonly name: string;
  /** Checks the discovery document and the key set now (the probe's, and a test's), throwing as `discover` does. */
  readonly check: () => Promise<Discovery>;
  readonly provider: OAuthProvider<OidcProfile>;
}

/** What the provider's verified token says of the account, as the library keeps it beside the account. */
export interface OidcProfile {
  readonly sub: string;
  readonly iss: string;
}

/** Redirects the browser, redeems the code and verifies the token for one provider, from its settings. */
export const createOidcProvider = (
  credentials: OidcCredentials,
  name: string,
  deps: OidcDependencies,
): OidcProvider => {
  const { fetch: get, clock, log } = deps;
  const { issuer, clientId } = credentials;

  /** The metadata, fetched once an hour and by one request at a time. */
  let discovery: { readonly value: Discovery; readonly at: number } | undefined;
  let discovering: Promise<Discovery> | undefined;
  const discovered = async (): Promise<Discovery> => {
    if (discovery !== undefined && clock.now().getTime() - discovery.at < DISCOVERY_TTL_MS) {
      return discovery.value;
    }
    discovering ??= discover(issuer, get)
      .then((value) => {
        discovery = { value, at: clock.now().getTime() };
        return value;
      })
      .finally(() => {
        discovering = undefined;
      });
    return await discovering;
  };

  /** The key set, fetched at most once in thirty seconds and believed for ten minutes. */
  let keys: { readonly set: JSONWebKeySet; readonly at: number } | undefined;
  let lastFetchedAt = Number.NEGATIVE_INFINITY;
  let fetchingKeys: Promise<void> | undefined;
  const fetchKeys = async (uri: string): Promise<void> => {
    fetchingKeys ??= (async (): Promise<void> => {
      lastFetchedAt = clock.now().getTime();
      const { status, json } = await call(get, uri, {
        headers: { Accept: 'application/json', 'User-Agent': 'purlay' },
      });
      const set = status === 200 ? keySetOf(json) : undefined;
      if (set === undefined)
        throw new OidcDiscoveryError('unexpected-reply', 'the provider published no usable keys');
      keys = { set, at: clock.now().getTime() };
    })().finally(() => {
      fetchingKeys = undefined;
    });
    await fetchingKeys;
  };
  const keyFor =
    (uri: string): JWTVerifyGetKey =>
    async (header, token) => {
      const now = (): number => clock.now().getTime();
      if (keys === undefined || now() - keys.at >= KEYS_TTL_MS) await fetchKeys(uri);
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await createLocalJWKSet((keys ?? { set: { keys: [] } }).set)(header, token);
        } catch (error) {
          // A key it has not seen is the provider's rotation — or somebody's guess: fetched again, once,
          // and not again for thirty seconds whoever asks.
          const unknown = error instanceof errors.JWKSNoMatchingKey;
          if (!unknown || attempt > 0 || now() - lastFetchedAt < KEYS_COOLDOWN_MS) throw error;
          await fetchKeys(uri);
        }
      }
    };

  /** The claims of an `id_token` that is whole and is this sign-in's, or why not. */
  const verified = async (
    idToken: string,
    nonce: string | undefined,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const metadata = await discovered();
    if (nonce === undefined || nonce === '')
      throw new Error('the sign-in carries no nonce to bind the token to');
    const { payload } = await jwtVerify(idToken, keyFor(metadata.jwksUri), {
      issuer,
      audience: clientId,
      algorithms: [...metadata.algorithms],
      requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      maxTokenAge: TOKEN_MAX_AGE,
      currentDate: clock.now(),
    });
    const { sub, aud, azp } = payload;
    if (typeof sub !== 'string' || sub === '' || sub.length > SUBJECT_MAX) {
      throw new Error('the token has no usable subject');
    }
    // Core §3.1.3.7 (4, 5): more than one audience needs an authorized party, and it is this client.
    if (
      (Array.isArray(aud) && aud.length > 1 && azp !== clientId) ||
      (azp !== undefined && azp !== clientId)
    ) {
      throw new Error('the token was issued to another party');
    }
    if (payload['nonce'] !== nonce)
      throw new Error('the token is not the one this sign-in asked for');
    return payload;
  };

  const redeem = async ({
    code,
    codeVerifier,
    redirectURI,
  }: {
    readonly code: string;
    readonly codeVerifier?: string | undefined;
    readonly redirectURI: string;
  }): Promise<OAuth2Tokens | null> => {
    // No verifier, no request: the code is no use to anybody who did not start this sign-in (PKCE).
    if (codeVerifier === undefined || codeVerifier === '') {
      log.error('oidc sign-in: the library gave no PKCE verifier for the code');
      return null;
    }
    let metadata: Discovery;
    try {
      metadata = await discovered();
    } catch (error) {
      log.warn('oidc sign-in: the provider could not be discovered', { err: error });
      return null;
    }
    let answer: { readonly status: number; readonly json: unknown };
    try {
      answer = await tokenRequest(metadata, credentials, { code, codeVerifier, redirectURI }, get);
    } catch (error) {
      log.warn('oidc sign-in: the token endpoint could not be reached', { err: error });
      return null;
    }
    const body = isRecord(answer.json) ? answer.json : {};
    const idToken = body['id_token'];
    if (answer.status !== 200 || typeof idToken !== 'string' || idToken === '') {
      const said = body['error'];
      // A client the provider no longer accepts is the operator's to fix, and every sign-in fails until they do:
      // loud, where a spent code is a person's retry.
      const level = said === 'invalid_client' || said === 'unauthorized_client' ? 'error' : 'warn';
      log[level]('oidc sign-in: the provider gave no id_token for the code', {
        status: answer.status,
        ...(typeof said === 'string' ? { oidcError: said.slice(0, 64) } : {}),
      });
      return null;
    }
    return { idToken, tokenType: 'bearer' };
  };

  const userInfo = async (
    tokens: OAuth2Tokens & { readonly expectedIdTokenNonce?: string | undefined },
  ): Promise<{
    user: {
      name: string | undefined;
      email: string;
      emailVerified: true;
      username: string;
    };
    data: { readonly sub: string; readonly iss: string };
  } | null> => {
    if (tokens.idToken === undefined || tokens.idToken === '') {
      log.warn('oidc sign-in: the token response held no id_token');
      return null;
    }
    let claims: Readonly<Record<string, unknown>>;
    try {
      claims = await verified(tokens.idToken, tokens.expectedIdTokenNonce);
    } catch (error) {
      // A key set that could not be had is the provider's failing, not the token's: said as such.
      if (error instanceof OidcDiscoveryError) {
        log.warn('oidc sign-in: the keys of the provider could not be had', {
          reason: error.reason,
        });
        throw new APIError('BAD_GATEWAY', {
          code: 'OIDC_UNAVAILABLE',
          message: 'The single sign-on provider did not answer.',
        });
      }
      // Which check refused it is the log's, by name; the person is told it did not work, never why.
      log.warn('oidc sign-in: the id_token was refused', {
        reason: error instanceof Error ? error.name : 'unknown',
        ...(error instanceof errors.JOSEError ? { code: error.code } : {}),
      });
      return null;
    }
    const subject = claims['sub'] as string;
    // `email_verified` is `true`, or the string `true` some providers send; nothing else is a yes.
    const email =
      typeof claims['email'] === 'string' ? normalisedMailbox(claims['email']) : undefined;
    const yes = claims['email_verified'] === true || claims['email_verified'] === 'true';
    if (email === undefined || !yes) {
      log.info('oidc sign-in: the provider did not vouch for a verified address');
      throw new APIError('FORBIDDEN', {
        code: 'OIDC_EMAIL_UNVERIFIED',
        message: 'The provider did not say the address is verified.',
      });
    }
    deps.onIdentity(accountKeyOf(issuer, subject));
    return {
      user: {
        name: oidcDisplayName(claims['name']),
        email,
        emailVerified: true,
        // Made from the address as an email account's is (D-138 §5), and made free and unique by the user hook
        // (`better-auth.ts`) whatever is said here; nothing the provider chose reaches it.
        username: usernameFrom(email) ?? `user-${randomToken().slice(0, 6)}`,
      },
      data: { sub: subject, iss: issuer },
    };
  };

  const provider: OAuthProvider<OidcProfile> = {
    id: OIDC_PROVIDER_ID,
    name,
    issuer,
    // The nonce is bound to the state this sign-in made, and a callback without it is refused.
    requiresIdTokenNonce: true,
    // A token handed to the sign-in route by a client is not how anybody signs in with this provider: the
    // browser comes back by the redirect, and the token is redeemed here. Nothing else weighs one.
    options: { disableIdTokenSignIn: true },
    // Only a person who started it by pressing the button; a provider-initiated sign-in is not served.
    allowIdpInitiated: false,
    accountSubject: ({ profile }: { readonly profile: { readonly sub: string } }): string =>
      accountKeyOf(issuer, profile.sub),
    createAuthorizationURL: async (data: {
      readonly state: string;
      readonly codeVerifier: string;
      readonly redirectURI: string;
      readonly idTokenNonce?: string | undefined;
    }): Promise<URL> => {
      let metadata: Discovery;
      try {
        metadata = await discovered();
      } catch (error) {
        log.warn('oidc sign-in: the provider could not be discovered', { err: error });
        throw new APIError('BAD_GATEWAY', {
          code: 'OIDC_UNAVAILABLE',
          message: 'The single sign-on provider did not answer.',
        });
      }
      return await createAuthorizationURL({
        id: OIDC_PROVIDER_ID,
        options: { clientId, redirectURI: data.redirectURI },
        authorizationEndpoint: metadata.authorizationEndpoint,
        state: data.state,
        codeVerifier: data.codeVerifier,
        scopes: [...SCOPES],
        redirectURI: data.redirectURI,
        nonce: data.idTokenNonce,
      });
    },
    validateAuthorizationCode: redeem,
    getUserInfo: userInfo,
  };
  return {
    id: OIDC_PROVIDER_ID,
    name,
    provider,
    check: async (): Promise<Discovery> => {
      const metadata = await discovered();
      await fetchKeys(metadata.jwksUri);
      return metadata;
    },
  };
};

/** What the library keeps as the account's id: the issuer and the subject, so a repeated `sub` is no other's. */
export const accountKeyOf = (issuer: string, subject: string): string => `${issuer}|${subject}`;

/** A credential part as RFC 6749 §2.3.1 sends it in the header: `application/x-www-form-urlencoded`. */
const formEncoded = (value: string): string =>
  new URLSearchParams({ v: value }).toString().slice(2);
