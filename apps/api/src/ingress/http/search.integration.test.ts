/**
 * `GET /api/workspaces/:workspaceId/search` through the HTTP surface (`API.md` §5, D-105).
 *
 * What is found, and where, is the module's and is tested there; this file proves the door: the
 * bounds of `q` read from the contract, the words trimmed before they are measured, the refusals
 * and their statuses, and that what comes back is the contract's shape. The tenant crossing is in
 * `cross-tenant.integration.test.ts`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, SEARCH_QUERY_MAX, SEARCH_QUERY_MIN, SearchPage } from '@purlay/types';
import { createApp } from './app';
import { NOW, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { aSignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

const call = async (
  db: Executor,
  method: string,
  path: string,
  cookie: string | undefined,
  body?: unknown,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`https://purlay.test${path}`, {
      method,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

/** One person, a workspace and a channel with one message in it. */
const aWorld = async (
  db: Executor,
): Promise<{ cookie: string; workspaceId: string; channelId: string }> => {
  const { cookie } = await aSignedInUser(db, clock, 'se-alice');
  const created = await call(db, 'POST', '/api/workspaces', cookie, {
    name: 'se',
    slug: aUniqueSlug('se'),
  });
  const workspaceId = ((await created.json()) as { id: string }).id;
  const channel = await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, cookie, {
    name: 'general',
  });
  const channelId = ((await channel.json()) as { id: string }).id;
  const sent = await call(db, 'POST', `/api/channels/${channelId}/messages`, cookie, {
    id: messageId(NOW),
    content: 'the deploy is at noon',
  });
  expect(sent.ok).toBe(true);
  return { cookie, workspaceId, channelId };
};

const search = async (
  db: Executor,
  world: { cookie: string; workspaceId: string },
  query: string,
): Promise<Response> =>
  await call(db, 'GET', `/api/workspaces/${world.workspaceId}/search?${query}`, world.cookie);

const codeOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe('integration: the search door', () => {
  test('answers a page in the contract’s shape, the words trimmed first', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const response = await search(db, world, `q=${encodeURIComponent('  DEPLOY  ')}&limit=10`);
      expect(response.status).toBe(200);
      const page: unknown = await response.json();
      expect(Value.Check(SearchPage, page)).toBe(true);
      expect((page as SearchPage).data.map((m) => m.content)).toEqual(['the deploy is at noon']);
    });
  });

  test('q is refused one below the minimum, once trimmed, and one above the maximum', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const at = (n: number): string => encodeURIComponent('e'.repeat(n));
      expect((await search(db, world, `q=${at(SEARCH_QUERY_MIN)}`)).status).toBe(200);
      expect((await search(db, world, `q=${at(SEARCH_QUERY_MAX)}`)).status).toBe(200);
      for (const q of [
        at(SEARCH_QUERY_MIN - 1),
        at(SEARCH_QUERY_MAX + 1),
        encodeURIComponent(` ${'e'.repeat(SEARCH_QUERY_MIN - 1)} `),
        '',
        // PostgreSQL cannot compare a NUL: refused at the contract, not a 500 from the database.
        'abc%00',
      ]) {
        const response = await search(db, world, `q=${q}`);
        expect(response.status).toBe(400);
        expect(await codeOf(response)).toBe('VALIDATION_FAILED');
      }
      const missing = await search(db, world, 'limit=5');
      expect(missing.status).toBe(400);
    });
  });

  test('takes no forward cursor, and a channel it cannot see is 404', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const forwards = await search(db, world, `q=deploy&after=${messageId(NOW)}`);
      expect(forwards.status).toBe(400);
      const narrowed = await search(db, world, `q=deploy&channelId=${world.channelId}`);
      expect(narrowed.status).toBe(200);
      const nowhere = await search(
        db,
        world,
        'q=deploy&channelId=00000000-0000-4000-8000-000000000000',
      );
      expect(nowhere.status).toBe(404);
      expect(await codeOf(nowhere)).toBe('CHANNEL_NOT_FOUND');
    });
  });

  test('needs a session', async () => {
    await withRollback(async (db) => {
      const response = await call(
        db,
        'GET',
        '/api/workspaces/00000000-0000-4000-8000-000000000000/search?q=deploy',
        undefined,
      );
      expect(response.status).toBe(401);
    });
  });
});
