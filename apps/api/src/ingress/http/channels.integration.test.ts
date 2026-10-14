/**
 * The channel endpoints, driven through real requests.
 *
 * Their cross-tenant tests are not here: every workspace-scoped endpoint is
 * crossed in `cross-tenant.integration.test.ts`, from a list the build checks
 * against `API.md` (D-21, D-63).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { createApp } from './app';
import { testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import type { ServerFrame } from '@purlay/types';
import { NO_LOG, userTopic, type EventBus } from '../../platform/events';
import { addChannelMember, createWorkspaceChannel, joinPublicChannel } from './channels';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';
const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

const call = async (
  db: Executor,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );

const signedIn = async (db: Executor, name: string): Promise<SignedInUser> =>
  await aSignedInUser(db, clock, name);

const aWorkspace = async (db: Executor, cookie: string, slug: string): Promise<string> => {
  const response = await call(db, 'POST', '/api/workspaces', {
    cookie,
    body: { name: slug, slug: aUniqueSlug(slug) },
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

const aChannel = async (
  db: Executor,
  cookie: string,
  workspaceId: string,
  name: string,
): Promise<string> => {
  const response = await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, {
    cookie,
    body: { name },
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

describe('integration: channels', () => {
  test('creating one puts the creator in it, and it is public', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'chn-alice');
      const workspaceId = await aWorkspace(db, alice.cookie, 'chn-acme');
      const channelId = await aChannel(db, alice.cookie, workspaceId, 'general');

      const row = await db
        .selectFrom('channels')
        .selectAll()
        .where('id', '=', channelId)
        .executeTakeFirstOrThrow();
      expect(row.type).toBe('public');
      expect(row.created_by).toBe(alice.userId);

      const members = await db
        .selectFrom('channel_members')
        .selectAll()
        .where('channel_id', '=', channelId)
        .execute();
      expect(members).toHaveLength(1);
      expect(members[0]?.user_id).toBe(alice.userId);
    });
  });

  /** Case-insensitively, and only among live channels: deleting `#api` frees the name. */
  test('a name taken in this workspace is refused; the same name elsewhere is not', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'chn-name');
      const mine = await aWorkspace(db, alice.cookie, 'chn-mine');
      const other = await aWorkspace(db, alice.cookie, 'chn-other');
      await aChannel(db, alice.cookie, mine, 'General');

      const clash = await call(db, 'POST', `/api/workspaces/${mine}/channels`, {
        cookie: alice.cookie,
        body: { name: 'general' },
      });
      expect(clash.status).toBe(409);
      expect(await clash.json()).toMatchObject({ error: { code: 'CHANNEL_NAME_TAKEN' } });

      // A name is unique per workspace, not per instance.
      const elsewhere = await call(db, 'POST', `/api/workspaces/${other}/channels`, {
        cookie: alice.cookie,
        body: { name: 'general' },
      });
      expect(elsewhere.status).toBe(201);
    });
  });

  test('listing shows the public channels of the workspace, and nothing from another', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'chn-list');
      const mine = await aWorkspace(db, alice.cookie, 'chn-list-mine');
      const other = await aWorkspace(db, alice.cookie, 'chn-list-other');
      await aChannel(db, alice.cookie, mine, 'general');
      await aChannel(db, alice.cookie, mine, 'random');
      await aChannel(db, alice.cookie, other, 'elsewhere');

      const response = await call(db, 'GET', `/api/workspaces/${mine}/channels`, {
        cookie: alice.cookie,
      });
      const channels = (await response.json()) as { name: string }[];
      expect(channels.map((channel) => channel.name).sort()).toEqual(['general', 'random']);
    });
  });

  /**
   * PostgreSQL sorts nulls **first** under `DESC`, so without `NULLS LAST` a
   * channel nobody has written in outranks every active one — the opposite of
   * what `UX.md` §4 asks the sidebar to show, and invisible in any test where no
   * channel has messages.
   */
  test('the sidebar puts recent activity first and silent channels last', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'chn-order');
      const workspaceId = await aWorkspace(db, alice.cookie, 'chn-order-ws');
      const quiet = await aChannel(db, alice.cookie, workspaceId, 'quiet');
      const busy = await aChannel(db, alice.cookie, workspaceId, 'busy');
      await db
        .updateTable('channels')
        .set({ last_message_at: new Date('2026-09-09T12:00:00.000Z') })
        .where('id', '=', busy)
        .execute();

      const response = await call(db, 'GET', `/api/workspaces/${workspaceId}/channels`, {
        cookie: alice.cookie,
      });
      const channels = (await response.json()) as { id: string; name: string }[];
      expect(channels.map((channel) => channel.name)).toEqual(['busy', 'quiet']);
      expect(channels[0]?.id).toBe(busy);
      expect(channels[1]?.id).toBe(quiet);
    });
  });

  test('joining is idempotent, so a retry after a dropped response is not a failure', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'chn-owner');
      const bob = await signedIn(db, 'chn-joiner');
      const workspaceId = await aWorkspace(db, alice.cookie, 'chn-join');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: workspaceId, user_id: bob.userId })
        .execute();
      const channelId = await aChannel(db, alice.cookie, workspaceId, 'general');

      expect(
        (await call(db, 'POST', `/api/channels/${channelId}/join`, { cookie: bob.cookie })).status,
      ).toBe(200);
      expect(
        (await call(db, 'POST', `/api/channels/${channelId}/join`, { cookie: bob.cookie })).status,
      ).toBe(200);

      const members = await db
        .selectFrom('channel_members')
        .selectAll()
        .where('channel_id', '=', channelId)
        .where('user_id', '=', bob.userId)
        .execute();
      expect(members).toHaveLength(1);
    });
  });

  test('every one of these endpoints requires a session', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'chn-anon');
      const workspaceId = await aWorkspace(db, alice.cookie, 'chn-anon-ws');
      const channelId = await aChannel(db, alice.cookie, workspaceId, 'general');

      for (const [method, path, body] of [
        ['GET', `/api/workspaces/${workspaceId}/channels`, undefined],
        ['POST', `/api/workspaces/${workspaceId}/channels`, { name: 'x' }],
        ['GET', `/api/channels/${channelId}`, undefined],
        ['POST', `/api/channels/${channelId}/join`, undefined],
      ] as const) {
        const response = await call(db, method, path, { ...(body === undefined ? {} : { body }) });
        expect(response.status).toBe(401);
      }
    });
  });
});

