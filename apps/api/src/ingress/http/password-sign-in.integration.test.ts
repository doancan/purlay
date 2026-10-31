/**
 * The sign-in library's password routes, through the mounted `/auth/*` (D-179 §4): the one account with
 * a password — the setup's administrator — signs in with it, its address unverified; nobody can tell an
 * address with an account from one without, by the answer or by its time; wrong guesses are throttled
 * by address and client without ever locking the account; a change of password is held to the policy,
 * ends the other sessions, and counts its wrong guesses with the sign-in's.
 *
 * On a database of its own: the library commits through its own connection, and the counters are
 * committed rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { hashPassword } from 'better-auth/crypto';
import {
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
} from '@purlay/db';
import { createApp, type HttpApplication } from './app';
import { JSON_BODY_MAX_BYTES } from './edge';
import { SESSION_COOKIE } from '../../platform/cookies';
import type { Clock } from '../../platform/clock';
import { testConfig, testDependencies } from '../../testing/doubles';
import { aTestAuth } from '../../testing/signed-in';
import { aUserRow, type TestUser } from '../../testing/users';
import { sessionFromHeaders } from '../../modules/auth/sessions';
import type { Auth } from '../../modules/auth/better-auth';
import {
  PASSWORD_FAILURE_WINDOW_MS,
  PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT,
  PASSWORD_FAILURES_PER_CLIENT,
} from '../../modules/auth/password-attempts';

const ORIGIN = 'https://purlay.test';
const PASSWORD = 'analytical engine 1843';

let cloned: ClonedDatabase;
let db: Executor;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
});

beforeEach(async () => {
  await sql`delete from rate_limits`.execute(db);
});

/** The wall clock, moved forward by the test: the throttle's windows are read from it. */
const movable = (): Clock & { advance: (ms: number) => void } => {
  let offset = 0;
  return {
    now: () => new Date(Date.now() + offset),
    advance: (ms): void => {
      offset += ms;
    },
  };
};

interface Server {
  readonly app: HttpApplication;
  readonly auth: Auth;
  readonly clock: ReturnType<typeof movable>;
}

const aServer = (): Server => {
  const clock = movable();
  const auth = aTestAuth(db, { baseUrl: ORIGIN, clock });
  // Behind a proxy, so each test names the client a request comes from (`X-Forwarded-For`).
  const config = testConfig({ APP_URL: ORIGIN, TRUST_PROXY: true });
  return { app: createApp(testDependencies({ database: db, config, auth })), auth, clock };
};

/** An account with a password — the setup's administrator's kind: made by setup, its address unverified. */
const aPasswordAccount = async (name = 'admin', password = PASSWORD): Promise<TestUser> => {
  const user = await aUserRow(db, name);
  await db
    .insertInto('accounts')
    .values({
      user_id: user.userId,
      provider_id: 'credential',
      account_id: user.userId,
      password: await hashPassword(password),
    })
    .execute();
  return user;
};

let clientCounter = 0;
/** A client address no other request of the run has come from. */
const aClient = (): string => {
  clientCounter += 1;
  return `198.51.${String(Math.floor(clientCounter / 250))}.${String((clientCounter % 250) + 1)}`;
};

const post = async (
  server: Server,
  path: string,
  body: unknown,
  { client, cookie }: { readonly client: string; readonly cookie?: string },
): Promise<Response> => {
  const text = JSON.stringify(body);
  return await server.app.handle(
    new Request(`${ORIGIN}/auth${path}`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(text)),
        'x-forwarded-for': client,
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: text,
    }),
  );
};

const signIn = async (
  server: Server,
  email: string,
  password: string,
  client: string,
): Promise<Response> => await post(server, '/sign-in/email', { email, password }, { client });

const sessionCookieOf = (response: Response): string | undefined =>
  response.headers
    .getSetCookie()
    .find(
      (line) => line.startsWith(`${SESSION_COOKIE}=`) && !line.startsWith(`${SESSION_COOKIE}=;`),
    )
    ?.split(';')[0];

