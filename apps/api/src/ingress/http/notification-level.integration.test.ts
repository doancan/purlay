/**
 * `PUT /api/channels/:channelId/notification-level` through the HTTP surface (D-107): the body read
 * against the contract, the member's own row, the refusals, and a level for a while (D-329) — its end on
 * the channel, its bounds, its own end, and the caller's other tabs told. What each level does to a message
 * is the module's (`notification-level.integration.test.ts`); the crossings are the tenancy suites'.
 *
 * @needs-modules chat
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { Channel, type ServerFrame } from '@purlay/types';
import { createApp } from './app';
import { aMovableClock, NOW, testDependencies } from '../../testing/doubles';
import { fixedClock, HOUR_MS, type Clock } from '../../platform/clock';
import { NO_LOG, userTopic, type EventBus } from '../../platform/events';
import { aSignedInUser, aTestSessionAuth } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { setLevel } from '../../features/chat/http/channels';

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
  at: Clock = clock,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock: at })).handle(
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
const aWorld = async (
  db: Executor,
): Promise<{
  alice: string;
  aliceId: string;
  bob: string;
  channelId: string;
  workspaceId: string;
}> => {
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
    name: 'ops',
  });
  const channelId = ((await channel.json()) as { id: string }).id;
  return { alice: alice.cookie, aliceId: alice.userId, bob: bob.cookie, channelId, workspaceId };
};

const put = async (
  db: Executor,
  cookie: string | undefined,
  channelId: string,
  body: unknown,
  at: Clock = clock,
): Promise<Response> =>
  await call(db, 'PUT', `/api/channels/${channelId}/notification-level`, cookie, body, at);

const channelOf = async (
  db: Executor,
  cookie: string,
  channelId: string,
  at: Clock = clock,
): Promise<Channel> => {
  const channel: unknown = await (
    await call(db, 'GET', `/api/channels/${channelId}`, cookie, undefined, at)
  ).json();
  expect(Value.Check(Channel, channel)).toBe(true);
  return channel as Channel;
};

const inHours = (hours: number, from: Date = NOW): string =>
  new Date(from.getTime() + hours * HOUR_MS).toISOString();

const fieldsOf = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { error: { code: string; details?: { fields?: unknown } } }).error;

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

describe('integration: a level for a while (D-329)', () => {
  test('is 204, and the channel says until when, to that member only; without until it is for good', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const until = inHours(1);
      expect((await put(db, world.alice, world.channelId, { level: 'none', until })).status).toBe(
        204,
      );
      expect(await channelOf(db, world.alice, world.channelId)).toMatchObject({
        notificationLevel: 'none',
        notificationLevelUntil: until,
      });
      // In the list too, where the sidebar reads it.
      const listed = (await (
        await call(db, 'GET', `/api/workspaces/${world.workspaceId}/channels`, world.alice)
      ).json()) as Channel[];
      expect(listed.find((channel) => channel.id === world.channelId)?.notificationLevelUntil).toBe(
        until,
      );
      expect((await channelOf(db, world.bob, world.channelId)).notificationLevelUntil).toBeNull();
      // Yesterday's client sends no until: the level is for good, and the timer is gone.
      expect((await put(db, world.alice, world.channelId, { level: 'mentions' })).status).toBe(204);
      expect(await channelOf(db, world.alice, world.channelId)).toMatchObject({
        notificationLevel: 'mentions',
        notificationLevelUntil: null,
      });
    });
  });

  test('ends by itself: at its instant the level before it is back, with no until', async () => {
    await withRollback(async (db) => {
      const at = aMovableClock(NOW);
      const world = await aWorld(db);
      expect((await put(db, world.alice, world.channelId, { level: 'all' }, at)).status).toBe(204);
      const until = inHours(8);
      expect(
        (await put(db, world.alice, world.channelId, { level: 'none', until }, at)).status,
      ).toBe(204);
      at.advance(8 * HOUR_MS - 1);
      expect((await channelOf(db, world.alice, world.channelId, at)).notificationLevel).toBe(
        'none',
      );
      at.advance(1);
      expect(await channelOf(db, world.alice, world.channelId, at)).toMatchObject({
        notificationLevel: 'all',
        notificationLevelUntil: null,
      });
    });
  });

  test('an end now, past, beyond 24 hours, malformed or null is 400, and the level is unchanged', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const until of [
        NOW.toISOString(),
        inHours(-1),
        new Date(NOW.getTime() + 24 * HOUR_MS + 1000).toISOString(),
      ]) {
        const refused = await put(db, world.alice, world.channelId, { level: 'none', until });
        expect(refused.status).toBe(400);
        expect(await fieldsOf(refused)).toMatchObject({
          code: 'VALIDATION_FAILED',
          details: { fields: { until: 'ahead, and at most 24 hours' } },
        });
      }
      for (const until of ['tomorrow', '2026-13-40T99:00:00Z', null, 3600, '']) {
        const refused = await put(db, world.alice, world.channelId, { level: 'none', until });
        expect(refused.status).toBe(400);
        expect(await fieldsOf(refused)).toMatchObject({ code: 'VALIDATION_FAILED' });
      }
      expect(await channelOf(db, world.alice, world.channelId)).toMatchObject({
        notificationLevel: 'mentions',
        notificationLevelUntil: null,
      });
      // The bound itself, exactly 24 hours ahead, is allowed.
      expect(
        (await put(db, world.alice, world.channelId, { level: 'none', until: inHours(24) })).status,
      ).toBe(204);
    });
  });

  test('somebody not in the channel, or in another workspace, is told 404; signed out is 401', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const stranger = await aSignedInUser(db, clock, 'nl-stranger');
      // In a workspace of their own: the channel is another workspace's.
      await call(db, 'POST', '/api/workspaces', stranger.cookie, {
        name: 'elsewhere',
        slug: aUniqueSlug('nl-elsewhere'),
      });
      const body = { level: 'none', until: inHours(1) };
      for (const cookie of [world.bob, stranger.cookie]) {
        const refused = await put(db, cookie, world.channelId, body);
        expect(refused.status).toBe(404);
        expect(await fieldsOf(refused)).toMatchObject({ code: 'CHANNEL_NOT_FOUND' });
      }
      expect((await put(db, undefined, world.channelId, body)).status).toBe(401);
      expect(
        await db
          .selectFrom('channel_level_timers')
          .selectAll()
          .where('channel_id', '=', world.channelId)
          .execute(),
      ).toEqual([]);
    });
  });

  test('the caller’s own other tabs are told to read their channels again, and nobody else', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const told: [string, ServerFrame][] = [];
      const bus: EventBus = {
        publish: (topic: string, frame: ServerFrame): Promise<void> => {
          told.push([topic, frame]);
          return Promise.resolve();
        },
        subscribe: () => false,
        unsubscribe: () => undefined,
        forget: () => undefined,
      };
      const dependencies = { auth: aTestSessionAuth(db), database: db, clock, bus, log: NO_LOG };
      const request = new Request('https://purlay.test/', { headers: { cookie: world.alice } });
      await setLevel(dependencies, request, world.channelId, { level: 'none', until: inHours(1) });
      await setLevel(dependencies, request, world.channelId, { level: 'all' });
      const frame: ServerFrame = {
        event: 'CHANNELS_UPDATED',
        data: { workspaceId: world.workspaceId },
        ts: NOW.getTime(),
      };
      expect(told).toEqual([
        [userTopic(world.aliceId), frame],
        [userTopic(world.aliceId), frame],
      ]);
      // A refusal tells nobody.
      await setLevel(dependencies, request, world.channelId, {
        level: 'none',
        until: inHours(-1),
      }).catch(() => undefined);
      expect(told.length).toBe(2);
    });
  });
});
