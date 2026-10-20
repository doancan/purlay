/**
 * Taking somebody out of a channel (D-172), driven through real requests: who may and who may not,
 * what a direct message and a group answer, the last member, what the person's sockets are told, what
 * the trail keeps, and that what they are told about the channel stops while their messages stay.
 *
 * Crossing a tenant and the visibility axis is `cross-tenant.integration.test.ts` and
 * `channel-visibility.integration.test.ts`; the role table is `permissions.integration.test.ts`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type ServerFrame, type Topic } from '@purlay/types';
import { createApp } from './app';
import { testDependencies, NOW } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { userTopic } from '../../platform/events';
import { inProcessBackplane } from '../../realtime/bus';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

interface World {
  readonly db: Executor;
  readonly owner: SignedInUser;
  readonly admin: SignedInUser;
  readonly bob: SignedInUser;
  readonly carol: SignedInUser;
  readonly workspaceId: string;
  /** Public; everybody is in it. */
  readonly channelId: string;
  readonly published: [Topic, ServerFrame][];
  readonly call: (
    method: string,
    path: string,
    as: SignedInUser,
    body?: unknown,
  ) => Promise<Response>;
}

const aWorld = async (db: Executor): Promise<World> => {
  const inner = inProcessBackplane();
  const published: [Topic, ServerFrame][] = [];
  const backplane: typeof inner = {
    node: (deliver, log) => {
      const real = inner.node(deliver, log);
      return {
        ...real,
        publish: async (topic, frame): Promise<void> => {
          published.push([topic, frame]);
          await real.publish(topic, frame);
        },
      };
    },
  };
  const app = createApp(testDependencies({ database: db, clock, backplane }));
  const call: World['call'] = async (method, path, as, body) =>
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
  const owner = await aSignedInUser(db, clock, 'rm-owner');
  const admin = await aSignedInUser(db, clock, 'rm-admin');
  const bob = await aSignedInUser(db, clock, 'rm-bob');
  const carol = await aSignedInUser(db, clock, 'rm-carol');
  const slug = aUniqueSlug('rm');
  const workspace = await call('POST', '/api/workspaces', owner, { name: slug, slug });
  const workspaceId = ((await workspace.json()) as { id: string }).id;
  await db
    .insertInto('workspace_members')
    .values([
      { workspace_id: workspaceId, user_id: admin.userId, role: 'admin', joined_at: NOW },
      { workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW },
      { workspace_id: workspaceId, user_id: carol.userId, role: 'member', joined_at: NOW },
    ])
    .execute();
  const channel = await call('POST', `/api/workspaces/${workspaceId}/channels`, owner, {
    name: 'general',
  });
  const channelId = ((await channel.json()) as { id: string }).id;
  for (const person of [admin, bob, carol]) {
    expect((await call('POST', `/api/channels/${channelId}/join`, person)).status).toBe(200);
  }
  published.splice(0);
  return { db, owner, admin, bob, carol, workspaceId, channelId, published, call };
};

/** A private channel the owner made, with these people brought in. */
const aPrivateChannel = async (world: World, people: readonly SignedInUser[]): Promise<string> => {
  const made = await world.call(
    'POST',
    `/api/workspaces/${world.workspaceId}/channels`,
    world.owner,
    { name: `quiet-${crypto.randomUUID().slice(0, 6)}`, type: 'private' },
  );
  expect(made.status).toBe(201);
  const id = ((await made.json()) as { id: string }).id;
  for (const person of people) {
    const added = await world.call('POST', `/api/channels/${id}/members`, world.owner, {
      userId: person.userId,
    });
    expect(added.status).toBe(204);
  }
  world.published.splice(0);
  return id;
};

const remove = async (
  world: World,
  channelId: string,
  as: SignedInUser,
  who: string,
): Promise<Response> => await world.call('DELETE', `/api/channels/${channelId}/members/${who}`, as);

