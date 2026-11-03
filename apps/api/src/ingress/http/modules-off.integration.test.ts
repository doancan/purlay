/**
 * An application that runs no module is the core alone, over HTTP, on a real database (D-250, `MODULES.md` §3).
 *
 * What the core does works — an account lists its workspaces, makes one, reads it — and what a module owns is not a
 * route: the `404` of any unknown path with the generic body, for a caller who has signed in and for one who has not,
 * and for a method the module registers and one it does not. Nothing in the answer says the module is *disabled*:
 * that would tell somebody who has not signed in which modules an instance runs.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { compose, composition } from '../../composition';
import { fixedClock } from '../../platform/clock';
import { NOW, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { createApp } from './app';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
const ORIGIN = 'https://purlay.test';

const caller = (db: Executor, modules: typeof composition) => {
  const app = createApp(testDependencies({ database: db, clock, composition: modules }));
  return async (
    method: string,
    path: string,
    who: SignedInUser | null,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> => {
    const headers: Record<string, string> = who === null ? {} : { cookie: who.cookie };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await app.handle(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
  };
};

/** Paths of chat's, each with a method it registers and one it does not. */
const CHAT_PATHS: readonly (readonly [string, string])[] = [
  ['GET', '/api/channels/c1/messages'],
  ['POST', '/api/channels/c1/messages'],
  ['DELETE', '/api/messages/m1'],
  ['GET', '/api/notifications'],
  ['PUT', '/api/notifications/read'],
  ['POST', '/api/workspaces/w1/channels'],
  ['GET', '/api/workspaces/w1/search'],
  ['POST', '/api/webhooks/incoming/h1/secret'],
  ['GET', '/api/github-app/callback'],
];

describe('integration: an application with no module is the core alone', () => {
  test('the core works: an account makes a workspace and reads it, and the workspace has no channel', async () => {
    await withRollback(async (db) => {
      const call = caller(db, compose([]));
      const ada = await aSignedInUser(db, clock, 'off-ada');
      const slug = aUniqueSlug('off');
      const made = await call('POST', '/api/workspaces', ada, { name: slug, slug });
      expect(made.status).toBe(201);
      const workspaceId = (made.body as { id: string }).id;
      const read = await call('GET', `/api/workspaces/${workspaceId}`, ada);
      expect(read.status).toBe(200);
      const channels = await db
        .selectFrom('channels')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .execute();
      expect(channels).toEqual([]);
    });
  });

  test('the caller is told which modules this server runs, so the page draws only those', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, clock, 'off-me');
      const modulesOf = async (modules: typeof composition): Promise<unknown> =>
        ((await caller(db, modules)('GET', '/api/me', ada)).body as { modules: unknown }).modules;
      expect(await modulesOf(compose([]))).toEqual([]);
      expect(await modulesOf(composition)).toEqual(['chat']);
    });
  });

  test('what chat owns is the 404 of any unknown path, signed in or not, whatever the method', async () => {
    await withRollback(async (db) => {
      const call = caller(db, compose([]));
      const ada = await aSignedInUser(db, clock, 'off-bob');
      const unknown = await call('GET', '/api/no-such-thing/x', ada);
      expect(unknown.status).toBe(404);
      for (const who of [ada, null]) {
        for (const [method, path] of CHAT_PATHS) {
          const answer = await call(method, path, who);
          expect({ method, path, status: answer.status, body: answer.body }).toEqual({
            method,
            path,
            status: 404,
            body: unknown.body,
          });
        }
      }
      expect(JSON.stringify(unknown.body)).not.toMatch(/disabled|module/i);
    });
  });

  test('a path cannot be spelled past it: an encoded segment, a doubled slash and a trailing slash are closed too', async () => {
    await withRollback(async (db) => {
      const call = caller(db, compose([]));
      const ada = await aSignedInUser(db, clock, 'off-cy');
      for (const path of ['/api/%6dessages/m1', '//api//messages/m1', '/api/messages/m1/']) {
        expect({ path, status: (await call('DELETE', path, ada)).status }).toEqual({
          path,
          status: 404,
        });
      }
    });
  });

  test('with chat running the same paths are not closed: they ask who is calling, or find nothing of the caller’s', async () => {
    await withRollback(async (db) => {
      const call = caller(db, composition);
      const ada = await aSignedInUser(db, clock, 'on-dan');
      const absent = await call(
        'GET',
        '/api/channels/00000000-0000-7000-8000-000000000000/messages',
        ada,
      );
      // Chat answers for a channel it does not have as its own refusal, not as no route.
      expect(absent.body).toMatchObject({ error: { code: 'CHANNEL_NOT_FOUND' } });
      expect((await call('GET', '/api/notifications', null)).status).toBe(401);
      const closed = await caller(db, compose([]))(
        'GET',
        '/api/channels/00000000-0000-7000-8000-000000000000/messages',
        ada,
      );
      expect(closed.body).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
    });
  });

  test('a chat webhook is no route: a missing or an oversized length is not refused before the path is judged', async () => {
    await withRollback(async (db) => {
      const post = async (
        modules: typeof composition,
        path: string,
        headers: Record<string, string>,
      ): Promise<{ status: number; body: string }> => {
        const response = await createApp(
          testDependencies({ database: db, clock, composition: modules }),
        ).handle(new Request(`${ORIGIN}${path}`, { method: 'POST', headers }));
        return { status: response.status, body: await response.text() };
      };
      const none = { 'content-type': 'application/json' };
      const huge = { 'content-type': 'application/json', 'content-length': '99999999' };
      const off = compose([]);
      for (const [name, headers] of [
        ['no length', none],
        ['a huge length', huge],
      ] as const) {
        const unknown = await post(off, '/api/no-such-thing', headers);
        for (const path of ['/api/webhooks/github/f1', '/api/webhooks/github-app']) {
          expect({ name, path, ...(await post(off, path, headers)) }).toEqual({
            name,
            path,
            ...unknown,
          });
        }
      }
      // With chat run the edge's refusals are unchanged.
      expect((await post(composition, '/api/webhooks/github/f1', none)).status).toBe(411);
      expect((await post(composition, '/api/webhooks/github-app', huge)).status).toBe(413);
    });
  });
});
