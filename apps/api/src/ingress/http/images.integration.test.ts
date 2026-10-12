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

const serving =
  (bytes: Uint8Array): ExternalFetch =>
  () =>
    Promise.resolve({ kind: 'bytes', bytes });

describe('integration: an external image through the API', () => {
  test('is served as our WebP, with the headers a download has', async () => {
    await withRollback(async (db) => {
      const asked: string[] = [];
      const fetch: ExternalFetch = async (url) => {
        asked.push(url.href);
        return await serving(twoColourPng(8, 8))(url);
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
      const fetch: ExternalFetch = async (url) => {
        fetched = true;
        return await serving(twoColourPng(8, 8))(url);
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
});
