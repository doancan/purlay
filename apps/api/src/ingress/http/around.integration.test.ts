/**
 * A link to a message opens the feed around it (D-149, `API.md` §5): the window, its two cursors,
 * a reply's root, and the one `404` for a message that is gone or not the caller's to see. The
 * tenant and visibility crossings are in `cross-tenant` and `channel-visibility`, which read the
 * endpoint list from `API.md`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { MESSAGE_WINDOW_SIDE, MessageWindow, messageId } from '@purlay/types';
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
  cookie: string,
  body?: unknown,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`https://purlay.test${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

interface World {
  readonly alice: string;
  readonly outsider: string;
  readonly channelId: string;
}

const aWorld = async (db: Executor): Promise<World> => {
  const alice = await aSignedInUser(db, clock, 'ar-alice');
  const outsider = await aSignedInUser(db, clock, 'ar-out');
  const created = await call(db, 'POST', '/api/workspaces', alice.cookie, {
    name: 'ar',
    slug: aUniqueSlug('ar'),
  });
  const workspaceId = ((await created.json()) as { id: string }).id;
  const channel = await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, alice.cookie, {
    name: 'ops',
  });
  const channelId = ((await channel.json()) as { id: string }).id;
  return { alice: alice.cookie, outsider: outsider.cookie, channelId };
};

/** Sends `count` roots, one millisecond apart so their ids are in the order they were sent. */
const roots = async (db: Executor, world: World, count: number): Promise<string[]> => {
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const id = messageId(new Date(NOW.getTime() - 10_000 + n));
    const sent = await call(db, 'POST', `/api/channels/${world.channelId}/messages`, world.alice, {
      id,
      content: `m${String(n)}`,
    });
    expect(sent.status).toBe(201);
    ids.push(id);
  }
  return ids;
};

const around = async (db: Executor, world: World, id: string): Promise<Response> =>
  await call(db, 'GET', `/api/messages/${id}/around`, world.alice);

const windowOf = async (response: Response): Promise<MessageWindow> => {
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(Value.Check(MessageWindow, body)).toBe(true);
  return body as MessageWindow;
};

describe('integration: the feed around a message (D-149)', () => {
  test('holds the message with a side of roots before and after it, newest first, and both cursors', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const ids = await roots(db, world, MESSAGE_WINDOW_SIDE * 2 + 11);
      const middle = MESSAGE_WINDOW_SIDE + 5;
      const target = ids[middle] ?? '';

      const window = await windowOf(await around(db, world, target));
      expect(window.target.id).toBe(target);
      const expected = ids
        .slice(middle - MESSAGE_WINDOW_SIDE, middle + MESSAGE_WINDOW_SIDE + 1)
        .reverse();
      expect(window.data.map((m) => m.id)).toEqual(expected);
      expect(window.olderCursor).toBe(expected.at(-1) ?? null);
      expect(window.newerCursor).toBe(expected[0] ?? null);

      // Each cursor continues the window as the feed's own pages do, with nothing skipped.
      const older = await call(
        db,
        'GET',
        `/api/channels/${world.channelId}/messages?before=${window.olderCursor ?? ''}`,
        world.alice,
      );
      const olderIds = ((await older.json()) as { data: { id: string }[] }).data.map((m) => m.id);
      expect(olderIds).toEqual(ids.slice(0, middle - MESSAGE_WINDOW_SIDE).reverse());
      const newer = await call(
        db,
        'GET',
        `/api/channels/${world.channelId}/messages?after=${window.newerCursor ?? ''}`,
        world.alice,
      );
      const newerIds = ((await newer.json()) as { data: { id: string }[] }).data.map((m) => m.id);
      expect(newerIds).toEqual(ids.slice(middle + MESSAGE_WINDOW_SIDE + 1));
    });
  });

  test('says an end is reached with a null cursor', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const ids = await roots(db, world, 3);
      const window = await windowOf(await around(db, world, ids[1] ?? ''));
      expect(window.data.map((m) => m.id)).toEqual([...ids].reverse());
      expect(window.olderCursor).toBeNull();
      expect(window.newerCursor).toBeNull();
    });
  });

  test('a reply is the target, and the window is around its root', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const ids = await roots(db, world, 3);
      const root = ids[1] ?? '';
      const reply = messageId(NOW);
      const sent = await call(
        db,
        'POST',
        `/api/channels/${world.channelId}/messages`,
        world.alice,
        {
          id: reply,
          content: 'an answer',
          parentId: root,
        },
      );
      expect(sent.status).toBe(201);

      const window = await windowOf(await around(db, world, reply));
      expect(window.target).toMatchObject({ id: reply, parentId: root });
      expect(window.data.map((m) => m.id)).toEqual([...ids].reverse());
    });
  });

  test('a deleted message, one never sent, and one the caller cannot see are the same 404', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const [kept, gone] = await roots(db, world, 2);
      expect((await call(db, 'DELETE', `/api/messages/${gone ?? ''}`, world.alice)).status).toBe(
        204,
      );
      for (const [cookie, id] of [
        [world.alice, gone],
        [world.alice, messageId(NOW)],
        [world.outsider, kept],
      ] as const) {
        const response = await call(db, 'GET', `/api/messages/${id ?? ''}/around`, cookie);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: 'MESSAGE_NOT_FOUND' } });
      }
    });
  });
});
