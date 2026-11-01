/**
 * An announcement channel (D-243), driven through real requests and real socket frames: who may say
 * that only owners and admins post, what that tells the room and the trail, and who may then write a
 * root, a reply or an edit by each door a message comes in by.
 *
 * The race between a demotion and a send is held open in
 * `modules/messages/announcement.concurrency.integration.test.ts`; a GitHub feed's event in such a
 * channel is `modules/integrations/webhook.integration.test.ts`'s.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type ServerFrame, type Topic } from '@purlay/types';
import { createApp } from './app';
import { testDependencies, NOW } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { channelTopic } from '../../platform/events';
import { createLogger } from '../../platform/logging';
import { atomicallyOn } from '../../platform/transactions';
import { inMemoryAttention } from '../../platform/attention';
import { inProcessBackplane, inProcessEventBus, type Backplane } from '../../realtime/bus';
import { inMemoryPresenceRegistry } from '../../realtime/presence';
import { inProcessRateLimiter, SOCKET_FRAME_BUDGET } from '../../realtime/rate-limiter';
import { routeFrame } from '../../realtime/router';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
let tick = 0;
/** A fresh id inside the plausibility window, each a millisecond older than the last. */
const nextId = (): string => messageId(new Date(NOW.getTime() - (tick += 1)));

interface World {
  readonly db: Executor;
  readonly owner: SignedInUser;
  readonly admin: SignedInUser;
  readonly bob: SignedInUser;
  readonly workspaceId: string;
  /** Public; the owner, the admin and Bob are in it. */
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
  const backplane: Backplane = {
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
  const owner = await aSignedInUser(db, clock, 'ann-owner');
  const admin = await aSignedInUser(db, clock, 'ann-admin');
  const bob = await aSignedInUser(db, clock, 'ann-bob');
  const slug = aUniqueSlug('ann');
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
    name: 'duyurular',
  });
  expect(channel.status).toBe(201);
  const channelId = ((await channel.json()) as { id: string }).id;
  for (const person of [admin, bob]) {
    expect((await call('POST', `/api/channels/${channelId}/join`, person)).status).toBe(200);
  }
  published.splice(0);
  return { db, owner, admin, bob, workspaceId, channelId, published, call };
};

/** Says, as somebody, whether only owners and admins post here. */
const setPosting = async (
  world: World,
  as: SignedInUser,
  onlyAdminsPost: boolean,
): Promise<Response> =>
  await world.call('PATCH', `/api/channels/${world.channelId}`, as, { onlyAdminsPost });

/** An announcement channel, made so by its owner, with what that published cleared. */
const anAnnouncementWorld = async (db: Executor): Promise<World> => {
  const world = await aWorld(db);
  expect((await setPosting(world, world.owner, true)).status).toBe(200);
  world.published.splice(0);
  return world;
};

const post = async (
  world: World,
  as: SignedInUser,
  body: { readonly id?: string; readonly content: string; readonly parentId?: string },
): Promise<Response> =>
  await world.call('POST', `/api/channels/${world.channelId}/messages`, as, {
    id: body.id ?? nextId(),
    ...body,
  });

const messagesIn = async (world: World): Promise<string[]> =>
  (
    await world.db
      .selectFrom('messages')
      .select('content')
      .where('channel_id', '=', world.channelId)
      .orderBy('id')
      .execute()
  ).map((row) => row.content);

const flag = async (world: World): Promise<boolean> =>
  (
    await world.db
      .selectFrom('channels')
      .select('only_admins_post')
      .where('id', '=', world.channelId)
      .executeTakeFirstOrThrow()
  ).only_admins_post;

const postingTrail = async (world: World): Promise<{ metadata: unknown; actor: string | null }[]> =>
  (
    await world.db
      .selectFrom('audit_log')
      .select(['metadata', 'actor_user_id', 'target_id'])
      .where('workspace_id', '=', world.workspaceId)
      .where('action', '=', 'channel.posting_changed')
      .orderBy('id')
      .execute()
  ).map((row) => {
    expect(row.target_id).toBe(world.channelId);
    return { metadata: row.metadata, actor: row.actor_user_id };
  });

