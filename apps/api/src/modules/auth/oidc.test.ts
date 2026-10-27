/**
 * What `oidc.ts` believes of a provider and of its token (D-200 §2), with no database: the provider is the
 * strict double at the `fetch` boundary (`testing/oidc-stub.ts`) or a bare `fetch` that answers what a test
 * writes. The whole sign-in through the library is `oidc-sign-in.integration.test.ts`'s.
 */
import { describe, expect, test } from 'bun:test';
import { systemClock } from '../../platform/clock';
import { aRecordingLogger } from '../../testing/doubles';
import {
  anOidcStub,
  OIDC_STUB_CREDENTIALS,
  type OidcBehaviour,
  type OidcPerson,
} from '../../testing/oidc-stub';
import {
  accountKeyOf,
  createOidcProvider,
  discover,
  OidcDiscoveryError,
  type OidcFetch,
} from './oidc';

const ISSUER = 'https://idp.example.test';

/** A discovery document as a provider serves it, with what a test turns wrong. */
const document = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  ...over,
});

const answering =
  (answer: () => Response | Promise<Response>): OidcFetch =>
  async () =>
    await answer();

const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OidcDiscoveryError) return error.reason;
    throw error;
  }
  return 'accepted';
};

describe('what discovery must say', () => {
  test('a document that checks out is read: its endpoints, RS256 by default, the secret in the header by default', async () => {
    const found = await discover(
      ISSUER,
      answering(() => Response.json(document())),
    );
    expect(found).toEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      jwksUri: `${ISSUER}/jwks`,
      algorithms: ['RS256'],
      tokenAuth: 'basic',
    });
  });

  test('it is asked at the issuer’s well-known address with a deadline, and never followed through a redirect', async () => {
    const seen: { url: string; redirect: string; signal: boolean }[] = [];
    await discover(`${ISSUER}/tenant-1/`, (url, init) => {
      seen.push({ url, redirect: init.redirect, signal: init.signal instanceof AbortSignal });
      return Promise.resolve(Response.json(document({ issuer: `${ISSUER}/tenant-1/` })));
    });
    expect(seen).toEqual([
      {
        url: `${ISSUER}/tenant-1/.well-known/openid-configuration`,
        redirect: 'manual',
        signal: true,
      },
    ]);
  });

  test('only the asymmetric algorithms it offers are kept: never none, never a shared secret', async () => {
    const found = await discover(
      ISSUER,
      answering(() =>
        Response.json(
          document({
            id_token_signing_alg_values_supported: ['none', 'HS256', 'ES256', 'RS256', 'PS384'],
          }),
        ),
      ),
    );
    expect(found.algorithms).toEqual(['ES256', 'RS256', 'PS384']);
    for (const only of [['none'], ['HS256', 'HS512'], []]) {
      expect(
        await reasonOf(
          discover(
            ISSUER,
            answering(() =>
              Response.json(document({ id_token_signing_alg_values_supported: only })),
            ),
          ),
        ),
      ).toBe('discovery-invalid');
    }
  });

  test('the secret goes where the provider takes it: the header, else the body, else nowhere it can be sent', async () => {
    const taking = async (methods: unknown): Promise<string> =>
      (
        await discover(
          ISSUER,
          answering(() =>
            Response.json(document({ token_endpoint_auth_methods_supported: methods })),
          ),
        )
      ).tokenAuth;
    expect(await taking(['client_secret_post', 'client_secret_basic'])).toBe('basic');
    expect(await taking(['client_secret_post'])).toBe('post');
    expect(
      await reasonOf(
        discover(
          ISSUER,
          answering(() =>
            Response.json(document({ token_endpoint_auth_methods_supported: ['private_key_jwt'] })),
          ),
        ),
      ),
    ).toBe('discovery-invalid');
  });

  test.each<[string, Record<string, unknown>]>([
    ['a provider without the code flow', { response_types_supported: ['id_token'] }],
    ['a provider without PKCE S256', { code_challenge_methods_supported: ['plain'] }],
    ['a provider without the authorization code grant', { grant_types_supported: ['implicit'] }],
    ['a missing authorization endpoint', { authorization_endpoint: undefined }],
    ['a missing token endpoint', { token_endpoint: undefined }],
    ['a missing key set', { jwks_uri: undefined }],
    ['an endpoint that is not an address', { token_endpoint: 'not an address' }],
    ['an endpoint that is a number', { jwks_uri: 7 }],
    ['an endpoint with credentials', { token_endpoint: 'https://u:p@idp.example.test/token' }],
    ['an endpoint with a fragment', { token_endpoint: `${ISSUER}/token#x` }],
    ['an http endpoint under an https issuer', { token_endpoint: 'http://idp.example.test/token' }],
    ['a file endpoint', { jwks_uri: 'file:///etc/passwd' }],
  ])('is refused as discovery-invalid: %s', async (_what, over) => {
    expect(
      await reasonOf(
        discover(
          ISSUER,
          answering(() => Response.json(document(over))),
        ),
      ),
    ).toBe('discovery-invalid');
  });

  test('another issuer in the document is a mismatch, whatever else is right; the slash counts', async () => {
    expect(
      await reasonOf(
        discover(
          ISSUER,
          answering(() => Response.json(document({ issuer: 'https://evil.example.test' }))),
        ),
      ),
    ).toBe('issuer-mismatch');
    expect(
      await reasonOf(
        discover(
          ISSUER,
          answering(() => Response.json(document({ issuer: `${ISSUER}/` }))),
        ),
      ),
    ).toBe('issuer-mismatch');
    expect(
      await reasonOf(
        discover(
          `${ISSUER}/`,
          answering(() => Response.json(document())),
        ),
      ),
    ).toBe('issuer-mismatch');
  });

  test.each<[string, () => Response]>([
    ['a 404', (): Response => new Response('nope', { status: 404 })],
    [
      'a 302',
      (): Response =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example.test' } }),
    ],
    ['a body that is not JSON', (): Response => new Response('<html>', { status: 200 })],
    ['JSON that is an array', (): Response => Response.json([document()])],
    ['JSON that is null', (): Response => Response.json(null)],
    ['an empty body', (): Response => new Response('', { status: 200 })],
    [
      'a body past 256 KB',
      (): Response => new Response(`{"issuer":"${'x'.repeat(300 * 1024)}"}`, { status: 200 }),
    ],
  ])('is refused as discovery-invalid: %s', async (_what, answer) => {
    expect(await reasonOf(discover(ISSUER, answering(answer)))).toBe('discovery-invalid');
  });

  test('a reply that is cut off while it is read is the provider not answering, not a document that was wrong', async () => {
    const cut = (): Response =>
      new Response(
        new ReadableStream({
          start(controller): void {
            controller.error(new Error('connection reset'));
          },
        }),
        { status: 200 },
      );
    expect(await reasonOf(discover(ISSUER, answering(cut)))).toBe('unreachable');
  });

  test('a provider nothing answers for is unreachable, and says what the transport said', async () => {
    const failure = new TypeError('fetch failed');
    try {
      await discover(ISSUER, () => Promise.reject(failure));
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(OidcDiscoveryError);
      expect((error as OidcDiscoveryError).reason).toBe('unreachable');
      expect((error as OidcDiscoveryError).cause).toBe(failure);
    }
  });

  test('http is accepted to this machine, with its endpoints, for a provider run beside the server', async () => {
    const local = 'http://127.0.0.1:9000';
    const found = await discover(
      local,
      answering(() =>
        Response.json(
          document({
            issuer: local,
            authorization_endpoint: `${local}/authorize`,
            token_endpoint: `${local}/token`,
            jwks_uri: `${local}/jwks`,
          }),
        ),
      ),
    );
    expect(found.tokenEndpoint).toBe(`${local}/token`);
  });
});