const isIn = async (world: World, channelId: string, userId: string): Promise<boolean> =>
  (await world.db
    .selectFrom('channel_members')
    .select('user_id')
    .where('channel_id', '=', channelId)
    .where('user_id', '=', userId)
    .executeTakeFirst()) !== undefined;

const removals = async (world: World): Promise<{ metadata: unknown; target_id: string | null }[]> =>
  await world.db
    .selectFrom('audit_log')
    .select(['metadata', 'target_id', 'actor_user_id'])
    .where('workspace_id', '=', world.workspaceId)
    .where('action', '=', 'channel.member_removed')
    .orderBy('id')
    .execute();

const code = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe('integration: taking somebody out of a channel', () => {
  test('an admin takes a member out of a public channel: out, told why on their own topic, on the trail, their messages kept', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const said = messageId(NOW);
      const sent = await world.call(
        'POST',
        `/api/channels/${world.channelId}/messages`,
        world.bob,
        {
          id: said,
          content: 'still here after',
        },
      );
      expect(sent.status).toBe(201);
      world.published.splice(0);

      const response = await remove(world, world.channelId, world.admin, world.bob.userId);
      expect(response.status).toBe(204);
      expect(await isIn(world, world.channelId, world.bob.userId)).toBe(false);
      expect(world.published).toEqual([
        [
          userTopic(world.bob.userId),
          expect.objectContaining({
            event: 'ACCESS_REVOKED',
            data: { channelIds: [world.channelId], reason: 'removed' },
          }) as ServerFrame,
        ],
      ]);
      expect(await removals(world)).toEqual([
        {
          target_id: world.bob.userId,
          metadata: { channelId: world.channelId },
          actor_user_id: world.admin.userId,
        } as never,
      ]);
      const kept = await db
        .selectFrom('messages')
        .select(['content', 'deleted_at'])
        .where('id', '=', said)
        .executeTakeFirstOrThrow();
      expect(kept).toEqual({ content: 'still here after', deleted_at: null });

      // Out already: the same answer, and nobody is told or recorded again.
      world.published.splice(0);
      expect((await remove(world, world.channelId, world.admin, world.bob.userId)).status).toBe(
        204,
      );
      expect(world.published).toEqual([]);
      expect(await removals(world)).toHaveLength(1);
    });
  });

  test('in a public channel a member takes out nobody: 403, and nothing changes', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const who of [world.carol, world.owner]) {
        const response = await remove(world, world.channelId, world.bob, who.userId);
        expect(response.status).toBe(403);
        expect(await code(response)).toBe('FORBIDDEN');
        expect(await isIn(world, world.channelId, who.userId)).toBe(true);
      }
      expect(world.published).toEqual([]);
      expect(await removals(world)).toEqual([]);
    });
  });

  test('an owner is an owner’s to take out: an admin is refused, another owner may', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const refused = await remove(world, world.channelId, world.admin, world.owner.userId);
      expect(refused.status).toBe(403);
      expect(await isIn(world, world.channelId, world.owner.userId)).toBe(true);
      // The owner takes the admin out; the admin's role is no shield from an owner.
      expect((await remove(world, world.channelId, world.owner, world.admin.userId)).status).toBe(
        204,
      );
      expect(await isIn(world, world.channelId, world.admin.userId)).toBe(false);
    });
  });

  test('a member of a private channel takes out another member of it, but not an admin or an owner', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const quiet = await aPrivateChannel(world, [world.admin, world.bob, world.carol]);
      expect((await remove(world, quiet, world.bob, world.carol.userId)).status).toBe(204);
      expect(await isIn(world, quiet, world.carol.userId)).toBe(false);
      expect(world.published).toEqual([
        [
          userTopic(world.carol.userId),
          expect.objectContaining({
            event: 'ACCESS_REVOKED',
            data: { channelIds: [quiet], reason: 'removed' },
          }) as ServerFrame,
        ],
      ]);
      for (const who of [world.admin, world.owner]) {
        const response = await remove(world, quiet, world.bob, who.userId);
        expect(response.status).toBe(403);
        expect(await isIn(world, quiet, who.userId)).toBe(true);
      }
      // Carol, out, cannot see it any more: the stranger's answer, as for any hidden channel.
      const gone = await remove(world, quiet, world.carol, world.bob.userId);
      expect(gone.status).toBe(404);
      expect(await code(gone)).toBe('CHANNEL_NOT_FOUND');
    });
  });

  test('once out of a private channel, a mention there tells them nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const quiet = await aPrivateChannel(world, [world.bob, world.carol]);
      expect((await remove(world, quiet, world.owner, world.carol.userId)).status).toBe(204);
      const sent = await world.call('POST', `/api/channels/${quiet}/messages`, world.bob, {
        id: messageId(NOW),
        content: `@${world.carol.username} are you there?`,
      });
      expect(sent.status).toBe(201);
      const told = await db
        .selectFrom('notifications')
        .select('id')
        .where('user_id', '=', world.carol.userId)
        .where('channel_id', '=', quiet)
        .execute();
      expect(told).toEqual([]);
      // The control: the same mention of somebody still in it is told.
      const control = await world.call('POST', `/api/channels/${quiet}/messages`, world.bob, {
        id: messageId(NOW),
        content: `@${world.owner.username} are you there?`,
      });
      expect(control.status).toBe(201);
      const toldOwner = await db
        .selectFrom('notifications')
        .select('id')
        .where('user_id', '=', world.owner.userId)
        .where('channel_id', '=', quiet)
        .execute();
      expect(toldOwner).toHaveLength(1);
    });
  });

  test('naming yourself is leaving: told as left, not on the trail, and the last member of a private channel stays', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect((await remove(world, world.channelId, world.bob, world.bob.userId)).status).toBe(204);
      expect(await isIn(world, world.channelId, world.bob.userId)).toBe(false);
      expect(world.published).toEqual([
        [
          userTopic(world.bob.userId),
          expect.objectContaining({
            event: 'ACCESS_REVOKED',
            data: { channelIds: [world.channelId], reason: 'left' },
          }) as ServerFrame,
        ],
      ]);
      expect(await removals(world)).toEqual([]);

      const alone = await aPrivateChannel(world, []);
      const last = await remove(world, alone, world.owner, world.owner.userId);
      expect(last.status).toBe(409);
      expect(await code(last)).toBe('LAST_CHANNEL_MEMBER');
      expect(await isIn(world, alone, world.owner.userId)).toBe(true);
    });
  });

  test('a direct message and a group have no removing: the stranger’s 404, and nobody leaves', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const dm = await world.call('POST', `/api/workspaces/${world.workspaceId}/dms`, world.owner, {
        userId: world.bob.userId,
      });
      const dmId = ((await dm.json()) as { id: string }).id;
      const group = await world.call(
        'POST',
        `/api/workspaces/${world.workspaceId}/conversations`,
        world.owner,
        { userIds: [world.bob.userId, world.carol.userId] },
      );
      const groupId = ((await group.json()) as { id: string }).id;
      for (const [channelId, who] of [
        [dmId, world.bob],
        [groupId, world.carol],
      ] as const) {
        const response = await remove(world, channelId, world.owner, who.userId);
        expect(response.status).toBe(404);
        expect(await code(response)).toBe('CHANNEL_NOT_FOUND');
        expect(await isIn(world, channelId, who.userId)).toBe(true);
      }
    });
  });

  test('somebody not in the workspace, or no id at all, is 404 USER_NOT_FOUND', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const stranger = await aSignedInUser(db, clock, 'rm-stranger');
      for (const who of [stranger.userId, 'not-an-id']) {
        const response = await remove(world, world.channelId, world.owner, who);
        expect(response.status).toBe(404);
        expect(await code(response)).toBe('USER_NOT_FOUND');
      }
    });
  });
});
