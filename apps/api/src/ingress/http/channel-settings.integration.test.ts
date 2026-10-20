/**
 * A channel's settings and leaving it (D-123), driven through real requests: what each answers,
 * what it writes, and what it tells the sockets watching — read off the application's own bus.
 *
 * Crossing a tenant and the visibility axis is not here (`cross-tenant.integration.test.ts`,
 * `channel-visibility.integration.test.ts`), nor is the archive per role
 * (`permissions.integration.test.ts`): each is a table the build checks against `API.md`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type ServerFrame, type Topic } from '@purlay/types';
import { createApp } from './app';
import { testDependencies, NOW } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { channelTopic, userTopic } from '../../platform/events';
import { inProcessBackplane, type Backplane } from '../../realtime/bus';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

/** Everything published, in order: the real bus, with a window onto it. */
const aWatchedBackplane = (): {
  readonly backplane: Backplane;
  readonly published: [Topic, ServerFrame][];
} => {
  const inner = inProcessBackplane();
  const published: [Topic, ServerFrame][] = [];
  return {
    published,
    backplane: {
      node: (deliver, log): ReturnType<Backplane['node']> => {
        const real = inner.node(deliver, log);
        return {
          ...real,
          publish: async (topic, frame): Promise<void> => {
            published.push([topic, frame]);
            await real.publish(topic, frame);
          },
        };
      },
    },
  };
};

interface World {
  readonly db: Executor;
  readonly owner: SignedInUser;
  readonly admin: SignedInUser;
  readonly bob: SignedInUser;
  readonly workspaceId: string;
  /** Public; the owner and Bob are in it. */
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
  const { backplane, published } = aWatchedBackplane();
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
  const owner = await aSignedInUser(db, clock, 'set-owner');
  const admin = await aSignedInUser(db, clock, 'set-admin');
  const bob = await aSignedInUser(db, clock, 'set-bob');
  const slug = aUniqueSlug('set');
  const workspace = await call('POST', '/api/workspaces', owner, { name: slug, slug });
  const workspaceId = ((await workspace.json()) as { id: string }).id;
  await db
    .insertInto('workspace_members')
    .values([
      { workspace_id: workspaceId, user_id: admin.userId, role: 'admin', joined_at: NOW },
      { workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW },
    ])
    .execute();
  const channel = await call('POST', `/api/workspaces/${workspaceId}/channels`, owner, {
    name: 'ops',
  });
  expect(channel.status).toBe(201);
  const channelId = ((await channel.json()) as { id: string }).id;
  expect((await call('POST', `/api/channels/${channelId}/join`, bob)).status).toBe(200);
  published.splice(0);
  return { db, owner, admin, bob, workspaceId, channelId, published, call };
};

const trail = async (
  world: World,
): Promise<{ action: string; metadata: unknown; target_id: string | null }[]> =>
  await world.db
    .selectFrom('audit_log')
    .select(['action', 'metadata', 'target_id'])
    .where('workspace_id', '=', world.workspaceId)
    .where('action', 'like', 'channel.%')
    .where('action', '!=', 'channel.created')
    .orderBy('id')
    .execute();

const aPrivateChannel = async (world: World, name: string): Promise<string> => {
  const made = await world.call(
    'POST',
    `/api/workspaces/${world.workspaceId}/channels`,
    world.owner,
    { name, type: 'private' },
  );
  expect(made.status).toBe(201);
  return ((await made.json()) as { id: string }).id;
};

const aDirectMessage = async (world: World): Promise<string> => {
  const opened = await world.call('POST', `/api/workspaces/${world.workspaceId}/dms`, world.owner, {
    userId: world.bob.userId,
  });
  expect(opened.status).toBe(201);
  return ((await opened.json()) as { id: string }).id;
};

