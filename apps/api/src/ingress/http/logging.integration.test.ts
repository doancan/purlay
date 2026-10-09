/**
 * What the application writes to its log, through real requests (#127).
 *
 * A line per request that names the request, the cause of a failure the client
 * was told nothing about, D-38's record of a renamed account — and, across a
 * whole sign-in, not one session token, cookie or address.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { createApp } from './app';
import {
  aDatabaseThatMustNotBeTouched,
  aGitHubAccount,
  aRecordingLogger,
  testDependencies,
} from '../../testing/doubles';
import { aSignedInUser } from '../../testing/signed-in';
import { fixedClock } from '../../platform/clock';
import { aUserRow } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const signIn = async (
  db: Executor,
  github: ReturnType<typeof aGitHubAccount>,
  log: ReturnType<typeof aRecordingLogger>['log'],
): Promise<Response> => {
  const app = createApp(testDependencies({ database: db, clock, github, log }));
  const started = await app.handle(new Request('https://purlay.test/auth/github'));
  const state = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';
  const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return await app.handle(
    new Request(`https://purlay.test/auth/github/callback?code=${github.accepts}&state=${state}`, {
      headers: { cookie },
    }),
  );
};

/** The first line matching, once it has been written; a test fails rather than waits forever. */
const written = async (
  lines: readonly Record<string, unknown>[],
  matches: (line: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> => {
  const deadline = performance.now() + 2_000;
  for (;;) {
    const line = lines.find(matches);
    if (line !== undefined) return line;
    if (performance.now() > deadline) throw new Error('the line was never written');
    await Bun.sleep(1);
  }
};

describe('integration: the log', () => {
  test('a request writes one line, carrying the id its response carries', async () => {
    await withRollback(async (db) => {
      const { log, lines } = aRecordingLogger();
      const user = await aSignedInUser(db, clock, 'log-me');
      const response = await createApp(testDependencies({ database: db, clock, log })).handle(
        new Request('https://purlay.test/api/me', { headers: { cookie: user.cookie } }),
      );
      expect(response.status).toBe(200);
      const requestId = response.headers.get('x-request-id');
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

      // Written after the response has gone — measured, a tick after `handle`
      // returns — so the test waits for the line rather than reading too early.
      const request = await written(lines, (line) => line['msg'] === 'request');
      expect(request).toMatchObject({ requestId, method: 'GET', path: '/api/me', status: 200 });
      expect(lines.filter((line) => line['msg'] === 'request')).toHaveLength(1);
    });
  });

  test('a failure the client is told nothing about is written with its cause', async () => {
    const { log, lines } = aRecordingLogger();
    // A session cookie sends the request to the database, which here refuses.
    const response = await createApp(
      testDependencies({ database: aDatabaseThatMustNotBeTouched(), log }),
    ).handle(
      new Request('https://purlay.test/api/me', {
        headers: { cookie: '__Host-purlay_session=anything' },
      }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: 'INTERNAL', message: 'Something went wrong.' },
    });
    const failure = lines.find((line) => line['msg'] === 'request failed');
    expect(failure).toMatchObject({ level: 'error', path: '/api/me', err: { type: 'Error' } });
    expect(String((failure?.['err'] as { stack?: unknown } | undefined)?.stack)).toContain(
      'must not touch it',
    );
    expect(failure?.['requestId']).toBe(response.headers.get('x-request-id'));
  });

  test('a whole sign-in writes no token, no cookie and no address', async () => {
    await withRollback(async (db) => {
      const { log, lines } = aRecordingLogger();
      const github = aGitHubAccount(
        { id: 7001, login: 'quiet-logs', name: null, avatarUrl: null },
        [{ email: 'quiet-logs@example.test', primary: true, verified: true }],
      );
      const signedIn = await signIn(db, github, log);
      expect(signedIn.status).toBe(302);
      const token = (signedIn.headers.getSetCookie()[0] ?? '').split(';')[0]?.split('=')[1] ?? '';
      expect(token.length).toBeGreaterThan(20);

      const written = JSON.stringify(lines);
      expect(lines.length).toBeGreaterThan(0);
      expect(written).not.toContain(token);
      expect(written).not.toContain('quiet-logs@example.test');
      expect(written).not.toContain('purlay_session=');
    });
  });

  test('an account stored under another name than GitHub gave is written down (D-38)', async () => {
    await withRollback(async (db) => {
      const taken = await aUserRow(db, 'log-taken');
      const { log, lines } = aRecordingLogger();
      const github = aGitHubAccount(
        { id: 7002, login: taken.username, name: null, avatarUrl: null },
        [{ email: 'second-of-that-name@example.test', primary: true, verified: true }],
      );
      expect((await signIn(db, github, log)).status).toBe(302);
      expect(
        lines.find((line) => line['msg'] === 'username taken; stored with a suffix'),
      ).toMatchObject({
        level: 'warn',
        wanted: taken.username,
      });
    });
  });
});
