/**
 * A message's priority through the real door (#1381): what the contract refuses, what the send keeps. The rule itself is `features/chat/messages/priority.integration.test.ts`'s.
 *
 * @needs-modules chat
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  withRollback,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { messageId, type MeResponse, type ServerFrame } from '@purlay/types';
import { createApp } from './app';
import { testDependencies, NOW } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { NO_LOG, userTopic } from '../../platform/events';
import { inProcessBackplane } from '../../realtime/bus';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
let tick = 0;
const nextId = (): string => messageId(new Date(NOW.getTime() - (tick += 1)));

interface World {
  readonly alice: SignedInUser;
  readonly bob: SignedInUser;
  readonly workspaceId: string;
  readonly frames: readonly ServerFrame[];
  readonly call: (
    method: string,
    path: string,
    as: SignedInUser,
    body?: unknown,
  ) => Promise<Response>;
  readonly send: (as: SignedInUser, body: Record<string, unknown>) => Promise<Response>;
  readonly rows: () => Promise<number>;
}

const aWorld = async (db: Executor): Promise<World> => {
  const backplane = inProcessBackplane();
  const app = createApp(testDependencies({ database: db, clock, backplane }));
  const call = async (
    method: string,
    path: string,
    as: SignedInUser,
    body?: unknown,
  ): Promise<Response> =>
    await app.handle(
      new Request(`https://purlay.test${path}`, {
        method,
        headers: {
          cookie: as.cookie,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const alice = await aSignedInUser(db, clock, 'prio-alice');
  const bob = await aSignedInUser(db, clock, 'prio-bob');
  const slug = aUniqueSlug('prio');
  const workspace = await call('POST', '/api/workspaces', alice, { name: slug, slug });
  const workspaceId = ((await workspace.json()) as { id: string }).id;
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW })
    .execute();
  const channel = await call('POST', `/api/workspaces/${workspaceId}/channels`, alice, {
    name: 'ops',
  });
  const channelId = ((await channel.json()) as { id: string }).id;
  expect((await call('POST', `/api/channels/${channelId}/join`, bob)).status).toBe(200);
  const frames: ServerFrame[] = [];
  const listener = backplane.node((_socket, frame) => {
    frames.push(frame);
  }, NO_LOG);
  listener.subscribe(userTopic(bob.userId), 'priority-settings-listener');
  const send = async (as: SignedInUser, body: Record<string, unknown>): Promise<Response> =>
    await call('POST', `/api/channels/${channelId}/messages`, as, { id: nextId(), ...body });
  const rows = async (): Promise<number> =>
    (await db.selectFrom('messages').select('id').where('channel_id', '=', channelId).execute())
      .length;
  return { alice, bob, workspaceId, frames, call, send, rows };
};

describe('integration: priority over HTTP', () => {
  test('naming somebody keeps it, and the page shows the marker', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const response = await world.send(world.alice, {
        content: `@${world.bob.username} the release is blocked on you`,
        priority: 'urgent',
      });
      expect(response.status).toBe(201);
      expect(((await response.json()) as { priority?: string }).priority).toBe('urgent');
    });
  });

  test('a value the contract does not know is a 400 and writes nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const response = await world.send(world.alice, { content: 'hi', priority: 'critical' });
      expect(response.status).toBe(400);
      expect(await world.rows()).toBe(0);
    });
  });

  test('a channel message naming nobody is a 400 on priority', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const response = await world.send(world.alice, { content: 'everyone', priority: 'urgent' });
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain('priority');
    });
  });
});

const settingPath = (workspaceId: string): string =>
  `/api/workspaces/${workspaceId}/urgent-messages`;

describe('integration: workspace urgent messages over HTTP', () => {
  test('only a current owner or admin changes the setting and tells the workspace once per change', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const { alice, bob, call, frames, workspaceId } = world;
      const outsider = await aSignedInUser(db, clock, 'priority-outsider');
      const path = settingPath(workspaceId);
      const settingFor = async (user: SignedInUser): Promise<boolean | undefined> => {
        const response = await call('GET', '/api/me', user);
        const me = (await response.json()) as MeResponse;
        return me.memberships.find((member) => member.workspace.id === workspaceId)
          ?.urgentMessagesEnabled;
      };
      expect(await settingFor(bob)).toBe(true);
      expect((await call('PUT', path, outsider, { enabled: false })).status).toBe(404);
      expect((await call('PUT', path, bob, { enabled: false })).status).toBe(403);
      expect((await call('PUT', path, alice, { enabled: 'false' })).status).toBe(400);
      expect((await call('PUT', path, alice, { enabled: false, other: true })).status).toBe(400);
      expect(await settingFor(bob)).toBe(true);

      const set = async (user: SignedInUser, enabled: boolean): Promise<void> => {
        const response = await call('PUT', path, user, { enabled });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ enabled });
      };
      await set(alice, false);
      await set(alice, false);
      expect(await settingFor(bob)).toBe(false);
      expect(frames.filter((frame) => frame.event === 'WORKSPACE_UPDATED')).toHaveLength(1);
      await db
        .updateTable('workspace_members')
        .set({ role: 'admin' })
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', bob.userId)
        .execute();
      await set(bob, true);
      expect(await settingFor(alice)).toBe(true);
      expect(frames.filter((frame) => frame.event === 'WORKSPACE_UPDATED')).toHaveLength(2);
      const trail = await db
        .selectFrom('audit_log')
        .select(['actor_user_id', 'metadata'])
        .where('workspace_id', '=', workspaceId)
        .where('action', '=', 'workspace.urgent_messages_changed')
        .execute();
      expect(trail).toHaveLength(2);
      expect(trail).toContainEqual({
        actor_user_id: alice.userId,
        metadata: { from: 'true', to: 'false' },
      });
      expect(trail).toContainEqual({
        actor_user_id: bob.userId,
        metadata: { from: 'false', to: 'true' },
      });
    });
  });

  describe('with real request transactions', () => {
    let cloned: ClonedDatabase;
    beforeAll(async () => {
      cloned = await cloneIntegrationDatabase();
    }, CLONE_HOOK_MS);
    afterAll(async () => {
      await cloned.drop();
    }, DROP_HOOK_MS);

    test('a new blocked urgent send rolls back while retries and another workspace keep their priority', async () => {
      const db = cloned.db;
      const world = await aWorld(db);
      const other = await aWorld(db);
      const { alice, bob, call, send, workspaceId } = world;
      const id = nextId();
      const content = `@${bob.username} the release is blocked`;
      const first = await send(alice, { id, content, priority: 'urgent' });
      expect(first.status).toBe(201);
      expect((await call('PUT', settingPath(workspaceId), alice, { enabled: false })).status).toBe(
        200,
      );
      const refusedId = nextId();
      const refused = await send(alice, { id: refusedId, content, priority: 'urgent' });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({
        error: {
          code: 'VALIDATION_FAILED',
          details: { fields: { priority: 'urgent messages are disabled in this workspace' } },
        },
      });
      expect(await world.rows()).toBe(1);
      expect(
        await db
          .selectFrom('notifications')
          .select('id')
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', bob.userId)
          .execute(),
      ).toHaveLength(1);
      const retry = await send(alice, { id, content, priority: 'urgent' });
      expect(retry.status).toBe(201);
      expect(await retry.json()).toEqual(await first.json());
      expect((await send(alice, { content, priority: 'important' })).status).toBe(201);
      expect((await send(alice, { content })).status).toBe(201);
      expect(
        (
          await other.send(other.alice, {
            content: `@${other.bob.username} look`,
            priority: 'urgent',
          })
        ).status,
      ).toBe(201);
      expect((await call('PUT', settingPath(workspaceId), alice, { enabled: true })).status).toBe(
        200,
      );
      expect(
        (
          await call('PUT', `/api/workspaces/${workspaceId}/deep-work`, bob, {
            active: true,
            until: new Date(NOW.getTime() + 3_600_000).toISOString(),
          })
        ).status,
      ).toBe(200);
      expect((await send(alice, { id: refusedId, content, priority: 'urgent' })).status).toBe(201);
      expect(
        await db
          .selectFrom('notifications')
          .select('suppressed_by_deep_work')
          .where('message_id', '=', refusedId)
          .where('user_id', '=', bob.userId)
          .executeTakeFirst(),
      ).toEqual({ suppressed_by_deep_work: true });
    });
  });
});
