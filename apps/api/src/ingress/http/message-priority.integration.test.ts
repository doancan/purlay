/**
 * A message's priority through the real door (#1381): what the contract refuses, what the send keeps. The rule itself is `features/chat/messages/priority.integration.test.ts`'s.
 *
 * @needs-modules chat
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { createApp } from './app';
import { testDependencies, NOW } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
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
  readonly send: (as: SignedInUser, body: Record<string, unknown>) => Promise<Response>;
  readonly rows: () => Promise<number>;
}

const aWorld = async (db: Executor): Promise<World> => {
  const app = createApp(testDependencies({ database: db, clock }));
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
  const send = async (as: SignedInUser, body: Record<string, unknown>): Promise<Response> =>
    await call('POST', `/api/channels/${channelId}/messages`, as, { id: nextId(), ...body });
  const rows = async (): Promise<number> =>
    (await db.selectFrom('messages').select('id').where('channel_id', '=', channelId).execute())
      .length;
  return { alice, bob, send, rows };
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