describe('who an account is', () => {
  test('the issuer and the subject, joined: a subject that repeats under another issuer is another account', () => {
    expect(accountKeyOf(ISSUER, '42')).toBe(`${ISSUER}|42`);
    expect(accountKeyOf(ISSUER, '42')).not.toBe(accountKeyOf('https://other.example.test', '42'));
  });
});

/** The whole redirect, redeem and verify, as the library drives it, through a provider. */
const signingIn = async (
  person: OidcPerson,
  behaviour: OidcBehaviour = {},
  options: { readonly withoutVerifier?: boolean } = {},
): Promise<{
  readonly identity:
    | Awaited<
        ReturnType<NonNullable<ReturnType<typeof createOidcProvider>['provider']['getUserInfo']>>
      >
    | 'refused';
  readonly lines: Record<string, unknown>[];
  readonly accounts: string[];
  readonly stub: Awaited<ReturnType<typeof anOidcStub>>;
}> => {
  const stub = await anOidcStub(person, behaviour);
  const { log, lines } = aRecordingLogger();
  const accounts: string[] = [];
  const { provider } = createOidcProvider(
    { issuer: stub.issuer(), ...OIDC_STUB_CREDENTIALS },
    'Acme',
    {
      fetch: stub.fetch,
      clock: systemClock,
      log,
      onIdentity: (key): void => {
        accounts.push(key);
      },
    },
  );
  const redirectURI = 'https://purlay.test/auth/callback/oidc';
  const verifier = 'v'.repeat(64);
  const nonce = 'n'.repeat(32);
  const url = await provider.createAuthorizationURL({
    state: 'state-value',
    codeVerifier: verifier,
    redirectURI,
    idTokenNonce: nonce,
  });
  const { code } = stub.authorize(url.toString());
  const tokens = await provider.validateAuthorizationCode({
    code,
    redirectURI,
    ...(options.withoutVerifier === true ? {} : { codeVerifier: verifier }),
  });
  if (tokens === null) return { identity: 'refused', lines, accounts, stub };
  const identity = await provider.getUserInfo({ ...tokens, expectedIdTokenNonce: nonce });
  return { identity, lines, accounts, stub };
};

