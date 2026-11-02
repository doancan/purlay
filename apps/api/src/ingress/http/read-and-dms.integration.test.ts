/**
 * `PUT /api/channels/:id/read` and `POST /api/workspaces/:id/dms`, through real
 * requests (`API.md` §4, D-99). Their cross-tenant and visibility crossings are in
 * `cross-tenant.integration.test.ts` and `channel-visibility.integration.test.ts`,
 * from the table the build checks against `API.md` (D-63, D-64).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  withRollback,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
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

describe('integration: the channel list and reads carry the caller’s state', () => {
  test('listing, reading, creating and joining all answer with state', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const listed = (await (
        await call(db, 'GET', `/api/workspaces/${room.workspaceId}/channels`, {
          cookie: room.bob.cookie,
        })
      ).json()) as { id: string; state: unknown; peer: unknown }[];
      // Bob's channel, and the one the workspace started with (D-174), which he has not joined.
      expect(listed).toHaveLength(2);
      expect(listed.find((channel) => channel.id === room.channelId)).toMatchObject({
        state: { lastReadMessageId: null, unreadCount: 0, unreadMentionCount: 0 },
        peer: null,
      });

      const one = await json(
        await call(db, 'GET', `/api/channels/${room.channelId}`, { cookie: room.alice.cookie }),
      );
      expect(one['state']).toMatchObject({ unreadCount: 0 });
    });
  });
});

describe('integration: PUT /api/channels/:id/read', () => {
  const path = (room: Room): string => `/api/channels/${room.channelId}/read`;

  test('moves the position, recounts, and answers with the new state', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const first = await say(db, room, room.bob, 1);
      await say(db, room, room.bob, 2);

      const response = await call(db, 'PUT', path(room), {
        cookie: room.alice.cookie,
        body: { lastReadMessageId: first },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        lastReadMessageId: first,
        unreadCount: 1,
        unreadMentionCount: 0,
      });
    });
  });

  test('a position behind the current one is accepted and changes nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const first = await say(db, room, room.bob, 1);
      const second = await say(db, room, room.bob, 2);
      await call(db, 'PUT', path(room), {
        cookie: room.alice.cookie,
        body: { lastReadMessageId: second },
      });

      const behind = await call(db, 'PUT', path(room), {
        cookie: room.alice.cookie,
        body: { lastReadMessageId: first },
      });
      expect(behind.status).toBe(200);
      expect((await json(behind))['lastReadMessageId']).toBe(second);
    });
  });

  test('refuses what the contract refuses, naming the field and nothing else', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const first = await say(db, room, room.bob, 1);
      for (const body of [
        {},
        { lastReadMessageId: 'not-a-uuid' },
        { lastReadMessageId: first, extra: 1 },
      ]) {
        const response = await call(db, 'PUT', path(room), { cookie: room.alice.cookie, body });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      }
    });
  });

  test('a message of another channel is 404, and a stranger to the session is 401', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const other = await call(db, 'POST', `/api/workspaces/${room.workspaceId}/channels`, {
        cookie: room.alice.cookie,
        body: { name: 'other' },
      });
      const otherId = (await json(other))['id'] as string;
      const foreign = messageId(new Date(NOW.getTime() + 5));
      await call(db, 'POST', `/api/channels/${otherId}/messages`, {
        cookie: room.alice.cookie,
        body: { id: foreign, content: 'elsewhere' },
      });

      const wrong = await call(db, 'PUT', path(room), {
        cookie: room.alice.cookie,
        body: { lastReadMessageId: foreign },
      });
      expect(wrong.status).toBe(404);
      expect(await wrong.json()).toMatchObject({ error: { code: 'MESSAGE_NOT_FOUND' } });

      const anonymous = await call(db, 'PUT', path(room), { body: { lastReadMessageId: foreign } });
      expect(anonymous.status).toBe(401);
    });
  });

  test('a person who can see the channel and has not joined it is told what a stranger is told', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const carol = await aSignedInUser(db, clock, 'rd-carol');
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: room.workspaceId,
          user_id: carol.userId,
          role: 'member',
          joined_at: NOW,
        })
        .execute();
      const first = await say(db, room, room.alice, 1);

      const response = await call(db, 'PUT', path(room), {
        cookie: carol.cookie,
        body: { lastReadMessageId: first },
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'CHANNEL_NOT_FOUND' } });
    });
  });
});

describe('integration: POST /api/workspaces/:id/dms', () => {
  const dms = (room: Room): string => `/api/workspaces/${room.workspaceId}/dms`;

  test('opens it with 201 and the same one again with 200', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const first = await call(db, 'POST', dms(room), {
        cookie: room.alice.cookie,
        body: { userId: room.bob.userId },
      });
      expect(first.status).toBe(201);
      const channel = await json(first);
      expect(channel).toMatchObject({ type: 'direct_message', name: null });
      expect((channel['peer'] as { id: string }).id).toBe(room.bob.userId);

      const again = await call(db, 'POST', dms(room), {
        cookie: room.bob.cookie,
        body: { userId: room.alice.userId },
      });
      expect(again.status).toBe(200);
      expect((await json(again))['id']).toBe(channel['id']);

      // It shows up in each person's list, naming the other.
      const forBob = (await (
        await call(db, 'GET', `/api/workspaces/${room.workspaceId}/channels`, {
          cookie: room.bob.cookie,
        })
      ).json()) as { type: string; peer: { id: string } | null }[];
      expect(forBob.find((entry) => entry.type === 'direct_message')?.peer?.id).toBe(
        room.alice.userId,
      );
    });
  });

  test('a note to self is created once', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const mine = { cookie: room.alice.cookie, body: { userId: room.alice.userId } };
      expect((await call(db, 'POST', dms(room), mine)).status).toBe(201);
      expect((await call(db, 'POST', dms(room), mine)).status).toBe(200);
    });
  });

  test('refuses a body the contract refuses, and a person who is not in the workspace', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const stranger = await aSignedInUser(db, clock, 'rd-stranger');
      for (const body of [{}, { userId: 'nope' }, { userId: room.bob.userId, also: true }]) {
        const response = await call(db, 'POST', dms(room), { cookie: room.alice.cookie, body });
        expect(response.status).toBe(400);
      }
      const response = await call(db, 'POST', dms(room), {
        cookie: room.alice.cookie,
        body: { userId: stranger.userId },
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'USER_NOT_FOUND' } });
    });
  });
});

describe('integration: two direct messages opened at once are one', () => {
  let cloned: ClonedDatabase;

  beforeAll(async () => {
    cloned = await cloneIntegrationDatabase();
    await sql`
      create function hold_window() returns trigger language plpgsql as
      $$ begin perform pg_sleep(0.3); return new; end $$
    `.execute(cloned.db);
  }, CLONE_HOOK_MS);

  afterAll(async () => {
    await cloned.drop();
  }, DROP_HOOK_MS);

  /**
   * Both look, both find nothing, both insert: only the unique index on the pair can
   * tell them apart. The sleep after the look holds the window open, so the test does
   * not rely on scheduling to produce the race.
   */
  test('from either side, with one channel and both people in it', async () => {
    const room = await aRoom(cloned.db);
    await sql`create trigger hold before insert on channels for each row execute function hold_window()`.execute(
      cloned.db,
    );
    try {
      const [first, second] = await Promise.all([
        call(cloned.db, 'POST', `/api/workspaces/${room.workspaceId}/dms`, {
          cookie: room.alice.cookie,
          body: { userId: room.bob.userId },
        }),
        call(cloned.db, 'POST', `/api/workspaces/${room.workspaceId}/dms`, {
          cookie: room.bob.cookie,
          body: { userId: room.alice.userId },
        }),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 201]);
      expect((await json(first))['id']).toBe((await json(second))['id']);
    } finally {
      await sql`drop trigger hold on channels`.execute(cloned.db);
    }

    const channels = await cloned.db
      .selectFrom('channels')
      .select('id')
      .where('workspace_id', '=', room.workspaceId)
      .where('type', '=', 'direct_message')
      .execute();
    expect(channels).toHaveLength(1);
    const members = await cloned.db
      .selectFrom('channel_members')
      .select('user_id')
      .where('channel_id', '=', channels[0]?.id ?? '')
      .execute();
    expect(members).toHaveLength(2);
  });
});

