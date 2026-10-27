/**
 * The Better Auth instance against the migrated database (D-179, migration 0047): what
 * `better-auth.test.ts` could not check without the tables. The library compares the database with
 * what it expects on its first request and fails on any difference, so the first test is that
 * comparison, run for real; the others go through the mapped tables and read the rows back with plain
 * SQL, so a mapping that agrees with itself and not with the database cannot pass.
 *
 * These write and commit, because the schema check needs a connection and not a transaction (the
 * library refuses a Kysely `Transaction`), and delete what they made by the address they made it under.
 */
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  integrationDatabase,
  sessionTokenDigest,
  sql,
  type Executor,
} from '@purlay/db';
import { makeSignature } from 'better-auth/crypto';
import {
  DEVELOPMENT_ENCRYPTION_KEY,
  GITHUB_API_URL_DEFAULT,
  GITHUB_URL_DEFAULT,
} from '../../platform/config';
import { createLogger } from '../../platform/logging';
import { outbox } from '../../platform/mail';
import { systemClock } from '../../platform/clock';
import type { EventBus } from '../../platform/events';
import {
  createAuth,
  deriveAuthSecret,
  type Auth,
  type AuthDependencies,
  type GithubFetch,
} from './better-auth';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const BASE = 'https://purlay.example.com';
const log = createLogger({ level: 'silent' });
const db = integrationDatabase();

/**
 * The library's hourly limits are kept in this committed database, and under test every request comes
 * from one address, so a run's sign-ins counted against the next run's: three GitHub sign-ins in ten
 * seconds and the fourth was refused. Each test starts and ends with none counted.
 */
const forgetLimits = async (): Promise<void> => {
  await sql`delete from rate_limits`.execute(db);
};
beforeEach(forgetLimits);

const made: string[] = [];
afterEach(async () => {
  await forgetLimits();
  while (made.length > 0) {
    const email = made.pop();
    if (email !== undefined) await sql`delete from users where email = ${email}`.execute(db);
  }
  await sql`delete from verifications where identifier like 'ba-test-%'`.execute(db);
});

/** A bus nobody hears on; what is published to it is `better-auth`'s session tests' business. */
const nobodyListening: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => true,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

const unique = (): string => crypto.randomUUID().slice(0, 8);

const authWith = (over: Partial<AuthDependencies> = {}): Auth =>
  createAuth({
    database: db,
    baseUrl: BASE,
    secret: deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY),
    mailer: outbox(() => Promise.resolve(), log),
    log,
    settings: {
      github: { clientId: 'client', clientSecret: 'secret' },
      oidc: undefined,
      signUp: 'open',
    },
    githubUrls: { web: GITHUB_URL_DEFAULT, api: GITHUB_API_URL_DEFAULT },
    sessionTtlDays: 30,
    bus: nobodyListening,
    clock: systemClock,
    ...over,
  });

