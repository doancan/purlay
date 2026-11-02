/**
 * "Mark unread from here" (D-212), through the HTTP surface against a real database: where the
 * position lands, what is counted, what is refused, and that it is the one backwards move.
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

interface State {
  readonly lastReadMessageId: string | null;
  readonly unreadCount: number;
  readonly unreadMentionCount: number;
}

const unread = async (
  db: Executor,
  room: Room,
  by: SignedInUser,
  from: string,
): Promise<Response> =>
  await call(db, 'PUT', `/api/channels/${room.channelId}/unread`, {
    cookie: by.cookie,
    body: { fromMessageId: from },
  });

const readTo = async (db: Executor, room: Room, by: SignedInUser, to: string): Promise<State> =>
  (await (
    await call(db, 'PUT', `/api/channels/${room.channelId}/read`, {
      cookie: by.cookie,
      body: { lastReadMessageId: to },
    })
  ).json()) as State;

const versionOf = async (db: Executor, room: Room, by: SignedInUser): Promise<number> => {
  const row = await db
    .selectFrom('channel_members')
    .select('state_version')
    .where('channel_id', '=', room.channelId)
    .where('user_id', '=', by.userId)
    .executeTakeFirstOrThrow();
  return row.state_version;
};

describe('integration: mark unread from here (D-212)', () => {
  test('moves the position back to just before the message, and recounts', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const one = await say(db, room, room.alice, 1_000);
      const two = await say(db, room, room.alice, 2_000);
      const three = await say(db, room, room.alice, 3_000);
      expect((await readTo(db, room, room.bob, three)).unreadCount).toBe(0);

      const response = await unread(db, room, room.bob, two);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        lastReadMessageId: one,
        unreadCount: 2,
        unreadMentionCount: 0,
      });
      // The row says the same: the answer is not computed apart from it.
      const row = await db
        .selectFrom('channel_members')
        .select(['last_read_message_id', 'unread_count'])
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', room.bob.userId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ last_read_message_id: one, unread_count: 2 });
    });
  });

  test('from the first message, nothing is read; the person’s own messages never count', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const first = await say(db, room, room.alice, 1_000);
      await say(db, room, room.bob, 2_000);
      const last = await say(db, room, room.alice, 3_000);
      await readTo(db, room, room.bob, last);
      expect(await (await unread(db, room, room.bob, first)).json()).toEqual({
        lastReadMessageId: null,
        unreadCount: 2,
        unreadMentionCount: 0,
      });
    });
  });

  test('already unread from there, it changes nothing and moves no version', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      await say(db, room, room.alice, 1_000);
      const two = await say(db, room, room.alice, 2_000);
      const three = await say(db, room, room.alice, 3_000);
      await readTo(db, room, room.bob, three);
      await unread(db, room, room.bob, two);
      const version = await versionOf(db, room, room.bob);
      const again = await unread(db, room, room.bob, three);
      expect(again.status).toBe(200);
      expect(((await again.json()) as State).unreadCount).toBe(2);
      expect(await versionOf(db, room, room.bob)).toBe(version);
    });
  });

  test('a reply marks its thread’s root: the position reads the feed (D-147)', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const before = await say(db, room, room.alice, 1_000);
      const root = await say(db, room, room.alice, 2_000);
      const reply = messageId(new Date(NOW.getTime() + 3_000));
      const replied = await call(db, 'POST', `/api/channels/${room.channelId}/messages`, {
        cookie: room.alice.cookie,
        body: { id: reply, content: 'in the thread', parentId: root },
      });
      expect(replied.status).toBe(201);
      await readTo(db, room, room.bob, reply);
      const state = (await (await unread(db, room, room.bob, reply)).json()) as State;
      expect(state.lastReadMessageId).toBe(before);
    });
  });

  test('then reading moves forward again, as it always did', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      await say(db, room, room.alice, 1_000);
      const two = await say(db, room, room.alice, 2_000);
      await readTo(db, room, room.bob, two);
      await unread(db, room, room.bob, two);
      expect((await readTo(db, room, room.bob, two)).unreadCount).toBe(0);
    });
  });

  test('a message of another channel, and a channel the person is not in, are not found', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const mine = await say(db, room, room.alice, 1_000);
      const other = await call(db, 'POST', `/api/workspaces/${room.workspaceId}/channels`, {
        cookie: room.alice.cookie,
        body: { name: 'elsewhere' },
      });
      const otherId = (await json(other))['id'] as string;
      const elsewhere = messageId(new Date(NOW.getTime() + 2_000));
      await call(db, 'POST', `/api/channels/${otherId}/messages`, {
        cookie: room.alice.cookie,
        body: { id: elsewhere, content: 'there' },
      });
      const wrong = await unread(db, room, room.bob, elsewhere);
      expect(wrong.status).toBe(404);
      expect(((await json(wrong))['error'] as { code: string }).code).toBe('MESSAGE_NOT_FOUND');
      // Bob never joined `elsewhere`: it has no position of his to move.
      const notIn = await call(db, 'PUT', `/api/channels/${otherId}/unread`, {
        cookie: room.bob.cookie,
        body: { fromMessageId: elsewhere },
      });
      expect(notIn.status).toBe(404);
      expect((await unread(db, room, room.bob, mine)).status).toBe(200);
    });
  });

  test('a body that is not a message id is refused before anything is read', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const refused = await call(db, 'PUT', `/api/channels/${room.channelId}/unread`, {
        cookie: room.bob.cookie,
        body: { fromMessageId: 'nope' },
      });
      expect(refused.status).toBe(400);
    });
  });
});
