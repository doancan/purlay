/**
 * Two-step verification for an account with a password (D-236), through the mounted `/auth/*` and the real
 * sign-in library: turned on only by a right code from the app, after the password; then a sign-in asks for a
 * code once the password is right, and a backup code works once; wrong codes lock the step; turning it off and
 * new backup codes need the password, counted with the sign-in's guesses; the caller's session is never
 * replaced; a suspended or erased account gets no session through it; erasure takes the key.
 *
 * On a database of its own: the library commits through its own connection.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { hashPassword } from 'better-auth/crypto';
import {
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import {
  TWO_FACTOR_CHALLENGE_MINUTES,
  TWO_FACTOR_FAILURES_BEFORE_LOCK,
  type ServerFrame,
  type Topic,
} from '@purlay/types';
import { createApp, type HttpApplication } from './app';
import { SESSION_COOKIE, TWO_FACTOR_COOKIE } from '../../platform/cookies';
import { sessionTopic } from '../../platform/events';
import { inProcessBackplane, type Backplane } from '../../realtime/bus';
import { testConfig, testDependencies } from '../../testing/doubles';
import { aTestAuth } from '../../testing/signed-in';
import { systemClock } from '../../platform/clock';
import { aWrongCode, codeAt, keyOf } from '../../testing/totp';
import { aUserRow, type TestUser } from '../../testing/users';
import { PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT } from '../../modules/auth/password-attempts';

const ORIGIN = 'https://purlay.test';
const PASSWORD = 'analytical engine 1843';
/** What the per-challenge cap of the library is: a sixth try at one challenge is refused unweighed. */
const TRIES_PER_CHALLENGE = 5;

/** The wall clock, as the library reads it when it weighs a code. */
const now = (): number => systemClock.now().getTime();

let cloned: ClonedDatabase;
let db: Executor;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

beforeEach(async () => {
  await sql`delete from rate_limits`.execute(db);
});

interface Server {
  readonly app: HttpApplication;
  readonly published: [Topic, ServerFrame][];
}

const aServer = (): Server => {
  const inner = inProcessBackplane();
  const published: [Topic, ServerFrame][] = [];
  const backplane: Backplane = {
    node: (deliver, log) => {
      const real = inner.node(deliver, log);
      return {
        ...real,
        publish: async (topic, frame): Promise<void> => {
          published.push([topic, frame]);
          await real.publish(topic, frame);
        },
      };
    },
  };
  const auth = aTestAuth(db, { baseUrl: ORIGIN });
  // Behind a proxy, so each request names the client it comes from: the library allows three requests to
  // its two-factor routes from one client in ten seconds, and the tests below make more on purpose.
  const config = testConfig({ APP_URL: ORIGIN, TRUST_PROXY: true });
  return {
    app: createApp(testDependencies({ database: db, config, auth, backplane })),
    published,
  };
};

const aPasswordAccount = async (name: string): Promise<TestUser> => {
  const user = await aUserRow(db, name);
  await db
    .insertInto('accounts')
    .values({
      user_id: user.userId,
      provider_id: 'credential',
      account_id: user.userId,
      password: await hashPassword(PASSWORD),
    })
    .execute();
  return user;
};

let clientCounter = 0;
const aClient = (): string => {
  clientCounter += 1;
  return `192.0.${String(Math.floor(clientCounter / 250))}.${String((clientCounter % 250) + 1)}`;
};

