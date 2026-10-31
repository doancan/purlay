/**
 * What the application writes to its log, through real requests (#127).
 *
 * A line per request that names the request, the cause of a failure the client
 * was told nothing about, D-38's record of a renamed account — and, across a
 * whole sign-in, not one session token, cookie or address.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  withRollback,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
} from '@purlay/db';
import { createApp } from './app';
import {
  aDatabaseThatMustNotBeTouched,
  aRecordingLogger,
  testDependencies,
} from '../../testing/doubles';
import {
  aGitHubAuth,
  aGitHubFor,
  aGitHubPerson,
  returnFromGitHub,
  signInWithGitHub,
  startGitHubSignIn,
  type GitHubPerson,
  type StartedSignIn,
} from '../../testing/github-sign-in';
import type { Logger } from '../../platform/logging';
import type { Auth } from '../../modules/auth/better-auth';
import { aSignedInUser, aTestAuth } from '../../testing/signed-in';
import { fixedClock } from '../../platform/clock';
import { aUserRow } from '../../testing/users';

// The sign-ins go through the library, whose transactions need a database of their own.
let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

/** A whole GitHub sign-in through the library, on the clone, writing to this log. */
const signIn = async (person: GitHubPerson, log: Logger): Promise<Response> => {
  const github = aGitHubFor(person);
  const app = createApp(
    testDependencies({
      database: cloned.db,
      clock,
      log,
      auth: aGitHubAuth(cloned.db, github.fetch, { log }),
    }),
  );
  return await signInWithGitHub(app, 'https://purlay.test', github);
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

  test('a request the edge turns away is written, under the id its response carries', async () => {
    const { log, lines } = aRecordingLogger();
    const app = createApp(
      testDependencies({ database: aDatabaseThatMustNotBeTouched(), clock, log }),
    );
    const tooLarge = await app.handle(
      new Request('https://purlay.test/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '70000' },
        body: 'x'.repeat(10),
      }),
    );
    const wrongType = await app.handle(
      new Request('https://purlay.test/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hello',
      }),
    );
    expect([tooLarge.status, wrongType.status]).toEqual([413, 415]);
    await written(lines, () => lines.filter((line) => line['msg'] === 'request').length === 2);
    expect(lines.filter((line) => line['msg'] === 'request')).toMatchObject([
      {
        level: 'info',
        requestId: tooLarge.headers.get('x-request-id'),
        status: 413,
        path: '/api/workspaces',
      },
      {
        level: 'info',
        requestId: wrongType.headers.get('x-request-id'),
        status: 415,
        path: '/api/workspaces',
      },
    ]);
  });

  test('a library answer is written with the status it went out with', async () => {
    const { log, lines } = aRecordingLogger();
    const app = createApp(testDependencies({ database: cloned.db, clock, log }));
    const response = await app.handle(
      new Request('https://purlay.test/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://purlay.test' },
        body: JSON.stringify({ email: 'nobody@purlay.test', password: 'not the password at all' }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    const line = await written(lines, (candidate) => candidate['msg'] === 'request');
    expect(line['status']).toBe(response.status);
  });

  test('health probes are written at debug, so a balancer polling them does not fill the log', async () => {
    await withRollback(async (db) => {
      const { log, lines } = aRecordingLogger();
      const app = createApp(testDependencies({ database: db, clock, log }));
      await app.handle(new Request('https://purlay.test/health'));
      await app.handle(new Request('https://purlay.test/health/ready'));
      const probes = ['/health', '/health/ready'];
      for (const path of probes) {
        const line = await written(lines, (l) => l['msg'] === 'request' && l['path'] === path);
        expect(line['level']).toBe('debug');
      }
      // A request that is not a probe is still an info line.
      await app.handle(new Request('https://purlay.test/api/me'));
      const other = await written(lines, (l) => l['msg'] === 'request' && l['path'] === '/api/me');
      expect(other['level']).toBe('info');
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
    const { log, lines } = aRecordingLogger();
    const person = aGitHubPerson(`quiet-logs-${crypto.randomUUID().slice(0, 6)}`);
    const signedIn = await signIn(person, log);
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get('location')).toBe('https://purlay.test');
    const session = signedIn.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('__Host-purlay_session='));
    const token =
      decodeURIComponent(session?.split(';')[0]?.split('=')[1] ?? '').split('.')[0] ?? '';
    expect(token.length).toBeGreaterThan(20);

    const written = JSON.stringify(lines);
    expect(lines.length).toBeGreaterThan(0);
    expect(written).not.toContain(token);
    expect(written).not.toContain(person.email);
    expect(written).not.toContain('purlay_session=');
    expect(written).not.toContain('gho_never_kept');
  });

  test('an account stored under another name than GitHub gave is written down (D-38)', async () => {
    const taken = await aUserRow(cloned.db, 'log-taken');
    const { log, lines } = aRecordingLogger();
    const person = aGitHubPerson(taken.username, {
      email: `second-of-that-name-${crypto.randomUUID().slice(0, 6)}@example.test`,
    });
    expect((await signIn(person, log)).headers.get('location')).toBe('https://purlay.test');
    expect(
      lines.find((line) => line['msg'] === 'username taken; stored with a suffix'),
    ).toMatchObject({
      level: 'warn',
      wanted: taken.username,
    });
  });

  test('what the sign-in library says goes to this log, without an address, a token, a cookie or a state', async () => {
    const { log, lines } = aRecordingLogger();
    const person = aGitHubPerson(`library-logs-${crypto.randomUUID().slice(0, 6)}`);
    const github = aGitHubFor(person);
    const app = createApp(
      testDependencies({
        database: cloned.db,
        clock,
        log,
        auth: aGitHubAuth(cloned.db, github.fetch, { log }),
      }),
    );
    // The library catches a failed sign-up and logs the database's error — which names the address.
    await sql`
      create function refuse_naming() returns trigger language plpgsql as
      $$ begin raise exception 'refused for %', new.email; end $$
    `.execute(cloned.db);
    await sql`create trigger refuse_naming before insert on users for each row execute function refuse_naming()`.execute(
      cloned.db,
    );
    let started: StartedSignIn;
    try {
      started = await startGitHubSignIn(app, 'https://purlay.test', github);
      const refused = await returnFromGitHub(app, 'https://purlay.test', started);
      expect(refused.headers.get('location')).toBe('https://purlay.test/sign-in?error=failed');
    } finally {
      await sql`drop trigger refuse_naming on users`.execute(cloned.db);
      await sql`drop function refuse_naming()`.execute(cloned.db);
    }
    // And a state that is not this browser's: the library logs why, naming the state.
    const stray = await startGitHubSignIn(app, 'https://purlay.test', github);
    await returnFromGitHub(app, 'https://purlay.test', { ...stray, cookie: '' });

    const fromLibrary = lines.filter((line) => line['msg'] === 'the sign-in library said');
    expect(fromLibrary.map((line) => line['said'])).toContain('Unable to create OAuth user');
    const written = JSON.stringify(lines);
    expect(written).toContain('refused for');
    expect(written).not.toContain(person.email);
    expect(written).not.toContain(stray.state);
    expect(written).not.toContain(started.state);
    expect(written).not.toContain('purlay_session=');
    expect(written).not.toContain('gho_');
  });

  /** Everything written to the console while the body runs: what reaches stdout and stderr past us. */
  const consoleDuring = async (body: () => Promise<void>): Promise<string> => {
    const said: string[] = [];
    const methods = ['error', 'warn', 'log', 'info', 'debug'] as const;
    const kept = methods.map((name) => console[name].bind(console));
    for (const name of methods) {
      console[name] = (...args: unknown[]): void => {
        said.push(
          args
            .map((arg) =>
              // Every own field of an error, a driver's `detail` among them.
              arg instanceof Error
                ? JSON.stringify(arg, Object.getOwnPropertyNames(arg))
                : String(arg),
            )
            .join(' '),
        );
      };
    }
    try {
      await body();
    } finally {
      methods.forEach((name, index) => {
        const original = kept[index];
        if (original !== undefined) console[name] = original;
      });
    }
    return said.join('\n');
  };

  test('a driver error the library does not catch is ours to log: nothing reaches the console (D-78)', async () => {
    const { log, lines } = aRecordingLogger();
    const person = aGitHubPerson(`uncaught-${crypto.randomUUID().slice(0, 6)}`);
    const github = aGitHubFor(person);
    const app = createApp(
      testDependencies({
        database: cloned.db,
        clock,
        log,
        auth: aGitHubAuth(cloned.db, github.fetch, { log }),
      }),
    );
    // The driver's own shape: a unique violation whose detail names the address.
    await sql`
      create function refuse_with_detail() returns trigger language plpgsql as
      $$ begin raise exception 'duplicate key value' using errcode = '23505',
         detail = 'Key (email)=(' || new.email || ') already exists.'; end $$
    `.execute(cloned.db);
    await sql`create trigger refuse_with_detail before update on users for each row execute function refuse_with_detail()`.execute(
      cloned.db,
    );
    let answered: Response | undefined;
    const printed = await consoleDuring(async () => {
      try {
        answered = await signInWithGitHub(app, 'https://purlay.test', github);
      } finally {
        await sql`drop trigger refuse_with_detail on users`.execute(cloned.db);
        await sql`drop function refuse_with_detail()`.execute(cloned.db);
      }
    });
    expect(answered?.headers.get('location')).toBe('https://purlay.test/sign-in?error=failed');
    expect(printed).not.toContain(person.email);
    expect(printed).not.toContain('already exists');
    expect(printed).not.toContain('SERVER_ERROR');
    const failure = lines.find((line) => line['msg'] === 'request failed');
    expect(failure).toMatchObject({ level: 'error', err: { errorCode: '23505' } });
    expect(JSON.stringify(lines)).not.toContain(person.email);
    expect(JSON.stringify(lines)).not.toContain('already exists');
  });

  test('a session lookup whose read fails reaches the console with nothing either', async () => {
    const { log, lines } = aRecordingLogger();
    const alice = await aSignedInUser(cloned.db, clock, 'lookup-fails');
    const failing = { on: false };
    // The read of the user behind a session fails, carrying the address as a driver's detail would.
    const database = cloned.db.withPlugin({
      transformQuery: (
        args,
      ): ReturnType<Parameters<Executor['withPlugin']>[0]['transformQuery']> => {
        if (failing.on && JSON.stringify(args.node).includes('"users"')) {
          throw Object.assign(new Error('the read failed'), {
            detail: `Key (email)=(${alice.email})`,
          });
        }
        return args.node;
      },
      transformResult: async (args) => await Promise.resolve(args.result),
    });
    const app = createApp(testDependencies({ database, clock, log }));
    let status = 0;
    const printed = await consoleDuring(async () => {
      failing.on = true;
      try {
        status = (
          await app.handle(
            new Request('https://purlay.test/api/me', { headers: { cookie: alice.cookie } }),
          )
        ).status;
      } finally {
        failing.on = false;
      }
    });
    expect(status).toBe(500);
    expect(printed).not.toContain(alice.email);
    expect(printed).not.toContain('Key (email)');
    expect(lines.find((line) => line['msg'] === 'request failed')).toMatchObject({
      level: 'error',
    });
    expect(JSON.stringify(lines)).not.toContain(alice.email);
  });

  /** A server whose statements matching `fails` throw an error carrying the address as its detail. */
  const aServerFailing = (
    log: Logger,
    email: string,
    fails: (node: { readonly kind: string }, text: string) => boolean,
    failing: { on: boolean },
  ): ReturnType<typeof createApp> =>
    createApp(
      testDependencies({
        database: cloned.db.withPlugin({
          transformQuery: (
            args,
          ): ReturnType<Parameters<Executor['withPlugin']>[0]['transformQuery']> => {
            if (failing.on && fails(args.node, JSON.stringify(args.node))) {
              throw Object.assign(new Error('the statement failed'), {
                detail: `Key (email)=(${email})`,
              });
            }
            return args.node;
          },
          transformResult: async (args) => await Promise.resolve(args.result),
        }),
        clock,
        log,
      }),
    );

  /** A token as a reset link would carry one: the kind of thing a path segment must never leak. */
  const RESET_TOKEN = `reset-${'f'.repeat(32)}`;

  for (const { sent, route, method, fails } of [
    {
      sent: '/auth/revoke-sessions',
      route: '/auth/revoke-sessions',
      method: 'POST',
      fails: (node: { readonly kind: string }, text: string): boolean =>
        node.kind === 'DeleteQueryNode' && text.includes('"sessions"'),
    },
    {
      sent: '/auth/get-session',
      route: '/auth/get-session',
      method: 'GET',
      fails: (node: { readonly kind: string }, text: string): boolean =>
        node.kind === 'SelectQueryNode' &&
        text.includes('"token_hash"') &&
        !text.includes('"sessions_ended"'),
    },
  ] as const) {
    test(`a failure the library answers itself on ${route} is written down once, by its route, and nothing reaches the console`, async () => {
      const { log, lines } = aRecordingLogger();
      const alice = await aSignedInUser(cloned.db, clock, 'library-500');
      const failing = { on: false };
      const app = aServerFailing(log, alice.email, fails, failing);
      let status = 0;
      const printed = await consoleDuring(async () => {
        failing.on = true;
        try {
          status = (
            await app.handle(
              new Request(
                `https://purlay.test${sent}${sent.includes('?') ? '&' : '?'}probe=${alice.username}`,
                {
                  method,
                  headers: {
                    cookie: alice.cookie,
                    origin: 'https://purlay.test',
                    ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
                  },
                  ...(method === 'POST' ? { body: '{}' } : {}),
                },
              ),
            )
          ).status;
        } finally {
          failing.on = false;
        }
      });
      expect(status).toBe(500);
      expect(printed).not.toContain(alice.email);
      expect(printed).not.toContain('Key (email)');
      const told = lines.filter((line) => line['msg'] === 'the sign-in library answered a failure');
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ level: 'error', status: 500, path: route });
      expect(lines.filter((line) => line['msg'] === 'request failed')).toEqual([]);
      const written = JSON.stringify(lines);
      expect(written).not.toContain(alice.email);
      expect(written).not.toContain('Key (email)');
      expect(written).not.toContain(alice.username);
      expect(written).not.toContain('probe=');
      expect(written).not.toContain(RESET_TOKEN);
      expect(written).not.toContain('purlay_session=');
    });
  }

  test('a failure the library throws on its route with a parameter is written by the route, never the token', async () => {
    const { log, lines } = aRecordingLogger();
    const alice = await aSignedInUser(cloned.db, clock, 'reset-500');
    const failing = { on: false };
    // The read of the reset's row fails under `GET /auth/reset-password/:token`: measured, the
    // library throws this one to us rather than answer it, so the edge writes it.
    const app = aServerFailing(
      log,
      alice.email,
      (node, text) => node.kind === 'SelectQueryNode' && text.includes('"verifications"'),
      failing,
    );
    let status = 0;
    const printed = await consoleDuring(async () => {
      failing.on = true;
      try {
        status = (
          await app.handle(
            new Request(
              `https://purlay.test/auth/reset-password/${RESET_TOKEN}?callbackURL=%2Fsign-in&probe=${alice.username}`,
            ),
          )
        ).status;
      } finally {
        failing.on = false;
      }
    });
    expect(status).toBe(500);
    expect(printed).not.toContain(alice.email);
    expect(printed).not.toContain(RESET_TOKEN);
    const failed = lines.filter((line) => line['msg'] === 'request failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ level: 'error', path: '/auth/reset-password/:token' });
    expect(
      lines.filter((line) => line['msg'] === 'the sign-in library answered a failure'),
    ).toEqual([]);
    const written = JSON.stringify(lines);
    expect(written).not.toContain(RESET_TOKEN);
    expect(written).not.toContain(alice.email);
    expect(written).not.toContain(alice.username);
    expect(written).not.toContain('probe=');
    expect(written).not.toContain('callbackURL');
  });

  /**
   * The library answering `500` to everything, with the real instance's route table: what the log
   * names a path by when the library has no route for it, or a route with a parameter in it, is
   * decided by ingress alone.
   */
  const aLibraryAnswering500 = (real: Auth): Auth =>
    new Proxy({} as Auth, {
      get: (_target, property): unknown => {
        const answer = (): Response =>
          Response.json(
            { code: 'FAILED_TO_GET_SESSION', message: 'the library says why' },
            { status: 500 },
          );
        if (property === 'handler') return () => Promise.resolve(answer());
        if (property === 'answer') {
          return () => Promise.resolve({ response: answer(), lostSignUpRace: false });
        }
        if (property === 'routeOf' || property === '$ERROR_CODES' || property === 'github') {
          return real[property];
        }
        throw new Error(
          `the sign-in library was reached (\`${String(property)}\`) beyond its handler`,
        );
      },
    });

  test('a 5xx the library answers is written by a route of its table, or /auth/*: never a segment the caller wrote', async () => {
    const { log, lines } = aRecordingLogger();
    const real = aTestAuth(cloned.db);
    const app = createApp(
      testDependencies({ database: cloned.db, clock, log, auth: aLibraryAnswering500(real) }),
    );
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    for (const sent of [
      `/auth/reset-password/${RESET_TOKEN}?callbackURL=%2Fsign-in`,
      `/auth/${first}/${second}?probe=${first}`,
      '/auth/revoke-sessions?probe=yes',
    ]) {
      expect(
        (
          await app.handle(
            new Request(`https://purlay.test${sent}`, {
              method: 'POST',
              headers: { origin: 'https://purlay.test', 'content-type': 'application/json' },
              body: '{}',
            }),
          )
        ).status,
      ).toBe(500);
    }
    const told = lines.filter((line) => line['msg'] === 'the sign-in library answered a failure');
    expect(told.map((line) => line['path'])).toEqual([
      '/auth/reset-password/:token',
      '/auth/*',
      '/auth/revoke-sessions',
    ]);
    expect(told.every((line) => line['libraryCode'] === 'FAILED_TO_GET_SESSION')).toBe(true);
    const written = JSON.stringify(lines);
    expect(written).not.toContain(RESET_TOKEN);
    expect(written).not.toContain(first);
    expect(written).not.toContain(second);
    expect(written).not.toContain('probe=');
    expect(written).not.toContain('callbackURL');
    expect(written).not.toContain('the library says why');
  });

  test('a request under the library’s path is written by its route: a reset link’s token and an unknown path’s segments never', async () => {
    const { log, lines } = aRecordingLogger();
    const app = createApp(testDependencies({ database: cloned.db, clock, log }));
    // Nobody issued the token: the library sends the browser back with `INVALID_TOKEN`.
    const reset = await app.handle(
      new Request(`https://purlay.test/auth/reset-password/${RESET_TOKEN}?callbackURL=%2Fsign-in`),
    );
    expect(reset.status).toBe(302);
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const unknown = await app.handle(new Request(`https://purlay.test/auth/${first}/${second}`));
    expect(unknown.status).toBe(404);
    // Written a tick after each response has gone.
    await written(lines, () => lines.filter((line) => line['msg'] === 'request').length === 2);
    const requests = lines.filter((line) => line['msg'] === 'request');
    expect(requests.map((line) => line['path'])).toEqual([
      '/auth/reset-password/:token',
      '/auth/*',
    ]);
    const everything = JSON.stringify(lines);
    expect(everything).not.toContain(RESET_TOKEN);
    expect(everything).not.toContain(first);
    expect(everything).not.toContain(second);
    expect(everything).not.toContain('callbackURL');
  });
});
