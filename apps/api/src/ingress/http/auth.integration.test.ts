/**
 * The whole GitHub sign-in, driven through real requests against the mounted library and a real
 * database (D-179).
 *
 * GitHub is a double at the `fetch` boundary — the token endpoint and both API calls — so what is
 * tested is that the library, its configuration, Purlay's columns and the sign-in screen's reasons fit
 * together, including every way one of them refuses (D-121). The library's transactions need a
 * database rather than a rolled-back transaction, so the file runs on a clone of its own, dropped
 * afterwards: its sessions, accounts and the library's counters reach nobody else's test.
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
import type { SignInFailure } from '@purlay/types';
import { createApp, type HttpApplication } from './app';
import { SESSION_COOKIE, STATE_COOKIE } from '../../platform/cookies';
import { DEVELOPMENT_ENCRYPTION_KEY, type Config } from '../../platform/config';
import type { Logger } from '../../platform/logging';
import {
  aRecordingLogger,
  creatorsFromTheSetting,
  testConfig,
  testDependencies,
} from '../../testing/doubles';
import {
  aGitHubAuth,
  aGitHubFor,
  aGitHubPerson,
  cookiesFrom,
  returnFromGitHub,
  signInWithGitHub,
  startGitHubSignIn,
  type GitHubBehaviour,
  type GitHubCalls,
  type GitHubStub,
  type GitHubPerson,
  type StartedSignIn,
} from '../../testing/github-sign-in';
import { aUserRow } from '../../testing/users';
import { inProcessBackplane } from '../../realtime/bus';
import { NO_LOG } from '../../platform/events';
import { sessionFromHeaders } from '../../modules/auth/sessions';
import { CLIENT_ADDRESS_HEADER, type Auth } from '../../modules/auth/better-auth';
import { saveSettings } from '../../modules/setup/settings';
import { workspaceCreatorsOf } from '../../modules/workspaces/creators';
import { systemClock } from '../../platform/clock';
import { credentialCipher } from '../../platform/crypto';

const ORIGIN = 'https://purlay.test';
const unique = (): string => crypto.randomUUID().slice(0, 8);

let cloned: ClonedDatabase;
let db: Executor;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

// The library counts sign-in attempts per address in this database, and under test every request
// comes from one: each test starts with none counted.
beforeEach(async () => {
  await sql`delete from rate_limits`.execute(db);
});

type GitHubAccount = GitHubPerson;
const anAccount = aGitHubPerson;

interface Server {
  readonly app: HttpApplication;
  readonly auth: Auth;
  readonly calls: GitHubCalls;
  readonly github: GitHubStub;
}

const aServer = (
  account: GitHubAccount,
  options: {
    readonly behaviour?: GitHubBehaviour;
    readonly signUp?: 'open' | 'invite-only';
    readonly config?: Partial<Config>;
    readonly log?: Logger;
    /** Who may make a workspace as the server's setting says, not the double that lets anybody. */
    readonly creatorsFromSettings?: boolean;
  } = {},
): Server => {
  const github = aGitHubFor(account, options.behaviour);
  const config = testConfig({ APP_URL: ORIGIN, ...options.config });
  const backplane = inProcessBackplane();
  const auth = aGitHubAuth(db, github.fetch, {
    baseUrl: ORIGIN,
    signUp: options.signUp ?? 'open',
    sessionTtlDays: config.SESSION_TTL_DAYS,
    bus: backplane.node(() => undefined, NO_LOG),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  const dependencies = testDependencies({
    database: db,
    config,
    auth,
    backplane,
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  const app = createApp(
    options.creatorsFromSettings === true ? creatorsFromTheSetting(dependencies) : dependencies,
  );
  return { app, auth, calls: github.calls, github };
};

type Started = StartedSignIn;

const start = async (server: Server): Promise<Started> =>
  await startGitHubSignIn(server.app, ORIGIN, server.github);

const callback = async (
  server: Server,
  started: Started,
  query?: Record<string, string>,
  headers?: Record<string, string>,
): Promise<Response> => await returnFromGitHub(server.app, ORIGIN, started, query, headers);

const signIn = async (server: Server): Promise<Response> =>
  await signInWithGitHub(server.app, ORIGIN, server.github);

/**
 * A sign-in that did not finish, as the browser receives it (D-121): a redirect to the sign-in
 * screen carrying this reason and nothing else, the state spent, and no session.
 */
const expectSentBack = (response: Response, failure: SignInFailure): void => {
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=${failure}`);
  expect(response.headers.get('content-type') ?? '').not.toContain('json');
  const cookies = response.headers.getSetCookie();
  expect(cookies.some((cookie) => cookie.startsWith(`${STATE_COOKIE}=;`))).toBe(true);
  expect(cookies.some((cookie) => /^__Host-purlay_session=[^;]/.test(cookie))).toBe(false);
};

interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly email_verified: boolean;
  readonly github_id: string | null;
  readonly github_login: string | null;
  readonly github_connected_at: Date | null;
  readonly avatar_url: string | null;
}

const usersWith = async (email: string): Promise<UserRow[]> =>
  await db
    .selectFrom('users')
    .select([
      'id',
      'username',
      'display_name',
      'email_verified',
      'github_id',
      'github_login',
      'github_connected_at',
      'avatar_url',
    ])
    .where('email', '=', email)
    .execute();

const sessionsOf = async (userId: string): Promise<{ id: string; expires_at: Date }[]> =>
  await db
    .selectFrom('sessions')
    .select(['id', 'expires_at'])
    .where('user_id', '=', userId)
    .execute();

describe('integration: the way to GitHub', () => {
  test('is a redirect asking for exactly the scopes D-38 allows, back to the library’s callback', async () => {
    const { response, state } = await start(aServer(anAccount()));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('scope')).toBe('read:user user:email');
    expect(location.searchParams.get('client_id')).toBe('client-id');
    // R13: the callback is the library's own under its base path, from the server's address.
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback/github`);
    expect(state.length).toBeGreaterThanOrEqual(32);
  });

  /**
   * Regression for #199. A sibling subdomain can set a cookie for this origin unless its name
   * carries `__Host-`, which a browser accepts only with `Secure`, `Path=/` and no `Domain`.
   */
  test('sets a state cookie, and later a session cookie, that a sibling subdomain cannot plant', async () => {
    const server = aServer(anAccount());
    const started = await start(server);
    const signedIn = await callback(server, started);
    const cookies = [
      ...started.response.headers.getSetCookie(),
      ...signedIn.headers.getSetCookie().filter((cookie) => !/^[^=]+=;/.test(cookie)),
    ];
    expect(cookies.map((cookie) => cookie.split('=')[0])).toEqual([STATE_COOKIE, SESSION_COOKIE]);
    // The library's five minutes for a sign-in's state, as API.md says.
    expect(cookies[0]).toContain('Max-Age=300');
    for (const cookie of cookies) {
      const attributes = cookie
        .split(';')
        .slice(1)
        .map((part) => part.trim().toLowerCase());
      expect(cookie.startsWith('__Host-')).toBe(true);
      expect(attributes).toContain('secure');
      expect(attributes).toContain('httponly');
      expect(attributes).toContain('path=/');
      expect(attributes).toContain('samesite=lax');
      expect(attributes.some((attribute) => attribute.startsWith('domain'))).toBe(false);
    }
  });
});

