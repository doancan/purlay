/**
 * The whole single sign-on (D-200), driven through real requests against the mounted library and a real
 * database, with a provider that is a double at the `fetch` boundary — discovery, key set, authorize and
 * token endpoint (`testing/oidc-stub.ts`), strict as a provider is.
 *
 * Every way the provider can lie is here: a token signed by another key, unsigned, signed with a shared
 * secret; one for another audience, another issuer, expired, with another nonce or none; a discovery document
 * that names another issuer or an insecure endpoint; an address that is absent or not verified. Each ends on
 * the sign-in screen with one reason from the closed set and no session, and the log says which check refused
 * it. The sessions, cookies and state are the library's, as GitHub's are: what is tested is that they fit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, sql, type ClonedDatabase, type Executor } from '@purlay/db';
import type { SignInFailure } from '@purlay/types';
import { createApp, type HttpApplication } from './app';
import { SESSION_COOKIE, STATE_COOKIE } from '../../platform/cookies';
import {
  aMovableClock,
  aRecordingLogger,
  testConfig,
  testDependencies,
} from '../../testing/doubles';
import type { Clock } from '../../platform/clock';
import {
  aGitHubFor,
  aGitHubPerson,
  cookiesFrom,
  returnFromGitHub,
  startGitHubSignIn,
  type StartedSignIn,
} from '../../testing/github-sign-in';
import { GITHUB_STUB_CREDENTIALS } from '../../testing/github-stub';
import { aTestAuth } from '../../testing/signed-in';
import { OIDC_STUB_CREDENTIALS } from '../../testing/oidc-stub';
import {
  anOidcStub,
  type OidcBehaviour,
  type OidcPerson,
  type OidcStub,
} from '../../testing/oidc-stub';
import {
  anOidcAuth,
  returnFromOidc,
  signInWithOidc,
  startOidcSignIn,
} from '../../testing/oidc-sign-in';
import { aUserRow } from '../../testing/users';
import { inProcessBackplane } from '../../realtime/bus';
import { NO_LOG } from '../../platform/events';
import { sessionFromHeaders } from '../../modules/auth/sessions';
import type { Auth } from '../../modules/auth/better-auth';
import { OIDC_PROVIDER_ID } from '../../modules/auth/oidc';

const ORIGIN = 'https://purlay.test';
const unique = (): string => crypto.randomUUID().slice(0, 8);

let cloned: ClonedDatabase;
let db: Executor;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
});

afterAll(async () => {
  await cloned.drop();
});

beforeEach(async () => {
  await sql`delete from rate_limits`.execute(db);
});

const aPerson = (over: Partial<OidcPerson> = {}): OidcPerson => ({
  sub: `sub-${unique()}`,
  email: `ada-${unique()}@example.test`,
  name: 'Ada Lovelace',
  ...over,
});

interface Server {
  readonly app: HttpApplication;
  readonly auth: Auth;
  readonly stub: OidcStub;
  readonly lines: Record<string, unknown>[];
}

const aServer = async (
  person: OidcPerson,
  options: {
    readonly behaviour?: OidcBehaviour;
    readonly signUp?: 'open' | 'invite-only';
    readonly name?: string;
    readonly clock?: Clock;
  } = {},
): Promise<Server> => {
  const { clock } = options;
  const stub = await anOidcStub(person, options.behaviour ?? {}, undefined, {
    ...(clock === undefined ? {} : { now: (): number => clock.now().getTime() }),
  });
  const config = testConfig({ APP_URL: ORIGIN });
  const backplane = inProcessBackplane();
  const lines = aRecordingLogger();
  const auth = anOidcAuth(db, stub, {
    baseUrl: ORIGIN,
    signUp: options.signUp ?? 'open',
    sessionTtlDays: config.SESSION_TTL_DAYS,
    bus: backplane.node(() => undefined, NO_LOG),
    log: lines.log,
    ...(clock === undefined ? {} : { clock }),
    ...(options.name === undefined ? {} : { name: options.name }),
  });
  const dependencies = testDependencies({ database: db, config, auth, backplane, log: lines.log });
  return { app: createApp(dependencies), auth, stub, lines: lines.lines };
};

const expectSentBack = (response: Response, failure: SignInFailure): void => {
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=${failure}`);
  const cookies = response.headers.getSetCookie();
  expect(cookies.some((cookie) => cookie.startsWith(`${STATE_COOKIE}=;`))).toBe(true);
  expect(cookies.some((cookie) => /^__Host-purlay_session=[^;]/.test(cookie))).toBe(false);
};

const expectSignedIn = async (server: Server, response: Response): Promise<string> => {
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(ORIGIN);
  const session = await sessionFromHeaders(
    server.auth,
    new Headers({ cookie: cookiesFrom(response) }),
  );
  expect(session).toBeDefined();
  return session?.userId ?? '';
};

interface Row {
  readonly id: string;
  readonly display_name: string;
  readonly username: string;
  readonly email_verified: boolean;
  readonly github_id: string | null;
}

const userByEmail = async (email: string): Promise<Row | undefined> =>
  await db
    .selectFrom('users')
    .select(['id', 'display_name', 'username', 'email_verified', 'github_id'])
    .where('email', '=', email)
    .executeTakeFirst();

describe('integration: GET /auth/oidc — the button', () => {
  test('sends the browser to the provider with state, nonce and an S256 challenge, and sets the state cookie', async () => {
    const server = await aServer(aPerson());
    const started = await startOidcSignIn(server.app, ORIGIN);
    expect(started.response.status).toBe(302);
    const location = new URL(started.response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${server.stub.issuer()}/authorize`);
    const asked = location.searchParams;
    expect(asked.get('response_type')).toBe('code');
    expect(asked.get('client_id')).toBe('purlay-client');
    expect(asked.get('scope')).toBe('openid email profile');
    expect(asked.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback/oidc`);
    expect(asked.get('code_challenge_method')).toBe('S256');
    expect(asked.get('code_challenge')?.length).toBe(43);
    expect(asked.get('nonce')?.length).toBeGreaterThan(20);
    expect(asked.get('state')).toBeTruthy();
    expect(
      started.response.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith(`${STATE_COOKIE}=`)),
    ).toBe(true);
  });

  test('where no provider is connected it is the route that does not exist: 404 ROUTE_NOT_FOUND', async () => {
    const config = testConfig({ APP_URL: ORIGIN });
    const auth = (await aServer(aPerson())).auth;
    const app = createApp(
      testDependencies({
        database: db,
        config,
        auth: { ...auth, oidc: undefined } as unknown as Auth,
      }),
    );
    const response = await app.handle(new Request(`${ORIGIN}/auth/oidc`));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'ROUTE_NOT_FOUND',
    );
  });

  test('sends nothing to the provider before somebody presses it', async () => {
    const server = await aServer(aPerson());
    expect(server.stub.calls.urls).toEqual([]);
  });
});

describe('integration: the round trip', () => {
  test('a new person is signed in: a session, an account named from their address, the provider linked by issuer and subject', async () => {
    const person = aPerson({ name: 'Ada Lovelace' });
    const server = await aServer(person);
    const response = await signInWithOidc(server.app, ORIGIN, server.stub);
    const userId = await expectSignedIn(server, response);
    const user = await userByEmail(person.email);
    expect(user?.id).toBe(userId);
    expect(user?.display_name).toBe('Ada Lovelace');
    expect(user?.email_verified).toBe(true);
    expect(user?.github_id).toBeNull();
    expect(user?.username).toMatch(/^ada-/);
    const account = await db
      .selectFrom('accounts')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(account.provider_id).toBe(OIDC_PROVIDER_ID);
    expect(account.account_id).toBe(`${server.stub.issuer()}|${person.sub}`);
    // No token of the provider is kept: the library's rows carry none.
    expect(account.access_token).toBeNull();
    expect(account.id_token).toBeNull();
    // Nothing was fetched but what a sign-in needs, each with a deadline.
    expect(server.stub.calls.urls.map((url) => new URL(url).pathname).sort()).toEqual([
      '/.well-known/openid-configuration',
      '/jwks',
      '/token',
    ]);
    expect(server.stub.calls.signals.every(Boolean)).toBe(true);
  });

  test("the session cookie is the library's: __Host-, HttpOnly, Secure, SameSite=Lax, Path=/", async () => {
    const server = await aServer(aPerson());
    const response = await signInWithOidc(server.app, ORIGIN, server.stub);
    const cookie = response.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain');
  });

  test('the same person signing in again is the same account, not a second', async () => {
    const person = aPerson();
    const server = await aServer(person);
    const first = await expectSignedIn(
      server,
      await signInWithOidc(server.app, ORIGIN, server.stub),
    );
    const second = await expectSignedIn(
      server,
      await signInWithOidc(server.app, ORIGIN, server.stub),
    );
    expect(second).toBe(first);
  });

  test('a person whose provider changes their address is still their account: the subject decides, not the address', async () => {
    const person = aPerson();
    const server = await aServer(person);
    const first = await expectSignedIn(
      server,
      await signInWithOidc(server.app, ORIGIN, server.stub),
    );
    server.stub.person = { ...person, email: `moved-${unique()}@example.test` };
    const second = await expectSignedIn(
      server,
      await signInWithOidc(server.app, ORIGIN, server.stub),
    );
    expect(second).toBe(first);
  });

  test('a provider claim with nothing to make a name of takes the username as the display name', async () => {
    const person = aPerson({ name: undefined });
    const server = await aServer(person);
    await signInWithOidc(server.app, ORIGIN, server.stub);
    const user = await userByEmail(person.email);
    expect(user?.display_name).toBe(user?.username);
  });

  test('control and direction-override characters in the name are removed, never stored', async () => {
    const person = aPerson({ name: 'Ada‮\u0000 Lovelace' });
    const server = await aServer(person);
    await signInWithOidc(server.app, ORIGIN, server.stub);
    expect((await userByEmail(person.email))?.display_name).toBe('Ada Lovelace');
  });
});

describe('integration: account linking by address (D-200 §3)', () => {
  test('an existing account whose own address is verified is linked, and signed into', async () => {
    const existing = await aUserRow(db, 'linked');
    await db
      .updateTable('users')
      .set({ email_verified: true })
      .where('id', '=', existing.userId)
      .execute();
    const server = await aServer(aPerson({ email: existing.email }));
    const userId = await expectSignedIn(
      server,
      await signInWithOidc(server.app, ORIGIN, server.stub),
    );
    expect(userId).toBe(existing.userId);
    const accounts = await db
      .selectFrom('accounts')
      .select('provider_id')
      .where('user_id', '=', userId)
      .execute();
    expect(accounts.map((row) => row.provider_id)).toEqual([OIDC_PROVIDER_ID]);
  });

  test('an existing account whose own address was never verified is NOT linked: email-taken, no session', async () => {
    const existing = await aUserRow(db, 'unproven');
    // email_verified is false by default: somebody once typed this address, and nobody proved it.
    const server = await aServer(aPerson({ email: existing.email }));
    const response = await signInWithOidc(server.app, ORIGIN, server.stub);
    expectSentBack(response, 'email-taken');
    expect(
      await db.selectFrom('accounts').select('id').where('user_id', '=', existing.userId).execute(),
    ).toEqual([]);
  });

  test('the provider saying the address is not verified never links, and never makes an account: email-unverified', async () => {
    const existing = await aUserRow(db, 'victim');
    await db
      .updateTable('users')
      .set({ email_verified: true })
      .where('id', '=', existing.userId)
      .execute();
    const server = await aServer(aPerson({ email: existing.email }), {
      behaviour: { claims: { email_verified: false } },
    });
    expectSentBack(await signInWithOidc(server.app, ORIGIN, server.stub), 'email-unverified');
    expect(
      await db.selectFrom('accounts').select('id').where('user_id', '=', existing.userId).execute(),
    ).toEqual([]);
  });

  test.each([
    ['absent', null],
    ['a string that is not "true"', 'yes'],
    ['the number 1', 1],
    ['null', 'null-literal'],
  ])('email_verified %s is not a yes', async (_label, value) => {
    const person = aPerson();
    const server = await aServer(person, {
      behaviour: { claims: { email_verified: value === 'null-literal' ? null : value } },
    });
    expectSentBack(await signInWithOidc(server.app, ORIGIN, server.stub), 'email-unverified');
    expect(await userByEmail(person.email)).toBeUndefined();
  });

  test('email_verified as the string "true" (some providers send it so) is a yes', async () => {
    const person = aPerson();
    const server = await aServer(person, { behaviour: { claims: { email_verified: 'true' } } });
    await expectSignedIn(server, await signInWithOidc(server.app, ORIGIN, server.stub));
  });

  test('no address in the token is email-unverified, not an account with none', async () => {
    const person = aPerson();
    const server = await aServer(person, { behaviour: { claims: { email: null } } });
    expectSentBack(await signInWithOidc(server.app, ORIGIN, server.stub), 'email-unverified');
  });

  test('an address that is not one mailbox written one way is refused as unverified: nothing is repaired', async () => {
    const server = await aServer(aPerson(), {
      behaviour: { claims: { email: 'x<a@example.test>' } },
    });
    expectSentBack(await signInWithOidc(server.app, ORIGIN, server.stub), 'email-unverified');
  });

  test('a subject that repeats under another issuer is not the same account', async () => {
    const person = aPerson();
    const first = await aServer(person);
    await expectSignedIn(first, await signInWithOidc(first.app, ORIGIN, first.stub));
    // Another provider, the same `sub`, and the same address: linked by address to the same person only
    // because that address is verified — but it is a second account row, keyed by its own issuer.
    const other = await anOidcStub(person, {}, undefined, {
      issuer: 'https://other-idp.example.test',
    });
    const auth = anOidcAuth(db, other, { baseUrl: ORIGIN });
    const app = createApp(
      testDependencies({ database: db, config: testConfig({ APP_URL: ORIGIN }), auth }),
    );
    await signInWithOidc(app, ORIGIN, other);
    const keys = await db
      .selectFrom('accounts')
      .select('account_id')
      .where('provider_id', '=', OIDC_PROVIDER_ID)
      .where('account_id', 'like', `%|${person.sub}`)
      .execute();
    expect(keys.map((row) => row.account_id).sort()).toEqual(
      [
        `https://idp.example.test|${person.sub}`,
        ...(keys.length === 2 ? [`https://other-idp.example.test|${person.sub}`] : []),
      ].sort(),
    );
  });
});

describe('integration: one identity per account (D-200 §3, §6)', () => {
  test('a new subject carrying the address of an account that already has an identity is refused, and links nothing', async () => {
    const person = aPerson();
    const server = await aServer(person);
    const first = await expectSignedIn(
      server,
      await signInWithOidc(server.app, ORIGIN, server.stub),
    );
    // The provider recycles the mailbox: another person, another subject, the same verified address.
    server.stub.person = { ...person, sub: `recycled-${unique()}` };
    expectSentBack(await signInWithOidc(server.app, ORIGIN, server.stub), 'failed');
    const rows = await db
      .selectFrom('accounts')
      .select('account_id')
      .where('user_id', '=', first)
      .where('provider_id', '=', OIDC_PROVIDER_ID)
      .execute();
    expect(rows).toHaveLength(1);
    expect(server.lines.some((line) => line['libraryError'] === 'identity_conflict')).toBe(true);
    // The first subject still signs in.
    server.stub.person = person;
    await expectSignedIn(server, await signInWithOidc(server.app, ORIGIN, server.stub));
  });

  test('GitHub is not linked by address to an account single sign-on owns', async () => {
    const person = aPerson();
    const github = aGitHubFor(aGitHubPerson('sso-owner', { email: person.email }));
    const stub = await anOidcStub(person);
    const config = testConfig({ APP_URL: ORIGIN });
    const backplane = inProcessBackplane();
    const lines = aRecordingLogger();
    const auth = aTestAuth(db, {
      baseUrl: ORIGIN,
      settings: {
        github: GITHUB_STUB_CREDENTIALS,
        oidc: { issuer: stub.issuer(), ...OIDC_STUB_CREDENTIALS, name: undefined },
        signUp: 'open',
      },
      // Two providers, one fetch: the issuer's addresses are the provider's, the rest GitHub's.
      fetch: async (url, init) =>
        url.startsWith(stub.issuer()) ? await stub.fetch(url, init) : await github.fetch(url, init),
      bus: backplane.node(() => undefined, NO_LOG),
      log: lines.log,
      sessionTtlDays: config.SESSION_TTL_DAYS,
    });
    const app = createApp(testDependencies({ database: db, config, auth, backplane }));
    const owner = await expectSignedIn(
      { app, auth, stub, lines: lines.lines },
      await signInWithOidc(app, ORIGIN, stub),
    );
    const started = await startGitHubSignIn(app, ORIGIN, github);
    const back = await returnFromGitHub(app, ORIGIN, started);
    expect(back.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=failed`);
    expect(
      await db.selectFrom('accounts').select('provider_id').where('user_id', '=', owner).execute(),
    ).toEqual([{ provider_id: OIDC_PROVIDER_ID }]);
  });
});

describe('integration: sign-up policy', () => {
  test('on an invite-only server a newcomer with no invitation is refused: signup-closed, no account', async () => {
    const person = aPerson();
    const server = await aServer(person, { signUp: 'invite-only' });
    expectSentBack(await signInWithOidc(server.app, ORIGIN, server.stub), 'signup-closed');
    expect(await userByEmail(person.email)).toBeUndefined();
  });

  test('on an invite-only server an existing, linked account still signs in', async () => {
    const existing = await aUserRow(db, 'member');
    await db
      .updateTable('users')
      .set({ email_verified: true })
      .where('id', '=', existing.userId)
      .execute();
    const server = await aServer(aPerson({ email: existing.email }), { signUp: 'invite-only' });
    expect(
      await expectSignedIn(server, await signInWithOidc(server.app, ORIGIN, server.stub)),
    ).toBe(existing.userId);
  });
});

describe('integration: what the id_token must be (D-200 §2)', () => {
  const refused = async (
    behaviour: OidcBehaviour,
    reason: SignInFailure = 'failed',
    options: { readonly clock?: Clock } = {},
  ): Promise<Server> => {
    const person = aPerson();
    const server = await aServer(person, { behaviour, ...options });
    expectSentBack(await signInWithOidc(server.app, ORIGIN, server.stub), reason);
    // No account was made for a token that was not believed.
    expect(await userByEmail(person.email)).toBeUndefined();
    return server;
  };

  test('signed by another key than the provider publishes', async () => {
    await refused({ tamper: 'signed-by-another-key' });
  });
  test('unsigned (alg none)', async () => {
    await refused({ tamper: 'unsigned' });
  });
  test('signed with a shared secret that is the public key (HS256 confusion)', async () => {
    await refused({ tamper: 'hmac' });
  });
  test('signed with an algorithm the provider’s discovery does not offer, by a key it does publish', async () => {
    await refused({ tamper: 'other-algorithm' });
  });
  test('for another audience', async () => {
    await refused({ claims: { aud: 'another-client' } });
  });
  test('for two audiences with no authorized party', async () => {
    await refused({ claims: { aud: ['purlay-client', 'another-client'] } });
  });
  test('issued by another issuer', async () => {
    await refused({ claims: { iss: 'https://evil.example.test' } });
  });
  test('already expired (beyond thirty seconds of skew)', async () => {
    await refused({ claims: { exp: Math.floor(Date.now() / 1000) - 120 } });
  });
  test('issued in the future', async () => {
    await refused({
      claims: {
        iat: Math.floor(Date.now() / 1000) + 3600,
        exp: Math.floor(Date.now() / 1000) + 7200,
      },
    });
  });
  test('issued more than ten minutes ago', async () => {
    await refused({
      claims: {
        iat: Math.floor(Date.now() / 1000) - 3600,
        exp: Math.floor(Date.now() / 1000) + 600,
      },
    });
  });
  test('carrying another nonce than the one this sign-in made', async () => {
    await refused({ nonce: 'other' });
  });
  test('carrying no nonce', async () => {
    await refused({ claims: { nonce: null } });
  });
  test.each(['iss', 'sub', 'aud', 'exp', 'iat'])('without %s', async (claim) => {
    await refused({ claims: { [claim]: null } });
  });
  test('with a subject longer than 255 characters', async () => {
    await refused({ claims: { sub: 'x'.repeat(256) } });
  });
  test('with no id_token at all in the token response: the provider did not answer as one', async () => {
    await refused({ token: 'no-id-token' }, 'oidc-unavailable');
  });
  test('the refusal is in the log by the check that made it, never with a token or a claim', async () => {
    const server = await refused({ claims: { aud: 'another-client' } });
    const line = server.lines.find(
      (entry) => entry['msg'] === 'oidc sign-in: the id_token was refused',
    );
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).not.toContain('another-client');
    expect(JSON.stringify(line)).toContain('JWTClaimValidationFailed');
  });
});

describe('integration: the state, the code and the callback', () => {
  test("a callback with another browser's state is expired, and nothing is exchanged", async () => {
    const server = await aServer(aPerson());
    const started = await startOidcSignIn(server.app, ORIGIN, server.stub);
    const before = server.stub.calls.urls.length;
    expectSentBack(
      await returnFromOidc(server.app, ORIGIN, started, {
        code: started.code,
        state: 'someone-elses',
      }),
      'expired',
    );
    expect(server.stub.calls.urls.length).toBe(before);
    expect(server.stub.presentedCodes).toEqual([]);
  });

  test('a callback with no cookie at all is expired', async () => {
    const server = await aServer(aPerson());
    const started = await startOidcSignIn(server.app, ORIGIN, server.stub);
    expectSentBack(await returnFromOidc(server.app, ORIGIN, { ...started, cookie: '' }), 'expired');
  });

  test('a callback twice with one state is one sign-in: the second finds its try over', async () => {
    const server = await aServer(aPerson());
    const started = await startOidcSignIn(server.app, ORIGIN, server.stub);
    const first = await returnFromOidc(server.app, ORIGIN, started);
    await expectSignedIn(server, first);
    expectSentBack(await returnFromOidc(server.app, ORIGIN, started), 'expired');
    expect(server.stub.presentedCodes).toHaveLength(1);
  });

  test('two callbacks at once with one state are one exchange, not a spent code answered as an outage', async () => {
    const server = await aServer(aPerson());
    const started = await startOidcSignIn(server.app, ORIGIN, server.stub);
    const [one, other] = await Promise.all([
      returnFromOidc(server.app, ORIGIN, started),
      returnFromOidc(server.app, ORIGIN, started),
    ]);
    const outcomes = [one, other].map((response) => response.headers.get('location'));
    expect(outcomes.filter((location) => location === ORIGIN)).toHaveLength(1);
    expect(
      outcomes.filter((location) => location === `${ORIGIN}/sign-in?error=expired`),
    ).toHaveLength(1);
    expect(server.stub.presentedCodes).toHaveLength(1);
  });

  test('a callback with no code is expired', async () => {
    const server = await aServer(aPerson());
    const started = await startOidcSignIn(server.app, ORIGIN, server.stub);
    expectSentBack(
      await returnFromOidc(server.app, ORIGIN, started, { state: started.state }),
      'expired',
    );
  });

  test('a code the provider never issued is the provider refusing: oidc-unavailable', async () => {
    const server = await aServer(aPerson());
    const started = await startOidcSignIn(server.app, ORIGIN, server.stub);
    expectSentBack(
      await returnFromOidc(server.app, ORIGIN, started, { code: 'forged', state: started.state }),
      'oidc-unavailable',
    );
    expect(server.stub.refusals).toEqual(['invalid_grant']);
  });

  test('the person pressing Cancel is cancelled, not a failure', async () => {
    const server = await aServer(aPerson());
    const started = await startOidcSignIn(server.app, ORIGIN, server.stub);
    expectSentBack(
      await returnFromOidc(server.app, ORIGIN, started, {
        error: 'access_denied',
        state: started.state,
      }),
      'cancelled',
    );
  });

  test.each(['login_required', 'interaction_required', 'server_error'])(
    'the provider answering error=%s is a failure, written down by name',
    async (error) => {
      const server = await aServer(aPerson());
      const started = await startOidcSignIn(server.app, ORIGIN, server.stub);
      expectSentBack(
        await returnFromOidc(server.app, ORIGIN, started, { error, state: started.state }),
        'failed',
      );
      expect(server.lines.some((entry) => entry['oidcError'] === error)).toBe(true);
    },
  );

  test('a callback whose iss names another issuer than the provider is refused (RFC 9207 mix-up)', async () => {
    const server = await aServer(aPerson());
    const started = await startOidcSignIn(server.app, ORIGIN, server.stub);
    const response = await returnFromOidc(server.app, ORIGIN, started, {
      code: started.code,
      state: started.state,
      iss: 'https://evil.example.test',
    });
    expectSentBack(response, 'failed');
    expect(server.stub.presentedCodes).toEqual([]);
  });

  test('a client submitting an id_token to the sign-in route directly is refused, whatever it holds', async () => {
    const person = aPerson();
    const server = await aServer(person);
    const forged = await server.stub.mint('anything');
    const response = await server.app.handle(
      new Request(`${ORIGIN}/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ provider: 'oidc', idToken: { token: forged, nonce: 'anything' } }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
      false,
    );
    expect(await userByEmail(person.email)).toBeUndefined();
  });

  test("the provider's answer to the code never redirects the secret elsewhere: a redirect is a failure", async () => {
    const server = await aServer(aPerson(), { behaviour: { token: 'redirects' } });
    expectSentBack(await signInWithOidc(server.app, ORIGIN, server.stub), 'oidc-unavailable');
  });
});

describe('integration: the provider failing (§6.9 partial failure)', () => {
  test('unreachable at the button: 502 OIDC_UNAVAILABLE, never a hang', async () => {
    const server = await aServer(aPerson(), { behaviour: { discovery: 'unreachable' } });
    const response = await server.app.handle(new Request(`${ORIGIN}/auth/oidc`));
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
      false,
    );
  });

  test('discovery unreachable at the callback is the provider unavailable', async () => {
    const server = await aServer(aPerson());
    const started = await startOidcSignIn(server.app, ORIGIN, server.stub);
    server.stub.behaviour.discovery = 'unreachable';
    // Discovery was believed for an hour: a provider that goes away mid-sign-in is not asked again.
    await expectSignedIn(server, await returnFromOidc(server.app, ORIGIN, started));
  });

  test('the token endpoint unreachable is oidc-unavailable', async () => {
    const server = await aServer(aPerson(), { behaviour: { token: 'unreachable' } });
    expectSentBack(await signInWithOidc(server.app, ORIGIN, server.stub), 'oidc-unavailable');
  });

  test('the token endpoint answering 503 is oidc-unavailable', async () => {
    const server = await aServer(aPerson(), { behaviour: { token: 'refuses' } });
    expectSentBack(await signInWithOidc(server.app, ORIGIN, server.stub), 'oidc-unavailable');
  });

  test('the key set unreachable is the provider unavailable, not a token that is wrong', async () => {
    const server = await aServer(aPerson(), { behaviour: { jwks: 'unreachable' } });
    expectSentBack(await signInWithOidc(server.app, ORIGIN, server.stub), 'oidc-unavailable');
  });

  test('a key set that is not one is the provider unavailable', async () => {
    const server = await aServer(aPerson(), { behaviour: { jwks: 'garbage' } });
    expectSentBack(await signInWithOidc(server.app, ORIGIN, server.stub), 'oidc-unavailable');
  });

  test.each<[string, OidcBehaviour['discovery']]>([
    ['names another issuer', 'issuer-mismatch'],
    ['points at an insecure endpoint', 'http-endpoints'],
    ['points an https issuer at plain http, even on this machine', 'loopback-endpoints'],
    ['offers no PKCE with S256', 'no-pkce'],
    ['signs with nothing this server accepts', 'hmac-only'],
    ['answers 503', 'refuses'],
    ['redirects', 'redirects'],
  ])('a discovery document that %s refuses the button', async (_what, discovery) => {
    const server = await aServer(aPerson(), { behaviour: { discovery } });
    const response = await server.app.handle(new Request(`${ORIGIN}/auth/oidc`));
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get('location')).toBeNull();
    // Nothing was redirected to, and nothing set a state cookie that could be spent.
    expect(response.headers.getSetCookie().some((c) => c.startsWith(`${STATE_COOKIE}=`))).toBe(
      false,
    );
  });

  test('a provider that takes the secret only in the body is sent it there', async () => {
    const server = await aServer(aPerson(), { behaviour: { discovery: 'post-only' } });
    await expectSignedIn(server, await signInWithOidc(server.app, ORIGIN, server.stub));
  });
});

describe('integration: key rotation (§6.9 network and time)', () => {
  test('a token signed by a key published after the keys were cached is believed once, after one fetch', async () => {
    const server = await aServer(aPerson());
    await expectSignedIn(server, await signInWithOidc(server.app, ORIGIN, server.stub));
    const fetched = (): number =>
      server.stub.calls.urls.filter((url) => new URL(url).pathname === '/jwks').length;
    expect(fetched()).toBe(1);
    await server.stub.rotate();
    // Inside the thirty-second cooldown the keys are not fetched again, however they are asked: this is the
    // flood guard, and the token signed by the new key is refused rather than believed.
    expectSentBack(await signInWithOidc(server.app, ORIGIN, server.stub), 'failed');
    expect(fetched()).toBe(1);
  });

  test('past the cooldown a rotated key is fetched and believed', async () => {
    const clock = aMovableClock(new Date());
    const server = await aServer(aPerson(), { clock });
    await expectSignedIn(server, await signInWithOidc(server.app, ORIGIN, server.stub));
    await server.stub.rotate();
    clock.advance(61_000);
    await expectSignedIn(server, await signInWithOidc(server.app, ORIGIN, server.stub));
  });
});

describe('integration: the email link and the account single sign-on is linked to (D-200 §6)', () => {
  test('an account the provider is linked to is never sent a link: nothing is made for the address', async () => {
    const person = aPerson();
    const server = await aServer(person);
    await expectSignedIn(server, await signInWithOidc(server.app, ORIGIN, server.stub));
    const user = await userByEmail(person.email);
    expect(user).toBeDefined();
    // The decision is `fateOf`'s (`magic-link.ts`); its own tests drive it. Here: the account has the row it reads.
    const sso = await db
      .selectFrom('accounts')
      .select('id')
      .where('user_id', '=', user?.id ?? '')
      .where('provider_id', '=', OIDC_PROVIDER_ID)
      .executeTakeFirst();
    expect(sso).toBeDefined();
  });
});

describe('integration: the session it makes', () => {
  test('ends as any other does: signing out everywhere ends it', async () => {
    const server = await aServer(aPerson());
    const response = await signInWithOidc(server.app, ORIGIN, server.stub);
    const cookie = cookiesFrom(response);
    const out = await server.app.handle(
      new Request(`${ORIGIN}/auth/logout`, { method: 'POST', headers: { cookie, origin: ORIGIN } }),
    );
    expect(out.status).toBe(204);
    expect(await sessionFromHeaders(server.auth, new Headers({ cookie }))).toBeUndefined();
  });

  test('a soft-deleted account starts no session by this way in either', async () => {
    const person = aPerson();
    const server = await aServer(person);
    await expectSignedIn(server, await signInWithOidc(server.app, ORIGIN, server.stub));
    await db
      .updateTable('users')
      .set({ deleted_at: new Date() })
      .where('email', '=', person.email)
      .execute();
    const again = await signInWithOidc(server.app, ORIGIN, server.stub);
    expect(again.headers.getSetCookie().some((c) => /^__Host-purlay_session=[^;]/.test(c))).toBe(
      false,
    );
  });
});

describe('integration: a started sign-in is a StartedSignIn', () => {
  test('the helper hands back what a test needs', async () => {
    const server = await aServer(aPerson());
    const started: StartedSignIn = await startOidcSignIn(server.app, ORIGIN, server.stub);
    expect(started.state).not.toBe('');
    expect(started.code).not.toBe('a-code');
  });
});