describe('integration: saying who posts in a channel', () => {
  test('an owner turns it on: the channel says so, the room hears it at a rising version, and the trail has it', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const on = await setPosting(world, world.owner, true);
      expect(on.status).toBe(200);
      expect(await on.json()).toMatchObject({ id: world.channelId, onlyAdminsPost: true });
      // Everybody who sees the channel reads it, a member too: their composer is drawn from it.
      const seen = await world.call('GET', `/api/channels/${world.channelId}`, world.bob);
      expect(await seen.json()).toMatchObject({ onlyAdminsPost: true });
      const listed = await world.call(
        'GET',
        `/api/workspaces/${world.workspaceId}/channels`,
        world.bob,
      );
      expect(
        ((await listed.json()) as { id: string; onlyAdminsPost: boolean }[]).find(
          (channel) => channel.id === world.channelId,
        )?.onlyAdminsPost,
      ).toBe(true);

      expect(world.published).toEqual([
        [
          channelTopic(world.channelId),
          {
            event: 'CHANNEL_UPDATED',
            data: {
              channelId: world.channelId,
              name: 'duyurular',
              topic: null,
              onlyAdminsPost: true,
            },
            version: 1,
            ts: NOW.getTime(),
          },
        ],
      ]);
      expect(await postingTrail(world)).toEqual([
        { metadata: { from: 'everyone', to: 'admins' }, actor: world.owner.userId },
      ]);
    });
  });

  test('an admin turns it off again, on the trail as theirs', async () => {
    await withRollback(async (db) => {
      const world = await anAnnouncementWorld(db);
      const off = await setPosting(world, world.admin, false);
      expect(off.status).toBe(200);
      expect(await off.json()).toMatchObject({ onlyAdminsPost: false });
      expect(await flag(world)).toBe(false);
      expect(world.published.map(([, frame]) => frame)).toMatchObject([
        { event: 'CHANNEL_UPDATED', data: { onlyAdminsPost: false }, version: 2 },
      ]);
      // Both at the one fixed instant, so in no order the trail's ids can be trusted to keep.
      expect(await postingTrail(world)).toContainEqual({
        metadata: { from: 'admins', to: 'everyone' },
        actor: world.admin.userId,
      });
      expect(await postingTrail(world)).toHaveLength(2);
    });
  });

  test('a member is refused, 403, and nothing sent with it is written: not a rename beside it either', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const body of [{ onlyAdminsPost: true }, { name: 'bob-says', onlyAdminsPost: true }]) {
        const refused = await world.call(
          'PATCH',
          `/api/channels/${world.channelId}`,
          world.bob,
          body,
        );
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      }
      expect(await flag(world)).toBe(false);
      const channel = await world.call('GET', `/api/channels/${world.channelId}`, world.bob);
      expect(await channel.json()).toMatchObject({ name: 'duyurular', onlyAdminsPost: false });
      expect(world.published).toEqual([]);
      expect(await postingTrail(world)).toEqual([]);

      // The rest of the form is still a member's (D-123).
      const renamed = await world.call('PATCH', `/api/channels/${world.channelId}`, world.bob, {
        topic: 'Haberler',
      });
      expect(renamed.status).toBe(200);
    });
  });

  test('asking for what is already there changes nothing and tells nobody, whoever asks', async () => {
    await withRollback(async (db) => {
      const world = await anAnnouncementWorld(db);
      for (const as of [world.owner, world.admin, world.bob]) {
        const same = await setPosting(world, as, true);
        expect(same.status).toBe(200);
        expect(await same.json()).toMatchObject({ onlyAdminsPost: true });
      }
      expect(world.published).toEqual([]);
      expect(await postingTrail(world)).toHaveLength(1);
    });
  });

  test('a direct message and a group have none: the stranger’s 404, nothing written', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const opened = await world.call(
        'POST',
        `/api/workspaces/${world.workspaceId}/dms`,
        world.owner,
        { userId: world.bob.userId },
      );
      const group = await world.call(
        'POST',
        `/api/workspaces/${world.workspaceId}/conversations`,
        world.owner,
        { userIds: [world.bob.userId, world.admin.userId] },
      );
      for (const made of [opened, group]) {
        expect(made.status).toBe(201);
        const { id } = (await made.json()) as { id: string };
        const refused = await world.call('PATCH', `/api/channels/${id}`, world.owner, {
          onlyAdminsPost: true,
        });
        expect(refused.status).toBe(404);
        expect(await refused.json()).toMatchObject({ error: { code: 'CHANNEL_NOT_FOUND' } });
        const row = await db
          .selectFrom('channels')
          .select('only_admins_post')
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        expect(row.only_admins_post).toBe(false);
      }
      expect(await postingTrail(world)).toEqual([]);
    });
  });

  test('another workspace’s owner is told the channel does not exist, and can neither set it nor post there', async () => {
    await withRollback(async (db) => {
      const world = await anAnnouncementWorld(db);
      const mallory = await aSignedInUser(db, clock, 'ann-mallory');
      const slug = aUniqueSlug('ann-other');
      expect((await world.call('POST', '/api/workspaces', mallory, { name: slug, slug })).ok).toBe(
        true,
      );
      const refused = await setPosting(world, mallory, false);
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ error: { code: 'CHANNEL_NOT_FOUND' } });
      expect(await flag(world)).toBe(true);
      const sent = await post(world, mallory, { content: 'merhaba' });
      expect(sent.status).toBe(404);
      expect(await sent.json()).toMatchObject({ error: { code: 'CHANNEL_NOT_FOUND' } });
      expect(await messagesIn(world)).toEqual([]);
    });
  });

  test('anything but true or false is refused by the contract, 400', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const onlyAdminsPost of ['true', 1, null]) {
        const bad = await world.call('PATCH', `/api/channels/${world.channelId}`, world.owner, {
          onlyAdminsPost,
        });
        expect(bad.status).toBe(400);
      }
      expect(await flag(world)).toBe(false);
    });
  });
});

