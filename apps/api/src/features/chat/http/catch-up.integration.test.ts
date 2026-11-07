/** The private catch-up door: bounded roots, waiting threads and no implicit read (#1193). */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  closeIntegrationDatabase,
  withRollback,
  type Executor,
  type Transaction,
} from '@purlay/db';
import { ChannelCatchUp, messageId, type Message } from '@purlay/types';
import { createApp } from '../../../ingress/http/app';
import { fixedClock } from '../../../platform/clock';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { NOW, testDependencies } from '../../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../../testing/signed-in';
import { aUniqueSlug } from '../../../testing/users';
import { createChannel, joinChannel } from '../channels/channels';
import { requireChannelById } from '../channels/guard';

afterAll(async () => {
  await closeIntegrationDatabase();
});
const clock = fixedClock(NOW);

const call = async (
  db: Executor,
  method: string,
  path: string,
  cookie?: string,
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

interface Room {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly reader: SignedInUser;
  readonly writer: SignedInUser;
}

const room = async (db: Transaction): Promise<Room> => {
  const reader = await aSignedInUser(db, clock, 'cu-reader');
  const writer = await aSignedInUser(db, clock, 'cu-writer');
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Operations', slug: aUniqueSlug('cu'), created_by: writer.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_members')
    .values([
      { workspace_id: workspace.id, user_id: writer.userId, role: 'owner', joined_at: NOW },
      { workspace_id: workspace.id, user_id: reader.userId, role: 'member', joined_at: NOW },
    ])
    .execute();
  const channel = await createChannel(
    db,
    clock,
    await requireWorkspaceMembership(db, writer.userId, workspace.id),
    { name: 'handover' },
  );
  await joinChannel(db, clock, await requireChannelById(db, reader.userId, channel.id));
  return { workspaceId: workspace.id, channelId: channel.id, reader, writer };
};

const say = async (db: Executor, setup: Room, at: number, parentId?: string): Promise<Message> => {
  const response = await call(
    db,
    'POST',
    `/api/channels/${setup.channelId}/messages`,
    setup.writer.cookie,
    {
      id: messageId(new Date(NOW.getTime() + at)),
      content: `Handover ${String(at)}`,
      ...(parentId === undefined ? {} : { parentId }),
    },
  );
  expect(response.status).toBe(201);
  return (await response.json()) as Message;
};

const page = async (db: Executor, setup: Room, query = ''): Promise<ChannelCatchUp> => {
  const response = await call(
    db,
    'GET',
    `/api/channels/${setup.channelId}/unreads${query}`,
    setup.reader.cookie,
  );
  expect(response.status).toBe(200);
  const data: unknown = await response.json();
  if (!Value.Check(ChannelCatchUp, data)) throw new Error('Invalid catch-up response');
  return data;
};

