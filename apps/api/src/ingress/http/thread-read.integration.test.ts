/**
 * A reply is read in its thread, not by scrolling the feed past it (D-147, amending D-99 §4), and
 * `PUT /api/messages/:messageId/thread/read` is how a thread is read — through real requests. Its
 * cross-tenant and visibility crossings are in `cross-tenant.integration.test.ts` and
 * `channel-visibility.integration.test.ts`, from the table the build checks against `API.md`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type ChannelState, type NotificationPage } from '@purlay/types';
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

interface Room {
  readonly alice: SignedInUser;
  readonly bob: SignedInUser;
  readonly carol: SignedInUser;
  readonly workspaceId: string;
  readonly channelId: string;
}

/** Alice owns a workspace with #incidents; Bob and Carol are in both. */
const aRoom = async (db: Executor): Promise<Room> => {
  const alice = await aSignedInUser(db, clock, 'tr-alice');
  const bob = await aSignedInUser(db, clock, 'tr-bob');
  const carol = await aSignedInUser(db, clock, 'tr-carol');
  const created = await call(db, 'POST', '/api/workspaces', {
    cookie: alice.cookie,
    body: { name: 'room', slug: aUniqueSlug('tr') },
  });
  const workspaceId = ((await created.json()) as { id: string }).id;
  for (const person of [bob, carol]) {
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: person.userId, role: 'member', joined_at: NOW })
      .execute();
  }
  const channel = await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, {
    cookie: alice.cookie,
    body: { name: 'incidents' },
  });
  const channelId = ((await channel.json()) as { id: string }).id;
  for (const person of [bob, carol]) {
    const joined = await call(db, 'POST', `/api/channels/${channelId}/join`, {
      cookie: person.cookie,
    });
    expect(joined.ok).toBe(true);
  }
  return { alice, bob, carol, workspaceId, channelId };
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

const stateOf = async (db: Executor, room: Room, who: SignedInUser): Promise<ChannelState> => {
  const response = await call(db, 'GET', `/api/channels/${room.channelId}`, { cookie: who.cookie });
  return ((await response.json()) as { state: ChannelState }).state;
};

const inboxOf = async (db: Executor, room: Room, who: SignedInUser): Promise<NotificationPage> => {
  const response = await call(db, 'GET', `/api/notifications?workspaceId=${room.workspaceId}`, {
    cookie: who.cookie,
  });
  return (await response.json()) as NotificationPage;
};

const readFeed = async (db: Executor, room: Room, who: SignedInUser, id: string): Promise<void> => {
  const response = await call(db, 'PUT', `/api/channels/${room.channelId}/read`, {
    cookie: who.cookie,
    body: { lastReadMessageId: id },
  });
  expect(response.status).toBe(200);
};

const readThread = async (
  db: Executor,
  who: SignedInUser,
  rootId: string,
  lastReadMessageId: string,
): Promise<Response> =>
  await call(db, 'PUT', `/api/messages/${rootId}/thread/read`, {
    cookie: who.cookie,
    body: { lastReadMessageId },
  });

