/**
 * Following a thread, and letting it go (D-161): `GET` and `PUT /api/messages/:messageId/follow`,
 * and what a reply then tells whom — through real requests. The crossings into another workspace and
 * into a private channel are in `cross-tenant.integration.test.ts` and
 * `channel-visibility.integration.test.ts`, from the table the build checks against `API.md`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type NotificationPage, type ThreadFollow } from '@purlay/types';
import { createApp } from './app';
import { THREAD_PARTICIPANTS_MAX } from '../../modules/messages/delivery';
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

interface Room {
  readonly alice: SignedInUser;
  readonly bob: SignedInUser;
  readonly carol: SignedInUser;
  readonly dave: SignedInUser;
  readonly workspaceId: string;
  readonly channelId: string;
}

/** Alice owns a workspace with #api; Bob, Carol and Dave are in both. */
const aRoom = async (db: Executor): Promise<Room> => {
  const alice = await aSignedInUser(db, clock, 'tf-alice');
  const bob = await aSignedInUser(db, clock, 'tf-bob');
  const carol = await aSignedInUser(db, clock, 'tf-carol');
  const dave = await aSignedInUser(db, clock, 'tf-dave');
  const created = await call(db, 'POST', '/api/workspaces', {
    cookie: alice.cookie,
    body: { name: 'room', slug: aUniqueSlug('tf') },
  });
  const workspaceId = ((await created.json()) as { id: string }).id;
  for (const person of [bob, carol, dave]) {
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: person.userId, role: 'member', joined_at: NOW })
      .execute();
  }
  const channel = await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, {
    cookie: alice.cookie,
    body: { name: 'api' },
  });
  const channelId = ((await channel.json()) as { id: string }).id;
  for (const person of [bob, carol, dave]) {
    const joined = await call(db, 'POST', `/api/channels/${channelId}/join`, {
      cookie: person.cookie,
    });
    expect(joined.ok).toBe(true);
  }
  return { alice, bob, carol, dave, workspaceId, channelId };
};

const say = async (
  db: Executor,
  room: Room,
  by: SignedInUser,
  at: number,
  content: string,
  parentId?: string,
): Promise<string> => {
  const id = messageId(new Date(NOW.getTime() + at));
  const response = await call(db, 'POST', `/api/channels/${room.channelId}/messages`, {
    cookie: by.cookie,
    body: { id, content, ...(parentId === undefined ? {} : { parentId }) },
  });
  expect(response.status).toBe(201);
  return id;
};

const follow = async (
  db: Executor,
  who: SignedInUser,
  rootId: string,
  following: boolean,
): Promise<Response> =>
  await call(db, 'PUT', `/api/messages/${rootId}/follow`, {
    cookie: who.cookie,
    body: { following },
  });

const followingOf = async (db: Executor, who: SignedInUser, rootId: string): Promise<boolean> => {
  const response = await call(db, 'GET', `/api/messages/${rootId}/follow`, { cookie: who.cookie });
  expect(response.status).toBe(200);
  return ((await response.json()) as ThreadFollow).following;
};