describe('integration: two reads of one channel at once keep the counters consistent', () => {
  let cloned: ClonedDatabase;

  beforeAll(async () => {
    cloned = await cloneIntegrationDatabase();
  }, CLONE_HOOK_MS);

  afterAll(async () => {
    await cloned.drop();
  }, DROP_HOOK_MS);

  test('the later position wins, however they interleave, and I-6 holds', async () => {
    const room = await aRoom(cloned.db);
    const ids: string[] = [];
    for (let at = 1; at <= 6; at += 1) ids.push(await say(cloned.db, room, room.bob, at));
    const path = `/api/channels/${room.channelId}/read`;

    // Many devices reading at once, to every position, in an order nobody chose.
    const answers = await Promise.all(
      [...ids, ...ids].map(
        async (lastReadMessageId) =>
          await call(cloned.db, 'PUT', path, {
            cookie: room.alice.cookie,
            body: { lastReadMessageId },
          }),
      ),
    );
    expect(answers.every((answer) => answer.status === 200)).toBe(true);

    const member = await cloned.db
      .selectFrom('channel_members')
      .select(['last_read_message_id', 'unread_count', 'unread_mention_count'])
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', room.alice.userId)
      .executeTakeFirstOrThrow();
    expect(member).toEqual({
      last_read_message_id: ids.at(-1) ?? null,
      unread_count: 0,
      unread_mention_count: 0,
    });
  });
});

