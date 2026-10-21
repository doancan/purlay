/**
 * `GET /api/images` (#110) over HTTP: signed in only, the address in the query, the image served as
 * ours with a download's headers, and one refusal for every failure.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { EXTERNAL_IMAGE_URL_MAX } from '@purlay/types';
import { createApp } from './app';
import { fixedClock } from '../../platform/clock';
import { NOW, testDependencies } from '../../testing/doubles';
import { twoColourPng } from '../../testing/png';
import { aSignedInUser } from '../../testing/signed-in';
import type { ExternalFetch } from '../../modules/images/proxy';
import { FETCHES_WAITING } from './images';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
const ORIGIN = 'https://purlay.test';
const IMAGE = 'https://images.example.com/a.png';

const get = async (
  db: Executor,
  externalFetch: ExternalFetch,
  query: string,
  cookie?: string,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock, externalFetch })).handle(
    new Request(`${ORIGIN}/api/images${query}`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
  );

const image = (bytes: Uint8Array): ReturnType<ExternalFetch> =>
  Promise.resolve({ kind: 'bytes', bytes });

const serving =
  (bytes: Uint8Array): ExternalFetch =>
  () =>
    image(bytes);

describe('integration: an external image through the API', () => {
  test('is served as our WebP, with the headers a download has', async () => {
    await withRollback(async (db) => {
      const asked: string[] = [];
      const fetch: ExternalFetch = async (url) => {
        asked.push(url.href);
        return await image(twoColourPng(8, 8));
      };
      const { cookie } = await aSignedInUser(db, clock, 'img-reader');
      const response = await get(db, fetch, `?url=${encodeURIComponent(IMAGE)}`, cookie);
      expect(response.status).toBe(200);
      expect(asked).toEqual([IMAGE]);
      expect(Object.fromEntries(response.headers)).toMatchObject({
        'content-type': 'image/webp',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'private, max-age=86400',
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WEBP');
    });
  });

  test('nobody signed in is 401, and nothing is fetched', async () => {
    await withRollback(async (db) => {
      let fetched = false;
      const fetch: ExternalFetch = async () => {
        fetched = true;
        return await image(twoColourPng(8, 8));
      };
      expect((await get(db, fetch, `?url=${encodeURIComponent(IMAGE)}`)).status).toBe(401);
      expect(fetched).toBe(false);
    });
  });

  test('no address, or one past the limit, is a 400 naming it; an address it will not try is the 404', async () => {
    await withRollback(async (db) => {
      const { cookie } = await aSignedInUser(db, clock, 'img-shape');
      const never: ExternalFetch = () => {
        throw new Error('fetched');
      };
      expect((await get(db, never, '', cookie)).status).toBe(400);
      const long = `https://images.example.com/${'a'.repeat(EXTERNAL_IMAGE_URL_MAX)}`;
      expect((await get(db, never, `?url=${encodeURIComponent(long)}`, cookie)).status).toBe(400);
      const local = await get(
        db,
        never,
        `?url=${encodeURIComponent('https://127.0.0.1/x.png')}`,
        cookie,
      );
      expect(local.status).toBe(404);
      expect(await local.json()).toMatchObject({ error: { code: 'IMAGE_NOT_AVAILABLE' } });
    });
  });

  test('a fetch that fails is the same 404, saying nothing of why', async () => {
    await withRollback(async (db) => {
      const { cookie } = await aSignedInUser(db, clock, 'img-failed');
      const refused: ExternalFetch = () =>
        Promise.resolve({ kind: 'failed', reason: 'refused an address that is not public' });
      const response = await get(db, refused, `?url=${encodeURIComponent(IMAGE)}`, cookie);
      expect(response.status).toBe(404);
      expect(JSON.stringify(await response.json())).not.toContain('public');
    });
  });

  test('it is charged to the reader’s budget for costly reads: one person cannot spend the node on it', async () => {
    await withRollback(async (db) => {
      const { cookie } = await aSignedInUser(db, clock, 'img-budget');
      const app = createApp(
        testDependencies({
          database: db,
          clock,
          externalFetch: serving(twoColourPng(8, 8)),
          rateBudgets: {
            auth: { perSecond: 1, burst: 1 },
            writes: { perSecond: 1, burst: 1 },
            costlyReads: { perSecond: 0.001, burst: 1 },
          },
        }),
      );
      const ask = async (): Promise<number> =>
        (
          await app.handle(
            new Request(`${ORIGIN}/api/images?url=${encodeURIComponent(IMAGE)}`, {
              headers: { cookie },
            }),
          )
        ).status;
      expect(await ask()).toBe(200);
      expect(await ask()).toBe(429);
    });
  });

  /** Found by review: a line for the node's few fetch slots that only grew held every caller waiting. */
  test('past the line for fetch slots a picture is not available now, at once; the line itself is served', async () => {
    await withRollback(async (db) => {
      const { cookie } = await aSignedInUser(db, clock, 'img-queue');
      const releases: (() => void)[] = [];
      const slow: ExternalFetch = async () => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return { kind: 'bytes', bytes: twoColourPng(8, 8) };
      };
      const app = createApp(testDependencies({ database: db, clock, externalFetch: slow }));
      const ask = (n: number): Promise<number> =>
        app
          .handle(
            new Request(`${ORIGIN}/api/images?url=${encodeURIComponent(`${IMAGE}?${String(n)}`)}`, {
              headers: { cookie },
            }),
          )
          .then((response) => response.status);
      const held = Array.from({ length: 4 + FETCHES_WAITING }, (_, n) => ask(n));
      for (let turn = 0; turn < 20 && releases.length < 4; turn += 1) await Bun.sleep(5);
      expect(releases).toHaveLength(4);
      expect(await ask(999)).toBe(404);
      // Each held fetch let go, and each waiter after it, until every one has answered.
      const done = Promise.all(held);
      const state = { settled: false };
      void done.then(() => {
        state.settled = true;
      });
      while (!state.settled) {
        releases.shift()?.();
        await Bun.sleep(1);
      }
      expect(await done).toEqual(Array.from({ length: 4 + FETCHES_WAITING }, () => 200));
    });
  });

  /** Found by review: the router takes these spellings to the same handler; the limiter did not. */
  test.each(['/api/images/', '//api/images', '/api//images'])(
    '%s is the same route and is charged the same',
    async (path) => {
      await withRollback(async (db) => {
        const { cookie } = await aSignedInUser(db, clock, 'img-spelling');
        const app = createApp(
          testDependencies({
            database: db,
            clock,
            externalFetch: serving(twoColourPng(8, 8)),
            rateBudgets: {
              auth: { perSecond: 1, burst: 1 },
              writes: { perSecond: 1, burst: 1 },
              costlyReads: { perSecond: 0.001, burst: 1 },
            },
          }),
        );
        const ask = async (at: string): Promise<number> =>
          (
            await app.handle(
              new Request(`${ORIGIN}${at}?url=${encodeURIComponent(IMAGE)}`, {
                headers: { cookie },
              }),
            )
          ).status;
        // Whatever the spelling reaches, it is charged: the plain one after it is refused.
        expect([200, 404]).toContain(await ask(path));
        expect(await ask('/api/images')).toBe(429);
      });
    },
  );
});
