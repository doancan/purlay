/**
 * The callback's failures that need no database: the ones that happen before an
 * account is looked at, and every reason the sign-in library can give, each turned
 * into one of ours. Each comes back as the sign-in screen with a reason, never as
 * the API's JSON (D-121). The ones that touch the database are in
 * `auth.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { DatabaseUnavailableError } from '@purlay/db';
import { AUTH_BASE_PATH, SIGN_IN_CALLBACK, type SignInFailure } from '@purlay/types';
import { createApp } from './app';
import type { Auth } from '../../modules/auth/better-auth';
import { AUTH_BUDGET, COSTLY_READ_BUDGET, WRITE_BUDGET } from './rate-limit';
import {
  aDatabaseThatMustNotBeTouched,
  aRecordingLogger,
  testDependencies,
} from '../../testing/doubles';
import { STATE_COOKIE } from '../../platform/cookies';

const ORIGIN = 'https://purlay.test';

/**
 * The library, answering every request with this — and touching nothing else. It has no route table,
 * so a log line names any path under its base by the placeholder (`routeOf`).
 */
const aLibraryThatAnswers = (answer: () => Response): Auth =>
  new Proxy({} as Auth, {
    get: (_target, property): unknown => {
      if (property === 'handler') return () => Promise.resolve(answer());
      if (property === 'answer') {
        return () => Promise.resolve({ response: answer(), lostSignUpRace: false });
      }
      if (property === 'routeOf') return () => `${AUTH_BASE_PATH}/*`;
      // A GitHub app is connected: what these tests are about is what the library answers to it.
      if (property === 'github') return true;
      throw new Error(
        `the sign-in library was reached (\`${String(property)}\`) beyond its handler`,
      );
    },
  });

describe('a sign-in that cannot finish for want of capacity', () => {
  test('a callback past the sign-in budget is sent back as busy, not answered 429 JSON', async () => {
    const app = createApp(
      testDependencies({
        auth: aLibraryThatAnswers(() => {
          throw new Error('the budget refuses the callback before the library sees it');
        }),
        rateBudgets: { auth: AUTH_BUDGET, writes: WRITE_BUDGET, costlyReads: COSTLY_READ_BUDGET },
      }),
    );
    for (let i = 0; i < AUTH_BUDGET.burst; i += 1) {
      await app.handle(new Request(`${ORIGIN}/auth/github`));
    }
    // The budget is spent; the callback is refused before its handler runs.
    const response = await app.handle(
      new Request(`${ORIGIN}${SIGN_IN_CALLBACK}?code=a-valid-code&state=anything`),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=busy`);
    // Every other route under /auth/ keeps the API's answer.
    const other = await app.handle(new Request(`${ORIGIN}/auth/github`));
    expect(other.status).toBe(429);
  });

  test('a callback that finds no database connection is sent back as busy', async () => {
    // The library reaches the database before anything else: what the browser carries back is the
    // callback, and the library meets the pool there.
    const app = createApp(
      testDependencies({
        database: aDatabaseThatMustNotBeTouched(new DatabaseUnavailableError('pool exhausted')),
        auth: aLibraryThatAnswers(() => {
          throw new DatabaseUnavailableError('pool exhausted');
        }),
      }),
    );
    const response = await app.handle(
      new Request(`${ORIGIN}${SIGN_IN_CALLBACK}?code=a-valid-code&state=a-state`),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=busy`);
  });
});

/** What the browser is sent on, when the library answered the callback with this. */
const sentOnFrom = async (
  answer: () => Response,
): Promise<{ readonly response: Response; readonly lines: Record<string, unknown>[] }> => {
  const { log, lines } = aRecordingLogger();
  const app = createApp(testDependencies({ auth: aLibraryThatAnswers(answer), log }));
  const response = await app.handle(
    new Request(`${ORIGIN}${SIGN_IN_CALLBACK}?code=a-code&state=a-state`),
  );
  return { response, lines };
};

const toTheErrorPage = (code: string) => (): Response =>
  new Response(null, {
    status: 302,
    headers: {
      location: `${ORIGIN}/sign-in?error=${code}&error_description=The+library+says+why`,
      'set-cookie': `${STATE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
    },
  });

describe('every reason the library gives is one of ours (D-121)', () => {
  const MAPPED: readonly (readonly [string, SignInFailure])[] = [
    ['state_not_found', 'expired'],
    ['state_mismatch', 'expired'],
    ['state_invalid', 'expired'],
    ['state_security_mismatch', 'expired'],
    ['please_restart_the_process', 'expired'],
    ['no_code', 'expired'],
    ['invalid_code', 'github-unavailable'],
    ['unable_to_get_user_info', 'email-required'],
    ['email_not_found', 'email-required'],
    ['email_not_verified', 'email-required'],
    ['account_not_linked', 'email-taken'],
    ['signup_disabled', 'signup-closed'],
    ['unable_to_link_account', 'failed'],
    ['unable_to_create_user', 'failed'],
    ['unable_to_create_session', 'failed'],
    ['internal_server_error', 'failed'],
  ];

  for (const [code, failure] of MAPPED) {
    test(`${code} is ${failure}, and nothing the library said is in the address`, async () => {
      const { response, lines } = await sentOnFrom(toTheErrorPage(code));
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=${failure}`);
      expect(response.headers.getSetCookie().some((c) => c.startsWith(`${STATE_COOKIE}=;`))).toBe(
        true,
      );
      expect(lines.find((line) => line['libraryError'] === code)).toBeDefined();
    });
  }

  test('a reason nobody anticipated is failed, never the library’s own word, and logged as an error', async () => {
    const { response: inherited, lines: told } = await sentOnFrom(toTheErrorPage('constructor'));
    expect(inherited.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=failed`);
    // Not a reason of ours, so said as the unanticipated one — not a crash on the way to `failed`.
    expect(told.find((line) => line['libraryError'] === 'constructor')).toMatchObject({
      level: 'error',
      msg: 'a GitHub sign-in failed for a reason nobody anticipated',
    });
    const { response, lines } = await sentOnFrom(toTheErrorPage('some_new_library_reason'));
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=failed`);
    expect(response.headers.get('location')).not.toContain('some_new_library_reason');
    expect(lines.find((line) => line['libraryError'] === 'some_new_library_reason')).toMatchObject({
      level: 'error',
    });
  });

  test('a success goes home as the library sent it, its cookies with it', async () => {
    const { response } = await sentOnFrom(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: ORIGIN, 'set-cookie': '__Host-purlay_session=t.s; Path=/' },
        }),
    );
    expect(response.headers.get('location')).toBe(ORIGIN);
    expect(response.headers.get('set-cookie')).toContain('__Host-purlay_session=t.s');
  });

  for (const [status, failure] of [
    [429, 'busy'],
    [503, 'busy'],
    [502, 'github-unavailable'],
    [500, 'failed'],
    [400, 'failed'],
  ] as const) {
    test(`an answer of ${String(status)} instead of a redirect is ${failure}, never JSON`, async () => {
      const { response } = await sentOnFrom(() => Response.json({ code: 'X' }, { status }));
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=${failure}`);
      expect(response.headers.get('content-type') ?? '').not.toContain('json');
    });
  }

  test('a library that throws on the callback is failed too, its cause logged', async () => {
    const { response, lines } = await sentOnFrom(() => {
      throw new Error('a defect, not an outage');
    });
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=failed`);
    const failure = lines.find((line) => line['msg'] === 'request failed');
    expect(failure).toMatchObject({ level: 'error', path: SIGN_IN_CALLBACK });
  });
});
