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
import { messageId } from '@purlay/types';
import { compose, composition } from '../../composition';
import { chatModule } from '../../features/chat/module';
import { issuesModule } from '../../features/issues/module';
import { fixedClock } from '../../platform/clock';
import { theDefaultChannelOf } from '../../testing/channels';
import { NOW, testDependencies } from '../../testing/doubles';
import { twoColourPng } from '../../testing/png';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aMemoryStore } from '../../testing/storage';
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
      expect(await modulesOf(composition)).toEqual(['chat', 'issues']);
      expect(await modulesOf(compose([chatModule]))).toEqual(['chat']);
      expect(await modulesOf(compose([issuesModule]))).toEqual(['issues']);
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

  test('a file attached to a message is chat’s: with chat not run it is nobody’s, and an unattached upload stays its uploader’s', async () => {
    await withRollback(async (db) => {
      const store = aMemoryStore();
      const handle = async (
        modules: typeof composition,
        method: string,
        path: string,
        who: SignedInUser,
        body?: Uint8Array | object,
      ): Promise<Response> => {
        const headers: Record<string, string> = { cookie: who.cookie };
        let payload: Uint8Array | string | undefined;
        if (body instanceof Uint8Array) {
          headers['content-type'] = 'application/octet-stream';
          headers['content-length'] = String(body.length);
          payload = body;
        } else if (body !== undefined) {
          headers['content-type'] = 'application/json';
          payload = JSON.stringify(body);
        }
        return await createApp(
          testDependencies({ database: db, clock, composition: modules, storage: store }),
        ).handle(
          new Request(`${ORIGIN}${path}`, {
            method,
            headers,
            ...(payload === undefined ? {} : { body: payload }),
          }),
        );
      };
      const status = async (
        modules: typeof composition,
        method: string,
        path: string,
        who: SignedInUser,
      ): Promise<number> => (await handle(modules, method, path, who)).status;
      const ada = await aSignedInUser(db, clock, 'att-ada');
      const bob = await aSignedInUser(db, clock, 'att-bob');
      const slug = aUniqueSlug('att');
      const made = await handle(composition, 'POST', '/api/workspaces', ada, { name: slug, slug });
      const workspaceId = ((await made.json()) as { id: string }).id;
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW })
        .execute();
      const channelId = await theDefaultChannelOf(db, workspaceId);
      await db
        .insertInto('channel_members')
        .values({ channel_id: channelId, user_id: bob.userId })
        .execute();
      let tick = 0;
      const upload = async (name: string): Promise<string> => {
        const id = messageId(new Date(NOW.getTime() - 60_000 + (tick += 1)));
        const sent = await handle(
          composition,
          'POST',
          `/api/workspaces/${workspaceId}/uploads?id=${id}&name=${name}`,
          ada,
          twoColourPng(64, 64),
        );
        expect(sent.status).toBe(201);
        return id;
      };
      const attached = await upload('attached.png');
      const loose = await upload('loose.png');
      const sent = await handle(composition, 'POST', `/api/channels/${channelId}/messages`, ada, {
        id: messageId(new Date(NOW.getTime() - 30_000)),
        content: 'look',
        attachmentIds: [attached],
      });
      expect(sent.status).toBe(201);

      const off = compose([]);
      const never = `/api/attachments/${messageId(new Date(NOW.getTime() - 1_000))}`;
      const absent = await handle(off, 'GET', never, ada);
      expect(absent.status).toBe(404);
      const absentBody = await absent.text();
      for (const suffix of ['', '/thumbnail']) {
        for (const who of [ada, bob]) {
          const answer = await handle(off, 'GET', `/api/attachments/${attached}${suffix}`, who);
          expect({ who: who.userId, suffix, status: answer.status }).toEqual({
            who: who.userId,
            suffix,
            status: 404,
          });
          expect(await answer.text()).toBe(absentBody);
        }
      }
      expect(await status(off, 'DELETE', `/api/attachments/${attached}`, ada)).toBe(404);
      // With chat run the member reads it; with chat not run the uploader still reads what was never attached.
      expect(await status(composition, 'GET', `/api/attachments/${attached}`, bob)).toBe(200);
      expect(await status(off, 'GET', `/api/attachments/${loose}`, ada)).toBe(200);
      expect(await status(off, 'GET', `/api/attachments/${loose}`, bob)).toBe(404);
      expect(await status(off, 'DELETE', `/api/attachments/${loose}`, ada)).toBe(204);
    });
  });

  test('the matrix: each module alone answers for its own paths and closes the other’s', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, clock, 'cell-ada');
      const slug = aUniqueSlug('cell');
      const made = await caller(db, composition)('POST', '/api/workspaces', ada, {
        name: slug,
        slug,
      });
      const workspaceId = (made.body as { id: string }).id;
      const issuesPath = `/api/workspaces/${workspaceId}/issues`;
      const channelsPath = `/api/workspaces/${workspaceId}/channels`;
      const unknown = (await caller(db, compose([]))('GET', '/api/no-such-thing/x', ada)).body;

      const chatOnly = caller(db, compose([chatModule]));
      expect((await chatOnly('GET', channelsPath, ada)).status).toBe(200);
      expect(await chatOnly('GET', issuesPath, ada)).toEqual({ status: 404, body: unknown });
      expect(await chatOnly('POST', issuesPath, ada, { title: 'x' })).toEqual({
        status: 404,
        body: unknown,
      });
      expect(await chatOnly('DELETE', `${issuesPath}/${workspaceId}`, null)).toEqual({
        status: 404,
        body: unknown,
      });

      const issuesOnly = caller(db, compose([issuesModule]));
      expect((await issuesOnly('GET', issuesPath, ada)).status).toBe(200);
      expect(await issuesOnly('GET', channelsPath, ada)).toEqual({ status: 404, body: unknown });
      expect((await issuesOnly('GET', issuesPath, null)).status).toBe(401);

      const coreOnly = caller(db, compose([]));
      expect(await coreOnly('GET', issuesPath, ada)).toEqual({ status: 404, body: unknown });
      expect(await coreOnly('GET', issuesPath, null)).toEqual({ status: 404, body: unknown });
    });
  });
});
