/**
 * The sign-in policy as a signed-in person meets it (D-239), through the mounted application and the real
 * sign-in library: where the server requires two-step verification of an account with a password, such an
 * account with it off is held back — every route answers `403 TWO_FACTOR_REQUIRED` but the few turning it on
 * needs, the socket included — until it turns it on, which lifts the hold on the same session; an account with
 * it on, or with no password, is not held back; turning it off is refused. Where passwords are off, a password
 * signs nobody in, the sign-in screen is told so, and nothing is required of a password that is no way in.
 *
 * Who changes the policy, and the rules that keep a way in, are `server.integration.test.ts`'s.
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
import type { AuthMethods, MeResponse, MySignIn } from '@purlay/types';
import { createApp, type HttpApplication } from './app';
import type { SignInPolicy } from '../../modules/auth/better-auth';
import { SESSION_COOKIE } from '../../platform/cookies';
import { AppError } from '../../platform/errors';
import { systemClock } from '../../platform/clock';
import { admitSocket } from '../../realtime/upgrade';
import { testConfig, testDependencies } from '../../testing/doubles';
import { aSession, aTestAuth } from '../../testing/signed-in';
import { codeAt, keyOf } from '../../testing/totp';
import { aUserRow, type TestUser } from '../../testing/users';

const ORIGIN = 'https://purlay.test';
const PASSWORD = 'analytical engine 1843';

const REQUIRED: SignInPolicy = { requireTwoFactor: true, passwordSignIn: true };
const OPTIONAL: SignInPolicy = { requireTwoFactor: false, passwordSignIn: true };
const NO_PASSWORDS: SignInPolicy = { requireTwoFactor: true, passwordSignIn: false };

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
  readonly policy: SignInPolicy;
}

const aServer = (policy: SignInPolicy): Server => {
  const auth = aTestAuth(db, { baseUrl: ORIGIN, signInPolicy: policy });
  // Behind a proxy, so each request names its client: the library allows three requests to its two-factor
  // routes from one client in ten seconds.
  const config = testConfig({ APP_URL: ORIGIN, TRUST_PROXY: true });
  return { app: createApp(testDependencies({ database: db, config, auth })), policy };
};

let clientCounter = 0;
const aClient = (): string => {
  clientCounter += 1;
  return `198.51.${String(Math.floor(clientCounter / 250))}.${String((clientCounter % 250) + 1)}`;
};

const request = async (
  server: Server,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  { cookie, body }: { readonly cookie?: string; readonly body?: unknown } = {},
): Promise<Response> => {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return await server.app.handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        'x-forwarded-for': aClient(),
        ...(text === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(text)),
            }),
        ...(cookie === undefined ? {} : { cookie }),
      },
      ...(text === undefined ? {} : { body: text }),
    }),
  );
};

const codeOf = async (response: Response): Promise<unknown> =>
  ((await response.clone().json()) as { error?: { code?: unknown }; code?: unknown }).error?.code ??
  ((await response.clone().json()) as { code?: unknown }).code;

/** An account with a password the library made, and no second step. */
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

/** A session for an account, as a browser carries it. */
const cookieFor = async (user: TestUser): Promise<string> =>
  `${SESSION_COOKIE}=${(await aSession(db, systemClock, user.userId)).token}`;

const signedInWithPassword = async (server: Server, user: TestUser): Promise<Response> =>
  await request(server, 'POST', '/auth/sign-in/email', {
    body: { email: user.email, password: PASSWORD },
  });

/** What a held-back person may still reach, and what they may not: one of each kind of route. */
const ENROLMENT = ['/api/me', '/api/me/sign-in'] as const;
const HELD = [
  '/api/workspaces',
  '/api/me/sessions',
  '/api/me/quiet-hours',
  '/api/me/missed-mail',
  '/api/push/key',
] as const;