describe('integration: renaming a channel and setting its topic', () => {
  test('a member renames it: everyone sees the new name, the room hears it at a rising version, and the trail has it', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const renamed = await world.call('PATCH', `/api/channels/${world.channelId}`, world.bob, {
        name: 'genel-sohbet',
      });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({ id: world.channelId, name: 'genel-sohbet' });
      const seen = await world.call('GET', `/api/channels/${world.channelId}`, world.owner);
      expect(await seen.json()).toMatchObject({ name: 'genel-sohbet' });

      await world.call('PATCH', `/api/channels/${world.channelId}`, world.owner, {
        topic: 'Anything that is not a project',
      });
      expect(world.published).toEqual([
        [
          channelTopic(world.channelId),
          {
            event: 'CHANNEL_UPDATED',
            data: { channelId: world.channelId, name: 'genel-sohbet', topic: null },
            version: 1,
            ts: NOW.getTime(),
          },
        ],
        [
          channelTopic(world.channelId),
          {
            event: 'CHANNEL_UPDATED',
            data: {
              channelId: world.channelId,
              name: 'genel-sohbet',
              topic: 'Anything that is not a project',
            },
            version: 2,
            ts: NOW.getTime(),
          },
        ],
      ]);
      // The rename, by name; the topic is somebody's words and stays off the trail.
      expect(await trail(world)).toEqual([
        {
          action: 'channel.renamed',
          metadata: { from: 'ops', to: 'genel-sohbet' },
          target_id: world.channelId,
        },
      ]);
    });
  });

  test('a null topic clears it; asking for what is there already changes nothing and tells nobody', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const path = `/api/channels/${world.channelId}`;
      await world.call('PATCH', path, world.owner, { topic: 'x' });
      const cleared = await world.call('PATCH', path, world.owner, { topic: null });
      expect(await cleared.json()).toMatchObject({ topic: null });
      world.published.splice(0);

      for (const body of [{ name: 'ops', topic: null }, {}]) {
        const same = await world.call('PATCH', path, world.owner, body);
        expect(same.status).toBe(200);
      }
      expect(world.published).toEqual([]);
      expect(await trail(world)).toEqual([]);
    });
  });

  test('a name another live channel has, in any case, is 409 CHANNEL_NAME_TAKEN; an archived one’s is free', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const other = await world.call(
        'POST',
        `/api/workspaces/${world.workspaceId}/channels`,
        world.owner,
        { name: 'random' },
      );
      const otherId = ((await other.json()) as { id: string }).id;
      const path = `/api/channels/${world.channelId}`;
      // Making it told the maker's devices (#540); what follows is the refusal's, which tells nobody.
      world.published.length = 0;

      const taken = await world.call('PATCH', path, world.owner, { name: 'RANDOM' });
      expect(taken.status).toBe(409);
      expect(await taken.json()).toMatchObject({ error: { code: 'CHANNEL_NAME_TAKEN' } });
      expect(world.published).toEqual([]);

      // Its own name in another case is not taken by itself.
      expect((await world.call('PATCH', path, world.owner, { name: 'Ops' })).status).toBe(200);

      expect((await world.call('DELETE', `/api/channels/${otherId}`, world.admin)).status).toBe(
        204,
      );
      expect((await world.call('PATCH', path, world.owner, { name: 'random' })).status).toBe(200);
    });
  });

  test('a name a channel of another workspace has is free here: the check stays inside the workspace', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      // Bob makes a workspace of his own with a channel called `elsewhere`. Were the check not
      // scoped, its 409 would tell anybody which names other tenants use.
      const slug = aUniqueSlug('set-other');
      const theirs = await world.call('POST', '/api/workspaces', world.bob, { name: slug, slug });
      const theirId = ((await theirs.json()) as { id: string }).id;
      const made = await world.call('POST', `/api/workspaces/${theirId}/channels`, world.bob, {
        name: 'elsewhere',
      });
      expect(made.status).toBe(201);

      const renamed = await world.call('PATCH', `/api/channels/${world.channelId}`, world.owner, {
        name: 'elsewhere',
      });
      expect(renamed.status).toBe(200);
    });
  });

  test('somebody who can see it but is not in it is 403; a direct message is 404; a bad name 400', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const outside = await world.call('PATCH', `/api/channels/${world.channelId}`, world.admin, {
        topic: 'mine now',
      });
      expect(outside.status).toBe(403);
      expect(await outside.json()).toMatchObject({ error: { code: 'NOT_A_CHANNEL_MEMBER' } });

      const dm = await aDirectMessage(world);
      const direct = await world.call('PATCH', `/api/channels/${dm}`, world.owner, { name: 'x' });
      expect(direct.status).toBe(404);
      expect(await direct.json()).toMatchObject({ error: { code: 'CHANNEL_NOT_FOUND' } });

      for (const body of [{ name: '' }, { name: 'x'.repeat(65) }, { colour: 'blue' }]) {
        const bad = await world.call(
          'PATCH',
          `/api/channels/${world.channelId}`,
          world.owner,
          body,
        );
        expect(bad.status).toBe(400);
      }
    });
  });
});

