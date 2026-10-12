/**
 * The per-user write limit and the session's recorded address, against a real
 * database. The unauthenticated half is `rate-limit.test.ts`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { createApp } from './app';
import { NOW, testConfig, testDependencies } from '../../testing/doubles';
import { aSignedInUser } from '../../testing/signed-in';
import { AUTH_BUDGET, COSTLY_READ_BUDGET, WRITE_BUDGET } from './rate-limit';
import { fixedClock } from '../../platform/clock';
import { aUniqueSlug } from '../../testing/users';
import { STATE_COOKIE } from '../../platform/cookies';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';
const clock = fixedClock(NOW);

const post = async (
  app: ReturnType<typeof createApp>,
  cookie: string,
  path: string,
  body: unknown,
): Promise<Response> =>
  await app.handle(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('integration: the per-user write limit', () => {
  test('a user who writes past the budget is told to wait; another user is not', async () => {
    await withRollback(async (db) => {
      const app = createApp(
        testDependencies({
          database: db,
          clock,
          rateBudgets: { auth: AUTH_BUDGET, writes: WRITE_BUDGET, costlyReads: COSTLY_READ_BUDGET },
        }),
      );
      const busy = await aSignedInUser(db, clock, 'rl-busy');
      const quiet = await aSignedInUser(db, clock, 'rl-quiet');

      const create = async (cookie: string): Promise<Response> => {
        const slug = aUniqueSlug('rl');
        return await post(app, cookie, '/api/workspaces', { name: slug, slug });
      };
      for (let i = 0; i < WRITE_BUDGET.burst; i += 1) {
        expect((await create(busy.cookie)).status).toBe(201);
      }
      const refused = await create(busy.cookie);
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBe('1');
      expect(await refused.json()).toEqual({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' },
      });

      expect((await create(quiet.cookie)).status).toBe(201);
    });
  });

  /** The send path that used to be unthrottled while the socket's was not (#235). */
  test('the HTTP send path is held to the budget, and reads are not counted', async () => {
    await withRollback(async (db) => {
      const app = createApp(
        testDependencies({
          database: db,
          clock,
          rateBudgets: { auth: AUTH_BUDGET, writes: WRITE_BUDGET, costlyReads: COSTLY_READ_BUDGET },
        }),
      );
      const user = await aSignedInUser(db, clock, 'rl-send');
      const slug = aUniqueSlug('rl-send');
      const workspace = (await (
        await post(app, user.cookie, '/api/workspaces', { name: slug, slug })
      ).json()) as { id: string };
      const channel = (await (
        await post(app, user.cookie, `/api/workspaces/${workspace.id}/channels`, {
          name: 'general',
        })
      ).json()) as { id: string };

      // Two writes spent; the rest of the burst goes to messages.
      const statuses: number[] = [];
      for (let i = 0; i < WRITE_BUDGET.burst; i += 1) {
        const response = await post(app, user.cookie, `/api/channels/${channel.id}/messages`, {
          id: messageId(NOW),
          content: `message ${String(i)}`,
        });
        statuses.push(response.status);
      }
      expect(statuses.filter((status) => status === 201)).toHaveLength(WRITE_BUDGET.burst - 2);
      expect(statuses.filter((status) => status === 429)).toHaveLength(2);

      // A read is not a write: still served while writes are refused.
      const history = await app.handle(
        new Request(`${ORIGIN}/api/channels/${channel.id}/messages`, {
          headers: { cookie: user.cookie },
        }),
      );
      expect(history.status).toBe(200);
    });
  });

  /**
   * Drawing a channel asks for its cards and pictures — a request per link. They were charged to the
   * bucket a person sends with, so a page with twenty-odd GitHub links spent it, and the person's next
   * message was refused (found in the browser suite as a 429 on the unfurl).
   */
  test('cards and pictures have a budget of their own: drawing a channel cannot spend what sending needs', async () => {
    await withRollback(async (db) => {
      const app = createApp(
        testDependencies({
          database: db,
          clock,
          rateBudgets: { auth: AUTH_BUDGET, writes: WRITE_BUDGET, costlyReads: COSTLY_READ_BUDGET },
        }),
      );
      const user = await aSignedInUser(db, clock, 'rl-read');
      const slug = aUniqueSlug('rl-read');
      const workspace = (await (
        await post(app, user.cookie, '/api/workspaces', { name: slug, slug })
      ).json()) as { id: string };
      const channel = (await (
        await post(app, user.cookie, `/api/workspaces/${workspace.id}/channels`, {
          name: 'general',
        })
      ).json()) as { id: string };

      const unfurl = async (n: number): Promise<number> =>
        (
          await post(app, user.cookie, '/api/integrations/github/unfurl', {
            workspaceId: workspace.id,
            url: `https://github.com/acme/api/pull/${String(n + 1)}`,
          })
        ).status;
      const statuses: number[] = [];
      for (let n = 0; n < COSTLY_READ_BUDGET.burst; n += 1) statuses.push(await unfurl(n));
      expect(statuses.every((status) => status === 200)).toBe(true);
      expect(await unfurl(COSTLY_READ_BUDGET.burst)).toBe(429);

      // Every card asked for, and the writing budget is whole: a message still goes.
      const sent = await post(app, user.cookie, `/api/channels/${channel.id}/messages`, {
        id: messageId(NOW),
        content: 'still able to say something',
      });
      expect(sent.status).toBe(201);
    });
  });

  test('a caller with no session is not given a bucket, and is answered 401 as before', async () => {
    await withRollback(async (db) => {
      const app = createApp(
        testDependencies({
          database: db,
          clock,
          rateBudgets: { auth: AUTH_BUDGET, writes: WRITE_BUDGET, costlyReads: COSTLY_READ_BUDGET },
        }),
      );
      for (let i = 0; i < WRITE_BUDGET.burst + 5; i += 1) {
        const response = await post(app, 'purlay_session=nope', '/api/workspaces', {});
        expect(response.status).toBe(401);
      }
    });
  });
});