describe('integration: private channels over HTTP', () => {
  /** Alice's workspace with Bob in it, and a private channel of Alice's. */
  const aPrivateChannel = async (
    db: Executor,
  ): Promise<{ alice: SignedInUser; bob: SignedInUser; channelId: string }> => {
    const alice = await signedIn(db, 'prv-alice');
    const bob = await signedIn(db, 'prv-bob');
    const workspaceId = await aWorkspace(db, alice.cookie, 'prv-acme');
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member' })
      .execute();
    const created = await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, {
      cookie: alice.cookie,
      body: { name: 'leads', type: 'private' },
    });
    expect(created.status).toBe(201);
    const channel = (await created.json()) as { id: string; type: string };
    expect(channel.type).toBe('private');
    return { alice, bob, channelId: channel.id };
  };

  test('nobody outside it sees it, until a member brings them in', async () => {
    await withRollback(async (db) => {
      const { alice, bob, channelId } = await aPrivateChannel(db);
      expect(
        (await call(db, 'GET', `/api/channels/${channelId}`, { cookie: bob.cookie })).status,
      ).toBe(404);
      const added = await call(db, 'POST', `/api/channels/${channelId}/members`, {
        cookie: alice.cookie,
        body: { userId: bob.userId },
      });
      expect(added.status).toBe(204);
      expect(
        (await call(db, 'GET', `/api/channels/${channelId}`, { cookie: bob.cookie })).status,
      ).toBe(200);
    });
  });

  test('a type that is not public or private is refused', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'prv-carol');
      const workspaceId = await aWorkspace(db, alice.cookie, 'prv-other');
      const response = await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, {
        cookie: alice.cookie,
        body: { name: 'x', type: 'direct_message' },
      });
      expect(response.status).toBe(400);
    });
  });

  test('a person not in the workspace is 404 USER_NOT_FOUND; a body naming nobody is 400', async () => {
    await withRollback(async (db) => {
      const { alice, channelId } = await aPrivateChannel(db);
      const stranger = await signedIn(db, 'prv-stranger');
      const unknown = await call(db, 'POST', `/api/channels/${channelId}/members`, {
        cookie: alice.cookie,
        body: { userId: stranger.userId },
      });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({ error: { code: 'USER_NOT_FOUND' } });
      const malformed = await call(db, 'POST', `/api/channels/${channelId}/members`, {
        cookie: alice.cookie,
        body: { userId: 'bob' },
      });
      expect(malformed.status).toBe(400);
    });
  });

  test('the person brought in is told on their own topic, once', async () => {
    await withRollback(async (db) => {
      const { alice, bob, channelId } = await aPrivateChannel(db);
      const topics: string[] = [];
      const frames: ServerFrame[] = [];
      const bus: EventBus = {
        publish: (topic, frame): Promise<void> => {
          topics.push(topic);
          frames.push(frame);
          return Promise.resolve();
        },
        subscribe: () => false,
        unsubscribe: () => undefined,
        forget: () => undefined,
      };
      const request = (): Request =>
        new Request(`${ORIGIN}/`, { headers: { cookie: alice.cookie } });
      const dependencies = { database: db, clock, bus, log: NO_LOG };
      await addChannelMember(dependencies, request(), channelId, { userId: bob.userId });
      await addChannelMember(dependencies, request(), channelId, { userId: bob.userId });
      expect(topics).toEqual([userTopic(bob.userId)]);
      const [frame] = frames;
      expect(frame?.event === 'CHANNEL_ADDED' ? frame.data.id : null).toBe(channelId);
    });
  });
});