describe('integration: two-step verification required of an account with a password (D-239)', () => {
  test('off, a password account without it reaches everything, as before', async () => {
    const server = aServer(OPTIONAL);
    const cookie = await cookieFor(await aPasswordAccount('policy-off'));
    for (const path of HELD) {
      expect((await request(server, 'GET', path, { cookie })).status, path).not.toBe(403);
    }
    const me = (await (await request(server, 'GET', '/api/me', { cookie })).json()) as MeResponse;
    expect(me.mustEnrolTwoFactor).toBe(false);
  });

  test('on, a password account without it is held back everywhere but what turning it on needs', async () => {
    const server = aServer(REQUIRED);
    const user = await aPasswordAccount('policy-held');
    const cookie = await cookieFor(user);
    for (const path of HELD) {
      const held = await request(server, 'GET', path, { cookie });
      expect([held.status, await codeOf(held)], path).toEqual([403, 'TWO_FACTOR_REQUIRED']);
    }
    // A write too, and one that names a workspace: the hold is asked before anything else.
    const write = await request(server, 'POST', '/api/workspaces', {
      cookie,
      body: { name: 'Nope', slug: 'nope-held' },
    });
    expect([write.status, await codeOf(write)]).toEqual([403, 'TWO_FACTOR_REQUIRED']);
    expect(await db.selectFrom('workspaces').where('slug', '=', 'nope-held').execute()).toEqual([]);

    for (const path of ENROLMENT) {
      expect((await request(server, 'GET', path, { cookie })).status, path).toBe(200);
    }
    const me = (await (await request(server, 'GET', '/api/me', { cookie })).json()) as MeResponse;
    expect(me.mustEnrolTwoFactor).toBe(true);
    const signIn = (await (
      await request(server, 'GET', '/api/me/sign-in', { cookie })
    ).json()) as MySignIn;
    expect([signIn.twoFactor, signIn.twoFactorRequired]).toEqual([false, true]);

    // The socket is refused at the door, as the routes are.
    const socket = await admitSocket(
      { auth: aTestAuth(db, { baseUrl: ORIGIN, signInPolicy: REQUIRED }), appUrl: ORIGIN },
      new Request(`${ORIGIN}/ws`, { headers: { origin: ORIGIN, cookie } }),
    ).then(
      () => 'admitted',
      (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
    );
    expect(socket).toBe('TWO_FACTOR_REQUIRED');

    // Signing out everywhere is theirs, held back or not.
    const out = await request(server, 'POST', '/auth/logout-all', { cookie });
    expect(out.status).toBe(204);
    expect((await request(server, 'GET', '/api/me', { cookie })).status).toBe(401);
  });

  test('an account with no password — GitHub, single sign-on, a link — is never held back', async () => {
    const server = aServer(REQUIRED);
    const user = await aUserRow(db, 'policy-github');
    await db
      .insertInto('accounts')
      .values({ user_id: user.userId, provider_id: 'github', account_id: '77001' })
      .execute();
    const cookie = await cookieFor(user);
    for (const path of HELD) {
      expect((await request(server, 'GET', path, { cookie })).status, path).not.toBe(403);
    }
    const linkOnly = await cookieFor(await aUserRow(db, 'policy-link'));
    expect((await request(server, 'GET', '/api/workspaces', { cookie: linkOnly })).status).toBe(
      200,
    );
    const me = (await (await request(server, 'GET', '/api/me', { cookie })).json()) as MeResponse;
    expect(me.mustEnrolTwoFactor).toBe(false);
  });

  test('an account with it on reaches everything, and cannot turn it off while it is required', async () => {
    const optional = aServer(OPTIONAL);
    const user = await aPasswordAccount('policy-enrolled');
    // Turned on through the routes, before the policy: then the policy comes in.
    const signedIn = await signedInWithPassword(optional, user);
    const cookie = signedIn.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${SESSION_COOKIE}=`))
      ?.split(';')[0];
    if (cookie === undefined) throw new Error('no session');
    const started = await request(optional, 'POST', '/auth/two-factor/enable', {
      cookie,
      body: { password: PASSWORD },
    });
    const key = keyOf(((await started.json()) as { totpURI: string }).totpURI);
    const confirmed = await request(optional, 'POST', '/auth/two-factor/verify-totp', {
      cookie,
      body: { code: codeAt(key, systemClock.now().getTime()) },
    });
    expect(confirmed.status).toBe(200);

    const server = aServer(REQUIRED);
    expect((await request(server, 'GET', '/api/workspaces', { cookie })).status).toBe(200);
    const off = await request(server, 'POST', '/auth/two-factor/disable', {
      cookie,
      body: { password: PASSWORD },
    });
    expect([off.status, await codeOf(off)]).toEqual([403, 'TWO_FACTOR_REQUIRED']);
    const still = await db
      .selectFrom('users')
      .select('two_factor_enabled')
      .where('id', '=', user.userId)
      .executeTakeFirstOrThrow();
    expect(still.two_factor_enabled).toBe(true);
    // Optional again, it may go.
    const gone = await request(optional, 'POST', '/auth/two-factor/disable', {
      cookie,
      body: { password: PASSWORD },
    });
    expect(gone.status).toBe(200);
  });

  test('turning it on lifts the hold from the next request, on the same session, with no sign-in again', async () => {
    const server = aServer(REQUIRED);
    const user = await aPasswordAccount('policy-enrols');
    // The password still signs in: there is no second step yet to ask for.
    const signedIn = await signedInWithPassword(server, user);
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${SESSION_COOKIE}=`))
      ?.split(';')[0];
    if (cookie === undefined) throw new Error('no session');
    const [session] = await db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', user.userId)
      .execute();
    expect((await request(server, 'GET', '/api/workspaces', { cookie })).status).toBe(403);

    const started = await request(server, 'POST', '/auth/two-factor/enable', {
      cookie,
      body: { password: PASSWORD },
    });
    expect(started.status).toBe(200);
    // Begun is not on: still held back until a right code.
    expect((await request(server, 'GET', '/api/workspaces', { cookie })).status).toBe(403);
    const key = keyOf(((await started.json()) as { totpURI: string }).totpURI);
    const confirmed = await request(server, 'POST', '/auth/two-factor/verify-totp', {
      cookie,
      body: { code: codeAt(key, systemClock.now().getTime()) },
    });
    expect(confirmed.status).toBe(200);

    expect((await request(server, 'GET', '/api/workspaces', { cookie })).status).toBe(200);
    const me = (await (await request(server, 'GET', '/api/me', { cookie })).json()) as MeResponse;
    expect(me.mustEnrolTwoFactor).toBe(false);
    // The same session, never replaced (D-236).
    expect(
      (
        await db.selectFrom('sessions').select('id').where('user_id', '=', user.userId).execute()
      ).map((row) => row.id),
    ).toEqual([session?.id ?? '']);
  });

  test('the server’s administrator is held back too; anybody else on its routes is still told they do not exist', async () => {
    const server = aServer(REQUIRED);
    const admin = await aPasswordAccount('policy-admin');
    await db
      .updateTable('users')
      .set({ is_server_admin: true })
      .where('id', '=', admin.userId)
      .execute();
    const held = await request(server, 'GET', '/api/server/settings', {
      cookie: await cookieFor(admin),
    });
    expect([held.status, await codeOf(held)]).toEqual([403, 'TWO_FACTOR_REQUIRED']);
    // A held-back person who is not the administrator learns nothing of the page.
    const stranger = await request(server, 'GET', '/api/server/settings', {
      cookie: await cookieFor(await aPasswordAccount('policy-stranger')),
    });
    expect([stranger.status, await codeOf(stranger)]).toEqual([404, 'ROUTE_NOT_FOUND']);
    const policy = await request(server, 'POST', '/api/server/policy', {
      cookie: await cookieFor(await aPasswordAccount('policy-stranger-2')),
      body: { requireTwoFactor: false },
    });
    expect(policy.status).toBe(404);
  });
});

