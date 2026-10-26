/**
 * The two doors of the native sign-in handoff, over HTTP, against a real database (D-191, `API.md` §2):
 * `POST /api/native/authorize`, which a signed-in person's browser calls once they have said yes, and
 * `POST /api/native/token`, which the application calls with nothing but a code and the verifier it kept.
 *
 * The module's own rules are `native-handoff.integration.test.ts` in `modules/auth`; this is what only the
 * edge decides — who may call each, what a browser page may never do, what the answers look like, and that
 * a session made this way is a session in every sense, down to the socket it opens and the sign-out that
 * closes it.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { cloneIntegrationDatabase, type ClonedDatabase, type Executor } from '@purlay/db';
import {
  CLOSE_CODES,
  ErrorResponse,
  NATIVE_REDIRECT,
  NativeAuthorizeResponse,
} from '@purlay/types';
import { createApp, type HttpApplication } from './app';
import { NATIVE_TOKEN_BUDGET } from './rate-limit';
import { fixedClock } from '../../platform/clock';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { testConfig, testDependencies } from '../../testing/doubles';

const origin = 'https://purlay.test';
const clock = fixedClock(new Date('2026-10-26T12:00:00.000Z'));
let cloned: ClonedDatabase;
let db: Executor;
let app: HttpApplication;
let port = 0;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
  app = createApp(
    testDependencies({ database: db, clock, config: testConfig({ APP_URL: origin }) }),
  );
  port = app.listen(0);
});

afterAll(async () => {
  await app.stop(true);
  await cloned.drop();
});

const aVerifier = (): { verifier: string; challenge: string; state: string } => {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
  };
};

const post = async (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  on: { handle: (request: Request) => Promise<Response> } = app,
): Promise<Response> =>
  await on.handle(
    new Request(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

/** What the browser's page does once the person has said yes. */
const authorize = async (
  person: SignedInUser,
  { challenge, state }: { challenge: string; state: string },
): Promise<{ code: string; state: string; response: Response }> => {
  const response = await post(
    '/api/native/authorize',
    { challenge, state },
    { cookie: person.cookie, origin },
  );
  const body = (await response.clone().json()) as { redirect?: string };
  const url = new URL(body.redirect ?? 'purlay://none');
  return {
    code: url.searchParams.get('code') ?? '',
    state: url.searchParams.get('state') ?? '',
    response,
  };
};

const DEVICE = { name: 'Doğancan’s MacBook Pro' };

const token = async (
  fields: { code: string; verifier: string; device?: unknown },
  headers: Record<string, string> = {},
  on: { handle: (request: Request) => Promise<Response> } = app,
): Promise<Response> => await post('/api/native/token', { device: DEVICE, ...fields }, headers, on);

/** The session cookie's value out of a response, as the application stores it. */
const cookieOf = (response: Response): string => {
  const header = response.headers.get('set-cookie') ?? '';
  return /__Host-purlay_session=([^;]+)/.exec(header)?.[1] ?? '';
};

const who = async (cookieValue: string): Promise<{ status: number; id?: string }> => {
  const response = await app.handle(
    new Request(`${origin}/api/me`, {
      headers: { cookie: `__Host-purlay_session=${cookieValue}` },
    }),
  );
  const body = (await response.json()) as { user?: { id: string } };
  return { status: response.status, ...(body.user === undefined ? {} : { id: body.user.id }) };
};