/**
 * Ids are lower-case (`formats.ts`): the one spelling the read position's text comparison,
 * `dm_key`'s CHECK and the topic names all agree on. An upper-case one is refused at the
 * boundary, in the same words as any malformed id — it used to pass the contract and then be
 * a 400 from a database constraint, a read position that silently did not move, or a frame
 * published to a topic nobody listens on (H-API 2).
 */
describe('integration: an id spelled in upper case', () => {
  test('a direct message to it, a read up to it and a path naming it are refused, not half-done', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const id = await say(db, room, room.bob, 1);

      const dm = await call(db, 'POST', `/api/workspaces/${room.workspaceId}/dms`, {
        cookie: room.alice.cookie,
        body: { userId: room.bob.userId.toUpperCase() },
      });
      expect(dm.status).toBe(400);
      expect(((await json(dm))['error'] as { code: string }).code).toBe('VALIDATION_FAILED');

      const read = await call(db, 'PUT', `/api/channels/${room.channelId}/read`, {
        cookie: room.alice.cookie,
        body: { lastReadMessageId: id.toUpperCase() },
      });
      expect(read.status).toBe(400);

      const path = await call(db, 'GET', `/api/channels/${room.channelId.toUpperCase()}`, {
        cookie: room.alice.cookie,
      });
      expect(path.status).toBe(404);
      const thread = await call(db, 'GET', `/api/messages/${id.toUpperCase()}/thread`, {
        cookie: room.alice.cookie,
      });
      expect(thread.status).toBe(404);

      // The same requests in the one spelling work, and the position really moved.
      const ok = await call(db, 'PUT', `/api/channels/${room.channelId}/read`, {
        cookie: room.alice.cookie,
        body: { lastReadMessageId: id },
      });
      expect(ok.status).toBe(200);
      expect((await json(ok))['lastReadMessageId']).toBe(id);
    });
  });
});
