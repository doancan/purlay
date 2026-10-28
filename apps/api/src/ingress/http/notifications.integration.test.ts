/**
 * The inbox doors (`API.md` §6, D-106): the query read from text, the refusals and their statuses,
 * the contract's shape, and that marking read tells the caller's devices and nobody else. What is
 * listed and what is marked is the module's, and is tested there; the tenant crossings are in
 * `cross-tenant.integration.test.ts` and `channel-visibility.integration.test.ts`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import {
  messageId,
  NotificationPage,
  NotificationType,
  ClientInfo,
  ErrorResponse,
  type ServerFrame,
} from '@purlay/types';
import { createApp } from './app';
import { markNotificationsRead } from './notifications';
import { NOW, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { userTopic, type EventBus } from '../../platform/events';
import { aTestAuth, aSignedInUser } from '../../testing/signed-in';
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
    name: 'ops',
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

  test('the public capability agrees with the authenticated filter, without granting access', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const publicInfo = await call(db, 'GET', '/api/client', undefined);
      expect(publicInfo.status).toBe(200);
      const handshake: unknown = await publicInfo.json();
      if (!Value.Check(ClientInfo, handshake)) throw new Error('invalid handshake');
      expect(handshake.capabilities?.notificationTypeFilters).toBe(true);
      const signedIn = await call(db, 'GET', '/api/client', world.bob);
      expect(await signedIn.json()).toEqual(handshake);
      const path = `/api/notifications?workspaceId=${world.workspaceId}&types=mention`;
      expect((await call(db, 'GET', path, undefined)).status).toBe(401);
      const outsider = await aSignedInUser(db, clock, 'cap-outsider');
      expect((await call(db, 'GET', path, outsider.cookie)).status).toBe(404);
      const response = await call(db, 'GET', path, world.bob);
      expect(response.status).toBe(200);
      const page = (await response.json()) as NotificationPage;
      expect(page.data.map((row) => row.type)).toEqual(['mention']);
    });
  });

  test('reads a single encoded type or CSV union, including channel_message, with the existing page shape', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const { const: type } of NotificationType.anyOf) {
        await db
          .updateTable('notifications')
          .set({ type })
          .where('user_id', '=', world.bobId)
          .where('workspace_id', '=', world.workspaceId)
          .execute();
        for (const unreadOnly of ['true', 'false']) {
          const response = await inbox(
            db,
            world,
            `&types=${type}&unreadOnly=${unreadOnly}&limit=1`,
          );
          expect(response.status).toBe(200);
          const body: unknown = await response.json();
          expect(Value.Check(NotificationPage, body)).toBe(true);
          if (!Value.Check(NotificationPage, body)) throw new Error('invalid page');
          expect(body.data.map((row) => row.type)).toEqual([type]);
          expect(body.nextCursor).toBeNull();
        }
      }
      await db
        .updateTable('notifications')
        .set({ type: 'thread_resolved' })
        .where('user_id', '=', world.bobId)
        .execute();
      const threads = await inbox(db, world, '&types=thread_reply%2Cthread_resolved');
      expect(threads.status).toBe(200);
      expect(((await threads.json()) as NotificationPage).data.map((row) => row.type)).toEqual([
        'thread_resolved',
      ]);
      const empty = await inbox(db, world, '&types=mention');
      expect(await empty.json()).toEqual({ data: [], nextCursor: null });
    });
  });

  test('malformed CSV, repeated and unknown keys are refused with the query field named', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const value of [
        '',
        'unknown',
        'all',
        'Mention',
        'mention,unknown',
        'mention,mention',
        'mention,,thread_reply',
        'mention,',
        ',mention',
        'mention, thread_reply',
        'mention\n',
        'mention\u0000',
        'mention;thread_reply',
      ]) {
        const response = await inbox(db, world, `&types=${encodeURIComponent(value)}`);
        expect(response.status).toBe(400);
        const error: unknown = await response.json();
        if (!Value.Check(ErrorResponse, error)) throw new Error('invalid error envelope');
        expect(error.error.code).toBe('VALIDATION_FAILED');
        if (error.error.code !== 'VALIDATION_FAILED') throw new Error('wrong refusal');
        expect(typeof error.error.details.fields['types']).toBe('string');
      }
      for (const suffix of [
        '&types=mention&types=thread_reply',
        '&type=mention',
        '&types[]=mention',
        '&types=mention&limit=0x10',
        '&types=mention&unreadOnly=1',
      ]) {
        const response = await inbox(db, world, suffix);
        expect(response.status).toBe(400);
        expect(await codeOf(response)).toBe('VALIDATION_FAILED');
      }
    });
  });

  test('session and workspace guards still precede type validation, and foreign cursors stay refused', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const outsider = await aSignedInUser(db, clock, 'nt-outsider');
      const path = `/api/notifications?workspaceId=${world.workspaceId}&types=unknown`;
      expect((await call(db, 'GET', path, undefined)).status).toBe(401);
      const forbidden = await call(db, 'GET', path, outsider.cookie);
      expect(forbidden.status).toBe(404);
      expect(await codeOf(forbidden)).toBe('WORKSPACE_NOT_FOUND');
      const first = await inbox(db, world);
      const page = (await first.json()) as NotificationPage;
      const before = page.data[0]?.id ?? '';
      const otherRecipient = await call(
        db,
        'GET',
        `/api/notifications?workspaceId=${world.workspaceId}&types=mention&before=${before}`,
        world.alice,
      );
      expect(otherRecipient.status).toBe(400);
      expect(await codeOf(otherRecipient)).toBe('VALIDATION_FAILED');
      const invalid = await inbox(db, world, '&types=mention&before=not-a-uuid');
      expect(invalid.status).toBe(400);
    });
  });

  test('filtering a GET does not narrow workspace-wide mark-read or accept a type filter on that write', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const original = await inbox(db, world);
      const page = (await original.json()) as NotificationPage;
      const message = page.data[0]?.message;
      if (message === undefined) throw new Error('missing the notification target');
      await db
        .insertInto('notifications')
        .values({
          user_id: world.bobId,
          workspace_id: world.workspaceId,
          channel_id: world.channelId,
          message_id: message.id,
          type: 'thread_reply',
          created_at: NOW,
        })
        .execute();
      expect(
        (
          (await (
            await inbox(db, world, '&types=mention&unreadOnly=true')
          ).json()) as NotificationPage
        ).data,
      ).toHaveLength(1);
      const invalid = await call(db, 'PUT', '/api/notifications/read', world.bob, {
        workspaceId: world.workspaceId,
        types: 'mention',
      });
      expect(invalid.status).toBe(400);
      expect(
        ((await (await inbox(db, world, '&unreadOnly=true')).json()) as NotificationPage).data,
      ).toHaveLength(2);
      expect(
        (
          await call(db, 'PUT', '/api/notifications/read', world.bob, {
            workspaceId: world.workspaceId,
          })
        ).status,
      ).toBe(204);
      expect(
        (
          (await (
            await inbox(db, world, '&types=thread_reply&unreadOnly=true')
          ).json()) as NotificationPage
        ).data,
      ).toEqual([]);
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
      // Two of one key: the guard and the schema would otherwise each read a different one.
      const twice = await inbox(db, world, `&workspaceId=${world.workspaceId}`);
      expect(twice.status).toBe(400);
      expect(await codeOf(twice)).toBe('VALIDATION_FAILED');
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
      await markNotificationsRead(
        { auth: aTestAuth(db), database: db, clock, bus },
        request(),
        body,
      );
      expect(heard.map((h) => [h.topic, h.frame.event])).toEqual([
        [userTopic(world.bobId), 'CHANNEL_STATE'],
      ]);
      // Read again: nothing moved, so nothing is said.
      await markNotificationsRead(
        { auth: aTestAuth(db), database: db, clock, bus },
        request(),
        body,
      );
      expect(heard).toHaveLength(1);
    });
  });

  test('a workspace that never existed is the stranger’s answer; a malformed one is the body’s 400', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const put = async (workspaceId: string): Promise<Response> =>
        await call(db, 'PUT', '/api/notifications/read', world.bob, { workspaceId });
      const never = await put('00000000-0000-4000-8000-000000000000');
      const stranger = await call(db, 'PUT', '/api/notifications/read', world.alice, {
        workspaceId: world.workspaceId,
      });
      expect(stranger.status).toBe(204);
      expect(never.status).toBe(404);
      expect(await codeOf(never)).toBe('WORKSPACE_NOT_FOUND');
      // Every body is read against the contract before anything is looked up (D-106 §5).
      expect((await put('not-a-uuid')).status).toBe(400);
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