describe('integration: signing in with GitHub through the library', () => {
  test('makes the account from GitHub: its id, its login, a username from the login, no token', async () => {
    const account = anAccount();
    const server = aServer(account);
    const response = await signIn(server);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(ORIGIN);
    // The state is spent with it: a callback consumes it, so it cannot be replayed (#199).
    expect(
      response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${STATE_COOKIE}=;`)),
    ).toBe(true);

    const [user, ...others] = await usersWith(account.email);
    expect(others).toEqual([]);
    expect(user).toMatchObject({
      username: account.login.toLowerCase(),
      display_name: 'Ada Lovelace',
      email_verified: true,
      github_id: String(account.id),
      github_login: account.login,
      // Made by GitHub: never "connected" (0046).
      github_connected_at: null,
      avatar_url: `https://avatars.example/${String(account.id)}`,
    });
    const accounts = await db
      .selectFrom('accounts')
      .select(['provider_id', 'account_id', 'access_token', 'refresh_token'])
      .where('user_id', '=', user?.id ?? '')
      .execute();
    expect(accounts).toEqual([
      {
        provider_id: 'github',
        account_id: String(account.id),
        access_token: null,
        refresh_token: null,
      },
    ]);
  });

  test('redeems the code with the PKCE verifier its authorization was bound to', async () => {
    const server = aServer(anAccount());
    const started = await start(server);
    const location = new URL(started.response.headers.get('location') ?? '');
    // What GitHub is asked (docs: authorizing OAuth apps): a challenge, and only S256.
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toHaveLength(43);
    expect((await callback(server, started)).headers.get('location')).toBe(ORIGIN);
    // The strict stub answers a token only for the verifier whose SHA-256 is the challenge.
    expect(server.github.refusals).toEqual([]);
  });

  test('a code issued for another authorization is refused at the token endpoint, and nothing is made', async () => {
    const account = anAccount();
    const server = aServer(account);
    const started = await start(server);
    // The same request at GitHub with somebody else's challenge: the code it issues is bound to it.
    const elsewhere = new URL(started.response.headers.get('location') ?? '');
    elsewhere.searchParams.set('code_challenge', 'A'.repeat(43));
    const foreign = server.github.authorize(elsewhere.toString()).code;
    expectSentBack(
      await callback(server, started, { code: foreign, state: started.state }),
      'github-unavailable',
    );
    expect(server.github.refusals).toEqual(['bad_verification_code']);
    expect(await usersWith(account.email)).toEqual([]);
  });

  test('issues a session the one seam resolves, and /api/me knows who it is', async () => {
    const account = anAccount();
    const server = aServer(account);
    const response = await signIn(server);
    const cookie = cookiesFrom(response);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);

    const owner = await sessionFromHeaders(server.auth, new Headers({ cookie }));
    const [user] = await usersWith(account.email);
    expect(owner?.userId).toBe(user?.id ?? 'none');

    const me = await server.app.handle(new Request(`${ORIGIN}/api/me`, { headers: { cookie } }));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      user: { id: user?.id, username: account.login.toLowerCase() },
    });

    // The cookie carries the token; the database carries only its digest (D-11).
    const token = decodeURIComponent(cookie.split('=')[1] ?? '').split('.')[0] ?? '';
    const { rows } = await sql<{ token_hash: string; user_agent: string | null }>`
      select token_hash, user_agent from sessions where user_id = ${user?.id ?? ''}`.execute(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(rows[0]?.user_agent).toBe('probe/1.0');
  });

  test('lasts SESSION_TTL_DAYS from sign-in, and using it does not move that', async () => {
    const account = anAccount();
    const server = aServer(account, { config: { SESSION_TTL_DAYS: 7 } });
    const before = Date.now();
    const response = await signIn(server);
    const after = Date.now();
    const [user] = await usersWith(account.email);
    const [session] = await sessionsOf(user?.id ?? '');
    const week = 7 * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(session?.expires_at ?? 0).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + week - 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + week);
    const sessionCookie = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
    expect(sessionCookie).toContain(`Max-Age=${String(7 * 24 * 60 * 60)}`);

    // The library's own read refreshes a session more than a day into its life (`updateAge`), by
    // moving its expiry; this one never does (R25): what was issued is what stays.
    const fiveDaysLeft = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await db
      .updateTable('sessions')
      .set({ expires_at: fiveDaysLeft })
      .where('user_id', '=', user?.id ?? '')
      .execute();
    const read = await server.app.handle(
      new Request(`${ORIGIN}/auth/get-session`, { headers: { cookie: cookiesFrom(response) } }),
    );
    expect(read.status).toBe(200);
    expect(read.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    const [again] = await sessionsOf(user?.id ?? '');
    expect(new Date(again?.expires_at ?? 0).getTime()).toBe(fiveDaysLeft.getTime());
  });

  test('signs an existing account in again: the same account, its names refreshed from GitHub', async () => {
    const account = anAccount();
    expect((await signIn(aServer(account))).headers.get('location')).toBe(ORIGIN);
    const [first] = await usersWith(account.email);

    // Renamed at GitHub since: an account GitHub made follows it (D-38).
    const renamed = { ...account, login: `Lovelace-${unique()}`, name: 'Countess Lovelace' };
    expect((await signIn(aServer(renamed))).headers.get('location')).toBe(ORIGIN);
    const [second, ...others] = await usersWith(account.email);
    expect(others).toEqual([]);
    expect(second).toMatchObject({
      id: first?.id,
      username: renamed.login.toLowerCase(),
      display_name: 'Countess Lovelace',
      github_login: renamed.login,
      github_connected_at: null,
    });
    expect(await sessionsOf(first?.id ?? '')).toHaveLength(2);
  });

  test('takes the first free username, never another person’s, and says so in the log', async () => {
    const holder = await aUserRow(db, 'grace');
    const recording = aRecordingLogger();
    // GitHub's login is the holder's username, in another case.
    const account = anAccount(holder.username.toUpperCase(), {
      email: `grace-${unique()}@example.test`,
    });
    expect((await signIn(aServer(account, { log: recording.log }))).headers.get('location')).toBe(
      ORIGIN,
    );
    const [user] = await usersWith(account.email);
    expect(user?.username).toBe(`${holder.username}-1`);
    // The login is GitHub's, as given; only the username moved (D-169).
    expect(user?.github_login).toBe(account.login);
    expect(
      recording.lines.find((line) => line['msg'] === 'username taken; stored with a suffix'),
    ).toMatchObject({ level: 'warn', wanted: holder.username, stored: `${holder.username}-1` });
    const [kept] = await db
      .selectFrom('users')
      .select('username')
      .where('id', '=', holder.userId)
      .execute();
    expect(kept?.username).toBe(holder.username);
  });

  test('a login listed in the creators setting may make a workspace, matched by github_login in any case', async () => {
    const listed = anAccount();
    const other = anAccount();
    // As `WORKSPACE_CREATORS` would seed it: the login as written, in upper case.
    await saveSettings(db, credentialCipher(DEVELOPMENT_ENCRYPTION_KEY), systemClock, {
      workspaceCreators: workspaceCreatorsOf(listed.login.toUpperCase()),
    });
    const mayCreate = async (account: GitHubAccount): Promise<unknown> => {
      const server = aServer(account, { creatorsFromSettings: true });
      const cookie = cookiesFrom(await signIn(server));
      const me = await server.app.handle(new Request(`${ORIGIN}/api/me`, { headers: { cookie } }));
      return ((await me.json()) as { mayCreateWorkspace: unknown }).mayCreateWorkspace;
    };
    try {
      expect(await mayCreate(listed)).toBe(true);
      expect(await mayCreate(other)).toBe(false);
    } finally {
      // The clone is this file's: the row this test made goes, and the next test finds none.
      await db.deleteFrom('server_settings').where('id', '=', true).execute();
    }
  });

  test('a body sent to the library’s own sign-in cannot name the username it makes (R23)', async () => {
    const victim = await aUserRow(db, 'victim');
    const account = anAccount();
    const server = aServer(account);
    const asked = await server.app.handle(
      new Request(`${ORIGIN}/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({
          provider: 'github',
          callbackURL: ORIGIN,
          username: victim.username,
          additionalData: { username: victim.username },
        }),
      }),
    );
    expect(asked.status).toBe(200);
    const { url } = (await asked.json()) as { url: string };
    const started: Started = {
      response: asked,
      state: new URL(url).searchParams.get('state') ?? '',
      cookie: cookiesFrom(asked),
      code: server.github.authorize(url).code,
    };
    expect((await callback(server, started)).headers.get('location')).toBe(ORIGIN);
    const [user] = await usersWith(account.email);
    expect(user?.username).toBe(account.login.toLowerCase());
  });

  test('answers none of the library’s routes that would edit a user or hand out a provider token', async () => {
    const server = aServer(anAccount());
    for (const path of [
      '/auth/update-user',
      '/auth/link-social',
      '/auth/unlink-account',
      '/auth/get-access-token',
      '/auth/refresh-token',
      '/auth/change-email',
      '/auth/send-verification-email',
      '/auth/verify-email',
      '/auth/update-session',
      '/auth/delete-user/callback',
      '/auth/list-accounts',
    ]) {
      // Both methods: a route open on one of them answers there, and a `POST` to a read is a 404 anyway.
      for (const method of ['POST', 'GET']) {
        const response = await server.app.handle(
          new Request(`${ORIGIN}${path}`, {
            method,
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            ...(method === 'POST'
              ? { body: JSON.stringify({ username: 'taken-over', providerId: 'github' }) }
              : {}),
          }),
        );
        expect({ path, method, status: response.status }).toEqual({ path, method, status: 404 });
      }
    }
    const info = await server.app.handle(new Request(`${ORIGIN}/auth/account-info`));
    expect(info.status).toBe(404);
  });

  test('keeps the address the server decided on, never one a client wrote into a header', async () => {
    const spoofing = { 'x-forwarded-for': '203.0.113.7', [CLIENT_ADDRESS_HEADER]: '198.51.100.1' };
    const addressOf = async (email: string): Promise<string | null> => {
      const [user] = await usersWith(email);
      const { rows } = await sql<{ ip: string | null }>`
        select host(ip_address) as ip from sessions where user_id = ${user?.id ?? ''}`.execute(db);
      return rows[0]?.ip ?? null;
    };

    // Behind a trusted proxy, the proxy's header (TRUST_PROXY).
    const proxied = anAccount();
    const behindProxy = aServer(proxied, { config: { TRUST_PROXY: true } });
    await callback(behindProxy, await start(behindProxy), undefined, spoofing);
    expect(await addressOf(proxied.email)).toBe('203.0.113.7');

    // Otherwise the peer — a request with no socket has none, and the library then says
    // localhost under test — and never what the client sent.
    const direct = anAccount();
    const notBehind = aServer(direct);
    await callback(notBehind, await start(notBehind), undefined, spoofing);
    expect(['203.0.113.7', '198.51.100.1']).not.toContain(await addressOf(direct.email));
  });
});

describe('integration: one verified address is one account (D-179 §5)', () => {
  test('a GitHub sign-in links to the verified account made by email, which keeps its names', async () => {
    const made = await aUserRow(db, 'byemail');
    await db
      .updateTable('users')
      .set({ email_verified: true })
      .where('id', '=', made.userId)
      .execute();
    const account = anAccount(`Linked-${unique()}`, { email: made.email, name: 'GitHub Name' });

    expect((await signIn(aServer(account))).headers.get('location')).toBe(ORIGIN);
    const [linked] = await usersWith(made.email);
    expect(linked).toMatchObject({
      id: made.userId,
      username: made.username,
      display_name: 'byemail',
      github_id: String(account.id),
      github_login: account.login,
    });
    expect(linked?.github_connected_at).not.toBeNull();
    const connectedAt = linked?.github_connected_at;

    // And every later one: the account was never GitHub's to rename (D-176 §6).
    const renamed = { ...account, login: `Renamed-${unique()}`, name: 'Another Name' };
    expect((await signIn(aServer(renamed))).headers.get('location')).toBe(ORIGIN);
    const [again] = await usersWith(made.email);
    expect(again).toMatchObject({
      username: made.username,
      display_name: 'byemail',
      github_login: renamed.login,
      github_connected_at: connectedAt,
    });
  });

  test('never links to an account whose own address is unverified: sent back as taken', async () => {
    const made = await aUserRow(db, 'unverified');
    const account = anAccount(`Claimer-${unique()}`, { email: made.email });
    const response = await signIn(aServer(account));
    expectSentBack(response, 'email-taken');
    const [kept] = await usersWith(made.email);
    expect(kept).toMatchObject({ id: made.userId, github_id: null, github_login: null });
    expect(await sessionsOf(made.userId)).toEqual([]);
  });

  describe('an account has one GitHub identity (D-179 §3)', () => {
    const githubAccountsOf = async (userId: string): Promise<string[]> =>
      (
        await db
          .selectFrom('accounts')
          .select('account_id')
          .where('user_id', '=', userId)
          .where('provider_id', '=', 'github')
          .execute()
      ).map((row) => row.account_id);

    const expectRefusedAsAnotherIdentity = async (
      owner: { readonly userId: string; readonly github: GitHubAccount },
      intruder: GitHubAccount,
      email: string,
    ): Promise<void> => {
      const recording = aRecordingLogger();
      const sessionsBefore = await sessionsOf(owner.userId);
      expectSentBack(await signIn(aServer(intruder, { log: recording.log })), 'failed');
      expect(recording.lines.some((line) => line['libraryError'] === 'identity_conflict')).toBe(
        true,
      );
      // Nothing of the intruder was written, and no session of anybody's began.
      expect(await githubAccountsOf(owner.userId)).toEqual([String(owner.github.id)]);
      const [kept, ...others] = await usersWith(email);
      expect(others).toEqual([]);
      expect(kept).toMatchObject({
        id: owner.userId,
        github_id: String(owner.github.id),
        github_login: owner.github.login,
      });
      expect(await sessionsOf(owner.userId)).toEqual(sessionsBefore);
      const stranger = await db
        .selectFrom('accounts')
        .select('id')
        .where('account_id', '=', String(intruder.id))
        .execute();
      expect(stranger).toEqual([]);
    };

    test('a second GitHub account with the verified address of one GitHub made is refused, and the first is untouched', async () => {
      const first = anAccount(`First-${unique()}`);
      expect((await signIn(aServer(first))).headers.get('location')).toBe(ORIGIN);
      const [owner] = await usersWith(first.email);
      const second = anAccount(`Second-${unique()}`, { email: first.email });
      await expectRefusedAsAnotherIdentity(
        { userId: owner?.id ?? '', github: first },
        second,
        first.email,
      );
      // The first signs in still.
      expect((await signIn(aServer(first))).headers.get('location')).toBe(ORIGIN);
    });

    test('and so is one that meets an account made by email and connected to a GitHub account', async () => {
      const made = await aUserRow(db, 'connected');
      await db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', made.userId)
        .execute();
      const first = anAccount(`Linked-${unique()}`, { email: made.email });
      expect((await signIn(aServer(first))).headers.get('location')).toBe(ORIGIN);
      const second = anAccount(`Intruder-${unique()}`, { email: made.email });
      await expectRefusedAsAnotherIdentity(
        { userId: made.userId, github: first },
        second,
        made.email,
      );
    });

    test('and so is one met by an account whose GitHub id is kept though its account row is gone', async () => {
      const first = anAccount(`Orphan-${unique()}`);
      expect((await signIn(aServer(first))).headers.get('location')).toBe(ORIGIN);
      const [owner] = await usersWith(first.email);
      await db
        .deleteFrom('accounts')
        .where('user_id', '=', owner?.id ?? '')
        .execute();
      const second = anAccount(`Second-${unique()}`, { email: first.email });
      const recording = aRecordingLogger();
      expectSentBack(await signIn(aServer(second, { log: recording.log })), 'failed');
      expect(await githubAccountsOf(owner?.id ?? '')).toEqual([]);
      const [kept] = await usersWith(first.email);
      expect(kept?.github_id).toBe(String(first.id));
    });

    test('a GitHub account that was renamed, or whose login another account held, still signs in as itself', async () => {
      const made = await aUserRow(db, 'legit');
      await db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', made.userId)
        .execute();
      const account = anAccount(`Legit-${unique()}`, { email: made.email });
      expect((await signIn(aServer(account))).headers.get('location')).toBe(ORIGIN);
      const renamed = { ...account, login: `Renamed-${unique()}` };
      expect((await signIn(aServer(renamed))).headers.get('location')).toBe(ORIGIN);
      // Another person takes the login it left (D-169): the account still signs in, and the login is theirs.
      const successor = anAccount(renamed.login);
      expect((await signIn(aServer(successor))).headers.get('location')).toBe(ORIGIN);
      expect((await signIn(aServer(renamed))).headers.get('location')).toBe(ORIGIN);
      expect(await githubAccountsOf(made.userId)).toEqual([String(account.id)]);
    });
  });

  test('never takes an address GitHub has not verified: sent back as email-required', async () => {
    const account = anAccount(undefined, {
      emails: [
        { email: 'unverified@example.test', primary: true, verified: false },
        { email: 'other@example.test', primary: false, verified: true },
      ],
    });
    expectSentBack(await signIn(aServer(account)), 'email-required');
    expect(await usersWith('unverified@example.test')).toEqual([]);
    expect(await usersWith('other@example.test')).toEqual([]);
  });
});

describe('integration: who may make an account', () => {
  test('invite-only refuses a new person, and nothing is written', async () => {
    const account = anAccount();
    const response = await signIn(aServer(account, { signUp: 'invite-only' }));
    expectSentBack(response, 'signup-closed');
    expect(await usersWith(account.email)).toEqual([]);
  });

  test('invite-only still lets an existing account in', async () => {
    const account = anAccount();
    expect((await signIn(aServer(account))).headers.get('location')).toBe(ORIGIN);
    const again = await signIn(aServer(account, { signUp: 'invite-only' }));
    expect(again.headers.get('location')).toBe(ORIGIN);
  });

  test('an erased account’s person who comes back gets a new account, not the old one (I-11)', async () => {
    const account = anAccount();
    const server = aServer(account);
    const cookie = cookiesFrom(await signIn(server));
    const [before] = await usersWith(account.email);
    const erased = await server.app.handle(
      new Request(`${ORIGIN}/api/me/erase`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: before?.username }),
      }),
    );
    expect(erased.status).toBe(204);

    expect((await signIn(aServer(account))).headers.get('location')).toBe(ORIGIN);
    const [after, ...others] = await usersWith(account.email);
    expect(others).toEqual([]);
    expect(after?.id).not.toBe(before?.id);
    expect(after?.github_id).toBe(String(account.id));
    const tombstone = await db
      .selectFrom('users')
      .select(['github_id', 'github_login', 'deleted_at'])
      .where('id', '=', before?.id ?? '')
      .executeTakeFirstOrThrow();
    expect(tombstone).toMatchObject({ github_id: null, github_login: null });
    expect(tombstone.deleted_at).not.toBeNull();
  });
});

describe('integration: a sign-in that does not finish comes back with a reason (D-121)', () => {
  test('cancelling on GitHub is cancelled, read before the state and without calling GitHub', async () => {
    const server = aServer(anAccount());
    const started = await start(server);
    expectSentBack(
      await callback(server, started, { error: 'access_denied', state: started.state }),
      'cancelled',
    );
    // A cancel in a second tab, whose state this browser does not hold, is still a cancel (§4).
    expectSentBack(
      await callback(server, { ...started, cookie: '' }, { error: 'access_denied', state: 'x' }),
      'cancelled',
    );
    expect(server.calls.urls).toEqual([]);
  });

  test('any other error GitHub returns with is failed, and written down', async () => {
    const recording = aRecordingLogger();
    const server = aServer(anAccount(), { log: recording.log });
    const started = await start(server);
    expectSentBack(
      await callback(server, started, { error: 'redirect_uri_mismatch', state: started.state }),
      'failed',
    );
    expect(
      recording.lines.find((line) => line['msg'] === 'GitHub refused a sign-in'),
    ).toMatchObject({ level: 'warn', githubError: 'redirect_uri_mismatch' });
  });

  test('a state that is not this browser’s is expired, however it is wrong, and nothing is made', async () => {
    const account = anAccount();
    const server = aServer(account);
    const started = await start(server);
    const flipped = `${started.state.slice(0, -1)}${started.state.endsWith('a') ? 'b' : 'a'}`;
    expectSentBack(await callback(server, started, { code: 'c', state: flipped }), 'expired');
    // No state cookie at all.
    expectSentBack(
      await callback(server, { ...started, cookie: '' }, { code: 'c', state: started.state }),
      'expired',
    );
    // No state in the address.
    expectSentBack(await callback(server, await start(server), { code: 'c' }), 'expired');
    // A state, and no code.
    const another = await start(server);
    expectSentBack(await callback(server, another, { state: another.state }), 'expired');
    expect(await usersWith(account.email)).toEqual([]);
    expect(server.calls.urls).toEqual([]);
  });

  test('a callback used twice signs in once: the second is expired', async () => {
    const account = anAccount();
    const server = aServer(account);
    const started = await start(server);
    const [first, second] = await Promise.all([
      callback(server, started),
      callback(server, started),
    ]);
    const locations = [first.headers.get('location'), second.headers.get('location')].sort();
    expect(locations).toEqual([ORIGIN, `${ORIGIN}/sign-in?error=expired`].sort());
    const [user, ...others] = await usersWith(account.email);
    expect(others).toEqual([]);
    expect(await sessionsOf(user?.id ?? '')).toHaveLength(1);
  });

  for (const [what, behaviour] of [
    ['a token endpoint that cannot be reached', { token: 'unreachable' }],
    ['a token endpoint that refuses', { token: 'refuses' }],
    ['a code GitHub says is spent', { token: 'spent' }],
    ['an API that cannot be reached', { user: 'unreachable' }],
    ['an API that fails', { user: 'fails' }],
  ] as const) {
    test(`${what} is github-unavailable, written down, and nothing is made`, async () => {
      const account = anAccount();
      const recording = aRecordingLogger();
      const server = aServer(account, { behaviour, log: recording.log });
      expectSentBack(await signIn(server), 'github-unavailable');
      expect(recording.lines.some((line) => line['level'] === 'warn')).toBe(true);
      expect(await usersWith(account.email)).toEqual([]);
      // No token reached the log.
      expect(JSON.stringify(recording.lines)).not.toContain('gho_never_kept');
    });
  }

  test('every call to GitHub carries a deadline', async () => {
    const server = aServer(anAccount());
    expect((await signIn(server)).headers.get('location')).toBe(ORIGIN);
    expect(server.calls.urls).toHaveLength(3);
    expect(server.calls.signals).toEqual([true, true, true]);
  });
});

describe('integration: the routes of ours under /auth are still ours', () => {
  test('signing out revokes the session and clears the cookie; everywhere needs a session', async () => {
    const account = anAccount();
    const server = aServer(account);
    const first = cookiesFrom(await signIn(server));
    const second = cookiesFrom(await signIn(server));
    const [user] = await usersWith(account.email);
    expect(await sessionsOf(user?.id ?? '')).toHaveLength(2);

    const out = await server.app.handle(
      new Request(`${ORIGIN}/auth/logout`, { method: 'POST', headers: { cookie: first } }),
    );
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=;`);
    expect(await sessionsOf(user?.id ?? '')).toHaveLength(1);

    const anonymous = await server.app.handle(
      new Request(`${ORIGIN}/auth/logout-all`, { method: 'POST' }),
    );
    expect(anonymous.status).toBe(401);
    const everywhere = await server.app.handle(
      new Request(`${ORIGIN}/auth/logout-all`, { method: 'POST', headers: { cookie: second } }),
    );
    expect(everywhere.status).toBe(204);
    expect(await sessionsOf(user?.id ?? '')).toEqual([]);
  });

  test('a path neither of us serves is the API’s 404, never HTML or an empty body', async () => {
    const server = aServer(anAccount());
    for (const method of ['GET', 'POST']) {
      const response = await server.app.handle(
        new Request(`${ORIGIN}/auth/nope`, {
          method,
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: '{}' } : {}),
        }),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({
        error: { code: 'ROUTE_NOT_FOUND', message: 'No such route.' },
      });
    }
  });

  test('a cookie that is not even well-formed signs out all the same, and no route that ends sessions answers 500', async () => {
    const server = aServer(anAccount());
    const malformed = `${SESSION_COOKIE}=%E0%A4%A`;
    const post = async (path: string, body: unknown = {}): Promise<Response> =>
      await server.app.handle(
        new Request(`${ORIGIN}/auth${path}`, {
          method: 'POST',
          headers: { cookie: malformed, origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    const out = await post('/sign-out');
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);
    for (const [path, body] of [
      ['/revoke-session', { token: 'x' }],
      ['/revoke-sessions', {}],
      ['/revoke-other-sessions', {}],
      ['/change-password', { currentPassword: 'a-password', newPassword: 'another-password' }],
      ['/reset-password', { token: 'not-a-token', newPassword: 'another-password' }],
    ] as const) {
      const answered = await post(path, body);
      expect({ path, status: answered.status }).not.toEqual({ path, status: 500 });
      expect(answered.status).toBeLessThan(500);
    }
  });
});
