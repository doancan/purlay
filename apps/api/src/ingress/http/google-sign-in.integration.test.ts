/**
 * Sign in with Google (D-250), driven through real requests against the mounted library and a real database, with
 * Google a strict double at the `fetch` boundary standing at Google's own issuer (`testing/google-sign-in.ts`).
 *
 * What the token must be is the OIDC core's, tested whole in `oidc-sign-in.integration.test.ts`; here is what
 * Google adds to it: the bare `sub` as the account and the `google_made` mark on an account it makes; whose say an
 * address is before an existing account is linked by it — Gmail's, or the Workspace domain the token names in
 * `hd` — and that nothing changes when it is not; one Google identity per account, and Google never a way past
 * single sign-on; the issuer with or without its scheme; the subject, not the address, deciding who signs in; the
 * sign-up policy and its invitation passport; two first sign-ins at once; and Google not answering.
 *
 * On a cloned database with real connections: the library's own transactions, and two callbacks racing on a
 * unique index, need them (D-46, D-77).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { AuthMethods, type SignInFailure } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { isAPIError } from 'better-auth/api';
import { createApp, type HttpApplication } from './app';
import { RETRY_COOKIE, STATE_COOKIE } from '../../platform/cookies';
import type { Clock } from '../../platform/clock';
import {
  aMovableClock,
  aRecordingLogger,
  testConfig,
  testDependencies,
} from '../../testing/doubles';
import { cookiesFrom, type StartedSignIn } from '../../testing/github-sign-in';
import type { OidcBehaviour, OidcPerson, OidcStub } from '../../testing/oidc-stub';
import {
  aGoogleAuth,
  aGoogleStub,
  returnFromGoogle,
  signInWithGoogle,
  startGoogleSignIn,
} from '../../testing/google-sign-in';
import { aSignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { inProcessBackplane } from '../../realtime/bus';
import { NO_LOG } from '../../platform/events';
import { sessionFromHeaders } from '../../modules/auth/sessions';
import type { Auth } from '../../modules/auth/better-auth';
import { GOOGLE_PROVIDER_ID } from '../../modules/auth/google';
import { mySignIn } from '../../modules/auth/my-sign-in';

const ORIGIN = 'https://purlay.test';
const unique = (): string => crypto.randomUUID().slice(0, 8);

let cloned: ClonedDatabase;
let db: Executor;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
  await sql`
    create function hold_window() returns trigger language plpgsql as
    $$ begin perform pg_sleep(0.3); return new; end $$
  `.execute(db);
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

beforeEach(async () => {
  await sql`delete from rate_limits`.execute(db);
});

/** A Google account: Gmail unless said, whose every address is Google's own to vouch for. */
const aPerson = (over: Partial<OidcPerson> = {}): OidcPerson => ({
  sub: `1${String(Math.floor(Math.random() * 1e15))}`,
  email: `ali-${unique()}@gmail.com`,
  name: 'Ali Veli',
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
    readonly clock?: Clock & { advance: (ms: number) => void };
  } = {},
): Promise<Server> => {
  const clock = options.clock ?? aMovableClock(new Date());
  // Google tells time as the server does: a token is judged by the instance's own clock.
  const stub = await aGoogleStub(person, { now: () => clock.now().getTime() });
  Object.assign(stub.behaviour, options.behaviour ?? {});
  const config = testConfig({ APP_URL: ORIGIN });
  const backplane = inProcessBackplane();
  const lines = aRecordingLogger();
  const signUp = options.signUp ?? 'open';
  const auth = aGoogleAuth(db, stub, {
    baseUrl: ORIGIN,
    signUp,
    sessionTtlDays: config.SESSION_TTL_DAYS,
    bus: backplane.node(() => undefined, NO_LOG),
    log: lines.log,
    clock,
  });
  const dependencies = testDependencies({
    database: db,
    config,
    auth,
    backplane,
    clock,
    signUp,
    log: lines.log,
  });
  return { app: createApp(dependencies), auth, stub, lines: lines.lines };
};

