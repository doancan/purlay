/**
 * The HTTP limits, through the real application.
 *
 * `handle` has no socket, so there is no peer address: every request is from
 * the one unknown client. That is what makes the spoofing cases exact — if a
 * header could change who the client is, rotating it here would get a fresh
 * budget, and these would see it.
 */
import { describe, expect, test } from 'bun:test';
import { unconnectedDatabase } from '@purlay/db';
import { createApp } from './app';
import {
  AUTH_BUDGET,
  COSTLY_READ_BUDGET,
  GITHUB_CALL_BUDGET,
  WRITE_BUDGET,
  httpLimits,
  retryAfterSeconds,
} from './rate-limit';
import { fixedClock } from '../../platform/clock';
import {
  NOW,
  anAuthThatMustNotBeTouched,
  testConfig,
  testDependencies,
} from '../../testing/doubles';

const appWith = (trustProxy: boolean): ReturnType<typeof createApp> =>
  createApp(
    testDependencies({
      config: testConfig({ TRUST_PROXY: trustProxy }),
      rateBudgets: { auth: AUTH_BUDGET, writes: WRITE_BUDGET, costlyReads: COSTLY_READ_BUDGET },
    }),
  );

/**
 * A request under /auth/ that touches nothing behind the edge: signing out with no session. The sign-in
 * library's own routes read their database, which these tests do not have.
 */
const signIn = async (
  app: ReturnType<typeof createApp>,
  headers: Record<string, string> = {},
): Promise<Response> =>
  await app.handle(new Request('https://purlay.test/auth/logout', { method: 'POST', headers }));

const exhaust = async (
  app: ReturnType<typeof createApp>,
  headersFor: (i: number) => Record<string, string> = () => ({}),
): Promise<number[]> => {
  const statuses: number[] = [];
  for (let i = 0; i < AUTH_BUDGET.burst + 5; i += 1) {
    statuses.push((await signIn(app, headersFor(i))).status);
  }
  return statuses;
};

describe('rate limiting /auth/*', () => {
  test('a client gets its burst, then 429 with RATE_LIMITED and a Retry-After', async () => {
    const app = appWith(false);
    const statuses = await exhaust(app);
    expect(statuses.slice(0, AUTH_BUDGET.burst).every((status) => status === 204)).toBe(true);
    expect(statuses.slice(AUTH_BUDGET.burst)).toEqual([429, 429, 429, 429, 429]);

    const refused = await signIn(app);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe(String(retryAfterSeconds(AUTH_BUDGET)));
    expect(await refused.json()).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' },
    });
    // The refusal still carries the edge's headers and a request id.
    expect(refused.headers.get('x-request-id')).not.toBeNull();
    expect(refused.headers.get('x-content-type-options')).toBe('nosniff');
  });

  /** The attack: a fresh X-Forwarded-For per request to get a fresh budget. */
  test('without a trusted proxy a spoofed X-Forwarded-For buys no extra budget', async () => {
    const statuses = await exhaust(appWith(false), (i) => ({
      'x-forwarded-for': `198.51.100.${String(i + 1)}`,
    }));
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });

  test('behind a trusted proxy each client address has its own budget', async () => {
    const app = appWith(true);
    const statuses = await exhaust(app, () => ({ 'x-forwarded-for': '198.51.100.1' }));
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
    // Another client, as the proxy reports it, is untouched.
    expect((await signIn(app, { 'x-forwarded-for': '198.51.100.2' })).status).toBe(204);
  });

  test('behind a trusted proxy the entries a client wrote are not the key', async () => {
    // The proxy appends the real address last; the client chooses everything before it.
    const statuses = await exhaust(appWith(true), (i) => ({
      'x-forwarded-for': `203.0.113.${String(i + 1)}, 198.51.100.1`,
    }));
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });

  test('the limit covers the whole of /auth/, logout included, and nothing else', async () => {
    const app = appWith(false);
    await exhaust(app);
    expect(
      (await app.handle(new Request('https://purlay.test/auth/logout', { method: 'POST' }))).status,
    ).toBe(429);
    expect((await app.handle(new Request('https://purlay.test/health'))).status).toBe(200);
  });

  test('a retry hint is at least a second and tracks the refill rate', () => {
    expect(retryAfterSeconds({ perSecond: 100, burst: 1 })).toBe(1);
    expect(retryAfterSeconds({ perSecond: 0.1, burst: 1 })).toBe(10);
  });
});

