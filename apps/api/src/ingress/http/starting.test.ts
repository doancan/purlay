/**
 * The window between listening and having read the settings (D-93, D-179 §6): a request that needs the
 * sign-in library is told the server is busy, as a client retries; what needs nothing is answered; and
 * once the settings are read the real instance answers, and only that one.
 */
import { describe, expect, test } from 'bun:test';
import { createApp } from './app';
import { SESSION_COOKIE } from '../../platform/cookies';
import { AppError } from '../../platform/errors';
import {
  aRecordingLogger,
  anAuthThatMustNotBeTouched,
  testDependencies,
} from '../../testing/doubles';
import { SETTINGS_NOT_READ, runtimeServicesHolder } from '../../modules/setup/runtime';
import type { ServerSettings } from '../../modules/setup/settings';
import { createLogger } from '../../platform/logging';

const silent = createLogger({ level: 'silent' });
const servicesAwaited = (): ReturnType<typeof runtimeServicesHolder> =>
  runtimeServicesHolder(silent);
const NOTHING_SET: ServerSettings = {
  signUp: 'invite-only',
  github: undefined,
  oidc: undefined,
  smtp: undefined,
  workspaceCreators: { kind: 'first' },
  setupCompletedAt: undefined,
};

const ORIGIN = 'https://purlay.test';

const statusAndCode = async (response: Response): Promise<[number, string | undefined]> => [
  response.status,
  ((await response.json()) as { error?: { code?: string } }).error?.code,
];

describe('before the settings are read', () => {
  test('a request that needs the sign-in library is answered 503, as a busy server, and changes nothing', async () => {
    const awaited = servicesAwaited();
    const app = createApp(testDependencies({ auth: awaited.auth }));
    // With a session cookie, so the request gets as far as asking the library who it is.
    const headers = { cookie: `${SESSION_COOKIE}=a-token.a-signature` };
    for (const path of ['/api/me', '/api/auth/methods', '/auth/github', '/auth/get-session']) {
      const response = await app.handle(new Request(`${ORIGIN}${path}`, { headers }));
      expect([path, ...(await statusAndCode(response))]).toEqual([
        path,
        503,
        'DATABASE_UNAVAILABLE',
      ]);
    }
    // The line each refusal writes names a library path by the placeholder, not by what was sent.
    const recording = aRecordingLogger();
    await createApp(testDependencies({ auth: awaited.auth, log: recording.log })).handle(
      new Request(`${ORIGIN}/auth/reset-password/a-reset-token`, { headers }),
    );
    // Written after the response is handed back: waited for, as the line itself.
    const requestLine = async (): Promise<Record<string, unknown> | undefined> => {
      for (let tries = 0; tries < 100; tries += 1) {
        const line = recording.lines.find((written) => written['msg'] === 'request');
        if (line !== undefined) return line;
        await Bun.sleep(10);
      }
      return undefined;
    };
    expect(await requestLine()).toMatchObject({
      path: '/auth/*',
      status: 503,
    });
    expect(JSON.stringify(recording.lines)).not.toContain('a-reset-token');
    // Liveness needs nothing, and answers.
    expect((await app.handle(new Request(`${ORIGIN}/health`))).status).toBe(200);
  });

  test('readiness is told why it waits, rather than refused', async () => {
    const { auth } = servicesAwaited();
    expect(await auth.schemaProblem()).toBe(SETTINGS_NOT_READ);
    const reach = (): unknown => auth.handler;
    let refused: unknown;
    try {
      reach();
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).body.code).toBe('DATABASE_UNAVAILABLE');
  });

  test('once settled, every use reaches the instance the settings built; a second settle is refused', () => {
    const awaited = servicesAwaited();
    const reached = new Error('the settled instance was reached');
    awaited.settle({
      auth: anAuthThatMustNotBeTouched(reached),
      mailer: undefined,
      mail: undefined,
      needsReentry: [],
      settings: NOTHING_SET,
    });
    expect(() => awaited.auth.handler).toThrow(reached);
    expect(() => awaited.auth.schemaProblem).toThrow(reached);
    expect(awaited.current()?.mail).toBeUndefined();
    expect(() => {
      awaited.settle({
        auth: anAuthThatMustNotBeTouched(),
        mailer: undefined,
        mail: undefined,
        needsReentry: [],
        settings: NOTHING_SET,
      });
    }).toThrow('settled once');
  });
});
