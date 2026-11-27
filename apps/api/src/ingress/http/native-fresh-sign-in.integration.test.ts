/**
 * A fresh sign-in through the native handoff (D-356): the handoff mints a session now, but the person may
 * have proved who they are in this browser long ago. Erasure (D-139 §5) reads when the person signed in,
 * not when the session was issued, and an application that needs a fresh check asks for `prompt: 'login'`,
 * which only a browser that has just proved who it is can answer.
 *
 * Through the real doors: a password sign-in, `POST /api/native/authorize`, `POST /api/native/token` and
 * `POST /api/me/erase`, on one clock the test moves. On a database of its own: the sign-in library commits
 * through its own connection.
 */
import { createHash } from 'node:crypto';
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
import { ERASURE_SIGN_IN_MINUTES, NATIVE_FRESH_SIGN_IN_MINUTES } from '@purlay/types';
import { createApp, type HttpApplication } from './app';
import { SESSION_COOKIE } from '../../platform/cookies';
import type { Clock } from '../../platform/clock';
import { testConfig, testDependencies } from '../../testing/doubles';
import { aTestAuth } from '../../testing/signed-in';
import { aUserRow, type TestUser } from '../../testing/users';

const ORIGIN = 'https://purlay.test';
const PASSWORD = 'difference engine 1822';
const MINUTE = 60_000;

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

/** The wall clock, moved forward by the test: sign-in, the handoff and erasure all read it. */
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
  readonly clock: ReturnType<typeof movable>;
}

const aServer = (): Server => {
  const clock = movable();
  const auth = aTestAuth(db, { baseUrl: ORIGIN, clock });
  const config = testConfig({ APP_URL: ORIGIN });
  return { app: createApp(testDependencies({ database: db, config, auth, clock })), clock };
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

const post = async (
  server: Server,
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> =>
  await server.app.handle(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );

const sessionCookieOf = (response: Response): string => {
  const line = response.headers
    .getSetCookie()
    .find(
      (value) => value.startsWith(`${SESSION_COOKIE}=`) && !value.startsWith(`${SESSION_COOKIE}=;`),
    );
  if (line === undefined) throw new Error(`no session cookie in a ${String(response.status)}`);
  return line.split(';')[0] ?? '';
};

const codeOf = async (response: Response): Promise<unknown> =>
  ((await response.clone().json()) as { error?: { code?: unknown } }).error?.code;

/** The person types their password into this browser: a session that has just proved who it is. */
const signIn = async (server: Server, person: TestUser): Promise<string> => {
  const answered = await post(
    server,
    '/auth/sign-in/email',
    { email: person.email, password: PASSWORD },
    { origin: ORIGIN },
  );
  expect(answered.status).toBe(200);
  return sessionCookieOf(answered);
};

const aQuestion = (): { verifier: string; challenge: string; state: string } => {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
  };
};

const authorize = async (
  server: Server,
  browser: string,
  question: { challenge: string; state: string },
  prompt?: 'login',
): Promise<Response> =>
  await post(
    server,
    '/api/native/authorize',
    {
      challenge: question.challenge,
      state: question.state,
      ...(prompt === undefined ? {} : { prompt }),
    },
    { cookie: browser, origin: ORIGIN },
  );

/** The application spends the code the browser was redirected with, for a session of its own. */
const handOver = async (
  server: Server,
  authorized: Response,
  question: { verifier: string },
): Promise<string> => {
  expect(authorized.status).toBe(200);
  const redirect = ((await authorized.json()) as { redirect: string }).redirect;
  const code = new URL(redirect).searchParams.get('code') ?? '';
  const minted = await post(server, '/api/native/token', {
    code,
    verifier: question.verifier,
    device: { name: 'A test iPhone' },
  });
  expect(minted.status).toBe(204);
  return sessionCookieOf(minted);
};

const erase = async (server: Server, session: string, person: TestUser): Promise<Response> =>
  await post(server, '/api/me/erase', { confirm: person.username }, { cookie: session });

describe('integration: a fresh sign-in through the native handoff (D-356)', () => {
  test('a session handed over from a browser that signed in long ago cannot erase the account, though it was issued now', async () => {
    const server = aServer();
    const person = await aPasswordAccount('stale-handoff');
    const browser = await signIn(server, person);
    server.clock.advance((ERASURE_SIGN_IN_MINUTES + 5) * MINUTE);

    // Without the prompt the handoff is as it was: one click, a session of its own.
    const question = aQuestion();
    const native = await handOver(server, await authorize(server, browser, question), question);
    const refused = await erase(server, native, person);
    expect(refused.status).toBe(403);
    expect(await codeOf(refused)).toBe('REAUTHENTICATION_REQUIRED');
  });

  test('prompt=login refuses a browser whose sign-in is older than the window, and nothing is handed over', async () => {
    const server = aServer();
    const person = await aPasswordAccount('stale-prompt');
    const browser = await signIn(server, person);
    server.clock.advance((NATIVE_FRESH_SIGN_IN_MINUTES + 1) * MINUTE);

    const refused = await authorize(server, browser, aQuestion(), 'login');
    expect(refused.status).toBe(403);
    expect(await codeOf(refused)).toBe('REAUTHENTICATION_REQUIRED');
    const grants = await db
      .selectFrom('native_authorizations')
      .select('id')
      .where('user_id', '=', person.userId)
      .execute();
    expect(grants).toEqual([]);
  });

  test('after the person enters their password again, prompt=login hands over a session that may erase the account', async () => {
    const server = aServer();
    const person = await aPasswordAccount('fresh-prompt');
    const old = await signIn(server, person);
    server.clock.advance((ERASURE_SIGN_IN_MINUTES + 5) * MINUTE);
    expect((await authorize(server, old, aQuestion(), 'login')).status).toBe(403);

    // The page signs this browser out and the person signs in again: the credential, checked now.
    const browser = await signIn(server, person);
    server.clock.advance((NATIVE_FRESH_SIGN_IN_MINUTES - 1) * MINUTE);
    const question = aQuestion();
    const native = await handOver(
      server,
      await authorize(server, browser, question, 'login'),
      question,
    );
    expect((await erase(server, native, person)).status).toBe(204);
  });

  test('the handed-over session keeps the browser’s sign-in time: erasure closes when the browser’s window does', async () => {
    const server = aServer();
    const person = await aPasswordAccount('window-handoff');
    const browser = await signIn(server, person);
    server.clock.advance((NATIVE_FRESH_SIGN_IN_MINUTES - 1) * MINUTE);
    const question = aQuestion();
    const native = await handOver(
      server,
      await authorize(server, browser, question, 'login'),
      question,
    );
    // Issued four minutes after the sign-in; the window is counted from the sign-in.
    server.clock.advance((ERASURE_SIGN_IN_MINUTES - NATIVE_FRESH_SIGN_IN_MINUTES + 2) * MINUTE);
    const refused = await erase(server, native, person);
    expect(refused.status).toBe(403);
    expect(await codeOf(refused)).toBe('REAUTHENTICATION_REQUIRED');
  });

  test('a browser that signed in just now erases its own account as before', async () => {
    const server = aServer();
    const person = await aPasswordAccount('browser-erases');
    const browser = await signIn(server, person);
    expect((await erase(server, browser, person)).status).toBe(204);
  });
});
