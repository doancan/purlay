/**
 * Replies, resolution and the open questions, through the HTTP surface (`API.md` §5).
 *
 * The rules live in the module and are tested there; this file proves the doors:
 * what a request must look like, what status each refusal is, and that a body that
 * reaches the contract's schema is the contract's shape. The tenant and visibility
 * crossings of every endpoint here are in `cross-tenant.integration.test.ts` and
 * `channel-visibility.integration.test.ts`, which read the endpoint list from
 * `API.md`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { Message, messageId, MessagePage } from '@purlay/types';
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

interface World {
  readonly alice: string;
  readonly bob: string;
  readonly workspaceId: string;
  readonly channelId: string;
}

/** Alice owns a workspace with a channel; Bob is a member who has joined it. */
const aWorld = async (db: Executor): Promise<World> => {
  const alice = await aSignedInUser(db, clock, 'th-alice');
  const bob = await aSignedInUser(db, clock, 'th-bob');
  const created = await call(db, 'POST', '/api/workspaces', alice.cookie, {
    name: 'th',
    slug: aUniqueSlug('th'),
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
  return { alice: alice.cookie, bob: bob.cookie, workspaceId, channelId };
};

const send = async (
  db: Executor,
  world: World,
  as: string,
  content: string,
  parentId?: string,
): Promise<Response> =>
  await call(db, 'POST', `/api/channels/${world.channelId}/messages`, as, {
    id: messageId(NOW),
    content,
    ...(parentId === undefined ? {} : { parentId }),
  });

const sentId = async (response: Response): Promise<string> => {
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

const fieldsOf = async (response: Response): Promise<Record<string, string>> =>
  ((await response.json()) as { error: { details: { fields: Record<string, string> } } }).error
    .details.fields;

describe('integration: replying over HTTP', () => {
  test('a reply is a message of the contract, under its root, and the feed shows the summary', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const root = await sentId(await send(db, world, world.alice, 'why is the backoff 4s?'));
      const reply = await send(db, world, world.bob, 'rate limit', root);
      expect(reply.status).toBe(201);
      const body: unknown = await reply.json();
      expect(Value.Check(Message, body)).toBe(true);
      expect(body).toMatchObject({ parentId: root, thread: null });

      const feed = await call(db, 'GET', `/api/channels/${world.channelId}/messages`, world.alice);
      const page: unknown = await feed.json();
      expect(Value.Check(MessagePage, page)).toBe(true);
      expect(page).toMatchObject({ data: [{ id: root, thread: { replyCount: 1 } }] });
    });
  });

  test('refuses a reply under a reply, under nothing, and under another channel’s message', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const root = await sentId(await send(db, world, world.alice, 'q'));
      const reply = await sentId(await send(db, world, world.bob, 'a', root));

      const deeper = await send(db, world, world.alice, 'deeper', reply);
      expect(deeper.status).toBe(400);
      expect(Object.keys(await fieldsOf(deeper))).toEqual(['parentId']);

      const missing = await send(db, world, world.alice, 'x', messageId(NOW));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: 'MESSAGE_NOT_FOUND' } });

      const other = await call(
        db,
        'POST',
        `/api/workspaces/${world.workspaceId}/channels`,
        world.alice,
        {
          name: 'random',
        },
      );
      const otherId = ((await other.json()) as { id: string }).id;
      const across = await call(db, 'POST', `/api/channels/${otherId}/messages`, world.alice, {
        id: messageId(NOW),
        content: 'x',
        parentId: root,
      });
      expect(across.status).toBe(404);
      expect(await across.json()).toMatchObject({ error: { code: 'MESSAGE_NOT_FOUND' } });
    });
  });

  test('refuses a parent that is not an id, and a field the contract does not have', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const notAnId = await send(db, world, world.alice, 'x', 'not-a-uuid');
      expect(notAnId.status).toBe(400);
      const extra = await call(
        db,
        'POST',
        `/api/channels/${world.channelId}/messages`,
        world.alice,
        {
          id: messageId(NOW),
          content: 'x',
          resolved: true,
        },
      );
      expect(extra.status).toBe(400);
    });
  });

  test('refuses @here, @channel and @everyone, naming the field', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const content of ['@here', 'hey @channel', '@everyone']) {
        const response = await send(db, world, world.alice, content);
        expect(response.status).toBe(400);
        expect(Object.keys(await fieldsOf(response))).toEqual(['content']);
      }
    });
  });
});

