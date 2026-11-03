/**
 * `GET /api/releases/latest` (D-248): the newest release on GitHub, for whoever is signed in, through the real
 * application against a real database — with a `fetch` the test holds standing in for GitHub, so every failure
 * GitHub can make is one this test makes.
 */
import { describe, expect, test } from 'bun:test';
import { withRollback, type Executor } from '@purlay/db';
import { LatestReleaseAnswer } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { createApp } from './app';
import { fixedClock } from '../../platform/clock';
import type { GitHubAppFetch } from '../../platform/github-app-api';
import { SERVER_VERSION } from '../../platform/server-version';
import { NOW, testConfig, testDependencies } from '../../testing/doubles';
import { aSignedInUser } from '../../testing/signed-in';

const ORIGIN = 'https://purlay.test';

const RELEASE = {
  tag_name: 'v1.4.0',
  html_url: 'https://github.com/doancan/purlay/releases/tag/v1.4.0',
  published_at: '2026-10-30T08:00:00Z',
};

/** GitHub, as the test makes it answer; every call it received. */
const github = (
  answer: () => Response,
): { readonly fetch: GitHubAppFetch; readonly urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url): Promise<Response> => {
      urls.push(url);
      return await Promise.resolve(answer());
    },
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ask = async (
  db: Executor,
  fetch: GitHubAppFetch,
  cookie: string | undefined,
  config = testConfig({ UPDATE_CHECK: true }),
): Promise<Response> =>
  await createApp(
    testDependencies({ database: db, clock: fixedClock(NOW), githubAppFetch: fetch, config }),
  ).handle(
    new Request(
      `${ORIGIN}/api/releases/latest`,
      cookie === undefined ? {} : { headers: { cookie } },
    ),
  );