describe('integration: the person’s other devices hear of a channel they joined or made (#540)', () => {
  const recording = (): { bus: EventBus; heard: [string, ServerFrame][] } => {
    const heard: [string, ServerFrame][] = [];
    return {
      heard,
      bus: {
        publish: (topic, frame): Promise<void> => {
          heard.push([topic, frame]);
          return Promise.resolve();
        },
        subscribe: () => false,
        unsubscribe: () => undefined,
        forget: () => undefined,
      },
    };
  };
  const as = (cookie: string): Request => new Request(`${ORIGIN}/`, { headers: { cookie } });

  test('joining a public channel tells their own topic, once — a second join is a no-op', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'own-alice');
      const bob = await signedIn(db, 'own-bob');
      const workspaceId = await aWorkspace(db, alice.cookie, 'own-acme');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member' })
        .execute();
      const channelId = await aChannel(db, alice.cookie, workspaceId, 'design');
      const { bus, heard } = recording();
      const dependencies = { database: db, clock, bus, log: NO_LOG };
      const joined = await joinPublicChannel(dependencies, as(bob.cookie), channelId);
      await joinPublicChannel(dependencies, as(bob.cookie), channelId);
      expect(heard.map(([topic, frame]) => [topic, frame.event])).toEqual([
        [userTopic(bob.userId), 'CHANNEL_ADDED'],
      ]);
      const [[, frame] = ['', null]] = heard;
      // What they are told is the channel as they now see it: theirs to show and to watch.
      expect(frame?.event === 'CHANNEL_ADDED' ? frame.data : null).toEqual(joined);
    });
  });

  test('making a channel tells the maker’s own topic', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'mk-alice');
      const workspaceId = await aWorkspace(db, alice.cookie, 'mk-acme');
      const { bus, heard } = recording();
      const made = await createWorkspaceChannel(
        { database: db, clock, bus, log: NO_LOG },
        as(alice.cookie),
        workspaceId,
        { name: 'launch' },
      );
      expect(heard.map(([topic, frame]) => [topic, frame.event])).toEqual([
        [userTopic(alice.userId), 'CHANNEL_ADDED'],
      ]);
      const [[, frame] = ['', null]] = heard;
      expect(frame?.event === 'CHANNEL_ADDED' ? frame.data : null).toEqual(made);
    });
  });
});