describe('integration: password sign-in turned off (D-239)', () => {
  test('a right password signs nobody in, in one answer whatever the address, and spends no guess', async () => {
    const server = aServer(NO_PASSWORDS);
    const user = await aPasswordAccount('nopw-known');
    const known = await signedInWithPassword(server, user);
    const unknown = await request(server, 'POST', '/auth/sign-in/email', {
      body: { email: 'nobody-here@example.test', password: PASSWORD },
    });
    for (const answer of [known, unknown]) {
      expect([answer.status, await codeOf(answer)]).toEqual([403, 'PASSWORD_SIGN_IN_DISABLED']);
      expect(answer.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
        false,
      );
    }
    expect(await db.selectFrom('sessions').where('user_id', '=', user.userId).execute()).toEqual(
      [],
    );
    // Nothing weighed, so nothing counted against the address.
    expect(
      await db
        .selectFrom('rate_limits')
        .select('key')
        .where('key', 'like', 'purlay:password%')
        .execute(),
    ).toEqual([]);
  });

  test('the sign-in screen is told; with passwords on it is told the same as before', async () => {
    const off = (await (
      await request(aServer(NO_PASSWORDS), 'GET', '/api/auth/methods')
    ).json()) as AuthMethods;
    expect(off.password).toBe(false);
    const on = (await (
      await request(aServer(OPTIONAL), 'GET', '/api/auth/methods')
    ).json()) as AuthMethods;
    expect(on.password).toBe(true);
    const client = (await (await request(aServer(NO_PASSWORDS), 'GET', '/api/client')).json()) as {
      auth: AuthMethods;
    };
    expect(client.auth.password).toBe(false);
  });

  test('nothing is required of a password that is no way in: an account with one, signed in otherwise, is not held back', async () => {
    const server = aServer(NO_PASSWORDS);
    const cookie = await cookieFor(await aPasswordAccount('nopw-held'));
    expect((await request(server, 'GET', '/api/workspaces', { cookie })).status).toBe(200);
    const signIn = (await (
      await request(server, 'GET', '/api/me/sign-in', { cookie })
    ).json()) as MySignIn;
    expect(signIn.twoFactorRequired).toBe(false);
  });
});