describe('integration: the address a session records', () => {
  const signIn = async (
    db: Executor,
    trustProxy: boolean,
    forwardedFor?: string,
  ): Promise<void> => {
    const app = createApp(
      testDependencies({
        database: db,
        clock,
        config: testConfig({ TRUST_PROXY: trustProxy }),
      }),
    );
    const started = await app.handle(new Request(`${ORIGIN}/auth/github`));
    const state = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const callback = await app.handle(
      new Request(`${ORIGIN}/auth/github/callback?code=a-valid-code&state=${state}`, {
        headers: {
          cookie: (started.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
          ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
        },
      }),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.getSetCookie().join(';')).toContain(STATE_COOKIE);
  };

  const addresses = async (db: Executor): Promise<(string | null)[]> =>
    (
      await db
        .selectFrom('sessions')
        .innerJoin('users', 'users.id', 'sessions.user_id')
        .select('sessions.ip_address')
        .where('users.email', '=', 'mona@example.test')
        .execute()
    ).map((row) => row.ip_address);

  test('behind a trusted proxy the session records the address the proxy reported', async () => {
    await withRollback(async (db) => {
      await signIn(db, true, '6.6.6.6, 198.51.100.7');
      expect(await addresses(db)).toEqual(['198.51.100.7']);
    });
  });

  test('without one, a header the client wrote is never recorded', async () => {
    await withRollback(async (db) => {
      await signIn(db, false, '198.51.100.7');
      expect(await addresses(db)).toEqual([null]);
    });
  });

  /** `handle` has no socket, so the peer path is only real on a listener. */
  test('over a real socket the peer address is what is recorded', async () => {
    await withRollback(async (db) => {
      const app = createApp(testDependencies({ database: db, clock }));
      const port = String(app.listen(0));
      try {
        const base = `http://127.0.0.1:${port}`;
        const started = await fetch(`${base}/auth/github`, { redirect: 'manual' });
        const state =
          new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';
        const callback = await fetch(
          `${base}/auth/github/callback?code=a-valid-code&state=${state}`,
          {
            redirect: 'manual',
            headers: { cookie: (started.headers.get('set-cookie') ?? '').split(';')[0] ?? '' },
          },
        );
        expect(callback.status).toBe(302);
        expect(await addresses(db)).toEqual(['127.0.0.1']);
      } finally {
        await app.stop(true);
      }
    });
  });
});