describe('integration: a reply is read in its thread, not by the feed', () => {
  test('reading the feed past an answer in a thread leaves the answer waiting until the thread is read', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'why is the retry backoff four seconds?');
      const answer = await say(db, room, room.carol, 2, 'it matches the upstream limit', question);
      const unrelated = await say(db, room, room.alice, 3, 'lunch is here');

      // Bob scrolls the channel to its newest message without opening the thread.
      await readFeed(db, room, room.bob, unrelated);

      const waiting = (await inboxOf(db, room, room.bob)).data;
      expect(waiting.map((n) => [n.type, n.message.id, n.readAt])).toEqual([
        ['thread_reply', answer, null],
      ]);
      // The badge, and the tab title and the inbox dot that add it up, still say it needs him.
      expect(await stateOf(db, room, room.bob)).toEqual({
        lastReadMessageId: unrelated,
        unreadCount: 1,
        unreadMentionCount: 1,
      });

      // He opens the thread: now it is read, and nothing is waiting.
      const opened = await readThread(db, room.bob, question, answer);
      expect(opened.status).toBe(204);
      const read = (await inboxOf(db, room, room.bob)).data;
      expect(read.map((n) => [n.message.id, n.readAt === null])).toEqual([[answer, false]]);
      expect(await stateOf(db, room, room.bob)).toEqual({
        lastReadMessageId: unrelated,
        unreadCount: 0,
        unreadMentionCount: 0,
      });
    });
  });

  test('the feed still reads what is in the feed: a mention in a root behind the position', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const mention = await say(db, room, room.alice, 1, `@${room.bob.username} can you look?`);
      const later = await say(db, room, room.carol, 2, 'and later');

      await readFeed(db, room, room.bob, later);
      const page = (await inboxOf(db, room, room.bob)).data;
      expect(page.map((n) => [n.type, n.message.id, n.readAt === null])).toEqual([
        ['mention', mention, false],
      ]);
      expect((await stateOf(db, room, room.bob)).unreadMentionCount).toBe(0);
    });
  });

  test('a thread is read up to and including the reply named, and no further', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'a question');
      const first = await say(db, room, room.carol, 2, 'first answer', question);
      const second = await say(db, room, room.alice, 3, 'second answer', question);

      expect((await readThread(db, room.bob, question, first)).status).toBe(204);
      const page = (await inboxOf(db, room, room.bob)).data;
      const waiting = new Map(page.map((n) => [n.message.id, n.readAt === null]));
      expect(waiting).toEqual(
        new Map([
          [first, false],
          [second, true],
        ]),
      );
      expect((await stateOf(db, room, room.bob)).unreadMentionCount).toBe(1);
      // Read again, and further: idempotent, and what is left is read.
      expect((await readThread(db, room.bob, question, second)).status).toBe(204);
      expect((await readThread(db, room.bob, question, second)).status).toBe(204);
      expect((await stateOf(db, room, room.bob)).unreadMentionCount).toBe(0);
    });
  });

  test('an answer read past in the feed and then read in the inbox is unread no longer', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'a question');
      await say(db, room, room.carol, 2, 'an answer', question);
      const unrelated = await say(db, room, room.alice, 3, 'unrelated');
      await readFeed(db, room, room.bob, unrelated);

      const [notification] = (await inboxOf(db, room, room.bob)).data;
      if (notification === undefined) throw new Error('bob was not told of the answer');
      const read = await call(db, 'PUT', '/api/notifications/read', {
        cookie: room.bob.cookie,
        body: { ids: [notification.id] },
      });
      expect(read.status).toBe(204);
      expect(await stateOf(db, room, room.bob)).toEqual({
        lastReadMessageId: unrelated,
        unreadCount: 0,
        unreadMentionCount: 0,
      });
    });
  });

  test('an answer read past in the feed and then deleted is taken back from both numbers', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'a question');
      const answer = await say(db, room, room.carol, 2, 'an answer', question);
      const unrelated = await say(db, room, room.alice, 3, 'unrelated');
      await readFeed(db, room, room.bob, unrelated);

      const removed = await call(db, 'DELETE', `/api/messages/${answer}`, {
        cookie: room.carol.cookie,
      });
      expect(removed.status).toBe(204);
      expect(await stateOf(db, room, room.bob)).toEqual({
        lastReadMessageId: unrelated,
        unreadCount: 0,
        unreadMentionCount: 0,
      });
    });
  });

  test('an answer whose id sorts behind the position waits, and is counted, all the same', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'a question');
      const unrelated = await say(db, room, room.alice, 3, 'unrelated');
      await readFeed(db, room, room.bob, unrelated);
      // A client may make an id up to a minute in the past (D-33): this one sorts before the position.
      const answer = await say(db, room, room.carol, 2, 'a late answer', question);

      const waiting = (await inboxOf(db, room, room.bob)).data;
      expect(waiting.map((n) => [n.message.id, n.readAt])).toEqual([[answer, null]]);
      expect(await stateOf(db, room, room.bob)).toEqual({
        lastReadMessageId: unrelated,
        unreadCount: 1,
        unreadMentionCount: 1,
      });
      expect((await readThread(db, room.bob, question, answer)).status).toBe(204);
      expect((await stateOf(db, room, room.bob)).unreadCount).toBe(0);
    });
  });

  test('a mention an edit adds to a reply read past in the feed waits for the thread', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.carol, 1, 'a question');
      const reply = await say(db, room, room.alice, 2, 'an answer', question);
      const unrelated = await say(db, room, room.carol, 3, 'unrelated');
      await readFeed(db, room, room.bob, unrelated);
      expect(await stateOf(db, room, room.bob)).toMatchObject({ unreadCount: 0 });

      const edited = await call(db, 'PATCH', `/api/messages/${reply}`, {
        cookie: room.alice.cookie,
        body: { content: `an answer, @${room.bob.username} take a look` },
      });
      expect(edited.status).toBe(200);
      expect(await stateOf(db, room, room.bob)).toEqual({
        lastReadMessageId: unrelated,
        unreadCount: 1,
        unreadMentionCount: 1,
      });
      expect((await readThread(db, room.bob, question, reply)).status).toBe(204);
      expect(await stateOf(db, room, room.bob)).toMatchObject({
        unreadCount: 0,
        unreadMentionCount: 0,
      });
    });
  });

  test('a reply has no thread to read, a message nobody can see is 404, and a session is needed', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db);
      const question = await say(db, room, room.bob, 1, 'a question');
      const answer = await say(db, room, room.carol, 2, 'an answer', question);

      const ofReply = await readThread(db, room.bob, answer, answer);
      expect(ofReply.status).toBe(404);
      expect(await ofReply.json()).toMatchObject({ error: { code: 'MESSAGE_NOT_FOUND' } });
      const never = await readThread(db, room.bob, messageId(NOW), answer);
      expect(never.status).toBe(404);
      const malformed = await call(db, 'PUT', `/api/messages/${question}/thread/read`, {
        cookie: room.bob.cookie,
        body: { lastReadMessageId: 'not-a-uuid' },
      });
      expect(malformed.status).toBe(400);
      const anonymous = await call(db, 'PUT', `/api/messages/${question}/thread/read`, {
        body: { lastReadMessageId: answer },
      });
      expect(anonymous.status).toBe(401);
    });
  });
});
