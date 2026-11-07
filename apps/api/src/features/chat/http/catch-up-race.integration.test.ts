/** Independent catch-up reads and deliveries on real connections, never a rollback's single session. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  sql,
  cloneIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId, type Message } from '@purlay/types';
import { createApp } from '../../../ingress/http/app';
import { fixedClock } from '../../../platform/clock';
import { NOW, testDependencies } from '../../../testing/doubles';
import { aRoom } from '../../../testing/rooms';
import { aSession } from '../../../testing/signed-in';
import { SESSION_COOKIE } from '../../../platform/cookies';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);
const clock = fixedClock(NOW);

const setup = async (): Promise<{
  readonly channelId: string;
  readonly readerId: string;
  readonly read: (root: string, bound: string) => Promise<Response>;
  readonly feed: (bound: string) => Promise<Response>;
  readonly join: () => Promise<Response>;
  readonly say: (parentId?: string) => Promise<Message>;
}> => {
  const room = await aRoom(cloned.db, ['writer', 'reader']);
  const reader = room.members['reader'];
  const writer = room.members['writer'];
  if (reader === undefined || writer === undefined) throw new Error('Missing members');
  const readerSession = await aSession(cloned.db, clock, reader.userId);
  const writerSession = await aSession(cloned.db, clock, writer.userId);
  const app = createApp(testDependencies({ database: cloned.db, clock }));
  const call = async (
    method: string,
    path: string,
    token: string,
    body: unknown,
  ): Promise<Response> =>
    await app.handle(
      new Request(`https://purlay.test${path}`, {
        method,
        headers: { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  let tick = 0;
  return {
    join: async () =>
      await call('POST', `/api/channels/${room.channelId}/join`, readerSession.token, undefined),
    channelId: room.channelId,
    readerId: reader.userId,
    read: async (root, bound) =>
      await call('PUT', `/api/messages/${root}/thread/read`, readerSession.token, {
        lastReadMessageId: bound,
      }),
    feed: async (bound) =>
      await call('PUT', `/api/channels/${room.channelId}/read`, readerSession.token, {
        lastReadMessageId: bound,
      }),
    say: async (parentId): Promise<Message> => {
      tick += 1;
      const answer = await call(
        'POST',
        `/api/channels/${room.channelId}/messages`,
        writerSession.token,
        {
          id: messageId(new Date(NOW.getTime() + tick)),
          content: `Handover ${String(tick)}`,
          ...(parentId === undefined ? {} : { parentId }),
        },
      );
      expect(answer.status).toBe(201);
      return (await answer.json()) as Message;
    },
  };
};

describe('integration: catch-up concurrency', () => {
  test('two devices reading different bounds preserve the furthest receipt and an unseen root', async () => {
    const world = await setup();
    const root = await world.say();
    expect((await world.feed(root.id)).status).toBe(200);
    const first = await world.say(root.id);
    const second = await world.say(root.id);
    await world.say();
    const answers = await Promise.all([
      world.read(root.id, second.id),
      world.read(root.id, first.id),
      world.read(root.id, second.id),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([204, 204, 204]);
    expect(
      await cloned.db
        .selectFrom('thread_reads')
        .select('last_read_message_id')
        .where('user_id', '=', world.readerId)
        .where('root_id', '=', root.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ last_read_message_id: second.id });
    expect(
      await cloned.db
        .selectFrom('channel_members')
        .select(['unread_count', 'last_read_message_id'])
        .where('channel_id', '=', world.channelId)
        .where('user_id', '=', world.readerId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ unread_count: 1, last_read_message_id: root.id });
  });

  test('a feed read and a thread read racing a new reply leave exactly that unseen reply waiting', async () => {
    const world = await setup();
    const root = await world.say();
    const oldReply = await world.say(root.id);
    const [feed, thread, arrived] = await Promise.all([
      world.feed(root.id),
      world.read(root.id, oldReply.id),
      world.say(root.id),
    ]);
    expect(feed.status).toBe(200);
    expect(thread.status).toBe(204);
    expect(arrived.id > oldReply.id).toBe(true);
    expect(
      await cloned.db
        .selectFrom('channel_members')
        .select(['unread_count', 'unread_mention_count', 'last_read_message_id'])
        .where('channel_id', '=', world.channelId)
        .where('user_id', '=', world.readerId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ unread_count: 1, unread_mention_count: 0, last_read_message_id: root.id });
  });
  test('a failed scope insert rolls the join back, and a later retry can join normally', async () => {
    const world = await setup();
    await cloned.db
      .deleteFrom('channel_members')
      .where('channel_id', '=', world.channelId)
      .where('user_id', '=', world.readerId)
      .execute();
    await sql`create function refuse_scope_insert() returns trigger language plpgsql as
      $$ begin raise exception 'scope write refused'; end $$`.execute(cloned.db);
    await sql`create trigger refuse_scope before insert on channel_read_scopes for each row execute function refuse_scope_insert()`.execute(
      cloned.db,
    );
    try {
      expect((await world.join()).status).toBe(500);
      expect(
        await cloned.db
          .selectFrom('channel_members')
          .select('id')
          .where('channel_id', '=', world.channelId)
          .where('user_id', '=', world.readerId)
          .execute(),
      ).toEqual([]);
    } finally {
      await sql`drop trigger refuse_scope on channel_read_scopes`.execute(cloned.db);
      await sql`drop function refuse_scope_insert()`.execute(cloned.db);
    }
    expect((await world.join()).status).toBe(200);
    expect(
      await cloned.db
        .selectFrom('channel_read_scopes')
        .select('unread_since')
        .where('channel_id', '=', world.channelId)
        .where('user_id', '=', world.readerId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ unread_since: NOW });
  });
});