describe('the token, believed whole or not at all', () => {
  const ada: OidcPerson = {
    sub: 'ada-1',
    email: 'Ada.Lovelace@Example.Test',
    name: 'Ada Lovelace',
  };

  test('a token that checks out is an identity: the address normalised, the name cleaned, the account keyed by issuer', async () => {
    const { identity, accounts, stub } = await signingIn(ada);
    expect(identity).toMatchObject({
      user: {
        name: 'Ada Lovelace',
        email: 'ada.lovelace@example.test',
        emailVerified: true,
        username: 'ada-lovelace',
      },
      data: { sub: 'ada-1', iss: stub.issuer() },
    });
    expect(accounts).toEqual([`${stub.issuer()}|ada-1`]);
  });

  test('several audiences are believed only with this client as the authorized party', async () => {
    const both = ['purlay-client', 'another-client'];
    expect(
      (await signingIn(ada, { claims: { aud: both, azp: 'purlay-client' } })).identity,
    ).not.toBeNull();
    expect((await signingIn(ada, { claims: { aud: both } })).identity).toBeNull();
    expect(
      (await signingIn(ada, { claims: { aud: both, azp: 'another-client' } })).identity,
    ).toBeNull();
    // An authorized party that is not this client is refused even with one audience.
    expect((await signingIn(ada, { claims: { azp: 'another-client' } })).identity).toBeNull();
  });

  test('a refusal is by the name of the check, in the log, with no token, no claim and no address', async () => {
    const { lines, identity } = await signingIn(ada, { claims: { aud: 'another-client' } });
    expect(identity).toBeNull();
    const written = JSON.stringify(lines);
    expect(written).toContain('JWTClaimValidationFailed');
    expect(written).not.toContain('another-client');
    expect(written).not.toContain('ada.lovelace');
    expect(written).not.toMatch(/eyJ/);
  });

  test('the account is told only once the token is believed: a refused token names nobody', async () => {
    const { accounts } = await signingIn(ada, { tamper: 'signed-by-another-key' });
    expect(accounts).toEqual([]);
  });

  test('an address that is not verified is refused with a 403 the sign-in names, and names nobody', async () => {
    const stub = await anOidcStub(ada, { claims: { email_verified: false } });
    const accounts: string[] = [];
    const { provider } = createOidcProvider(
      { issuer: stub.issuer(), ...OIDC_STUB_CREDENTIALS },
      'Acme',
      {
        fetch: stub.fetch,
        clock: systemClock,
        log: aRecordingLogger().log,
        onIdentity: (key): void => {
          accounts.push(key);
        },
      },
    );
    const idToken = await stub.mint('the-nonce');
    let refused: unknown;
    try {
      await provider.getUserInfo({ idToken, expectedIdTokenNonce: 'the-nonce' });
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({ status: 'FORBIDDEN', body: { code: 'OIDC_EMAIL_UNVERIFIED' } });
    expect(accounts).toEqual([]);
  });

  test('a token with no nonce expected is refused: a callback that cannot bind one believes nothing', async () => {
    const stub = await anOidcStub(ada);
    const { provider } = createOidcProvider(
      { issuer: stub.issuer(), ...OIDC_STUB_CREDENTIALS },
      'Acme',
      {
        fetch: stub.fetch,
        clock: systemClock,
        log: aRecordingLogger().log,
        onIdentity: (): void => undefined,
      },
    );
    const idToken = await stub.mint('a-nonce');
    expect(await provider.getUserInfo({ idToken })).toBeNull();
    expect(await provider.getUserInfo({ idToken, expectedIdTokenNonce: '' })).toBeNull();
    expect(await provider.getUserInfo({ expectedIdTokenNonce: 'a-nonce' })).toBeNull();
    expect(await provider.getUserInfo({ idToken: '', expectedIdTokenNonce: 'a-nonce' })).toBeNull();
    expect(
      await provider.getUserInfo({ idToken: 'not.a.jwt', expectedIdTokenNonce: 'a-nonce' }),
    ).toBeNull();
  });

  test('a subject made of nothing, or a stranger’s control characters in a name, never reaches an account', async () => {
    expect((await signingIn(ada, { claims: { sub: '' } })).identity).toBeNull();
    const { identity } = await signingIn({ ...ada, name: '\u0000‮' });
    expect(identity).toMatchObject({ user: { name: undefined } });
  });
});

describe('redeeming the code', () => {
  const ada: OidcPerson = { sub: 'ada-1', email: 'ada@example.test' };

  test('the secret goes in the header where the provider takes it there, and in the body where only that works', async () => {
    expect((await signingIn(ada)).stub.refusals).toEqual([]);
    expect((await signingIn(ada, { discovery: 'post-only' })).identity).not.toBe('refused');
    // A provider that refuses the header is the stub's `basic-refused`: the default is the header, so it is refused.
    const { identity, stub } = await signingIn(ada, { discovery: 'basic-refused' });
    expect(identity).toBe('refused');
    expect(stub.refusals).toEqual(['invalid_client']);
  });

  test('a client the provider no longer accepts is written at error: every sign-in fails until the operator acts', async () => {
    const { lines } = await signingIn(ada, { discovery: 'basic-refused' });
    const said = lines.find((line) => String(line['msg']).includes('gave no id_token'));
    expect(said).toMatchObject({ level: 'error', oidcError: 'invalid_client' });
  });

  test('no verifier, no request: the code is no use to anybody who did not start this sign-in', async () => {
    const { identity, lines, stub } = await signingIn(ada, {}, { withoutVerifier: true });
    expect(identity).toBe('refused');
    expect(stub.presentedCodes).toEqual([]);
    expect(JSON.stringify(lines)).toContain('no PKCE verifier');
  });

  test('another verifier than the one the challenge came from is refused by the provider', async () => {
    const stub = await anOidcStub(ada);
    const { provider } = createOidcProvider(
      { issuer: stub.issuer(), ...OIDC_STUB_CREDENTIALS },
      'Acme',
      {
        fetch: stub.fetch,
        clock: systemClock,
        log: aRecordingLogger().log,
        onIdentity: (): void => undefined,
      },
    );
    const redirectURI = 'https://purlay.test/auth/callback/oidc';
    const url = await provider.createAuthorizationURL({
      state: 's',
      codeVerifier: 'a'.repeat(64),
      redirectURI,
      idTokenNonce: 'n',
    });
    const { code } = stub.authorize(url.toString());
    expect(
      await provider.validateAuthorizationCode({ code, redirectURI, codeVerifier: 'b'.repeat(64) }),
    ).toBeNull();
    expect(stub.refusals).toEqual(['invalid_grant']);
  });

  test('a code spent once is spent: a second redemption is refused, whoever brings it', async () => {
    const stub = await anOidcStub(ada);
    const { provider } = createOidcProvider(
      { issuer: stub.issuer(), ...OIDC_STUB_CREDENTIALS },
      'Acme',
      {
        fetch: stub.fetch,
        clock: systemClock,
        log: aRecordingLogger().log,
        onIdentity: (): void => undefined,
      },
    );
    const redirectURI = 'https://purlay.test/auth/callback/oidc';
    const verifier = 'a'.repeat(64);
    const url = await provider.createAuthorizationURL({
      state: 's',
      codeVerifier: verifier,
      redirectURI,
      idTokenNonce: 'n',
    });
    const { code } = stub.authorize(url.toString());
    expect(
      await provider.validateAuthorizationCode({ code, redirectURI, codeVerifier: verifier }),
    ).not.toBeNull();
    expect(
      await provider.validateAuthorizationCode({ code, redirectURI, codeVerifier: verifier }),
    ).toBeNull();
  });

  test('discovery is asked once for many sign-ins, and for a request at a time', async () => {
    const stub = await anOidcStub(ada);
    const { provider } = createOidcProvider(
      { issuer: stub.issuer(), ...OIDC_STUB_CREDENTIALS },
      'Acme',
      {
        fetch: stub.fetch,
        clock: systemClock,
        log: aRecordingLogger().log,
        onIdentity: (): void => undefined,
      },
    );
    const redirectURI = 'https://purlay.test/auth/callback/oidc';
    await Promise.all(
      [1, 2, 3, 4, 5].map(
        async () =>
          await provider.createAuthorizationURL({
            state: 's',
            codeVerifier: 'a'.repeat(64),
            redirectURI,
            idTokenNonce: 'n',
          }),
      ),
    );
    expect(
      stub.calls.urls.filter((url) => url.endsWith('/.well-known/openid-configuration')),
    ).toHaveLength(1);
  });

  test('the authorization request asks for the code flow, openid email profile, the nonce and S256', async () => {
    const stub = await anOidcStub(ada);
    const { provider } = createOidcProvider(
      { issuer: stub.issuer(), ...OIDC_STUB_CREDENTIALS },
      'Acme',
      {
        fetch: stub.fetch,
        clock: systemClock,
        log: aRecordingLogger().log,
        onIdentity: (): void => undefined,
      },
    );
    const url = await provider.createAuthorizationURL({
      state: 's',
      codeVerifier: 'a'.repeat(64),
      redirectURI: 'https://purlay.test/auth/callback/oidc',
      idTokenNonce: 'the-nonce',
    });
    const asked = url.searchParams;
    expect(Object.fromEntries(asked)).toMatchObject({
      response_type: 'code',
      client_id: 'purlay-client',
      scope: 'openid email profile',
      nonce: 'the-nonce',
      code_challenge_method: 'S256',
      state: 's',
    });
  });

  test('the library is told this provider wants a nonce, takes no id_token from a client, and is not started by the provider', async () => {
    const stub = await anOidcStub(ada);
    const { provider } = createOidcProvider(
      { issuer: stub.issuer(), ...OIDC_STUB_CREDENTIALS },
      'Acme',
      {
        fetch: stub.fetch,
        clock: systemClock,
        log: aRecordingLogger().log,
        onIdentity: (): void => undefined,
      },
    );
    expect(provider.requiresIdTokenNonce).toBe(true);
    expect(provider.options?.disableIdTokenSignIn).toBe(true);
    expect(provider.allowIdpInitiated).toBe(false);
    expect(provider.issuer).toBe(stub.issuer());
    // Nothing of this provider was fetched by building it.
    expect(stub.calls.urls).toEqual([]);
  });
});