describe('the budgets in force', () => {
  /** Tests run with a roomy budget; this is what stops that being the only one ever exercised. */
  test('unless told otherwise, the limits are the provisional ones', async () => {
    const admit = httpLimits({
      auth: anAuthThatMustNotBeTouched(),
      clock: fixedClock(NOW),
      trustProxy: false,
    });
    const request = new Request('https://purlay.test/auth/github');
    for (let i = 0; i < AUTH_BUDGET.burst; i += 1) {
      expect(await admit(request, '203.0.113.9')).toBeUndefined();
    }
    expect(await admit(request, '203.0.113.9')).toBe(retryAfterSeconds(AUTH_BUDGET));
    // The write budget is the socket's, so the two doors cost the same.
    expect(WRITE_BUDGET).toEqual({ perSecond: 10, burst: 20 });
    // A page of cards and pictures is asked for at once; their own bucket holds more than a burst.
    expect(COSTLY_READ_BUDGET).toEqual({ perSecond: 10, burst: 60 });
    // Under the hourly quota of the workspace's one GitHub token, however many members ask.
    expect(GITHUB_CALL_BUDGET.burst + GITHUB_CALL_BUDGET.perSecond * 3600).toBeLessThan(5_000);
  });
});

describe('rate limiting GET /api/client (D-186)', () => {
  const ask = async (app: ReturnType<typeof createApp>, address = ''): Promise<Response> =>
    await app.handle(
      new Request('https://purlay.test/api/client', {
        headers: address === '' ? {} : { 'x-forwarded-for': address },
      }),
    );
  const anApp = (trustProxy: boolean): ReturnType<typeof createApp> =>
    createApp(
      testDependencies({
        database: unconnectedDatabase(),
        config: testConfig({ TRUST_PROXY: trustProxy }),
        rateBudgets: { auth: AUTH_BUDGET, writes: WRITE_BUDGET, costlyReads: COSTLY_READ_BUDGET },
      }),
    );

  // Public and asked before anybody has signed in, so it is charged to the address, not to a user: it
  // is the one route a stranger can call at will that is not under /auth/.
  test('a client gets the sign-in burst, then 429 with a Retry-After', async () => {
    const app = anApp(false);
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_BUDGET.burst + 3; i += 1) statuses.push((await ask(app)).status);
    expect(statuses.slice(0, AUTH_BUDGET.burst).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(AUTH_BUDGET.burst)).toEqual([429, 429, 429]);
    const refused = await ask(app);
    expect(refused.headers.get('retry-after')).toBe(String(retryAfterSeconds(AUTH_BUDGET)));
  });

  test('it is the sign-in bucket: what a client spends here it does not have for /auth/', async () => {
    const app = anApp(false);
    for (let i = 0; i < AUTH_BUDGET.burst; i += 1) await ask(app);
    const signOut = await app.handle(
      new Request('https://purlay.test/auth/logout', { method: 'POST' }),
    );
    expect(signOut.status).toBe(429);
  });

  test('behind a trusted proxy each address has its own, and a spoofed prefix buys nothing', async () => {
    const app = anApp(true);
    for (let i = 0; i < AUTH_BUDGET.burst; i += 1) {
      expect((await ask(app, `203.0.113.${String(i + 1)}, 198.51.100.1`)).status).toBe(200);
    }
    expect((await ask(app, '203.0.113.99, 198.51.100.1')).status).toBe(429);
    expect((await ask(app, '198.51.100.2')).status).toBe(200);
  });
});
