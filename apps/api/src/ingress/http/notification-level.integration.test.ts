/**
 * `PUT /api/channels/:channelId/notification-level` through the HTTP surface (D-107): the body read
 * against the contract, the member's own row, and the refusals. What each level does to a message is
 * the module's (`notification-level.integration.test.ts`); the crossings are the tenancy suites'.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { Channel } from '@purlay/types';
import { createApp } from './app';
import { NOW, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { aSignedInUser } from '../../testing/signed-in';
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

/** Alice's channel, which Bob can see in the workspace and has not joined. */
const aWorld = async (db: Executor): Promise<{ alice: string; bob: string; channelId: string }> => {
  const alice = await aSignedInUser(db, clock, 'nl-alice');
  const bob = await aSignedInUser(db, clock, 'nl-bob');
  const created = await call(db, 'POST', '/api/workspaces', alice.cookie, {
    name: 'nl',
    slug: aUniqueSlug('nl'),
  });
  const workspaceId = ((await created.json()) as { id: string }).id;
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW })
    .execute();
  const channel = await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, alice.cookie, {
    name: 'general',
  });
  const channelId = ((await channel.json()) as { id: string }).id;
  return { alice: alice.cookie, bob: bob.cookie, channelId };
};

const put = async (
  db: Executor,
  cookie: string | undefined,
  channelId: string,
  body: unknown,
): Promise<Response> =>
  await call(db, 'PUT', `/api/channels/${channelId}/notification-level`, cookie, body);

describe('integration: setting a notification level', () => {
  test('is 204, and the channel then says the level, to that member', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect((await put(db, world.alice, world.channelId, { level: 'none' })).status).toBe(204);
      const read = await call(db, 'GET', `/api/channels/${world.channelId}`, world.alice);
      const channel: unknown = await read.json();
      expect(Value.Check(Channel, channel)).toBe(true);
      expect((channel as Channel).notificationLevel).toBe('none');
      // Somebody who can see it and is not in it has no level here.
      const seen = (await (
        await call(db, 'GET', `/api/channels/${world.channelId}`, world.bob)
      ).json()) as Channel;
      expect(seen.notificationLevel).toBeNull();
    });
  });

  test('a level that is not one of the three is 400; not a member is 404; no session is 401', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const loud = await put(db, world.alice, world.channelId, { level: 'loud' });
      expect(loud.status).toBe(400);
      const outsider = await put(db, world.bob, world.channelId, { level: 'all' });
      expect(outsider.status).toBe(404);
      expect(((await outsider.json()) as { error: { code: string } }).error.code).toBe(
        'CHANNEL_NOT_FOUND',
      );
      expect((await put(db, undefined, world.channelId, { level: 'all' })).status).toBe(401);
    });
  });
});
