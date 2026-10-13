/**
 * The HTTP limits, through the real application.
 *
 * `handle` has no socket, so there is no peer address: every request is from
 * the one unknown client. That is what makes the spoofing cases exact — if a
 * header could change who the client is, rotating it here would get a fresh
 * budget, and these would see it.
 */
import { describe, expect, test } from 'bun:test';
import { createApp } from './app';
import {
  AUTH_BUDGET,
  COSTLY_READ_BUDGET,
  GITHUB_CALL_BUDGET,
  WRITE_BUDGET,
  budgetsFor,
  httpLimits,
  retryAfterSeconds,
} from './rate-limit';
import { fixedClock } from '../../platform/clock';
import {
  NOW,
  aDatabaseThatMustNotBeTouched,
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

const signIn = async (
  app: ReturnType<typeof createApp>,
  headers: Record<string, string> = {},
): Promise<Response> =>
  await app.handle(new Request('https://purlay.test/auth/github', { headers }));

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
    expect(statuses.slice(0, AUTH_BUDGET.burst).every((status) => status === 302)).toBe(true);
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
    expect((await signIn(app, { 'x-forwarded-for': '198.51.100.2' })).status).toBe(302);
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
      database: aDatabaseThatMustNotBeTouched(),
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

describe('the budgets a server is started with (#522)', () => {
  test('are the product’s unless the configuration asks for roomy ones', () => {
    expect(budgetsFor({})).toBeUndefined();
    const roomy = budgetsFor({ RATE_BUDGETS: 'roomy' });
    expect(roomy?.writes.burst).toBeGreaterThan(WRITE_BUDGET.burst * 1000);
    expect(roomy?.costlyReads.burst).toBeGreaterThan(COSTLY_READ_BUDGET.burst * 1000);
    // Sign-in is per address, not per person: the browser suite does not share it, so it stays.
    expect(roomy?.auth).toEqual(AUTH_BUDGET);
  });
});