const codeOf = async (response: Response): Promise<unknown> =>
  ((await response.clone().json()) as { code?: unknown }).code;

/** The headers of an answer, minus the ones that differ on every request whoever asks. */
const comparableHeaders = (response: Response): [string, string][] =>
  [...response.headers.entries()]
    .filter(([name]) => name !== 'x-request-id' && name !== 'date')
    .sort(([a], [b]) => a.localeCompare(b));

describe('integration: signing in with a password (D-179 §4)', () => {
  test('the administrator’s unverified account signs in with its password, and the session is real', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const answered = await signIn(server, admin.email, PASSWORD, aClient());
    expect(answered.status).toBe(200);
    const cookie = sessionCookieOf(answered);
    expect(cookie).toBeDefined();
    const owner = await sessionFromHeaders(server.auth, new Headers({ cookie: cookie ?? '' }));
    expect(owner?.userId).toBe(admin.userId);
  });

  test('nobody makes a password account over HTTP, and no reset can be asked for', async () => {
    const server = aServer();
    const signUp = await post(
      server,
      '/sign-up/email',
      { email: 'new@example.com', password: PASSWORD, name: 'New' },
      { client: aClient() },
    );
    expect(signUp.status).toBe(400);
    expect(await codeOf(signUp)).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED');
    const reset = await post(
      server,
      '/request-password-reset',
      { email: 'new@example.com' },
      { client: aClient() },
    );
    expect(reset.status).toBe(404);
  });

  test('an unknown address and a wrong password are answered alike: status, body and headers', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const unknown = await signIn(server, 'nobody-here@example.com', 'some password 123', aClient());
    const wrong = await signIn(server, admin.email, 'some password 123', aClient());
    // An account with no password (made by GitHub or a link) is answered alike too.
    const noPassword = await aUserRow(db, 'linkonly');
    const passwordless = await signIn(server, noPassword.email, 'some password 123', aClient());
    for (const answered of [wrong, passwordless]) {
      expect(answered.status).toBe(unknown.status);
      expect(await answered.text()).toBe(await unknown.clone().text());
      expect(comparableHeaders(answered)).toEqual(comparableHeaders(unknown));
    }
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({
      code: 'INVALID_EMAIL_OR_PASSWORD',
      message: 'Invalid email or password',
    });
  });

  // Every sample is a real password hash, 35 ms on a laptop and more on a CI runner: 122 of them took 4.3 s
  // here, against the 5 s a test is given unless it says otherwise, so on the runner it timed out, and its
  // loop went on writing to `rate_limits` under the test after it. The budget is the work, at up to
  // eight times the laptop's hash.
  const SAMPLES = 60;
  const TIMING_BUDGET_MS = (SAMPLES * 2 + 2) * 280;

  test(
    '...and take the same time: the hash is done for an unknown address too',
    async () => {
      const server = aServer();
      const admin = await aPasswordAccount();
      const known: number[] = [];
      const unknown: number[] = [];
      const time = async (email: string): Promise<number> => {
        const started = performance.now();
        const answered = await signIn(server, email, 'some password 123', aClient());
        const took = performance.now() - started;
        expect(answered.status).toBe(401);
        return took;
      };
      // Warmed, then interleaved, so a drift of the machine falls on both alike.
      await time(admin.email);
      await time('warm@example.com');
      for (let n = 0; n < SAMPLES; n += 1) {
        known.push(await time(admin.email));
        unknown.push(await time(`nobody-${String(n)}@example.com`));
      }
      const median = (values: number[]): number => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)] ?? 0;
      };
      const ratio = median(unknown) / median(known);
      console.info(
        `password sign-in timing, ${String(SAMPLES)} samples each: known-wrong median ${median(known).toFixed(2)} ms, unknown median ${median(unknown).toFixed(2)} ms, ratio ${ratio.toFixed(3)}`,
      );
      // Without the hash an unknown address answers in a small fraction of a known one's time.
      expect(ratio).toBeGreaterThan(0.75);
      expect(ratio).toBeLessThan(1.33);
    },
    TIMING_BUDGET_MS,
  );

  test('a password over the limit is refused before it is hashed or counted', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const client = aClient();
    const tooLong = 'x'.repeat(129);
    const median = async (password: string): Promise<number> => {
      const took: number[] = [];
      for (let n = 0; n < 15; n += 1) {
        const started = performance.now();
        const answered = await signIn(server, admin.email, password, client);
        took.push(performance.now() - started);
        if (password === tooLong) {
          expect(answered.status).toBe(400);
          expect(await codeOf(answered)).toBe('PASSWORD_TOO_LONG');
        }
      }
      return [...took].sort((a, b) => a - b)[7] ?? 0;
    };
    const refused = await median(tooLong);
    // Nothing counted for any of them: the eleventh wrong guess would otherwise be refused.
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from rate_limits`.execute(
      db,
    );
    expect(rows[0]?.n).toBe(0);
    await sql`delete from rate_limits`.execute(db);
    const weighed = await median('a wrong password 1');
    expect(refused).toBeLessThan(weighed / 3);
  });

  test('a body past the edge’s bound is refused before it is read', async () => {
    const server = aServer();
    const answered = await server.app.handle(
      new Request(`${ORIGIN}/auth/sign-in/email`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'content-type': 'application/json',
          'content-length': String(JSON_BODY_MAX_BYTES + 1),
        },
        body: 'x'.repeat(JSON_BODY_MAX_BYTES + 1),
      }),
    );
    expect(answered.status).toBe(413);
  });
});

describe('integration: the throttle on wrong passwords is not a lockout (D-179 §4)', () => {
  test('ten wrong for an address from a client, then 429 with Retry-After — the right password included', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const guesser = aClient();
    for (let n = 0; n < PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT; n += 1) {
      expect((await signIn(server, admin.email, `guess number ${String(n)}`, guesser)).status).toBe(
        401,
      );
    }
    for (const password of ['guess number past', PASSWORD]) {
      const refused = await signIn(server, admin.email, password, guesser);
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({
        code: 'RATE_LIMITED',
        message: 'Too many wrong passwords. Wait, then try again.',
      });
      const wait = Number(refused.headers.get('retry-after'));
      expect(wait).toBeGreaterThan(PASSWORD_FAILURE_WINDOW_MS / 1000 - 60);
      expect(wait).toBeLessThanOrEqual(PASSWORD_FAILURE_WINDOW_MS / 1000);
      expect(sessionCookieOf(refused)).toBeUndefined();
    }
  });

  test('strangers’ wrong guesses from other clients never keep the administrator out', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    for (const stranger of [aClient(), aClient(), aClient()]) {
      for (let n = 0; n <= PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT; n += 1) {
        await signIn(server, admin.email, `guess number ${String(n)}`, stranger);
      }
      expect((await signIn(server, admin.email, 'one more', stranger)).status).toBe(429);
    }
    const answered = await signIn(server, admin.email, PASSWORD, aClient());
    expect(answered.status).toBe(200);
    expect(sessionCookieOf(answered)).toBeDefined();
  });

  test('twenty wrong from a client across addresses, then 429 for any address', async () => {
    const server = aServer();
    const client = aClient();
    for (let n = 0; n < PASSWORD_FAILURES_PER_CLIENT; n += 1) {
      expect(
        (await signIn(server, `someone-${String(n)}@example.com`, 'a wrong one 123', client))
          .status,
      ).toBe(401);
    }
    const refused = await signIn(server, 'someone-else@example.com', 'a wrong one 123', client);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).not.toBeNull();
  });

  test('a sign-in that works spends nothing: nine wrong, the right one, and the tenth wrong is still weighed', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const client = aClient();
    for (let n = 0; n < PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT - 1; n += 1) {
      await signIn(server, admin.email, `guess number ${String(n)}`, client);
    }
    expect((await signIn(server, admin.email, PASSWORD, client)).status).toBe(200);
    expect((await signIn(server, admin.email, 'the tenth wrong', client)).status).toBe(401);
    expect((await signIn(server, admin.email, 'the eleventh wrong', client)).status).toBe(429);
  });

  test('signing in again and again is never throttled by our count, nor by the library’s own rule', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const client = aClient();
    // The library's rule for /sign-in would refuse the fourth in ten seconds; ours counts no success.
    for (let n = 0; n < PASSWORD_FAILURES_PER_CLIENT + 5; n += 1) {
      expect((await signIn(server, admin.email, PASSWORD, client)).status).toBe(200);
    }
  });

  test('the window passes: fifteen minutes on, the guesser is weighed again', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const client = aClient();
    for (let n = 0; n < PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT; n += 1) {
      await signIn(server, admin.email, `guess number ${String(n)}`, client);
    }
    expect((await signIn(server, admin.email, PASSWORD, client)).status).toBe(429);
    server.clock.advance(PASSWORD_FAILURE_WINDOW_MS + 1000);
    expect((await signIn(server, admin.email, PASSWORD, client)).status).toBe(200);
  });
});

describe('integration: changing the password (D-179 §4)', () => {
  const signedIn = async (server: Server, admin: TestUser, client: string): Promise<string> => {
    const answered = await signIn(server, admin.email, PASSWORD, client);
    expect(answered.status).toBe(200);
    return sessionCookieOf(answered) ?? '';
  };

  test('works with the current password, ends every other session though the client did not ask, and the new one signs in', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const elsewhere = await signedIn(server, admin, aClient());
    const here = await signedIn(server, admin, aClient());
    const changed = await post(
      server,
      '/change-password',
      { currentPassword: PASSWORD, newPassword: 'a brand new passphrase' },
      { client: aClient(), cookie: here },
    );
    expect(changed.status).toBe(200);
    expect(
      await sessionFromHeaders(server.auth, new Headers({ cookie: elsewhere })),
    ).toBeUndefined();
    // No new session: this device keeps the one it had.
    expect(sessionCookieOf(changed)).toBeUndefined();
    expect((await sessionFromHeaders(server.auth, new Headers({ cookie: here })))?.userId).toBe(
      admin.userId,
    );
    expect((await signIn(server, admin.email, 'a brand new passphrase', aClient())).status).toBe(
      200,
    );
    expect((await signIn(server, admin.email, PASSWORD, aClient())).status).toBe(401);
  });

  test('a new password the policy refuses is a typed 400 saying why, and nothing changes', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const here = await signedIn(server, admin, aClient());
    // The display name is `admin`; the address is `admin-…@example.test`.
    const cases: readonly (readonly [string, string, string | undefined])[] = [
      ['password123', 'PASSWORD_TOO_WEAK', 'common'],
      [`${admin.email}-x`, 'PASSWORD_TOO_WEAK', 'contains-email'],
      ['my name is admin, hi', 'PASSWORD_TOO_WEAK', 'contains-name'],
      ['short one', 'PASSWORD_TOO_SHORT', undefined],
      ['x'.repeat(129), 'PASSWORD_TOO_LONG', undefined],
    ];
    for (const [newPassword, code, reason] of cases) {
      const refused = await post(
        server,
        '/change-password',
        { currentPassword: PASSWORD, newPassword },
        { client: aClient(), cookie: here },
      );
      expect(refused.status).toBe(400);
      const body = (await refused.json()) as { code?: unknown; reason?: unknown };
      expect(body.code).toBe(code);
      if (reason !== undefined) expect(body.reason).toBe(reason);
      // Nothing about the current password is said: the policy is weighed before it.
      expect(JSON.stringify(body)).not.toContain(PASSWORD);
    }
    expect((await signIn(server, admin.email, PASSWORD, aClient())).status).toBe(200);
  });

  test('a wrong current password is one answer, and counts toward the same throttle as signing in', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const client = aClient();
    const here = await signedIn(server, admin, client);
    for (let n = 0; n < PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT - 1; n += 1) {
      const wrong = await post(
        server,
        '/change-password',
        { currentPassword: `not it ${String(n)} at all`, newPassword: 'a brand new passphrase' },
        { client, cookie: here },
      );
      expect(wrong.status).toBe(400);
      expect(await wrong.json()).toEqual({ code: 'INVALID_PASSWORD', message: 'Invalid password' });
    }
    // The tenth wrong guess is a sign-in's, from the same client, for the same address.
    expect((await signIn(server, admin.email, 'the tenth wrong', client)).status).toBe(401);
    const refused = await post(
      server,
      '/change-password',
      { currentPassword: PASSWORD, newPassword: 'a brand new passphrase' },
      { client, cookie: here },
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).not.toBeNull();
  });

  test('a reset — reachable only with a token the server wrote — is held to the same policy', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const token = `reset-${crypto.randomUUID()}`;
    await (
      await server.auth.$context
    ).internalAdapter.createVerificationValue({
      identifier: `reset-password:${token}`,
      value: admin.userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const refused = await post(
      server,
      '/reset-password',
      { token, newPassword: 'qwertyuiop' },
      { client: aClient() },
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: 'PASSWORD_TOO_WEAK', reason: 'common' });
    // The token is not spent by a refusal: a good password still takes it.
    const reset = await post(
      server,
      '/reset-password',
      { token, newPassword: 'a sound new passphrase' },
      { client: aClient() },
    );
    expect(reset.status).toBe(200);
  });
});

describe('integration: the throttle counts a network, not a host (D-179 §4)', () => {
  test('hosts inside one IPv6 /64 share the address’s budget: the eleventh rotated host is refused', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const statuses: number[] = [];
    for (let host = 1; host <= 25; host += 1) {
      statuses.push(
        (
          await signIn(
            server,
            admin.email,
            'a wrong password',
            `2001:db8:1:2::${host.toString(16)}`,
          )
        ).status,
      );
    }
    expect(statuses.slice(0, PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT)).toEqual(
      Array<number>(PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT).fill(401),
    );
    expect(statuses.slice(PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT)).toEqual(
      Array<number>(25 - PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT).fill(429),
    );
    // Another /64 is another network; the administrator's own signs in.
    expect((await signIn(server, admin.email, PASSWORD, '2001:db8:1:3::1')).status).toBe(200);
  });

  test('hosts inside one /64 share the client’s budget across addresses: the twenty-first is refused', async () => {
    const server = aServer();
    const statuses: number[] = [];
    for (let host = 1; host <= 25; host += 1) {
      statuses.push(
        (
          await signIn(
            server,
            `someone-${String(host)}@example.com`,
            'a wrong password',
            `2001:db8:9:9:${host.toString(16)}::1`,
          )
        ).status,
      );
    }
    expect(statuses.filter((status) => status === 401)).toHaveLength(PASSWORD_FAILURES_PER_CLIENT);
    expect(statuses.slice(PASSWORD_FAILURES_PER_CLIENT)).toEqual(
      Array<number>(25 - PASSWORD_FAILURES_PER_CLIENT).fill(429),
    );
  });

  test('IPv4 hosts are their own networks, and an IPv4-mapped address is the IPv4 one', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    for (let n = 0; n < PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT; n += 1) {
      await signIn(server, admin.email, 'a wrong password', '192.0.2.77');
    }
    expect((await signIn(server, admin.email, PASSWORD, '::ffff:192.0.2.77')).status).toBe(429);
    expect((await signIn(server, admin.email, PASSWORD, '192.0.2.78')).status).toBe(200);
  });

  test('the address is counted in any case: a case-varied address after ten wrong is still refused', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const client = aClient();
    for (let n = 0; n < PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT; n += 1) {
      await signIn(server, admin.email, `guess number ${String(n)}`, client);
    }
    expect((await signIn(server, admin.email.toUpperCase(), PASSWORD, client)).status).toBe(429);
  });

  test('fifty wrong passwords at once from one client weigh exactly ten', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const client = aClient();
    const answers = await Promise.all(
      Array.from(
        { length: 50 },
        async () => await signIn(server, admin.email, 'a wrong one', client),
      ),
    );
    const statuses = answers.map((answer) => answer.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(
      PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT,
    );
    expect(statuses.filter((status) => status === 429)).toHaveLength(
      50 - PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT,
    );
  });
});

describe('integration: every route of the library that takes a password is closed or counted (D-179 §4)', () => {
  /**
   * Every endpoint of the library whose path or body names a password, and what it is here. A route a
   * library upgrade adds that takes one fails the first test until it is decided and listed.
   */
  const PASSWORD_ROUTES: Readonly<
    Record<string, 'counted' | 'closed' | 'policy' | 'no-password' | 'no-route'>
  > = {
    '/sign-in/email': 'counted',
    '/change-password': 'counted',
    // Weighed by a token no route issues; its new password is held to the policy.
    '/reset-password': 'policy',
    // Checks a token and redirects; takes no password.
    '/reset-password/:token': 'no-password',
    '/verify-password': 'closed',
    '/delete-user': 'closed',
    '/request-password-reset': 'closed',
    // Two-step verification (D-236): each weighs the session holder's password, counted as a change's is.
    '/two-factor/enable': 'counted',
    '/two-factor/disable': 'counted',
    '/two-factor/generate-backup-codes': 'counted',
    // The key is never read back.
    '/two-factor/get-totp-uri': 'closed',
    // The library's API alone, no route; nothing of ours calls it (`better-auth.test.ts`).
    'api:setPassword': 'no-route',
  };

  const passwordEndpoints = (auth: Auth): string[] =>
    Object.entries(auth.api).flatMap(([name, endpoint]) => {
      const { path, options } = endpoint as {
        readonly path?: string;
        readonly options?: { readonly body?: { readonly shape?: Record<string, unknown> } };
      };
      const fields = Object.keys(options?.body?.shape ?? {});
      const names = /password/i.test(path ?? '') || fields.some((field) => /password/i.test(field));
      return names ? [path ?? `api:${name}`] : [];
    });

  test('the library’s endpoint table holds no password route this list has not decided', () => {
    const found = passwordEndpoints(aServer().auth).toSorted();
    expect(found).toEqual(Object.keys(PASSWORD_ROUTES).toSorted());
  });

  test('each closed one is the API’s 404, signed in or not', async () => {
    const server = aServer();
    const admin = await aPasswordAccount();
    const signedIn = await signIn(server, admin.email, PASSWORD, aClient());
    const cookie = sessionCookieOf(signedIn) ?? '';
    const closed = Object.entries(PASSWORD_ROUTES)
      .filter(([, kind]) => kind === 'closed')
      .map(([path]) => path);
    for (const path of closed) {
      const answered = await post(
        server,
        path,
        { password: PASSWORD, email: admin.email },
        { client: aClient(), cookie },
      );
      // Closed by configuration, so the API's own 404 — never the library's answer, which for
      // `/delete-user` is a 404 of its own only while deleting is off.
      expect({ path, status: answered.status, body: await answered.json() }).toEqual({
        path,
        status: 404,
        body: { error: { code: 'ROUTE_NOT_FOUND', message: 'No such route.' } },
      });
    }
    // Twenty-five wrong passwords through the closed one weighed nothing, and the right one says nothing.
    const oracle = await post(
      server,
      '/verify-password',
      { password: PASSWORD },
      { client: aClient(), cookie },
    );
    expect(oracle.status).toBe(404);
  });

  test('a password sign-up is refused, as password sign-up is closed', async () => {
    const server = aServer();
    const answered = await post(
      server,
      '/sign-up/email',
      { email: 'someone-new@example.com', password: PASSWORD, name: 'New' },
      { client: aClient() },
    );
    expect(await codeOf(answered)).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED');
  });
});