describe('integration: the newest release', () => {
  test('a signed-in person is told the version, the page and the date', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, fixedClock(NOW), 'release-ada');
      const stand = github((): Response => json(RELEASE));
      const response = await ask(db, stand.fetch, ada.cookie);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(Value.Check(LatestReleaseAnswer, body)).toBe(true);
      expect(body).toEqual({
        current: SERVER_VERSION,
        latest: {
          version: '1.4.0',
          url: 'https://github.com/doancan/purlay/releases/tag/v1.4.0',
          publishedAt: '2026-10-30T08:00:00.000Z',
        },
      });
      expect(stand.urls).toEqual(['https://api.github.com/repos/doancan/purlay/releases/latest']);
    });
  });

  test('signed out is 401, and GitHub is not asked', async () => {
    await withRollback(async (db) => {
      const stand = github((): Response => json(RELEASE));
      const response = await ask(db, stand.fetch, undefined);
      expect(response.status).toBe(401);
      expect(stand.urls).toEqual([]);
    });
  });

  test('a second person is answered from what the first caused GitHub to say', async () => {
    await withRollback(async (db) => {
      const app = createApp(
        testDependencies({
          database: db,
          clock: fixedClock(NOW),
          config: testConfig({ UPDATE_CHECK: true }),
          githubAppFetch: github((): Response => json(RELEASE)).fetch,
        }),
      );
      const ada = await aSignedInUser(db, fixedClock(NOW), 'release-first');
      const bo = await aSignedInUser(db, fixedClock(NOW), 'release-second');
      for (const cookie of [ada.cookie, bo.cookie]) {
        const response = await app.handle(
          new Request(`${ORIGIN}/api/releases/latest`, { headers: { cookie } }),
        );
        expect(((await response.json()) as LatestReleaseAnswer).latest?.version).toBe('1.4.0');
      }
    });
  });

  test('with the check off the version is still answered, the newest release is null and GitHub is never asked', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, fixedClock(NOW), 'release-off');
      const stand = github((): Response => json(RELEASE));
      const response = await ask(db, stand.fetch, ada.cookie, testConfig({ UPDATE_CHECK: false }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ current: SERVER_VERSION, latest: null });
      expect(stand.urls).toEqual([]);
    });
  });

  for (const [name, answer] of [
    ['a server error', (): Response => json({ message: 'down' }, 503)],
    ['a rate limit', (): Response => json({}, 403)],
    [
      'a redirect',
      (): Response => new Response('', { status: 302, headers: { location: 'https://evil.test' } }),
    ],
    ['something that is not JSON', (): Response => new Response('<html>', { status: 200 })],
    ['a pre-release tag', (): Response => json({ ...RELEASE, tag_name: 'v1.4.0-rc1' })],
    [
      'a page that is not GitHub’s',
      (): Response => json({ ...RELEASE, html_url: 'https://evil.test/x' }),
    ],
  ] as const) {
    test(`${name} from GitHub is a 200 with null, never an error`, async () => {
      await withRollback(async (db) => {
        const ada = await aSignedInUser(db, fixedClock(NOW), 'release-bad');
        const response = await ask(db, github(answer).fetch, ada.cookie);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ current: SERVER_VERSION, latest: null });
      });
    });
  }

  test('a second person is not throttled by the first one’s burst: the budget is each person’s own', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, fixedClock(NOW), 'release-burst-first');
      const bo = await aSignedInUser(db, fixedClock(NOW), 'release-burst-second');
      const app = createApp(
        testDependencies({
          database: db,
          clock: fixedClock(NOW),
          config: testConfig({ UPDATE_CHECK: true }),
          githubAppFetch: github((): Response => json(RELEASE)).fetch,
          rateBudgets: {
            auth: { perSecond: 1, burst: 5 },
            writes: { perSecond: 1, burst: 5 },
            costlyReads: { perSecond: 0.001, burst: 1 },
          },
        }),
      );
      const get = async (cookie: string): Promise<number> =>
        (await app.handle(new Request(`${ORIGIN}/api/releases/latest`, { headers: { cookie } })))
          .status;
      expect(await get(ada.cookie)).toBe(200);
      expect(await get(ada.cookie)).toBe(429);
      expect(await get(bo.cookie)).toBe(200);
    });
  });

  test('a cookie that names no live session is 401, and GitHub is not asked', async () => {
    await withRollback(async (db) => {
      const revoked = await aSignedInUser(db, fixedClock(NOW), 'release-revoked');
      // Ending a session deletes its row (D-179 §3): that is what revoking one is.
      await db.deleteFrom('sessions').where('user_id', '=', revoked.userId).execute();
      const expired = await aSignedInUser(db, fixedClock(NOW), 'release-expired');
      await db
        .updateTable('sessions')
        .set({ expires_at: new Date(0) })
        .where('user_id', '=', expired.userId)
        .execute();
      const stand = github((): Response => json(RELEASE));
      for (const cookie of [
        revoked.cookie,
        expired.cookie,
        `${revoked.cookie.split('=')[0] ?? ''}=not-a-token`,
        'unrelated=1',
      ]) {
        const response = await ask(db, stand.fetch, cookie);
        expect({ cookie: cookie.split('=')[0], status: response.status }).toEqual({
          cookie: cookie.split('=')[0],
          status: 401,
        });
      }
      expect(stand.urls).toEqual([]);
    });
  });

  test('is charged to the costly reads: past the burst a person is told to wait', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, fixedClock(NOW), 'release-limit');
      const app = createApp(
        testDependencies({
          database: db,
          clock: fixedClock(NOW),
          config: testConfig({ UPDATE_CHECK: true }),
          githubAppFetch: github((): Response => json(RELEASE)).fetch,
          rateBudgets: {
            auth: { perSecond: 1, burst: 5 },
            writes: { perSecond: 1, burst: 5 },
            costlyReads: { perSecond: 0.001, burst: 1 },
          },
        }),
      );
      const get = async (): Promise<number> =>
        (
          await app.handle(
            new Request(`${ORIGIN}/api/releases/latest`, { headers: { cookie: ada.cookie } }),
          )
        ).status;
      expect(await get()).toBe(200);
      expect(await get()).toBe(429);
    });
  });
});