/** Why the person was told of each of these messages, or nothing: `[messageId, type]`. */
const toldOf = async (
  db: Executor,
  room: Room,
  who: SignedInUser,
): Promise<readonly (readonly [string, string])[]> => {
  const response = await call(db, 'GET', `/api/notifications?workspaceId=${room.workspaceId}`, {
    cookie: who.cookie,
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as NotificationPage).data.map(
    (n) => [n.message.id, n.type] as const,
  );
};

describe('integration: following a thread (D-161)', () => {
  test('somebody who started or answered a thread follows it; anybody else does not', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'why is the backoff four seconds?');
      await say(db, room, room.carol, 2, 'the upstream limit', question);

      expect(await followingOf(db, room.bob, question)).toBe(true);
      expect(await followingOf(db, room.carol, question)).toBe(true);
      expect(await followingOf(db, room.dave, question)).toBe(false);
    });
  });

  test('a person who unfollows is not told of the next reply; the others still are', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'why is the backoff four seconds?');
      await say(db, room, room.carol, 2, 'the upstream limit', question);

      const answered = await follow(db, room.bob, question, false);
      expect(answered.status).toBe(200);
      expect((await answered.json()) as ThreadFollow).toEqual({ following: false });
      expect(await followingOf(db, room.bob, question)).toBe(false);

      const later = await say(db, room, room.alice, 3, 'we could make it configurable', question);
      expect((await toldOf(db, room, room.bob)).some(([id]) => id === later)).toBe(false);
      // Carol answered and chose nothing: she is still told.
      expect(await toldOf(db, room, room.carol)).toContainEqual([later, 'thread_reply']);
    });
  });

  test('replying again after unfollowing does not follow again', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'why is the backoff four seconds?');
      await say(db, room, room.carol, 2, 'the upstream limit', question);
      expect((await follow(db, room.carol, question, false)).status).toBe(200);

      await say(db, room, room.carol, 3, 'one more thing', question);
      expect(await followingOf(db, room.carol, question)).toBe(false);

      const after = await say(db, room, room.bob, 4, 'thanks', question);
      expect((await toldOf(db, room, room.carol)).some(([id]) => id === after)).toBe(false);
    });
  });

  test('a mention still arrives in a thread the person has unfollowed', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'why is the backoff four seconds?');
      await say(db, room, room.carol, 2, 'the upstream limit', question);
      expect((await follow(db, room.bob, question, false)).status).toBe(200);

      const named = await say(
        db,
        room,
        room.carol,
        3,
        `@${room.bob.username} can you confirm?`,
        question,
      );
      expect(await toldOf(db, room, room.bob)).toContainEqual([named, 'mention']);
    });
  });

  test('following a thread one never wrote in tells one of its replies', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'why is the backoff four seconds?');
      await say(db, room, room.carol, 2, 'the upstream limit', question);
      const before = await say(db, room, room.alice, 3, 'agreed', question);
      expect((await toldOf(db, room, room.dave)).some(([id]) => id === before)).toBe(false);

      expect((await follow(db, room.dave, question, true)).status).toBe(200);
      expect(await followingOf(db, room.dave, question)).toBe(true);

      const reply = await say(db, room, room.carol, 4, 'shipping it', question);
      expect(await toldOf(db, room, room.dave)).toContainEqual([reply, 'thread_reply']);
      // Not retroactive: what was not told stays untold.
      expect((await toldOf(db, room, room.dave)).some(([id]) => id === before)).toBe(false);
    });
  });

  test('following again after unfollowing tells again', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'why is the backoff four seconds?');
      expect((await follow(db, room.bob, question, false)).status).toBe(200);
      expect((await follow(db, room.bob, question, true)).status).toBe(200);
      // Twice is once.
      expect((await follow(db, room.bob, question, true)).status).toBe(200);

      const reply = await say(db, room, room.carol, 2, 'the upstream limit', question);
      expect(await toldOf(db, room, room.bob)).toContainEqual([reply, 'thread_reply']);
    });
  });

  test('a thread let go is also quiet for a channel at every message', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const level = await call(db, 'PUT', `/api/channels/${room.channelId}/notification-level`, {
        cookie: room.dave.cookie,
        body: { level: 'all' },
      });
      expect(level.status).toBe(204);
      const question = await say(db, room, room.bob, 1, 'why is the backoff four seconds?');
      expect(await toldOf(db, room, room.dave)).toContainEqual([question, 'channel_message']);
      expect((await follow(db, room.dave, question, false)).status).toBe(200);

      const reply = await say(db, room, room.carol, 2, 'the upstream limit', question);
      expect((await toldOf(db, room, room.dave)).some(([id]) => id === reply)).toBe(false);
      // The rest of the channel is as loud as he asked.
      const next = await say(db, room, room.carol, 3, 'deploying now');
      expect(await toldOf(db, room, room.dave)).toContainEqual([next, 'channel_message']);
    });
  });

  test('a muted channel stays muted for a thread one follows', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'why is the backoff four seconds?');
      expect((await follow(db, room.dave, question, true)).status).toBe(200);
      const level = await call(db, 'PUT', `/api/channels/${room.channelId}/notification-level`, {
        cookie: room.dave.cookie,
        body: { level: 'none' },
      });
      expect(level.status).toBe(204);

      const reply = await say(db, room, room.carol, 2, 'the upstream limit', question);
      expect((await toldOf(db, room, room.dave)).some(([id]) => id === reply)).toBe(false);
    });
  });

  test('somebody who let a thread go does not take a place among the repliers a reply tells', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'why is the backoff four seconds?');
      await say(db, room, room.carol, 2, 'an early answer', question);
      // As many people as a reply tells, each answering after Carol.
      const later: SignedInUser[] = [];
      for (let n = 0; n < THREAD_PARTICIPANTS_MAX; n += 1) {
        const person = await aSignedInUser(db, clock, `tf-${String(n)}`);
        await db
          .insertInto('workspace_members')
          .values({
            workspace_id: room.workspaceId,
            user_id: person.userId,
            role: 'member',
            joined_at: NOW,
          })
          .execute();
        const joined = await call(db, 'POST', `/api/channels/${room.channelId}/join`, {
          cookie: person.cookie,
        });
        expect(joined.ok).toBe(true);
        await say(db, room, person, 10 + n, `answer ${String(n)}`, question);
        later.push(person);
      }
      const leaving = later[THREAD_PARTICIPANTS_MAX - 1];
      if (leaving === undefined) throw new Error('nobody to let the thread go');
      expect((await follow(db, leaving, question, false)).status).toBe(200);

      const reply = await say(db, room, room.alice, 1000, 'closing the loop', question);
      // Carol was the fifty-first most recent: the place the one who left made is hers.
      expect(await toldOf(db, room, room.carol)).toContainEqual([reply, 'thread_reply']);
      expect((await toldOf(db, room, leaving)).some(([id]) => id === reply)).toBe(false);
    });
  });

  test('a reply has no thread to follow, and a malformed body is refused', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'why is the backoff four seconds?');
      const answer = await say(db, room, room.carol, 2, 'the upstream limit', question);

      const onReply = await follow(db, room.dave, answer, true);
      expect(onReply.status).toBe(404);
      expect(await onReply.json()).toMatchObject({ error: { code: 'MESSAGE_NOT_FOUND' } });
      const read = await call(db, 'GET', `/api/messages/${answer}/follow`, {
        cookie: room.dave.cookie,
      });
      expect(read.status).toBe(404);

      const malformed = await call(db, 'PUT', `/api/messages/${question}/follow`, {
        cookie: room.dave.cookie,
        body: { following: 'yes' },
      });
      expect(malformed.status).toBe(400);
    });
  });

  test('somebody in another workspace is told the thread is not there', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const stranger = await aSignedInUser(db, clock, 'tf-stranger');
      const question = await say(db, room, room.bob, 1, 'why is the backoff four seconds?');

      for (const response of [
        await follow(db, stranger, question, true),
        await call(db, 'GET', `/api/messages/${question}/follow`, { cookie: stranger.cookie }),
      ]) {
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: 'MESSAGE_NOT_FOUND' } });
      }
      expect(
        await db
          .selectFrom('thread_follows')
          .selectAll()
          .where('message_id', '=', question)
          .execute(),
      ).toEqual([]);
      const reply = await say(db, room, room.carol, 2, 'the upstream limit', question);
      expect(
        await db
          .selectFrom('notifications')
          .select('user_id')
          .where('message_id', '=', reply)
          .where('user_id', '=', stranger.userId)
          .execute(),
      ).toEqual([]);
    });
  });
});