describe('integration: reading a thread over HTTP', () => {
  test('answers a page of replies, oldest first, and honours the cursor and the limit', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const root = await sentId(await send(db, world, world.alice, 'q'));
      const ids: string[] = [];
      for (let n = 0; n < 3; n += 1) {
        ids.push(await sentId(await send(db, world, world.bob, `a${String(n)}`, root)));
      }
      ids.sort();

      const first = await call(db, 'GET', `/api/messages/${root}/thread?limit=2`, world.alice);
      expect(first.status).toBe(200);
      const page = (await first.json()) as { data: { id: string }[]; nextCursor: string | null };
      expect(Value.Check(MessagePage, page)).toBe(true);
      expect(page.data.map((m) => m.id)).toEqual(ids.slice(0, 2));
      expect(page.nextCursor).toBe(ids[1] ?? null);

      const rest = await call(
        db,
        'GET',
        `/api/messages/${root}/thread?after=${page.nextCursor ?? ''}`,
        world.alice,
      );
      expect(((await rest.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual(
        ids.slice(2),
      );
    });
  });

  test('is refused for a reply, a bad limit and a query in both directions', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const root = await sentId(await send(db, world, world.alice, 'q'));
      const reply = await sentId(await send(db, world, world.bob, 'a', root));
      expect((await call(db, 'GET', `/api/messages/${reply}/thread`, world.alice)).status).toBe(
        404,
      );
      expect(
        (await call(db, 'GET', `/api/messages/${root}/thread?limit=0`, world.alice)).status,
      ).toBe(400);
      const both = await call(
        db,
        'GET',
        `/api/messages/${root}/thread?before=${root}&after=${root}`,
        world.alice,
      );
      expect(both.status).toBe(400);
    });
  });
});

describe('integration: resolving over HTTP', () => {
  test('closes, is idempotent, and reopens — answering the root each time', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const root = await sentId(await send(db, world, world.alice, 'q'));
      await sentId(await send(db, world, world.bob, 'a', root));

      const closed = await call(db, 'POST', `/api/messages/${root}/resolve`, world.bob);
      expect(closed.status).toBe(200);
      const body: unknown = await closed.json();
      expect(Value.Check(Message, body)).toBe(true);
      expect(body).toMatchObject({
        id: root,
        thread: { replyCount: 1, resolvedAt: NOW.toISOString() },
      });

      expect((await call(db, 'POST', `/api/messages/${root}/resolve`, world.alice)).status).toBe(
        200,
      );

      const reopened = await call(db, 'DELETE', `/api/messages/${root}/resolve`, world.alice);
      expect(reopened.status).toBe(200);
      expect(await reopened.json()).toMatchObject({
        thread: { resolvedAt: null, resolvedBy: null },
      });
    });
  });

  test('a reply, and a root nobody answered, are 409 THREAD_NOT_RESOLVABLE', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const root = await sentId(await send(db, world, world.alice, 'q'));
      const reply = await sentId(await send(db, world, world.bob, 'a', root));
      const lonely = await sentId(await send(db, world, world.alice, 'nobody answered'));

      for (const id of [reply, lonely]) {
        const response = await call(db, 'POST', `/api/messages/${id}/resolve`, world.alice);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: 'THREAD_NOT_RESOLVABLE' } });
      }
      expect((await call(db, 'DELETE', `/api/messages/${reply}/resolve`, world.alice)).status).toBe(
        409,
      );
    });
  });
});

describe('integration: the open questions over HTTP', () => {
  test('lists what is open, drops what is resolved, and pages', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const open: string[] = [];
      for (let n = 0; n < 3; n += 1) {
        const root = await sentId(await send(db, world, world.alice, `q${String(n)}`));
        await sentId(await send(db, world, world.bob, 'a', root));
        open.push(root);
      }
      open.sort();
      await call(db, 'POST', `/api/messages/${open[1] ?? ''}/resolve`, world.bob);

      const read = async (
        query = '',
      ): Promise<{ data: { id: string }[]; nextCursor: string | null }> => {
        const response = await call(
          db,
          'GET',
          `/api/workspaces/${world.workspaceId}/unresolved${query}`,
          world.bob,
        );
        expect(response.status).toBe(200);
        const page: unknown = await response.json();
        expect(Value.Check(MessagePage, page)).toBe(true);
        return page as { data: { id: string }[]; nextCursor: string | null };
      };

      const all = await read();
      expect(all.data.map((m) => m.id)).toEqual([open[2] ?? '', open[0] ?? '']);
      const firstOnly = await read('?limit=1');
      expect(firstOnly.data).toHaveLength(1);
      expect(firstOnly.nextCursor).toBe(open[2] ?? null);
    });
  });
});

describe('integration: every one of these needs a session', () => {
  test.each([
    ['GET', '/api/messages/00000000-0000-4000-8000-000000000000/thread'],
    ['POST', '/api/messages/00000000-0000-4000-8000-000000000000/resolve'],
    ['DELETE', '/api/messages/00000000-0000-4000-8000-000000000000/resolve'],
    ['GET', '/api/workspaces/00000000-0000-4000-8000-000000000000/unresolved'],
  ])('%s %s is 401 without one', async (method, path) => {
    await withRollback(async (db) => {
      const response = await call(db, method, path, undefined);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    });
  });
});