const expectSentBack = (response: Response, failure: SignInFailure): void => {
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=${failure}`);
  const cookies = response.headers.getSetCookie();
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
  readonly email: string;
  readonly display_name: string;
  readonly email_verified: boolean;
  readonly avatar_url: string | null;
  readonly github_id: string | null;
  readonly google_made: boolean;
  readonly updated_at: Date;
}

const userBy = async (column: 'email' | 'id', value: string): Promise<Row | undefined> =>
  await db
    .selectFrom('users')
    .select([
      'id',
      'email',
      'display_name',
      'email_verified',
      'avatar_url',
      'github_id',
      'google_made',
      'updated_at',
    ])
    .where(column, '=', value)
    .executeTakeFirst();

const accountsOf = async (
  userId: string,
): Promise<readonly { readonly provider_id: string; readonly account_id: string }[]> =>
  await db
    .selectFrom('accounts')
    .select(['provider_id', 'account_id'])
    .where('user_id', '=', userId)
    .orderBy('provider_id')
    .execute();

/** An account made by email, its address proven or not, as an earlier sign-in by link left it. */
const anEmailAccount = async (email: string, verified = true): Promise<Row> => {
  const tag = unique();
  await db
    .insertInto('users')
    .values({
      email,
      username: `local-${tag}`,
      display_name: 'Local Person',
      email_verified: verified,
    })
    .execute();
  const row = await userBy('email', email);
  if (row === undefined) throw new Error('the account was not made');
  return row;
};

describe('integration: GET /auth/google — the button', () => {
  test('sends the browser to Google with state, nonce, an S256 challenge and exactly openid email profile', async () => {
    const server = await aServer(aPerson());
    const started = await startGoogleSignIn(server.app, ORIGIN, server.stub);
    expect(started.response.status).toBe(302);
    const location = new URL(started.response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe('https://accounts.google.com/authorize');
    const asked = location.searchParams;
    expect(asked.get('scope')).toBe('openid email profile');
    expect(asked.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback/google`);
    expect(asked.get('code_challenge_method')).toBe('S256');
    expect(asked.get('nonce')?.length).toBeGreaterThan(20);
    expect(
      started.response.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith(`${STATE_COOKIE}=`)),
    ).toBe(true);
  });

  test('where Google is not connected it is the route that does not exist, and the methods say false', async () => {
    const config = testConfig({ APP_URL: ORIGIN });
    const app = createApp(testDependencies({ database: db, config }));
    const response = await app.handle(new Request(`${ORIGIN}/auth/google`));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'ROUTE_NOT_FOUND', message: 'Google sign-in is not set up on this server.' },
    });
    const methods = (await (
      await app.handle(new Request(`${ORIGIN}/api/auth/methods`))
    ).json()) as AuthMethods;
    expect(methods.google).toBe(false);
    // A callback that arrives anyway is a browser: told its try is over.
    const callback = await app.handle(new Request(`${ORIGIN}/auth/callback/google?code=x&state=y`));
    expect(callback.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=expired`);
  });

  test('where Google is connected the methods say so, and nothing was sent to Google for asking', async () => {
    const server = await aServer(aPerson());
    const methods: unknown = await (
      await server.app.handle(new Request(`${ORIGIN}/api/auth/methods`))
    ).json();
    expect(Value.Check(AuthMethods, methods)).toBe(true);
    expect((methods as AuthMethods).google).toBe(true);
    expect(server.stub.calls.urls).toEqual([]);
  });

  test('Google unreachable at the button is a failure, never a hang, and sets no session', async () => {
    const server = await aServer(aPerson(), { behaviour: { discovery: 'unreachable' } });
    const response = await server.app.handle(new Request(`${ORIGIN}/auth/google`));
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get('location')).toBeNull();
  });
});

describe('integration: a new person', () => {
  test('on an open server gets an account Google made: keyed by the bare sub, marked google_made, signed in, no picture kept', async () => {
    const person = aPerson();
    const server = await aServer(person, {
      behaviour: { claims: { picture: 'https://lh3.googleusercontent.com/a/photo' } },
    });
    const userId = await expectSignedIn(
      server,
      await signInWithGoogle(server.app, ORIGIN, server.stub),
    );
    const user = await userBy('id', userId);
    expect(user?.email).toBe(person.email);
    expect(user?.email_verified).toBe(true);
    expect(user?.google_made).toBe(true);
    expect(user?.github_id).toBeNull();
    expect(user?.avatar_url).toBeNull();
    expect(user?.display_name).toBe('Ali Veli');
    expect(await accountsOf(userId)).toEqual([
      { provider_id: GOOGLE_PROVIDER_ID, account_id: person.sub },
    ]);
    const tokens = await db
      .selectFrom('accounts')
      .select(['access_token', 'id_token', 'refresh_token'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(tokens).toEqual({ access_token: null, id_token: null, refresh_token: null });
    expect(
      await mySignIn(db, userId, { requireTwoFactor: false, passwordSignIn: true }, true),
    ).toMatchObject({ google: true, oidc: false, github: null });
  });

  test('with an address outside Gmail and no hd, no account having it: made as any sign-up, Google’s say not needed', async () => {
    const person = aPerson({ email: `ali-${unique()}@sirket.com` });
    const server = await aServer(person);
    const userId = await expectSignedIn(
      server,
      await signInWithGoogle(server.app, ORIGIN, server.stub),
    );
    const user = await userBy('id', userId);
    expect(user?.email).toBe(person.email);
    expect(user?.google_made).toBe(true);
    expect(await accountsOf(userId)).toEqual([
      { provider_id: GOOGLE_PROVIDER_ID, account_id: person.sub },
    ]);
  });

  test('on an invite-only server without a passport is signup-closed, and nothing is made', async () => {
    const person = aPerson();
    const server = await aServer(person, { signUp: 'invite-only' });
    expectSentBack(await signInWithGoogle(server.app, ORIGIN, server.stub), 'signup-closed');
    expect(await userBy('email', person.email)).toBeUndefined();
  });

  test('on an invite-only server with an invitation passport is made, and the passport spent', async () => {
    const person = aPerson();
    const clock = aMovableClock();
    const server = await aServer(person, { signUp: 'invite-only', clock });
    const owner = await aSignedInUser(db, clock, 'g-owner');
    const post = async (path: string, body: unknown, cookie = ''): Promise<Response> =>
      await server.app.handle(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: ORIGIN,
            ...(cookie === '' ? {} : { cookie }),
          },
          body: JSON.stringify(body),
        }),
      );
    const created = await post(
      '/api/workspaces',
      { name: 'g-ws', slug: aUniqueSlug('g-ws') },
      owner.cookie,
    );
    const { id: workspaceId } = (await created.json()) as { id: string };
    const made = await post(`/api/workspaces/${workspaceId}/invitations`, {}, owner.cookie);
    const { token } = (await made.json()) as { token: string };
    const passport = await post('/api/invitations/passport', { token });
    expect(passport.status).toBe(204);
    const pair = cookiesFrom(passport);

    const response = await signInWithGoogle(server.app, ORIGIN, server.stub, pair);
    const userId = await expectSignedIn(server, response);
    expect((await userBy('id', userId))?.google_made).toBe(true);

    // The cookie spends no second account.
    const other = aPerson();
    server.stub.person = other;
    expectSentBack(await signInWithGoogle(server.app, ORIGIN, server.stub, pair), 'signup-closed');
    expect(await userBy('email', other.email)).toBeUndefined();
  });
});

describe('integration: the sign-in round', () => {
  test('a Google sign-in is served only inside the handler, where google_made is written', async () => {
    const server = await aServer(aPerson());
    const provider = (await server.auth.$context).socialProviders.find(
      (one) => one.id === GOOGLE_PROVIDER_ID,
    );
    const nonce = 'n'.repeat(32);
    const refused = await provider
      ?.getUserInfo({
        idToken: await server.stub.mint(nonce),
        expectedIdTokenNonce: nonce,
      })
      .then(
        () => 'answered',
        (error: unknown) => (isAPIError(error) ? error.statusCode : String(error)),
      );
    expect(refused).toBe(500);
  });
});

describe('integration: an existing account by its address (D-250)', () => {
  test('a verified email-made Gmail account is linked and signed into; google_made stays false', async () => {
    const email = `ali-${unique()}@gmail.com`;
    const existing = await anEmailAccount(email);
    const person = aPerson({ email });
    const server = await aServer(person);
    const userId = await expectSignedIn(
      server,
      await signInWithGoogle(server.app, ORIGIN, server.stub),
    );
    expect(userId).toBe(existing.id);
    expect((await userBy('id', userId))?.google_made).toBe(false);
    expect(await accountsOf(userId)).toEqual([
      { provider_id: GOOGLE_PROVIDER_ID, account_id: person.sub },
    ]);
  });

  test('an address outside Gmail with no hd is not Google’s to vouch for: email-unverified, nothing linked, the account untouched', async () => {
    const email = `ali-${unique()}@sirket.com`;
    const existing = await anEmailAccount(email);
    const server = await aServer(aPerson({ email }));
    expectSentBack(await signInWithGoogle(server.app, ORIGIN, server.stub), 'email-unverified');
    expect(await accountsOf(existing.id)).toEqual([]);
    expect(await userBy('id', existing.id)).toEqual(existing);
    // And it is said in the log without the address.
    const said = server.lines.filter((line) => JSON.stringify(line).includes('sirket'));
    expect(said).toEqual([]);
  });

  test('an hd naming another domain is no say over this one: email-unverified', async () => {
    const email = `ali-${unique()}@sirket.com`;
    const existing = await anEmailAccount(email);
    const server = await aServer(aPerson({ email, hd: 'baska.com' }));
    expectSentBack(await signInWithGoogle(server.app, ORIGIN, server.stub), 'email-unverified');
    expect(await accountsOf(existing.id)).toEqual([]);
  });

  test('the Workspace domain the token names in hd is Google’s to vouch for: linked', async () => {
    const email = `ali-${unique()}@sirket.com`;
    const existing = await anEmailAccount(email);
    const person = aPerson({ email, hd: 'sirket.com' });
    const server = await aServer(person);
    expect(
      await expectSignedIn(server, await signInWithGoogle(server.app, ORIGIN, server.stub)),
    ).toBe(existing.id);
    expect(await accountsOf(existing.id)).toEqual([
      { provider_id: GOOGLE_PROVIDER_ID, account_id: person.sub },
    ]);
  });

  test('case does not count, in the address or in hd: linked', async () => {
    const local = `ali-${unique()}`;
    const existing = await anEmailAccount(`${local}@sirket.com`);
    const server = await aServer(
      aPerson({ email: `${local.toUpperCase()}@Sirket.COM`, hd: 'Sirket.com' }),
    );
    expect(
      await expectSignedIn(server, await signInWithGoogle(server.app, ORIGIN, server.stub)),
    ).toBe(existing.id);
    expect((await userBy('id', existing.id))?.email).toBe(`${local}@sirket.com`);
  });

  test('Google saying the address is not verified: email-unverified, and nothing is made or linked', async () => {
    const email = `ali-${unique()}@gmail.com`;
    const existing = await anEmailAccount(email);
    const server = await aServer(aPerson({ email }), {
      behaviour: { claims: { email_verified: false } },
    });
    expectSentBack(await signInWithGoogle(server.app, ORIGIN, server.stub), 'email-unverified');
    expect(await accountsOf(existing.id)).toEqual([]);
  });

  test('a local account whose address was never proven is not linked: email-taken', async () => {
    const email = `ali-${unique()}@gmail.com`;
    const existing = await anEmailAccount(email, false);
    const server = await aServer(aPerson({ email }));
    expectSentBack(await signInWithGoogle(server.app, ORIGIN, server.stub), 'email-taken');
    expect(await accountsOf(existing.id)).toEqual([]);
  });
});

describe('integration: one Google identity, and never a way past single sign-on', () => {
  test('an account single sign-on is linked to is not linked to Google by address: failed (identity_conflict)', async () => {
    const email = `ali-${unique()}@gmail.com`;
    const existing = await anEmailAccount(email);
    await db
      .insertInto('accounts')
      .values({
        user_id: existing.id,
        provider_id: 'oidc',
        account_id: `https://idp.example.test|${unique()}`,
      })
      .execute();
    const server = await aServer(aPerson({ email }));
    expectSentBack(await signInWithGoogle(server.app, ORIGIN, server.stub), 'failed');
    expect((await accountsOf(existing.id)).map((row) => row.provider_id)).toEqual(['oidc']);
    expect(server.lines.some((line) => line['libraryError'] === 'identity_conflict')).toBe(true);
  });

  test('an account Google is linked to under another sub is not given a second: failed (identity_conflict)', async () => {
    const person = aPerson();
    const server = await aServer(person);
    const first = await expectSignedIn(
      server,
      await signInWithGoogle(server.app, ORIGIN, server.stub),
    );
    server.stub.person = { ...person, sub: `2${String(Math.floor(Math.random() * 1e15))}` };
    expectSentBack(await signInWithGoogle(server.app, ORIGIN, server.stub), 'failed');
    expect(await accountsOf(first)).toEqual([
      { provider_id: GOOGLE_PROVIDER_ID, account_id: person.sub },
    ]);
    // The first sub still signs in.
    server.stub.person = person;
    expect(
      await expectSignedIn(server, await signInWithGoogle(server.app, ORIGIN, server.stub)),
    ).toBe(first);
  });
});

