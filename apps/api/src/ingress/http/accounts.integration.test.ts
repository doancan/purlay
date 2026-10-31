/**
 * Suspending an account and lifting it (D-233), through real requests and the real sign-in library: the
 * person's live session stops resolving, their sockets are told, a password sign-in is refused while it
 * lasts and works again after, and the server's trail says whose account it was. Only the server's
 * administrator reaches the routes; to anybody else they are not there.
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
import type { ServerAccount, ServerFrame, Topic } from '@purlay/types';
import { createApp, type HttpApplication } from './app';
import { SESSION_COOKIE } from '../../platform/cookies';
import { sessionTopic } from '../../platform/events';
import { inProcessBackplane, type Backplane } from '../../realtime/bus';
import { testConfig, testDependencies } from '../../testing/doubles';
import { aSession, aTestAuth } from '../../testing/signed-in';
import { systemClock } from '../../platform/clock';
import { aUserRow, type TestUser } from '../../testing/users';

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

const anAdministrator = async (name = 'acc-admin'): Promise<TestUser> => {
  const admin = await aPasswordAccount(name);
  await db
    .updateTable('users')
    .set({ is_server_admin: true })
    .where('id', '=', admin.userId)
    .execute();
  return admin;
};

let clientCounter = 0;
const aClient = (): string => {
  clientCounter += 1;
  return `203.0.${String(Math.floor(clientCounter / 250))}.${String((clientCounter % 250) + 1)}`;
};

/** A password sign-in: the session cookie it set, or undefined when it was refused. */
const signIn = async (server: Server, user: TestUser): Promise<string | undefined> => {
  const text = JSON.stringify({ email: user.email, password: PASSWORD });
  const response = await server.app.handle(
    new Request(`${ORIGIN}/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(text)),
        'x-forwarded-for': aClient(),
      },
      body: text,
    }),
  );
  return response.headers
    .getSetCookie()
    .find(
      (line) => line.startsWith(`${SESSION_COOKIE}=`) && !line.startsWith(`${SESSION_COOKIE}=;`),
    )
    ?.split(';')[0];
};

const call = async (
  server: Server,
  method: string,
  path: string,
  cookie: string | undefined,
): Promise<Response> =>
  await server.app.handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { origin: ORIGIN, ...(cookie === undefined ? {} : { cookie }) },
    }),
  );

const signedIn = async (server: Server, user: TestUser): Promise<string> => {
  const cookie = await signIn(server, user);
  if (cookie === undefined) throw new Error(`${user.username} could not sign in`);
  return cookie;
};

const trail = async (target: string): Promise<{ action: string; actor: string | null }[]> =>
  (
    await db
      .selectFrom('server_audit_log')
      .select(['action', 'actor_user_id'])
      .where('target_user_id', '=', target)
      .orderBy('id')
      .execute()
  ).map((row) => ({ action: row.action, actor: row.actor_user_id }));

describe('integration: suspending an account (D-233)', () => {
  test('suspended: the session stops, its sockets are told, a sign-in is refused; lifted: it signs in again', async () => {
    const server = aServer();
    const admin = await signedIn(server, await anAdministrator());
    const person = await aPasswordAccount('acc-person');
    const theirs = await signedIn(server, person);
    expect((await call(server, 'GET', '/api/me', theirs)).status).toBe(200);
    const [session] = await db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', person.userId)
      .execute();
    server.published.splice(0);

    const suspended = await call(
      server,
      'PUT',
      `/api/server/accounts/${person.userId}/suspension`,
      admin,
    );
    expect(suspended.status).toBe(204);
    expect((await call(server, 'GET', '/api/me', theirs)).status).toBe(401);
    expect(server.published).toContainEqual([
      sessionTopic(session?.id ?? ''),
      expect.objectContaining({ event: 'SESSION_ENDED' }) as unknown as ServerFrame,
    ]);
    expect(await signIn(server, person)).toBeUndefined();
    // A session that slipped past the sign-in's refusal — written in the same instant, or by a path that
    // is not the library's — resolves to nobody: the seam refuses a suspended account too.
    const slipped = await aSession(db, systemClock, person.userId);
    expect(
      (await call(server, 'GET', '/api/me', `${SESSION_COOKIE}=${slipped.token}`)).status,
    ).toBe(401);
    await db.deleteFrom('sessions').where('id', '=', slipped.sessionId).execute();
    expect(
      await db.selectFrom('sessions').select('id').where('user_id', '=', person.userId).execute(),
    ).toEqual([]);

    const lifted = await call(
      server,
      'DELETE',
      `/api/server/accounts/${person.userId}/suspension`,
      admin,
    );
    expect(lifted.status).toBe(204);
    const again = await signedIn(server, person);
    expect((await call(server, 'GET', '/api/me', again)).status).toBe(200);
  });

  test('each change is on the server’s trail with whose account it was, once; again changes nothing', async () => {
    const server = aServer();
    const administrator = await anAdministrator();
    const admin = await signedIn(server, administrator);
    const person = await aPasswordAccount('acc-twice');
    const path = `/api/server/accounts/${person.userId}/suspension`;
    for (const method of ['PUT', 'PUT', 'DELETE', 'DELETE']) {
      expect((await call(server, method, path, admin)).status).toBe(204);
    }
    // Two rows, one each: written in the same millisecond, so not ordered by their ids.
    expect((await trail(person.userId)).sort((a, b) => a.action.localeCompare(b.action))).toEqual([
      { action: 'server.account_restored', actor: administrator.userId },
      { action: 'server.account_suspended', actor: administrator.userId },
    ]);
  });

  test('the administrator finds accounts by name, username or address, and sees who is suspended', async () => {
    const server = aServer();
    const admin = await signedIn(server, await anAdministrator());
    const person = await aPasswordAccount('acc-findme');
    await call(server, 'PUT', `/api/server/accounts/${person.userId}/suspension`, admin);
    const found = async (q: string): Promise<ServerAccount[]> => {
      const response = await call(
        server,
        'GET',
        `/api/server/accounts?q=${encodeURIComponent(q)}`,
        admin,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as ServerAccount[];
    };
    const [byName] = await found(person.username.toUpperCase());
    expect(byName).toMatchObject({
      id: person.userId,
      username: person.username,
      email: person.email,
      isServerAdmin: false,
    });
    expect(typeof byName?.suspendedAt).toBe('string');
    expect((await found(person.email)).map((account) => account.id)).toEqual([person.userId]);
    // What is typed is words, not a pattern: `%` finds a percent sign, which nobody's name has.
    expect(await found('%')).toEqual([]);
  });

  test('an administrator is not suspended, the caller least of all: 403; no account, 404', async () => {
    const server = aServer();
    const administrator = await anAdministrator();
    const admin = await signedIn(server, administrator);
    const other = await anAdministrator('acc-admin-2');
    for (const target of [administrator.userId, other.userId]) {
      const refused = await call(server, 'PUT', `/api/server/accounts/${target}/suspension`, admin);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    const erased = await aPasswordAccount('acc-erased');
    await db
      .updateTable('users')
      .set({ deleted_at: new Date() })
      .where('id', '=', erased.userId)
      .execute();
    for (const target of [erased.userId, '00000000-0000-4000-8000-000000000000', 'not-an-id']) {
      const missing = await call(server, 'PUT', `/api/server/accounts/${target}/suspension`, admin);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: 'USER_NOT_FOUND' } });
    }
  });

  test('to anybody but the administrator the routes are not there', async () => {
    const server = aServer();
    const somebody = await signedIn(server, await aPasswordAccount('acc-somebody'));
    const person = await aPasswordAccount('acc-target');
    for (const [method, path] of [
      ['GET', '/api/server/accounts'],
      ['PUT', `/api/server/accounts/${person.userId}/suspension`],
      ['DELETE', `/api/server/accounts/${person.userId}/suspension`],
    ] as const) {
      for (const cookie of [somebody, undefined]) {
        const response = await call(server, method, path, cookie);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
      }
    }
    expect(typeof (await signIn(server, person))).toBe('string');
  });
});
