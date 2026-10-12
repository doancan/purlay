/**
 * The inbox doors (`API.md` §6, D-106): the query read from text, the refusals and their statuses,
 * the contract's shape, and that marking read tells the caller's devices and nobody else. What is
 * listed and what is marked is the module's, and is tested there; the tenant crossings are in
 * `cross-tenant.integration.test.ts` and `channel-visibility.integration.test.ts`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, NotificationPage, type ServerFrame } from '@purlay/types';
import { createApp } from './app';
import { markNotificationsRead } from './notifications';
import { NOW, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { userTopic, type EventBus } from '../../platform/events';
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

interface World {
  readonly alice: string;
  readonly bob: string;
  readonly bobId: string;
  readonly workspaceId: string;
  readonly channelId: string;
}

/** Bob is in Alice's channel, and Alice has named him once. */
const aWorld = async (db: Executor): Promise<World> => {
  const alice = await aSignedInUser(db, clock, 'nt-alice');
  const bob = await aSignedInUser(db, clock, 'nt-bob');
  const created = await call(db, 'POST', '/api/workspaces', alice.cookie, {
    name: 'nt',
    slug: aUniqueSlug('nt'),
  });
  const workspaceId = ((await created.json()) as { id: string }).id;
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW })
    .execute();
  const channel = await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, alice.cookie, {
    name: 'general',
  });
  const channelId = ((await channel.json()) as { id: string }).id;
  expect((await call(db, 'POST', `/api/channels/${channelId}/join`, bob.cookie)).ok).toBe(true);
  const username = (
    await db
      .selectFrom('users')
      .select('username')
      .where('id', '=', bob.userId)
      .executeTakeFirstOrThrow()
  ).username;
  const sent = await call(db, 'POST', `/api/channels/${channelId}/messages`, alice.cookie, {
    id: messageId(NOW),
    content: `@${username} the deploy`,
  });
  expect(sent.ok).toBe(true);
  return { alice: alice.cookie, bob: bob.cookie, bobId: bob.userId, workspaceId, channelId };
};

const inbox = async (db: Executor, world: World, query = ''): Promise<Response> =>
  await call(db, 'GET', `/api/notifications?workspaceId=${world.workspaceId}${query}`, world.bob);

const codeOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe('integration: GET /api/notifications', () => {
  test('answers a page in the contract’s shape, and reads `unreadOnly` and `limit` from text', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const query of ['', '&unreadOnly=true', '&unreadOnly=false&limit=1']) {
        const response = await inbox(db, world, query);
        expect(response.status).toBe(200);
        const page: unknown = await response.json();
        expect(Value.Check(NotificationPage, page)).toBe(true);
        expect((page as NotificationPage).data.map((n) => [n.type, n.channelId])).toEqual([
          ['mention', world.channelId],
        ]);
      }
    });
  });

  test('a malformed query is 400 by name; no workspace at all is 400, not a guess', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const query of ['&unreadOnly=yes', '&limit=0', '&after=' + messageId(NOW)]) {
        const response = await inbox(db, world, query);
        expect(response.status).toBe(400);
        expect(await codeOf(response)).toBe('VALIDATION_FAILED');
      }
      const none = await call(db, 'GET', '/api/notifications', world.bob);
      expect(none.status).toBe(400);
    });
  });
});

describe('integration: PUT /api/notifications/read', () => {
  test('is 204, by ids or by workspace, and a malformed body is 400', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const page = (await (await inbox(db, world)).json()) as NotificationPage;
      const ids = page.data.map((n) => n.id);
      expect((await call(db, 'PUT', '/api/notifications/read', world.bob, { ids })).status).toBe(
        204,
      );
      const byWorkspace = { workspaceId: world.workspaceId };
      expect(
        (await call(db, 'PUT', '/api/notifications/read', world.bob, byWorkspace)).status,
      ).toBe(204);
      for (const body of [{ ids: [] }, { ids, workspaceId: world.workspaceId }, {}]) {
        const response = await call(db, 'PUT', '/api/notifications/read', world.bob, body);
        expect(response.status).toBe(400);
      }
    });
  });

  test('tells the caller’s own devices the channel’s new state, once, and nobody else', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const page = (await (await inbox(db, world)).json()) as NotificationPage;
      const heard: { topic: string; frame: ServerFrame }[] = [];
      const bus: EventBus = {
        publish: (topic, frame) => {
          heard.push({ topic, frame });
          return Promise.resolve();
        },
        subscribe: () => false,
        unsubscribe: () => undefined,
        forget: () => undefined,
      };
      const request = (): Request =>
        new Request('https://purlay.test/api/notifications/read', {
          method: 'PUT',
          headers: { cookie: world.bob },
        });
      const body = { ids: page.data.map((n) => n.id) };
      await markNotificationsRead({ database: db, clock, bus }, request(), body);
      expect(heard.map((h) => [h.topic, h.frame.event])).toEqual([
        [userTopic(world.bobId), 'CHANNEL_STATE'],
      ]);
      // Read again: nothing moved, so nothing is said.
      await markNotificationsRead({ database: db, clock, bus }, request(), body);
      expect(heard).toHaveLength(1);
    });
  });

  test('both need a session', async () => {
    await withRollback(async (db) => {
      expect((await call(db, 'GET', '/api/notifications', undefined)).status).toBe(401);
      const put = await call(db, 'PUT', '/api/notifications/read', undefined, { ids: [] });
      expect(put.status).toBe(401);
    });
  });
});