describe('integration: private channel catch-up', () => {
  test('starts at the oldest unread root and advances only after the displayed page is explicitly read', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      const messages: Message[] = [];
      for (let index = 1; index <= 25; index += 1) messages.push(await say(db, setup, index));
      const first = await page(db, setup);
      expect(first.roots.data.map((message) => message.id)).toEqual(
        messages.slice(0, 20).map((message) => message.id),
      );
      const boundary = messages[19];
      if (boundary === undefined) throw new Error('Missing twentieth fixture message');
      expect(first.roots.nextCursor).toBe(boundary.id);
      expect(first.threads).toEqual([]);
      const before = await db
        .selectFrom('channel_members')
        .select(['last_read_message_id', 'unread_count'])
        .where('channel_id', '=', setup.channelId)
        .where('user_id', '=', setup.reader.userId)
        .executeTakeFirstOrThrow();
      expect(before).toEqual({ last_read_message_id: null, unread_count: 25 });
      expect(
        (
          await call(db, 'PUT', `/api/channels/${setup.channelId}/read`, setup.reader.cookie, {
            lastReadMessageId: first.roots.nextCursor,
          })
        ).status,
      ).toBe(200);
      expect((await page(db, setup)).roots.data.map((message) => message.id)).toEqual(
        messages.slice(20).map((message) => message.id),
      );
    });
  });

  test('pages waiting threads separately and a root read leaves their undisplayed replies waiting', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      const a = await say(db, setup, 1);
      const b = await say(db, setup, 2);
      await call(db, 'PUT', `/api/channels/${setup.channelId}/read`, setup.reader.cookie, {
        lastReadMessageId: b.id,
      });
      const answerB = await say(db, setup, 3, b.id);
      const answerA = await say(db, setup, 4, a.id);
      const root = await say(db, setup, 5);
      const first = await page(db, setup, '?limit=1');
      expect(first.roots.data.map((message) => message.id)).toEqual([root.id]);
      expect(
        first.threads.map((thread) => [
          thread.root.id,
          thread.firstUnreadMessageId,
          thread.unreadCount,
        ]),
      ).toEqual([[a.id, answerA.id, 1]]);
      expect(first.nextThreadCursor).toBe(a.id);
      expect(
        (await page(db, setup, `?limit=1&afterThread=${a.id}`)).threads.map(
          (thread) => thread.root.id,
        ),
      ).toEqual([b.id]);
      await call(db, 'PUT', `/api/channels/${setup.channelId}/read`, setup.reader.cookie, {
        lastReadMessageId: root.id,
      });
      expect((await page(db, setup)).threads).toHaveLength(2);
      await call(db, 'PUT', `/api/messages/${a.id}/thread/read`, setup.reader.cookie, {
        lastReadMessageId: answerA.id,
      });
      expect((await page(db, setup)).threads.map((thread) => thread.root.id)).toEqual([b.id]);
      await call(db, 'PUT', `/api/messages/${b.id}/thread/read`, setup.reader.cookie, {
        lastReadMessageId: answerB.id,
      });
      expect(await page(db, setup)).toEqual({
        roots: { data: [], nextCursor: null },
        threads: [],
        nextThreadCursor: null,
      });
    });
  });

  test('a join excludes old history but an explicit rewind adds its range without reading a backdated new message', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', setup.channelId)
        .where('user_id', '=', setup.reader.userId)
        .execute();
      const first = await say(db, setup, 1);
      const second = await say(db, setup, 2);
      await db
        .updateTable('messages')
        .set({ created_at: new Date(NOW.getTime() - 1000) })
        .where('channel_id', '=', setup.channelId)
        .execute();
      await joinChannel(
        db,
        clock,
        await requireChannelById(db, setup.reader.userId, setup.channelId),
      );
      const arrived = await say(db, setup, -10);
      expect((await page(db, setup)).roots.data.map((message) => message.id)).toEqual([arrived.id]);
      await call(db, 'PUT', `/api/channels/${setup.channelId}/unread`, setup.reader.cookie, {
        fromMessageId: first.id,
      });
      expect((await page(db, setup)).roots.data.map((message) => message.id)).toEqual([
        arrived.id,
        first.id,
        second.id,
      ]);
    });
  });

  test('requires a session and channel membership without disclosing another workspace or a public visitor’s private state', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      const path = `/api/channels/${setup.channelId}/unreads`;
      expect((await call(db, 'GET', path)).status).toBe(401);
      const outsider = await aSignedInUser(db, clock, 'cu-outsider');
      expect((await call(db, 'GET', path, outsider.cookie)).status).toBe(404);
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', setup.channelId)
        .where('user_id', '=', setup.reader.userId)
        .execute();
      expect((await call(db, 'GET', path, setup.reader.cookie)).status).toBe(404);
    });
  });
  test('excludes own, hidden and deleted unread content, but keeps a waiting thread’s tombstone context', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      const live = await say(db, setup, 1);
      const removed = await say(db, setup, 2);
      const hidden = await say(db, setup, 3);
      const deletedParent = await say(db, setup, 4);
      const hiddenParent = await say(db, setup, 5);
      const deletedReply = await say(db, setup, 6, live.id);
      const hiddenReply = await say(db, setup, 7, live.id);
      const answer = await say(db, setup, 8, deletedParent.id);
      const hiddenContextAnswer = await say(db, setup, 9, hiddenParent.id);
      const own = await call(
        db,
        'POST',
        `/api/channels/${setup.channelId}/messages`,
        setup.reader.cookie,
        { id: messageId(new Date(NOW.getTime() + 10)), content: 'My own reply', parentId: live.id },
      );
      expect(own.status).toBe(201);
      for (const message of [removed, deletedParent, deletedReply]) {
        expect(
          (await call(db, 'DELETE', `/api/messages/${message.id}`, setup.writer.cookie)).status,
        ).toBe(204);
      }
      for (const message of [hidden, hiddenParent, hiddenReply]) {
        expect(
          (await call(db, 'PUT', `/api/messages/${message.id}/hidden`, setup.reader.cookie)).status,
        ).toBe(200);
      }
      const result = await page(db, setup);
      expect(result.roots.data.map((message) => message.id)).toEqual([live.id]);
      expect(result.threads.map((thread) => [thread.root.id, thread.firstUnreadMessageId])).toEqual(
        [
          [deletedParent.id, answer.id],
          [hiddenParent.id, hiddenContextAnswer.id],
        ],
      );
      expect(result.threads.every((thread) => thread.root.content === '')).toBe(true);
      expect(result.nextThreadCursor).toBeNull();
    });
  });

  test('rejects malformed and unbounded query values without changing a read position', async () => {
    await withRollback(async (db) => {
      const setup = await room(db);
      await say(db, setup, 1);
      for (const query of [
        '?limit=0',
        '?limit=101',
        '?limit=1.5',
        '?afterThread=not-a-uuid',
        '?before=ignored',
      ]) {
        expect(
          (
            await call(
              db,
              'GET',
              `/api/channels/${setup.channelId}/unreads${query}`,
              setup.reader.cookie,
            )
          ).status,
        ).toBe(400);
      }
      const last = await page(db, setup, `?limit=1&afterThread=${messageId(NOW)}`);
      expect(last.roots.data).toHaveLength(1);
      expect(last.threads).toEqual([]);
    });
  });
});