describe('integration: writing in an announcement channel over HTTP', () => {
  test('an owner and an admin post a root; a member is refused, 403 ONLY_ADMINS_POST, and nothing is written', async () => {
    await withRollback(async (db) => {
      const world = await anAnnouncementWorld(db);
      expect((await post(world, world.owner, { content: 'Yarın bakım var' })).status).toBe(201);
      expect((await post(world, world.admin, { content: 'Şirket gezisi cuma' })).status).toBe(201);
      world.published.splice(0);

      const refused = await post(world, world.bob, { content: 'Ben de bir şey söyleyeyim' });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: 'ONLY_ADMINS_POST' } });
      expect(await messagesIn(world)).toEqual(['Şirket gezisi cuma', 'Yarın bakım var']);
      // Nobody was told of a message that is not there.
      expect(world.published).toEqual([]);
    });
  });

  test('a member replies in a thread, and edits what they wrote before it became one', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const earlier = nextId();
      expect((await post(world, world.bob, { id: earlier, content: 'eski' })).status).toBe(201);
      expect((await setPosting(world, world.owner, true)).status).toBe(200);

      const root = nextId();
      expect((await post(world, world.admin, { id: root, content: 'Duyuru' })).status).toBe(201);
      const reply = await post(world, world.bob, { content: 'Teşekkürler 🙏', parentId: root });
      expect(reply.status).toBe(201);
      const edited = await world.call('PATCH', `/api/messages/${earlier}`, world.bob, {
        content: 'eski, düzeltilmiş',
      });
      expect(edited.status).toBe(200);
      expect((await messagesIn(world)).sort()).toEqual(
        ['Duyuru', 'Teşekkürler 🙏', 'eski, düzeltilmiş'].sort(),
      );
    });
  });

  test('a member’s retry of a root written before it became one is answered with that root (D-33)', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const id = nextId();
      expect((await post(world, world.bob, { id, content: 'gönderildi' })).status).toBe(201);
      expect((await setPosting(world, world.owner, true)).status).toBe(200);

      const again = await post(world, world.bob, { id, content: 'gönderildi' });
      expect(again.ok).toBe(true);
      expect(await again.json()).toMatchObject({ id, content: 'gönderildi' });
      expect(await messagesIn(world)).toEqual(['gönderildi']);
    });
  });

  test('turned off again, a member posts a root', async () => {
    await withRollback(async (db) => {
      const world = await anAnnouncementWorld(db);
      expect((await setPosting(world, world.admin, false)).status).toBe(200);
      expect((await post(world, world.bob, { content: 'artık serbest' })).status).toBe(201);
    });
  });

  test('a demotion is the answer to the next send, and a promotion too', async () => {
    await withRollback(async (db) => {
      const world = await anAnnouncementWorld(db);
      const role = async (person: SignedInUser, to: string): Promise<void> => {
        const changed = await world.call(
          'PATCH',
          `/api/workspaces/${world.workspaceId}/members/${person.userId}`,
          world.owner,
          { role: to },
        );
        expect(changed.status).toBe(200);
      };
      await role(world.admin, 'member');
      const demoted = await post(world, world.admin, { content: 'hâlâ yönetici miyim?' });
      expect(demoted.status).toBe(403);
      expect(await demoted.json()).toMatchObject({ error: { code: 'ONLY_ADMINS_POST' } });

      await role(world.bob, 'admin');
      expect((await post(world, world.bob, { content: 'artık yöneticiyim' })).status).toBe(201);
      expect(await messagesIn(world)).toEqual(['artık yöneticiyim']);
    });
  });
});