describe('integration: POST /api/native/authorize', () => {
  test('is for somebody signed in: 401 for nobody, and a code is never made', async () => {
    const { challenge, state } = aVerifier();
    const response = await post('/api/native/authorize', { challenge, state }, { origin });
    expect(response.status).toBe(401);
  });

  test('is never a thing another site can do for the person: a cross-site page is refused before the session is read', async () => {
    const person = await aSignedInUser(db, clock, 'cross');
    const { challenge, state } = aVerifier();
    for (const headers of [
      { cookie: person.cookie, origin: 'https://evil.test' },
      { cookie: person.cookie, origin: 'null' },
      { cookie: person.cookie, 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = await post('/api/native/authorize', { challenge, state }, headers);
      expect(response.status).toBe(403);
    }
    const made = await db
      .selectFrom('native_authorizations')
      .select('id')
      .where('user_id', '=', person.userId)
      .execute();
    expect(made).toEqual([]);
  });

  test('answers a redirect to the one address a native client is sent to, with the code and the state', async () => {
    const person = await aSignedInUser(db, clock, 'sayyes');
    const { challenge, state } = aVerifier();
    const { response, code, state: echoed } = await authorize(person, { challenge, state });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(Value.Check(NativeAuthorizeResponse, body)).toBe(true);
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(echoed).toBe(state);
    expect((body as { redirect: string }).redirect).toBe(
      `${NATIVE_REDIRECT}?code=${code}&state=${state}`,
    );
  });

  test('takes no address to redirect to: a field it does not declare is refused, so there is no open redirect', async () => {
    const person = await aSignedInUser(db, clock, 'redirect');
    const { challenge, state } = aVerifier();
    const response = await post(
      '/api/native/authorize',
      { challenge, state, redirect: 'https://evil.test/' },
      { cookie: person.cookie, origin },
    );
    expect(response.status).toBe(400);
    expect(Value.Check(ErrorResponse, await response.json())).toBe(true);
  });

  test.each([
    ['a challenge of 42 characters', { challenge: 'a'.repeat(42) }],
    ['a challenge of 44 characters', { challenge: 'a'.repeat(44) }],
    ['a challenge with padding', { challenge: `${'a'.repeat(42)}=` }],
    ['a challenge that is not base64url', { challenge: `${'a'.repeat(42)}+` }],
    ['no challenge', { challenge: undefined }],
    ['a state of 15 characters', { state: 'a'.repeat(15) }],
    ['a state of 129 characters', { state: 'a'.repeat(129) }],
    // The state is written into a URL: anything outside base64url could end a parameter or begin one.
    ['a state that ends the query', { state: `${'a'.repeat(16)}&code=x` }],
    ['a state with a slash', { state: `${'a'.repeat(16)}/x` }],
    ['a state with a quote', { state: `${'a'.repeat(16)}"` }],
    ['a state with markup', { state: `${'a'.repeat(16)}<` }],
    ['a state with a space', { state: `${'a'.repeat(16)} ` }],
    ['no state', { state: undefined }],
  ])('refuses %s with 400 and makes no code', async (_name, change) => {
    const person = await aSignedInUser(db, clock, 'shape');
    const good = aVerifier();
    const response = await post(
      '/api/native/authorize',
      { challenge: good.challenge, state: good.state, ...change },
      { cookie: person.cookie, origin },
    );
    expect(response.status).toBe(400);
    const made = await db
      .selectFrom('native_authorizations')
      .select('id')
      .where('user_id', '=', person.userId)
      .execute();
    expect(made).toEqual([]);
  });

  test('refuses what is not JSON before anything else: 415', async () => {
    const person = await aSignedInUser(db, clock, 'media');
    const response = await app.handle(
      new Request(`${origin}/api/native/authorize`, {
        method: 'POST',
        headers: { cookie: person.cookie, origin, 'content-type': 'text/plain' },
        body: 'x',
      }),
    );
    expect(response.status).toBe(415);
  });
});

describe('integration: POST /api/native/token', () => {
  test('needs no session — that is the point — and answers 204 with a session cookie of the usual kind', async () => {
    const person = await aSignedInUser(db, clock, 'spend');
    const { verifier, challenge, state } = aVerifier();
    const { code } = await authorize(person, { challenge, state });

    const response = await token({ code, verifier });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    const cookie = response.headers.get('set-cookie') ?? '';
    // What the browser's own session carries: the same name, the same protections (D-62).
    expect(cookie).toMatch(/^__Host-purlay_session=[^;]+; /);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
      expect(cookie).toContain(attribute);
    }
    expect(cookie).not.toContain('Domain=');
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect(Number(/Max-Age=(\d+)/.exec(cookie)?.[1])).toBeGreaterThan(29 * 24 * 60 * 60);
  });

  test('makes a session that is the person’s, in every route that takes one', async () => {
    const person = await aSignedInUser(db, clock, 'whoami');
    const { verifier, challenge, state } = aVerifier();
    const { code } = await authorize(person, { challenge, state });
    const value = cookieOf(await token({ code, verifier }));
    expect(await who(value)).toEqual({ status: 200, id: person.userId });
  });

  test('is a different session from the browser’s: ending one leaves the other', async () => {
    const person = await aSignedInUser(db, clock, 'two');
    const { verifier, challenge, state } = aVerifier();
    const { code } = await authorize(person, { challenge, state });
    const value = cookieOf(await token({ code, verifier }));
    const signedOut = await app.handle(
      new Request(`${origin}/auth/logout`, {
        method: 'POST',
        headers: { cookie: `__Host-purlay_session=${value}` },
      }),
    );
    expect(signedOut.status).toBe(204);
    expect((await who(value)).status).toBe(401);
    const browser = await app.handle(
      new Request(`${origin}/api/me`, { headers: { cookie: person.cookie } }),
    );
    expect(browser.status).toBe(200);
  });

  test('is told 404 NATIVE_CODE_NOT_FOUND, and the same 404, whichever way the code failed', async () => {
    const person = await aSignedInUser(db, clock, 'refused');
    const { verifier, challenge, state } = aVerifier();
    const spent = (await authorize(person, { challenge, state })).code;
    await token({ code: spent, verifier });
    const live = (await authorize(person, { challenge, state })).code;

    const answers = await Promise.all([
      token({ code: '1'.repeat(64), verifier }),
      token({ code: live, verifier: aVerifier().verifier }),
      token({ code: spent, verifier }),
    ]);

    const bodies: unknown[] = [];
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      bodies.push(await answer.json());
    }
    expect(Value.Check(ErrorResponse, bodies[0])).toBe(true);
    expect(bodies[0]).toEqual({
      error: { code: 'NATIVE_CODE_NOT_FOUND', message: expect.any(String) as string },
    });
    // Not three answers that differ in a word: one, byte for byte.
    expect(JSON.stringify(bodies[1])).toBe(JSON.stringify(bodies[0]));
    expect(JSON.stringify(bodies[2])).toBe(JSON.stringify(bodies[0]));
    expect(answers.map((answer) => answer.headers.get('set-cookie'))).toEqual([null, null, null]);
  });

  test('refuses a browser page: another site cannot spend a code', async () => {
    const person = await aSignedInUser(db, clock, 'page');
    const { verifier, challenge, state } = aVerifier();
    const { code } = await authorize(person, { challenge, state });
    for (const headers of [{ origin: 'https://evil.test' }, { 'sec-fetch-site': 'cross-site' }]) {
      expect((await token({ code, verifier }, headers)).status).toBe(403);
    }
    // And the code is still there for the application that holds the verifier.
    expect((await token({ code, verifier })).status).toBe(204);
  });

  test.each([
    ['a code of 63 digits', { code: 'a'.repeat(63) }],
    ['a code with a capital', { code: `${'a'.repeat(63)}A` }],
    ['a verifier of 42 characters', { verifier: 'a'.repeat(42) }],
    ['a verifier of 129 characters', { verifier: 'a'.repeat(129) }],
    ['a verifier that is not base64url', { verifier: `${'a'.repeat(42)}+` }],
    ['no device', { device: undefined }],
    ['a device that is not an object', { device: 'a Mac' }],
    ['a device with no name', { device: {} }],
    ['an empty device name', { device: { name: '' } }],
    ['a device name of 65 characters', { device: { name: 'x'.repeat(65) } }],
    ['a device name with a newline', { device: { name: 'Mac\nSet-Cookie: x=1' } }],
    ['a device name with a control character', { device: { name: 'Mac\u0007' } }],
    ['a device name with a line separator', { device: { name: 'Mac ' } }],
    ['a device with a field it does not declare', { device: { name: 'Mac', model: 'x' } }],
    ['a field the body does not declare', { extra: 1 }],
  ])('refuses %s with 400 before the code is looked at', async (_name, change) => {
    const person = await aSignedInUser(db, clock, 'bad');
    const { verifier, challenge, state } = aVerifier();
    const { code } = await authorize(person, { challenge, state });
    const response = await post('/api/native/token', { code, verifier, device: DEVICE, ...change });
    expect(response.status).toBe(400);
    // Nothing was spent and nothing was counted: the shape is the edge's, the code is the module's.
    const row = await db
      .selectFrom('native_authorizations')
      .select(['spent_at', 'wrong_verifiers'])
      .where('user_id', '=', person.userId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ spent_at: null, wrong_verifiers: 0 });
  });

  test('records the device and the application version on the session, for whoever reads it', async () => {
    const person = await aSignedInUser(db, clock, 'label');
    const { verifier, challenge, state } = aVerifier();
    const { code } = await authorize(person, { challenge, state });
    const response = await token(
      { code, verifier },
      { 'x-purlay-client': 'macos/1.2.3 contract/1', 'user-agent': 'PurlayTest/9' },
    );
    expect(response.status).toBe(204);
    const row = await db
      .selectFrom('sessions')
      .select('user_agent')
      .where('user_id', '=', person.userId)
      .where('user_agent', 'like', 'Purlay for macOS%')
      .executeTakeFirstOrThrow();
    expect(row.user_agent).toBe('Purlay for macOS/1.2.3 (Doğancan’s MacBook Pro)');
  });

  test('says "unknown" for a version nobody gave, and never copies a header it did not parse', async () => {
    const person = await aSignedInUser(db, clock, 'unversioned');
    const { verifier, challenge, state } = aVerifier();
    const { code } = await authorize(person, { challenge, state });
    await token({ code, verifier }, { 'x-purlay-client': 'macos/1.2.3 contract/x; <script>' });
    const row = await db
      .selectFrom('sessions')
      .select('user_agent')
      .where('user_id', '=', person.userId)
      .where('user_agent', 'like', 'Purlay for macOS%')
      .executeTakeFirstOrThrow();
    expect(row.user_agent).toBe('Purlay for macOS/unknown (Doğancan’s MacBook Pro)');
  });

  test('five at once with one code: one session, four refusals', async () => {
    const person = await aSignedInUser(db, clock, 'race');
    const { verifier, challenge, state } = aVerifier();
    const { code } = await authorize(person, { challenge, state });
    const answers = await Promise.all(
      Array.from({ length: 5 }, async () => await token({ code, verifier })),
    );
    expect(answers.map((answer) => answer.status).sort()).toEqual([204, 404, 404, 404, 404]);
  });

  test('is charged to the client’s address before the code is looked at, as the passport is', async () => {
    const strict = createApp(
      testDependencies({
        database: db,
        clock,
        config: testConfig({ APP_URL: origin }),
        rateBudgets: {
          auth: { perSecond: 100, burst: 1000 },
          writes: { perSecond: 100, burst: 1000 },
          costlyReads: { perSecond: 100, burst: 1000 },
          nativeTokens: NATIVE_TOKEN_BUDGET,
        },
      }),
    );
    const statuses: number[] = [];
    for (let i = 0; i < NATIVE_TOKEN_BUDGET.burst + 2; i += 1) {
      statuses.push(
        (await token({ code: '2'.repeat(64), verifier: aVerifier().verifier }, {}, strict)).status,
      );
    }
    expect(statuses.slice(0, NATIVE_TOKEN_BUDGET.burst).every((status) => status === 404)).toBe(
      true,
    );
    expect(statuses.slice(NATIVE_TOKEN_BUDGET.burst)).toEqual([429, 429]);
  });
});

describe('integration: a session the handoff made, on a real socket', () => {
  const connect = async (value: string): Promise<WebSocket> => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`, {
      headers: { cookie: `__Host-purlay_session=${value}`, origin },
    } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve();
      });
      socket.addEventListener('error', () => {
        reject(new Error('the socket did not open'));
      });
    });
    return socket;
  };

  test('opens a socket, and is ended with the code the sign-out always ends one with', async () => {
    const person = await aSignedInUser(db, clock, 'socket');
    const { verifier, challenge, state } = aVerifier();
    const { code } = await authorize(person, { challenge, state });
    const value = cookieOf(await token({ code, verifier }));

    const socket = await connect(value);
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener('close', (event) => {
        resolve(event.code);
      });
    });
    const out = await fetch(`http://127.0.0.1:${String(port)}/auth/logout`, {
      method: 'POST',
      headers: { cookie: `__Host-purlay_session=${value}`, origin },
    });
    expect(out.status).toBe(204);
    expect(await closed).toBe(CLOSE_CODES.SESSION_ENDED);
  });
});