describe('integration: Better Auth on the migrated schema', () => {
  test("passes the library's own schema check with the mapping createAuth makes", async () => {
    // Asked of a fresh instance (`schemaProblem`); the serving one does not ask it of itself.
    const auth = authWith();
    expect(await auth.schemaProblem()).toBeUndefined();
    expect((await auth.$context).checkSchema).toBeUndefined();
    const response = await auth.handler(new Request(`${BASE}/auth/ok`));
    expect(response.status).toBe(200);
  });

  test('...and that check does fail on a schema that is not the one the mapping names', async () => {
    // The same database, with no mapping: the library looks for `user`, `account` and the rest.
    const unmapped = betterAuth({
      baseURL: BASE,
      secret: deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY),
      telemetry: { enabled: false },
      logger: { disabled: true },
      database: { db, type: 'postgres' },
    });
    const context = await unmapped.$context;
    const verdict = await (context.checkSchema?.() ?? Promise.resolve()).then(
      () => 'passed',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(verdict).toMatch(/Missing tables[\s\S]*user/);
  });

  test('answers no route that would let a signed-in client write a username', async () => {
    const response = await authWith().handler(
      new Request(`${BASE}/auth/update-user`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ username: 'taken-over' }),
      }),
    );
    expect(response.status).toBe(404);
  });

  test('writes a session through the mapped columns and reads it back, an empty address as null', async () => {
    const auth = authWith();
    const context = await auth.$context;
    const email = `ba-session-${unique()}@example.test`;
    made.push(email);
    const user = await context.internalAdapter.createUser(
      { email, name: '', emailVerified: true },
      { method: 'email-password' },
    );
    const session = await context.internalAdapter.createSession(user.id);
    expect(session.userId).toBe(user.id);

    const { rows } = await sql<{
      user_id: string;
      token_hash: string;
      ip_address: string | null;
      user_agent: string | null;
      revoked_at: Date | null;
    }>`select user_id, token_hash, ip_address, user_agent, revoked_at
       from sessions where id = ${session.id}`.execute(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: user.id, ip_address: null, revoked_at: null });
    // The library holds the raw token; the column holds only its digest (D-11, D-179 §3).
    expect(rows[0]?.token_hash).toBe(sessionTokenDigest(session.token));
    expect(rows[0]?.token_hash).not.toBe(session.token);

    const found = await context.internalAdapter.findSession(session.token);
    expect(found?.user.id).toBe(user.id);
    expect(found?.session.id).toBe(session.id);
  });

  test('makes a user without a name or username one of each, and verified only when told', async () => {
    const context = await authWith().$context;
    const email = `ba-bare-${unique()}@example.test`;
    made.push(email);
    const user = await context.internalAdapter.createUser(
      { email, name: '' },
      { method: 'email-password' },
    );
    const { rows } = await sql<{
      username: string;
      display_name: string;
      email_verified: boolean;
      is_server_admin: boolean;
    }>`select username, display_name, email_verified, is_server_admin
       from users where id = ${user.id}`.execute(db);
    expect(rows[0]?.display_name).toBe(email.split('@')[0] ?? '');
    expect(rows[0]?.username).not.toBe('');
    expect(rows[0]).toMatchObject({ email_verified: false, is_server_admin: false });
  });
});