describe('integration: archiving a channel', () => {
  test('an admin archives it: it is gone for everyone, its messages and memberships stay, the room is told why, and the trail has it', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const sent = await world.call(
        'POST',
        `/api/channels/${world.channelId}/messages`,
        world.bob,
        {
          id: messageId(NOW),
          content: 'still here',
        },
      );
      expect(sent.status).toBe(201);
      world.published.splice(0);

      const archived = await world.call('DELETE', `/api/channels/${world.channelId}`, world.admin);
      expect(archived.status).toBe(204);

      for (const person of [world.owner, world.bob, world.admin]) {
        const read = await world.call('GET', `/api/channels/${world.channelId}`, person);
        expect(read.status).toBe(404);
        const list = await world.call(
          'GET',
          `/api/workspaces/${world.workspaceId}/channels`,
          person,
        );
        expect(((await list.json()) as { id: string }[]).map((c) => c.id)).not.toContain(
          world.channelId,
        );
      }
      expect(world.published).toEqual([
        [
          channelTopic(world.channelId),
          {
            event: 'ACCESS_REVOKED',
            data: { channelIds: [world.channelId], reason: 'archived' },
            ts: NOW.getTime(),
          },
        ],
      ]);
      // Soft, and never cascading (D-9).
      const kept = await db
        .selectFrom('messages')
        .select('id')
        .where('channel_id', '=', world.channelId)
        .execute();
      expect(kept).toHaveLength(1);
      const members = await db
        .selectFrom('channel_members')
        .select('user_id')
        .where('channel_id', '=', world.channelId)
        .execute();
      expect(members).toHaveLength(2);
      expect(await trail(world)).toEqual([
        { action: 'channel.archived', metadata: { name: 'ops' }, target_id: world.channelId },
      ]);

      const again = await world.call('DELETE', `/api/channels/${world.channelId}`, world.admin);
      expect(again.status).toBe(404);
      const reused = await world.call(
        'POST',
        `/api/workspaces/${world.workspaceId}/channels`,
        world.owner,
        { name: 'ops' },
      );
      expect(reused.status).toBe(201);
    });
  });

  test('the role that archives is the one held in this workspace: an owner elsewhere is a member here, 403', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      // Carol owned a workspace of her own before she was brought in here as a member: her first
      // membership row is an owner's, so a role read without this workspace would find it.
      const carol = await aSignedInUser(db, clock, 'set-carol');
      const slug = aUniqueSlug('set-own');
      expect(
        (await world.call('POST', '/api/workspaces', carol, { name: slug, slug })).status,
      ).toBe(201);
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: world.workspaceId,
          user_id: carol.userId,
          role: 'member',
          joined_at: NOW,
        })
        .execute();
      const refused = await world.call('DELETE', `/api/channels/${world.channelId}`, carol);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      const still = await db
        .selectFrom('channels')
        .select('deleted_at')
        .where('id', '=', world.channelId)
        .executeTakeFirstOrThrow();
      expect(still.deleted_at).toBeNull();
    });
  });

  test('a direct message is not archived: 404, for an owner too', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const dm = await aDirectMessage(world);
      const refused = await world.call('DELETE', `/api/channels/${dm}`, world.owner);
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ error: { code: 'CHANNEL_NOT_FOUND' } });
    });
  });
});

describe('integration: leaving a channel', () => {
  test('leaving a public channel: out of it, still able to see it, and the person’s own sockets are told they left', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const left = await world.call('POST', `/api/channels/${world.channelId}/leave`, world.bob);
      expect(left.status).toBe(204);
      const read = await world.call('GET', `/api/channels/${world.channelId}`, world.bob);
      expect(await read.json()).toMatchObject({ state: null, notificationLevel: null });
      expect(world.published).toEqual([
        [
          userTopic(world.bob.userId),
          {
            event: 'ACCESS_REVOKED',
            data: { channelIds: [world.channelId], reason: 'left' },
            ts: NOW.getTime(),
          },
        ],
      ]);

      // Not in it any more: the same answer, and nobody is told again.
      const again = await world.call('POST', `/api/channels/${world.channelId}/leave`, world.bob);
      expect(again.status).toBe(204);
      expect(world.published).toHaveLength(1);
      // Leaving is not an administrative act.
      expect(await trail(world)).toEqual([]);
    });
  });

  test('the last member of a private channel is refused; with somebody else in it they may go, and it is hidden from them', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const channelId = await aPrivateChannel(world, 'leads');
      const alone = await world.call('POST', `/api/channels/${channelId}/leave`, world.owner);
      expect(alone.status).toBe(409);
      expect(await alone.json()).toMatchObject({ error: { code: 'LAST_CHANNEL_MEMBER' } });
      expect(world.published.filter(([, f]) => f.event === 'ACCESS_REVOKED')).toEqual([]);

      await world.call('POST', `/api/channels/${channelId}/members`, world.owner, {
        userId: world.bob.userId,
      });
      expect(
        (await world.call('POST', `/api/channels/${channelId}/leave`, world.owner)).status,
      ).toBe(204);
      expect((await world.call('GET', `/api/channels/${channelId}`, world.owner)).status).toBe(404);
      // And now Bob is the last one.
      expect((await world.call('POST', `/api/channels/${channelId}/leave`, world.bob)).status).toBe(
        409,
      );
    });
  });

  test('a direct message is not left: 404', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const dm = await aDirectMessage(world);
      const refused = await world.call('POST', `/api/channels/${dm}/leave`, world.bob);
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ error: { code: 'CHANNEL_NOT_FOUND' } });
    });
  });
});

describe('integration: who is in a channel', () => {
  test('its members, and nobody who left', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await world.call('POST', `/api/channels/${world.channelId}/join`, world.admin);
      await world.call('POST', `/api/channels/${world.channelId}/leave`, world.bob);
      // Somebody who can see the channel without being in it may ask.
      const listed = await world.call('GET', `/api/channels/${world.channelId}/members`, world.bob);
      expect(listed.status).toBe(200);
      const members = (await listed.json()) as { user: { id: string } }[];
      // One clock for the whole test, so they joined at the same instant: the order is not asserted.
      expect(members.map((m) => m.user.id).sort()).toEqual(
        [world.owner.userId, world.admin.userId].sort(),
      );
    });
  });
});