const post = async (
  server: Server,
  path: string,
  body: unknown,
  { cookie, client = aClient() }: { readonly cookie?: string; readonly client?: string } = {},
): Promise<Response> => {
  const text = JSON.stringify(body);
  return await server.app.handle(
    new Request(`${ORIGIN}${path}`, {
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

const get = async (server: Server, path: string, cookie: string): Promise<Response> =>
  await server.app.handle(new Request(`${ORIGIN}${path}`, { headers: { origin: ORIGIN, cookie } }));

/** The `name=value` a response sets for a cookie, unless it clears it. */
const cookieOf = (response: Response, name: string): string | undefined =>
  response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${name}=`) && !/Max-Age=0/i.test(line))
    ?.split(';')[0];

const bodyOf = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.clone().json()) as Record<string, unknown>;

const signInWithPassword = async (server: Server, user: TestUser): Promise<Response> =>
  await post(server, '/auth/sign-in/email', { email: user.email, password: PASSWORD });

/** A session from the password alone: the account has no second step yet. */
const signedIn = async (server: Server, user: TestUser): Promise<string> => {
  const answered = await signInWithPassword(server, user);
  const cookie = cookieOf(answered, SESSION_COOKIE);
  if (answered.status !== 200 || cookie === undefined) {
    throw new Error(`${user.username} could not sign in: ${String(answered.status)}`);
  }
  return cookie;
};

const enabled = async (userId: string): Promise<boolean> =>
  (
    await db
      .selectFrom('users')
      .select('two_factor_enabled')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
  ).two_factor_enabled;

const sessionIds = async (userId: string): Promise<string[]> =>
  (await db.selectFrom('sessions').select('id').where('user_id', '=', userId).execute()).map(
    (row) => row.id,
  );

interface Enrolled {
  readonly user: TestUser;
  readonly cookie: string;
  readonly key: Buffer;
  readonly backupCodes: readonly string[];
}

/** An account with two-step verification on, through the routes, and the session that turned it on. */
const anEnrolledAccount = async (server: Server, name: string): Promise<Enrolled> => {
  const user = await aPasswordAccount(name);
  const cookie = await signedIn(server, user);
  const started = await post(server, '/auth/two-factor/enable', { password: PASSWORD }, { cookie });
  expect(started.status).toBe(200);
  const { totpURI, backupCodes } = (await started.json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  const key = keyOf(totpURI);
  const confirmed = await post(
    server,
    '/auth/two-factor/verify-totp',
    { code: codeAt(key, now()) },
    { cookie },
  );
  expect(confirmed.status).toBe(200);
  expect(await enabled(user.userId)).toBe(true);
  return { user, cookie, key, backupCodes };
};

/** The password, right: the challenge's cookie, and no session. */
const challenged = async (server: Server, user: TestUser): Promise<string> => {
  const answered = await signInWithPassword(server, user);
  expect(answered.status).toBe(200);
  expect(await answered.json()).toEqual({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
  expect(cookieOf(answered, SESSION_COOKIE)).toBeUndefined();
  const challenge = cookieOf(answered, TWO_FACTOR_COOKIE);
  if (challenge === undefined) throw new Error('no challenge cookie');
  return challenge;
};

describe('integration: turning two-step verification on (D-236)', () => {
  test('the password first, then a key and backup codes; nothing is on until a right code, and the key is sealed', async () => {
    const server = aServer();
    const user = await aPasswordAccount('tf-enrol');
    const cookie = await signedIn(server, user);

    const wrongPassword = await post(
      server,
      '/auth/two-factor/enable',
      { password: 'not the password at all' },
      { cookie },
    );
    expect(wrongPassword.status).toBe(400);
    expect(await bodyOf(wrongPassword)).toMatchObject({ code: 'INVALID_PASSWORD' });
    expect(await db.selectFrom('two_factors').where('user_id', '=', user.userId).execute()).toEqual(
      [],
    );

    // What a client says of the method and the issuer is not what the server does.
    const started = await post(
      server,
      '/auth/two-factor/enable',
      { password: PASSWORD, method: 'otp', issuer: 'Somebody Else' },
      { cookie },
    );
    expect(started.status).toBe(200);
    const { totpURI, backupCodes, method } = (await started.json()) as {
      totpURI: string;
      backupCodes: string[];
      method: string;
    };
    expect(method).toBe('totp');
    const uri = new URL(totpURI);
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('issuer')).toBe('Purlay (purlay.test)');
    expect(
      totpURI.startsWith(
        `otpauth://totp/${encodeURIComponent('Purlay (purlay.test)')}:${encodeURIComponent(user.email)}?`,
      ),
    ).toBe(true);
    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10);

    const row = await db
      .selectFrom('two_factors')
      .selectAll()
      .where('user_id', '=', user.userId)
      .executeTakeFirstOrThrow();
    expect(row.verified).toBe(false);
    const secret = uri.searchParams.get('secret') ?? '';
    expect(row.secret).not.toContain(secret);
    expect(row.secret).not.toContain(keyOf(totpURI).toString('utf8'));
    for (const code of backupCodes) expect(row.backup_codes).not.toContain(code);
    expect(await enabled(user.userId)).toBe(false);
    // Not on yet: the password alone still signs in.
    expect(cookieOf(await signInWithPassword(server, user), SESSION_COOKIE)).toBeDefined();
  });

  test('a wrong code leaves it off; a right one turns it on, and the session that asked is the same row, untold', async () => {
    const server = aServer();
    const user = await aPasswordAccount('tf-confirm');
    const cookie = await signedIn(server, user);
    const [session] = await sessionIds(user.userId);
    const started = await post(
      server,
      '/auth/two-factor/enable',
      { password: PASSWORD },
      { cookie },
    );
    const key = keyOf(((await started.json()) as { totpURI: string }).totpURI);

    const wrong = await post(
      server,
      '/auth/two-factor/verify-totp',
      { code: aWrongCode(key, now()) },
      { cookie },
    );
    expect(wrong.status).toBe(401);
    expect(await bodyOf(wrong)).toMatchObject({ code: 'INVALID_CODE' });
    expect(await enabled(user.userId)).toBe(false);

    server.published.splice(0);
    const right = await post(
      server,
      '/auth/two-factor/verify-totp',
      { code: codeAt(key, now()) },
      { cookie },
    );
    expect(right.status).toBe(200);
    expect(await enabled(user.userId)).toBe(true);
    expect(
      (
        await db
          .selectFrom('two_factors')
          .select('verified')
          .where('user_id', '=', user.userId)
          .executeTakeFirstOrThrow()
      ).verified,
    ).toBe(true);
    // The library would have made a new session and ended this one: kept, and nothing new set or told.
    expect(cookieOf(right, SESSION_COOKIE)).toBeUndefined();
    expect(await sessionIds(user.userId)).toEqual([session ?? '']);
    expect((await get(server, '/api/me', cookie)).status).toBe(200);
    expect(server.published.filter(([, frame]) => frame.event === 'SESSION_ENDED')).toEqual([]);
    const sign = await get(server, '/api/me/sign-in', cookie);
    expect(await sign.json()).toMatchObject({ hasPassword: true, twoFactor: true });

    // Once on, it is not begun again over the top.
    const again = await post(server, '/auth/two-factor/enable', { password: PASSWORD }, { cookie });
    expect(again.status).toBe(400);
    expect(await bodyOf(again)).toMatchObject({ code: 'TOTP_ALREADY_ENABLED' });
  });

  test('signed out, nothing of it is reached; the routes nothing here uses are not there', async () => {
    const server = aServer();
    const user = await aPasswordAccount('tf-closed');
    const cookie = await signedIn(server, user);
    const unsigned = await post(server, '/auth/two-factor/enable', { password: PASSWORD });
    expect(unsigned.status).toBe(401);
    for (const path of ['get-totp-uri', 'send-otp', 'verify-otp']) {
      const answered = await post(
        server,
        `/auth/two-factor/${path}`,
        { password: PASSWORD, code: '123456' },
        { cookie },
      );
      expect({ path, status: answered.status }).toEqual({ path, status: 404 });
    }
  });
});

