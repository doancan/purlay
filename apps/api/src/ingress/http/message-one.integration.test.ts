/**
 * `GET /api/messages/:messageId` (D-217) against a real database: the message for whoever may read it,
 * and the same 404 for everything else, with nothing of the message in it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { createApp } from './app';
import { NOW, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

const call = async (
  db: Executor,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`https://purlay.test${path}`, {
      method,
      headers: {
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );

const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

interface Room {
  readonly alice: SignedInUser;
  readonly bob: SignedInUser;
  readonly workspaceId: string;
  readonly channelId: string;
}

/** Alice owns a workspace with a channel; Bob is a member of both. */
const aRoom = async (db: Executor): Promise<Room> => {
  const alice = await aSignedInUser(db, clock, 'rd-alice');
  const bob = await aSignedInUser(db, clock, 'rd-bob');
  const created = await call(db, 'POST', '/api/workspaces', {
    cookie: alice.cookie,
    body: { name: 'room', slug: aUniqueSlug('rd') },
  });
  const workspaceId = (await json(created))['id'] as string;
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW })
    .execute();
  const channel = await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, {
    cookie: alice.cookie,
    body: { name: 'ops' },
  });
  const channelId = (await json(channel))['id'] as string;
  expect(
    (await call(db, 'POST', `/api/channels/${channelId}/join`, { cookie: bob.cookie })).ok,
  ).toBe(true);
  return { alice, bob, workspaceId, channelId };
};

const say = async (db: Executor, room: Room, by: SignedInUser, at: number): Promise<string> => {
  const id = messageId(new Date(NOW.getTime() + at));
  const response = await call(db, 'POST', `/api/channels/${room.channelId}/messages`, {
    cookie: by.cookie,
    body: { id, content: `m${String(at)}` },
  });
  expect(response.status).toBe(201);
  return id;
};

describe('integration: one message, for a card (D-217)', () => {
  test('a message the caller can read is the message, a reply included', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const root = await say(db, room, room.alice, 1_000);
      const reply = messageId(new Date(NOW.getTime() + 2_000));
      await call(db, 'POST', `/api/channels/${room.channelId}/messages`, {
        cookie: room.alice.cookie,
        body: { id: reply, content: 'in the thread', parentId: root },
      });
      const one = await call(db, 'GET', `/api/messages/${root}`, { cookie: room.bob.cookie });
      expect(one.status).toBe(200);
      const message = await json(one);
      expect(message['id']).toBe(root);
      expect(message['content']).toBe('m1000');
      expect((message['sender'] as { id: string }).id).toBe(room.alice.userId);
      const answer = await call(db, 'GET', `/api/messages/${reply}`, { cookie: room.bob.cookie });
      expect((await json(answer))['parentId']).toBe(root);
    });
  });

  test('a private channel the caller is not in, a deleted message and nonsense are the one 404', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const secret = await call(db, 'POST', `/api/workspaces/${room.workspaceId}/channels`, {
        cookie: room.alice.cookie,
        body: { name: 'secret', type: 'private' },
      });
      const secretId = (await json(secret))['id'] as string;
      const hidden = messageId(new Date(NOW.getTime() + 3_000));
      await call(db, 'POST', `/api/channels/${secretId}/messages`, {
        cookie: room.alice.cookie,
        body: { id: hidden, content: 'only for alice' },
      });
      const gone = await say(db, room, room.alice, 4_000);
      expect(
        (await call(db, 'DELETE', `/api/messages/${gone}`, { cookie: room.alice.cookie })).ok,
      ).toBe(true);
      for (const id of [hidden, gone, 'not-an-id']) {
        const response = await call(db, 'GET', `/api/messages/${id}`, { cookie: room.bob.cookie });
        expect(response.status).toBe(404);
        const body = await json(response);
        expect((body['error'] as { code: string }).code).toBe('MESSAGE_NOT_FOUND');
        expect(JSON.stringify(body)).not.toContain('only for alice');
      }
    });
  });
});