describe('integration: who the token says it is', () => {
  test('an iss written without its scheme, as Google sometimes writes it, is Google: signed in', async () => {
    const server = await aServer(aPerson(), {
      behaviour: { claims: { iss: 'accounts.google.com' } },
    });
    await expectSignedIn(server, await signInWithGoogle(server.app, ORIGIN, server.stub));
  });

  test.each([
    'https://evil.example.test',
    'http://accounts.google.com',
    'accounts.google.com.evil.test',
  ])('an iss of %s is not Google: failed, nothing made', async (iss) => {
    const person = aPerson();
    const server = await aServer(person, { behaviour: { claims: { iss } } });
    expectSentBack(await signInWithGoogle(server.app, ORIGIN, server.stub), 'failed');
    expect(await userBy('email', person.email)).toBeUndefined();
  });

  test('a linked person whose Google address changed is still their account, and their address is not rewritten', async () => {
    const person = aPerson();
    const server = await aServer(person);
    const first = await expectSignedIn(
      server,
      await signInWithGoogle(server.app, ORIGIN, server.stub),
    );
    const before = await userBy('id', first);
    server.stub.person = { ...person, email: `moved-${unique()}@sirket.com` };
    expect(
      await expectSignedIn(server, await signInWithGoogle(server.app, ORIGIN, server.stub)),
    ).toBe(first);
    expect((await userBy('id', first))?.email).toBe(person.email);
    expect(await userBy('id', first)).toEqual(before);
  });

  test('a linked person whose new Google address is another account’s, not Google’s to vouch for, still signs into their own', async () => {
    const person = aPerson();
    const server = await aServer(person);
    const first = await expectSignedIn(
      server,
      await signInWithGoogle(server.app, ORIGIN, server.stub),
    );
    const someoneElse = await anEmailAccount(`other-${unique()}@sirket.com`);
    server.stub.person = { ...person, email: someoneElse.email };
    expect(
      await expectSignedIn(server, await signInWithGoogle(server.app, ORIGIN, server.stub)),
    ).toBe(first);
    expect(await accountsOf(someoneElse.id)).toEqual([]);
  });
});

