/**
 * The callback's failures that need no database: the ones that happen before an
 * account is looked at. Each comes back as the sign-in screen with a reason, never
 * as the API's JSON (D-121). The ones that touch the database are in
 * `auth.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { DatabaseUnavailableError } from '@purlay/db';
import { createApp } from './app';
import { AUTH_BUDGET, COSTLY_READ_BUDGET, WRITE_BUDGET } from './rate-limit';
import { aDatabaseThatMustNotBeTouched, testDependencies } from '../../testing/doubles';

const ORIGIN = 'https://purlay.test';

/** A sign-in started and come back from GitHub with a code, as a browser carries it. */
const signIn = async (app: ReturnType<typeof createApp>): Promise<Response> => {
  const started = await app.handle(new Request(`${ORIGIN}/auth/github`));
  const state = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';
  return await app.handle(
    new Request(`${ORIGIN}/auth/github/callback?code=a-valid-code&state=${state}`, {
      headers: { cookie: (started.headers.get('set-cookie') ?? '').split(';')[0] ?? '' },
    }),
  );
};

describe('a sign-in that cannot finish for want of capacity', () => {
  test('a callback past the sign-in budget is sent back as busy, not answered 429 JSON', async () => {
    const app = createApp(
      testDependencies({
        rateBudgets: { auth: AUTH_BUDGET, writes: WRITE_BUDGET, costlyReads: COSTLY_READ_BUDGET },
      }),
    );
    for (let i = 0; i < AUTH_BUDGET.burst; i += 1) {
      await app.handle(new Request(`${ORIGIN}/auth/github`));
    }
    // The budget is spent; the callback is refused before its handler runs.
    const response = await app.handle(
      new Request(`${ORIGIN}/auth/github/callback?code=a-valid-code&state=anything`),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=busy`);
    // Every other route under /auth/ keeps the API's answer.
    const other = await app.handle(new Request(`${ORIGIN}/auth/github`));
    expect(other.status).toBe(429);
  });

  test('a callback that finds no database connection is sent back as busy', async () => {
    const app = createApp(
      testDependencies({
        database: aDatabaseThatMustNotBeTouched(new DatabaseUnavailableError('pool exhausted')),
      }),
    );
    const response = await signIn(app);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=busy`);
  });
});