describe('integration: writing in an announcement channel over the socket', () => {
  const route = async (
    world: World,
    as: SignedInUser,
    payload: { readonly content: string; readonly parentId?: string },
  ): Promise<{ readonly id: string; readonly replies: readonly ServerFrame[] }> => {
    const log = createLogger({ level: 'silent' });
    const id = nextId();
    const replies = await routeFrame(
      {
        database: world.db,
        clock,
        bus: inProcessEventBus(() => undefined, log),
        limiter: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
        userWrites: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
        presence: inMemoryPresenceRegistry(clock),
        attention: inMemoryAttention(clock),
        log,
        socket: { hold: () => undefined, isOpen: () => true, drop: () => undefined },
        atomically: atomicallyOn(world.db),
      },
      { socketId: 's1', expiresAt: NOW, userId: as.userId, sessionId: as.sessionId },
      { id, op: 'MESSAGE_SEND', payload: { channelId: world.channelId, ...payload } },
    );
    return { id, replies };
  };

  test('a member’s root is an ERROR naming ONLY_ADMINS_POST; their reply and an admin’s root are acknowledged', async () => {
    await withRollback(async (db) => {
      const world = await anAnnouncementWorld(db);
      const refused = await route(world, world.bob, { content: 'soketten' });
      expect(refused.replies).toMatchObject([
        { event: 'ERROR', refId: refused.id, data: { code: 'ONLY_ADMINS_POST' } },
      ]);

      const root = await route(world, world.admin, { content: 'Duyuru, soketten' });
      expect(root.replies).toMatchObject([{ event: 'ACK', data: { id: root.id } }]);
      const reply = await route(world, world.bob, { content: 'yanıt', parentId: root.id });
      expect(reply.replies).toMatchObject([{ event: 'ACK', data: { id: reply.id } }]);
      expect((await messagesIn(world)).sort()).toEqual(['Duyuru, soketten', 'yanıt'].sort());
    });
  });
});