describe('integration: Google failing', () => {
  test('the token endpoint unreachable is google-unavailable', async () => {
    const server = await aServer(aPerson(), { behaviour: { token: 'unreachable' } });
    expectSentBack(await signInWithGoogle(server.app, ORIGIN, server.stub), 'google-unavailable');
  });

  test('the key set unreachable is google-unavailable, not a token that is wrong', async () => {
    const server = await aServer(aPerson(), { behaviour: { jwks: 'unreachable' } });
    expectSentBack(await signInWithGoogle(server.app, ORIGIN, server.stub), 'google-unavailable');
  });

  test('the token endpoint answering 503 is google-unavailable', async () => {
    const server = await aServer(aPerson(), { behaviour: { token: 'refuses' } });
    expectSentBack(await signInWithGoogle(server.app, ORIGIN, server.stub), 'google-unavailable');
  });
});

describe('integration: two first sign-ins of one Google account at once', () => {
  test('both end signed in to one account: the loser is sent round once, as GitHub’s is (D-78)', async () => {
    const person = aPerson();
    const server = await aServer(person);
    const one = await startGoogleSignIn(server.app, ORIGIN, server.stub);
    const two = await startGoogleSignIn(server.app, ORIGIN, server.stub);
    await sql`create trigger hold before insert on users for each row execute function hold_window()`.execute(
      db,
    );
    let answers: Response[];
    try {
      answers = await Promise.all(
        [one, two].map(async (tab) => await returnFromGoogle(server.app, ORIGIN, tab)),
      );
    } finally {
      await sql`drop trigger hold on users`.execute(db);
    }
    const locations = answers.map((answer) => answer.headers.get('location'));
    expect(locations.sort()).toEqual([ORIGIN, `${ORIGIN}/auth/google`].sort());
    const lost = answers.find(
      (answer) => answer.headers.get('location') === `${ORIGIN}/auth/google`,
    );
    const tab: StartedSignIn = lost === answers[0] ? one : two;
    expect(
      lost?.headers.getSetCookie().some((cookie) => cookie.startsWith(`${RETRY_COOKIE}=`)),
    ).toBe(true);
    const carried = [tab.cookie, cookiesFrom(lost ?? new Response())].filter(Boolean).join('; ');
    const back = await signInWithGoogle(server.app, ORIGIN, server.stub, carried);
    expect(back.headers.get('location')).toBe(ORIGIN);
    const users = await db
      .selectFrom('users')
      .select('id')
      .where('email', '=', person.email)
      .execute();
    expect(users).toHaveLength(1);
    expect(await accountsOf(users[0]?.id ?? '')).toEqual([
      { provider_id: GOOGLE_PROVIDER_ID, account_id: person.sub },
    ]);
  });
});