describe('integration: signing in with GitHub, through the real callback', () => {
  const login = `Ada-${unique()}`;
  const githubId = Math.floor(Math.random() * 1_000_000_000);
  const email = `ba-github-${unique()}@example.test`;
  const reply = (body: unknown): Response => Response.json(body);

  // Every call a sign-in makes to GitHub — the token too — goes through the `fetch` handed over.
  const github: GithubFetch = (url) =>
    Promise.resolve(
      url === 'https://github.com/login/oauth/access_token'
        ? reply({
            access_token: 'gho_never_stored',
            refresh_token: 'ghr_never_stored',
            token_type: 'bearer',
            scope: 'read:user,user:email',
          })
        : url.endsWith('/emails')
          ? reply([{ email, primary: true, verified: true }])
          : reply({
              id: githubId,
              login,
              name: 'Ada Lovelace',
              avatar_url: 'https://a.example/ada',
            }),
    );

  test('makes the user and the account, with the username, name and verified address, and no token', async () => {
    made.push(email);
    const auth = authWith({ fetch: github });

    const start = await auth.handler(
      new Request(`${BASE}/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ provider: 'github', callbackURL: '/' }),
      }),
    );
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get('state');
    expect(state).not.toBeNull();
    const cookies = start.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0] ?? '')
      .join('; ');

    const callback = await auth.handler(
      new Request(`${BASE}/auth/callback/github?code=abc&state=${state ?? ''}`, {
        headers: { cookie: cookies },
      }),
    );
    // A redirect to the page, with the session cookie set; an error redirect carries `?error=`.
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location') ?? '').not.toContain('error=');
    expect(callback.headers.getSetCookie().join('\n')).toContain('__Host-purlay_session=');

    const { rows: users } = await sql<{
      id: string;
      username: string;
      display_name: string;
      avatar_url: string | null;
      email_verified: boolean;
    }>`select id, username, display_name, avatar_url, email_verified
       from users where email = ${email}`.execute(db);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      display_name: 'Ada Lovelace',
      avatar_url: 'https://a.example/ada',
      email_verified: true,
    });
    // The login, shaped as a mention can name it (R23).
    expect(users[0]?.username).toBe(login.toLowerCase());

    const { rows: accounts } = await sql<{
      provider_id: string;
      account_id: string;
      access_token: string | null;
      refresh_token: string | null;
      id_token: string | null;
    }>`select provider_id, account_id, access_token, refresh_token, id_token
       from accounts where user_id = ${users[0]?.id ?? ''}`.execute(db);
    expect(accounts).toEqual([
      {
        provider_id: 'github',
        account_id: String(githubId),
        access_token: null,
        refresh_token: null,
        id_token: null,
      },
    ]);

    const { rows: sessions } = await sql<{ n: number }>`
      select count(*)::int as n from sessions where user_id = ${users[0]?.id ?? ''}`.execute(db);
    expect(sessions[0]?.n).toBe(1);
  });
});

describe('integration: no username is stored as a client sent it (R23)', () => {
  /** What the user hook makes of an asked-for username, for an address of its own. */
  const usernameFor = async (asked: unknown, local = `ba-r23-${unique()}`): Promise<string> => {
    const hook = authWith().options.databaseHooks?.user?.create?.before;
    const email = `${local}@example.test`;
    const result = await hook?.(
      { email, name: '', ...(asked === undefined ? {} : { username: asked }) } as never,
      null,
    );
    return String((result as { data: Record<string, unknown> }).data['username']);
  };

  test('shapes every username into what a mention can name, at most 39 characters', async () => {
    expect(await usernameFor('Ada.Lovelace!!')).toBe('ada-lovelace');
    expect((await usernameFor('x'.repeat(60))).length).toBeLessThanOrEqual(39);
    expect(await usernameFor('x'.repeat(60))).toMatch(/^[a-z0-9-]+$/);
  });

  test('a name with nothing left, or a broadcast name, is the address’s instead', async () => {
    const local = `ba-local-${unique()}`;
    expect(await usernameFor('+++', local)).toBe(local);
    expect(await usernameFor('here', local)).toBe(local);
    expect(await usernameFor(42, local)).toBe(local);
  });

  test('another person’s username is never taken: the first free one is', async () => {
    const holder = `ba-holder-${unique()}`;
    const email = `${holder}@example.test`;
    made.push(email);
    await sql`insert into users (email, username, display_name) values (${email}, ${holder}, 'H')`.execute(
      db,
    );
    expect(await usernameFor(holder)).toBe(`${holder}-1`);
    expect(await usernameFor(holder.toUpperCase())).toBe(`${holder}-1`);
  });

  test('a living account is never named like an erased one (D-139 §5)', async () => {
    expect(await usernameFor(`deleted-user-${unique()}`)).toMatch(/^user-deleted-user-/);
  });
});

describe('integration: a session the library ends is told to its sockets (D-85)', () => {
  /** A bus that keeps what was published to it. */
  const aRecordingBus = (): EventBus & { readonly ended: string[] } => {
    const ended: string[] = [];
    return {
      ended,
      publish: (topic, frame): Promise<void> => {
        if (frame.event === 'SESSION_ENDED') ended.push(topic);
        return Promise.resolve();
      },
      subscribe: () => true,
      unsubscribe: () => undefined,
      forget: () => undefined,
    };
  };

  /** A person with a password, and two sessions the library knows. */
  const aPersonWithTwoSessions = async (
    auth: Auth,
  ): Promise<{ userId: string; here: string; there: { id: string; token: string } }> => {
    const context = await auth.$context;
    const email = `ba-ended-${unique()}@example.test`;
    made.push(email);
    const user = await context.internalAdapter.createUser(
      { email, name: '', emailVerified: true },
      { method: 'email-password' },
    );
    await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: await context.password.hash('the old password'),
    });
    const here = await context.internalAdapter.createSession(user.id);
    const there = await context.internalAdapter.createSession(user.id);
    const signed = await makeSignature(here.token, deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY));
    return {
      userId: user.id,
      here: `__Host-purlay_session=${encodeURIComponent(`${here.token}.${signed}`)}`,
      there: { id: there.id, token: there.token },
    };
  };

  const post = async (
    auth: Auth,
    path: string,
    cookie: string,
    body: unknown = {},
  ): Promise<Response> =>
    await auth.handler(
      new Request(`${BASE}/auth${path}`, {
        method: 'POST',
        headers: { cookie, origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  test('revoking every session announces each one, after it is gone', async () => {
    const bus = aRecordingBus();
    const auth = authWith({ bus });
    const person = await aPersonWithTwoSessions(auth);
    expect((await post(auth, '/revoke-sessions', person.here)).status).toBe(200);
    // Each told — by the library's hook and again by the watch over the route; a socket hears the
    // first and is gone (the hub ends a socket once).
    expect(new Set(bus.ended).size).toBe(2);
    expect(bus.ended).toContain(`session:${person.there.id}`);
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from sessions where user_id = ${person.userId}`.execute(db);
    expect(rows[0]?.n).toBe(0);
  });

  test('a session ended by a call of the library’s, outside any request, is announced by its hook', async () => {
    const bus = aRecordingBus();
    const auth = authWith({ bus });
    const person = await aPersonWithTwoSessions(auth);
    await auth.api.signOut({ headers: new Headers({ cookie: person.here }) });
    expect(bus.ended).toHaveLength(1);
    expect(bus.ended).not.toContain(`session:${person.there.id}`);
  });

  test('our revoke-other-sessions announces what it ended, outside any request too', async () => {
    const bus = aRecordingBus();
    const auth = authWith({ bus });
    const person = await aPersonWithTwoSessions(auth);
    await auth.api.revokeOtherSessions({ headers: new Headers({ cookie: person.here }) });
    expect(bus.ended).toEqual([`session:${person.there.id}`]);
  });

  test('the watch over a route reads the person’s sessions by person, never by a list of ids', async () => {
    const watched: string[] = [];
    const bus = aRecordingBus();
    const auth = authWith({
      bus,
      database: db.withPlugin({
        transformQuery: (
          args,
        ): ReturnType<Parameters<Executor['withPlugin']>[0]['transformQuery']> => {
          const text = JSON.stringify(args.node);
          if (text.includes('"sessions_ended"')) watched.push(text);
          return args.node;
        },
        transformResult: async (args) => await Promise.resolve(args.result),
      }),
    });
    const person = await aPersonWithTwoSessions(auth);
    expect((await post(auth, '/revoke-sessions', person.here)).status).toBe(200);
    // Before and after, and how many of each is the watch's whole cost.
    expect(watched.filter((text) => text.includes('"user_id"')).length).toBeGreaterThanOrEqual(2);
    expect(watched.some((text) => text.includes('"operator":"in"'))).toBe(false);
    expect(new Set(bus.ended).size).toBe(2);
  });

  /** The watch's own reads fail from the n-th on (counted from one). */
  const watchFailingFrom = (n: number): Parameters<Executor['withPlugin']>[0] => {
    let reads = 0;
    return {
      transformQuery: (
        args,
      ): ReturnType<Parameters<Executor['withPlugin']>[0]['transformQuery']> => {
        if (
          JSON.stringify(args.node).includes('"sessions_ended"') &&
          args.node.kind === 'SelectQueryNode'
        ) {
          reads += 1;
          if (reads >= n) throw new Error('the watch read failed');
        }
        return args.node;
      },
      transformResult: async (args) => await Promise.resolve(args.result),
    };
  };

  test('a sign-out whose first read of ours fails still signs out, and says so', async () => {
    const lines: string[] = [];
    const auth = authWith({
      database: db.withPlugin(watchFailingFrom(1)),
      log: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    });
    const person = await aPersonWithTwoSessions(auth);
    const out = await post(auth, '/sign-out', person.here);
    expect(out.status).toBe(200);
    expect(lines.join('\n')).toContain('the sessions a sign-out ends could not be read first');
  });

  test('a sign-out everywhere whose read after fails still answers, and says what it could not tell', async () => {
    const lines: string[] = [];
    const auth = authWith({
      database: db.withPlugin(watchFailingFrom(3)),
      log: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    });
    const person = await aPersonWithTwoSessions(auth);
    expect((await post(auth, '/revoke-sessions', person.here)).status).toBe(200);
    expect(lines.join('\n')).toContain('the sessions a request ended could not all be told');
  });

  test('a cookie that does not decode names nobody, quietly: no failure is written for it', async () => {
    const lines: string[] = [];
    const auth = authWith({
      log: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    });
    const out = await post(auth, '/sign-out', '__Host-purlay_session=%E0%A4%A');
    expect(out.status).toBe(200);
    expect(lines.join('\n')).not.toContain('could not be read first');
  });

  test('a session whose announcement fails does not keep the others from being told', async () => {
    const told: string[] = [];
    let first = true;
    const lines: string[] = [];
    const auth = authWith({
      bus: {
        ...aRecordingBus(),
        publish: (topic, frame): Promise<void> => {
          if (frame.event !== 'SESSION_ENDED') return Promise.resolve();
          if (first) {
            first = false;
            return Promise.reject(new Error('the bus refused this one'));
          }
          told.push(topic);
          return Promise.resolve();
        },
      },
      log: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    });
    const person = await aPersonWithTwoSessions(auth);
    await (await auth.$context).internalAdapter.createSession(person.userId);
    // Our endpoint ends the two others in one go and announces them together.
    await auth.api.revokeOtherSessions({ headers: new Headers({ cookie: person.here }) });
    // The first announcement refused: the second was still told.
    expect(told).toHaveLength(1);
    expect(lines.join('\n')).toContain('publish failed after commit');
  });

  test('a change of password whose step that ends the others fails announces nothing, and says so', async () => {
    // A clone of its own: a trigger on `sessions` must not be seen by any other test.
    const clone = await cloneIntegrationDatabase();
    try {
      const bus = aRecordingBus();
      const lines: string[] = [];
      const auth = authWith({
        bus,
        database: clone.db,
        log: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
      });
      const person = await aPersonWithTwoSessions(auth);
      await sql`create function refuse_delete_here() returns trigger language plpgsql as $$ begin raise exception 'frozen for this test'; end $$`.execute(
        clone.db,
      );
      await sql`create trigger refuse_delete_here before delete on sessions for each row execute function refuse_delete_here()`.execute(
        clone.db,
      );
      const changed = await post(auth, '/change-password', person.here, {
        currentPassword: 'the old password',
        newPassword: 'a new password, long enough',
      });
      expect(changed.status).toBe(500);
      expect(await changed.json()).toMatchObject({ code: 'OTHER_SESSIONS_NOT_ENDED' });
      expect(lines.join('\n')).toContain(
        'the password changed but the other sessions could not be ended',
      );
      expect(bus.ended).toEqual([]);
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from sessions where user_id = ${person.userId}`.execute(clone.db);
      expect(rows[0]?.n).toBe(2);
    } finally {
      await clone.drop();
    }
  });

  test('a publish that fails is written down and does not fail what already happened', async () => {
    const lines: string[] = [];
    const auth = authWith({
      bus: { ...aRecordingBus(), publish: () => Promise.reject(new Error('the bus is down')) },
      log: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
    });
    const person = await aPersonWithTwoSessions(auth);
    expect((await post(auth, '/sign-out', person.here)).status).toBe(200);
    expect(lines.join('\n')).toContain('publish failed after commit');
  });
});

describe('integration: the schema check is a verdict on the database as it is now (D-179)', () => {
  test('answers the reason on a schema that drifted, and nothing once it is put right', async () => {
    const drifted = await cloneIntegrationDatabase();
    try {
      await sql`alter table accounts rename column scope to scope_was`.execute(drifted.db);
      const auth = authWith({ database: drifted.db });
      expect(await auth.schemaProblem()).toContain('scope');
      // Put right while the process runs — a migration on start that finished after the instance
      // was built: the verdict follows the database, never the first answer it gave. A mismatch is
      // kept for a few seconds before it is looked at again, so a fresh instance shows it at once.
      await sql`alter table accounts rename column scope_was to scope`.execute(drifted.db);
      expect(await auth.schemaProblem()).toContain('scope');
      expect(await authWith({ database: drifted.db }).schemaProblem()).toBeUndefined();
      // And the same instance, once that while has passed, looks again and finds it right.
      setSystemTime(new Date(Date.now() + 11_000));
      try {
        expect(await auth.schemaProblem()).toBeUndefined();
      } finally {
        setSystemTime();
      }
      // And the serving instance was never refusing sign-ins over it meanwhile.
      expect((await auth.handler(new Request(`${BASE}/auth/ok`))).status).toBe(200);
    } finally {
      await drifted.drop();
    }
  });

  test('is not asked inside a rolled-back transaction, which it cannot read', async () => {
    expect(await authWith({ checkSchema: false }).schemaProblem()).toBeUndefined();
  });
});