describe('integration: signing in with the second step (D-236)', () => {
  test('a right password asks for the code and starts no session; a wrong code is refused, the right one signs in', async () => {
    const server = aServer();
    const { user, key } = await anEnrolledAccount(server, 'tf-signin');
    const before = await sessionIds(user.userId);
    const challenge = await challenged(server, user);
    const attributes =
      (await signInWithPassword(server, user)).headers
        .getSetCookie()
        .find((line) => line.startsWith(`${TWO_FACTOR_COOKIE}=`)) ?? '';
    expect(attributes).toMatch(/HttpOnly/i);
    expect(attributes).toMatch(/Secure/i);
    expect(attributes).toMatch(/Path=\//);
    expect(attributes).toMatch(new RegExp(`Max-Age=${String(TWO_FACTOR_CHALLENGE_MINUTES * 60)}`));
    // The password's session was the library's to throw away: none is left for the account.
    expect(await sessionIds(user.userId)).toEqual(before);

    const wrong = await post(
      server,
      '/auth/two-factor/verify-totp',
      { code: aWrongCode(key, now()) },
      { cookie: challenge },
    );
    expect(wrong.status).toBe(401);
    expect(await bodyOf(wrong)).toMatchObject({ code: 'INVALID_CODE' });
    expect(cookieOf(wrong, SESSION_COOKIE)).toBeUndefined();

    // A device asked to be trusted is not: nothing of that is set.
    const right = await post(
      server,
      '/auth/two-factor/verify-totp',
      { code: codeAt(key, now()), trustDevice: true },
      { cookie: challenge },
    );
    expect(right.status).toBe(200);
    const session = cookieOf(right, SESSION_COOKIE);
    expect(session).toBeDefined();
    expect(right.headers.getSetCookie().some((line) => line.includes('trust_device'))).toBe(false);
    expect((await get(server, '/api/me', session ?? '')).status).toBe(200);

    // The challenge is spent with the sign-in.
    const replayed = await post(
      server,
      '/auth/two-factor/verify-totp',
      { code: codeAt(key, now()) },
      { cookie: challenge },
    );
    expect(replayed.status).toBe(401);
    expect(await bodyOf(replayed)).toMatchObject({ code: 'INVALID_TWO_FACTOR_COOKIE' });
  });

  test('without the challenge a code is nothing; a wrong password still says only that it is wrong', async () => {
    const server = aServer();
    const { user, key } = await anEnrolledAccount(server, 'tf-nochallenge');
    const bare = await post(server, '/auth/two-factor/verify-totp', { code: codeAt(key, now()) });
    expect(bare.status).toBe(401);
    expect(await bodyOf(bare)).toMatchObject({ code: 'INVALID_TWO_FACTOR_COOKIE' });
    const wrong = await post(server, '/auth/sign-in/email', {
      email: user.email,
      password: 'not the password at all',
    });
    expect(wrong.status).toBe(401);
    expect(await bodyOf(wrong)).toEqual({
      code: 'INVALID_EMAIL_OR_PASSWORD',
      message: 'Invalid email or password',
    });
    expect(cookieOf(wrong, TWO_FACTOR_COOKIE)).toBeUndefined();
  });

  test('a backup code signs in once; spent, it is refused', async () => {
    const server = aServer();
    const { user, backupCodes } = await anEnrolledAccount(server, 'tf-backup');
    const [code] = backupCodes;
    const first = await post(
      server,
      '/auth/two-factor/verify-backup-code',
      { code, disableSession: true },
      { cookie: await challenged(server, user) },
    );
    expect(first.status).toBe(200);
    expect(cookieOf(first, SESSION_COOKIE)).toBeDefined();
    const second = await post(
      server,
      '/auth/two-factor/verify-backup-code',
      { code },
      { cookie: await challenged(server, user) },
    );
    expect(second.status).toBe(401);
    expect(await bodyOf(second)).toMatchObject({ code: 'INVALID_BACKUP_CODE' });
  });

  test('wrong codes lock the step: five spend a challenge, ten in a row lock it, the right code included', async () => {
    const server = aServer();
    const { user, key, backupCodes } = await anEnrolledAccount(server, 'tf-lock');
    const wrongTimes = async (challenge: string, times: number): Promise<void> => {
      for (let n = 0; n < times; n += 1) {
        const wrong = await post(
          server,
          '/auth/two-factor/verify-totp',
          { code: aWrongCode(key, now()) },
          { cookie: challenge },
        );
        expect(wrong.status).toBe(401);
      }
    };
    const first = await challenged(server, user);
    await wrongTimes(first, TRIES_PER_CHALLENGE);
    // A sixth try at the same challenge is refused unweighed, and the challenge is gone.
    const spent = await post(
      server,
      '/auth/two-factor/verify-totp',
      { code: codeAt(key, now()) },
      { cookie: first },
    );
    expect(spent.status).toBe(400);
    expect(await bodyOf(spent)).toMatchObject({ code: 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE' });
    expect(cookieOf(spent, SESSION_COOKIE)).toBeUndefined();

    await wrongTimes(
      await challenged(server, user),
      TWO_FACTOR_FAILURES_BEFORE_LOCK - TRIES_PER_CHALLENGE,
    );
    // Ten in a row: the step is locked, for a new challenge too, whatever the code.
    const challenge = await challenged(server, user);
    for (const [path, code] of [
      ['verify-totp', codeAt(key, now())],
      ['verify-backup-code', backupCodes[0]],
    ] as const) {
      const locked = await post(
        server,
        `/auth/two-factor/${path}`,
        { code },
        { cookie: challenge },
      );
      expect({ path, status: locked.status }).toEqual({ path, status: 429 });
      expect(await bodyOf(locked)).toMatchObject({ code: 'ACCOUNT_TEMPORARILY_LOCKED' });
      expect(cookieOf(locked, SESSION_COOKIE)).toBeUndefined();
    }
    expect(await sessionIds(user.userId)).toHaveLength(1);
  });

  test('a suspended account gets no session through the step, nor one erased while it was asked', async () => {
    const server = aServer();
    const suspended = await anEnrolledAccount(server, 'tf-suspended');
    // Two steps asked for before the suspension: once suspended, the password is refused before any step.
    const challenge = await challenged(server, suspended.user);
    const another = await challenged(server, suspended.user);
    await db
      .updateTable('users')
      .set({ suspended_at: new Date() })
      .where('id', '=', suspended.user.userId)
      .execute();
    await db.deleteFrom('sessions').where('user_id', '=', suspended.user.userId).execute();
    const refused = await post(
      server,
      '/auth/two-factor/verify-totp',
      { code: codeAt(suspended.key, now()) },
      { cookie: challenge },
    );
    // Refused as any sign-in of a suspended account is, never a 500 (#857).
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ code: 'FAILED_TO_CREATE_SESSION' });
    expect(cookieOf(refused, SESSION_COOKIE)).toBeUndefined();
    expect(await sessionIds(suspended.user.userId)).toEqual([]);
    const backup = await post(
      server,
      '/auth/two-factor/verify-backup-code',
      { code: suspended.backupCodes[0] ?? '' },
      { cookie: another },
    );
    expect(backup.status).toBe(401);
    expect(cookieOf(backup, SESSION_COOKIE)).toBeUndefined();
    expect(await sessionIds(suspended.user.userId)).toEqual([]);

    const erased = await anEnrolledAccount(server, 'tf-erased');
    const pending = await challenged(server, erased.user);
    const gone = await post(
      server,
      '/api/me/erase',
      { confirm: erased.user.username },
      { cookie: erased.cookie },
    );
    expect(gone.status).toBe(204);
    expect(
      await db.selectFrom('two_factors').where('user_id', '=', erased.user.userId).execute(),
    ).toEqual([]);
    expect(await enabled(erased.user.userId)).toBe(false);
    const after = await post(
      server,
      '/auth/two-factor/verify-totp',
      { code: codeAt(erased.key, now()) },
      { cookie: pending },
    );
    expect(after.ok).toBe(false);
    expect(cookieOf(after, SESSION_COOKIE)).toBeUndefined();
    expect(await sessionIds(erased.user.userId)).toEqual([]);
  });
});

describe('integration: turning it off and new backup codes need the password (D-236)', () => {
  test('off: a wrong password changes nothing; the right one turns it off, keeps the session, and signs in by password alone', async () => {
    const server = aServer();
    const { user, cookie } = await anEnrolledAccount(server, 'tf-off');
    const before = await sessionIds(user.userId);
    const wrong = await post(
      server,
      '/auth/two-factor/disable',
      { password: 'not the password at all' },
      { cookie },
    );
    expect(wrong.status).toBe(400);
    expect(await bodyOf(wrong)).toMatchObject({ code: 'INVALID_PASSWORD' });
    expect(await enabled(user.userId)).toBe(true);

    server.published.splice(0);
    const off = await post(server, '/auth/two-factor/disable', { password: PASSWORD }, { cookie });
    expect(off.status).toBe(200);
    expect(await enabled(user.userId)).toBe(false);
    expect(await db.selectFrom('two_factors').where('user_id', '=', user.userId).execute()).toEqual(
      [],
    );
    expect(cookieOf(off, SESSION_COOKIE)).toBeUndefined();
    expect(await sessionIds(user.userId)).toEqual(before);
    expect((await get(server, '/api/me', cookie)).status).toBe(200);
    expect(server.published).not.toContainEqual([
      sessionTopic(before[0] ?? ''),
      expect.objectContaining({ event: 'SESSION_ENDED' }) as unknown as ServerFrame,
    ]);
    expect(cookieOf(await signInWithPassword(server, user), SESSION_COOKIE)).toBeDefined();
  });

  test('new backup codes: a wrong password keeps the old ones; the right one replaces them all', async () => {
    const server = aServer();
    const { user, cookie, backupCodes } = await anEnrolledAccount(server, 'tf-codes');
    const wrong = await post(
      server,
      '/auth/two-factor/generate-backup-codes',
      { password: 'not the password at all' },
      { cookie },
    );
    expect(wrong.status).toBe(400);
    expect(await bodyOf(wrong)).toMatchObject({ code: 'INVALID_PASSWORD' });

    const fresh = await post(
      server,
      '/auth/two-factor/generate-backup-codes',
      { password: PASSWORD },
      { cookie },
    );
    expect(fresh.status).toBe(200);
    const { backupCodes: replaced } = (await fresh.json()) as { backupCodes: string[] };
    expect(replaced).toHaveLength(10);
    expect(replaced.some((code) => backupCodes.includes(code))).toBe(false);
    const old = await post(
      server,
      '/auth/two-factor/verify-backup-code',
      { code: backupCodes[0] },
      { cookie: await challenged(server, user) },
    );
    expect(old.status).toBe(401);
    const used = await post(
      server,
      '/auth/two-factor/verify-backup-code',
      { code: replaced[0] },
      { cookie: await challenged(server, user) },
    );
    expect(used.status).toBe(200);
  });

  test('a wrong password on these routes is a guess like a sign-in’s, from the same client: the tenth is refused', async () => {
    const server = aServer();
    const { user, cookie } = await anEnrolledAccount(server, 'tf-count');
    const client = aClient();
    const paths = ['disable', 'generate-backup-codes', 'enable'];
    for (let n = 0; n < PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT; n += 1) {
      // Past the library's own three a client in ten seconds on these routes: counted all the same.
      await sql`delete from rate_limits where key not like 'purlay:%'`.execute(db);
      const wrong = await post(
        server,
        `/auth/two-factor/${paths[n % paths.length] ?? 'disable'}`,
        { password: `not it ${String(n)} at all` },
        { cookie, client },
      );
      expect(wrong.status).toBe(400);
    }
    const refused = await post(
      server,
      '/auth/sign-in/email',
      { email: user.email, password: PASSWORD },
      { client },
    );
    expect(refused.status).toBe(429);
    await sql`delete from rate_limits where key not like 'purlay:%'`.execute(db);
    const disable = await post(
      server,
      '/auth/two-factor/disable',
      { password: PASSWORD },
      { cookie, client },
    );
    expect(disable.status).toBe(429);
    expect(disable.headers.get('retry-after')).not.toBeNull();
    expect(await enabled(user.userId)).toBe(true);
  });
});
