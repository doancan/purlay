/**
 * The channel endpoints, driven through real requests.
 *
 * Two mandates apply here rather than one. Every workspace-scoped endpoint
 * carries a cross-tenant test asserting `404` (D-21), and every channel-scoped
 * endpoint carries an intra-workspace visibility test asserting the same (D-34).
 * Both are `ARCHITECTURE.md` §10 requirements with no exceptions.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { createApp } from './app';
import { testDependencies } from './testing';
import { issueSession } from '../../modules/auth/sessions';
import { fixedClock } from '../../platform/clock';

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

const signedIn = async (
  db: Executor,
  name: string,
): Promise<{ userId: string; cookie: string }> => {
  const row = await db
    .insertInto('users')
    .values({ email: `${name}@example.test`, username: name, display_name: name })
    .returning('id')
    .executeTakeFirstOrThrow();
  const { token } = await issueSession(db, clock, row.id, 30);
  return { userId: row.id, cookie: `purlay_session=${token}` };
};

const aWorkspace = async (db: Executor, cookie: string, slug: string): Promise<string> => {
  const response = await call(db, 'POST', '/api/workspaces', {
    cookie,
    body: { name: slug, slug },
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

  /** Mandatory: the workspace-scoped pair (D-21). */
  for (const [method, suffix] of [
    ['GET', ''],
    ['POST', ''],
  ] as const) {
    test(`${method} /api/workspaces/:id/channels${suffix} answers 404 across a tenant boundary`, async () => {
      await withRollback(async (db) => {
        const owner = await signedIn(db, `chn-x-owner-${method}`);
        const stranger = await signedIn(db, `chn-x-stranger-${method}`);
        const theirs = await aWorkspace(db, owner.cookie, `chn-x-${method.toLowerCase()}`);

        const response = await call(db, method, `/api/workspaces/${theirs}/channels`, {
          cookie: stranger.cookie,
          ...(method === 'POST' ? { body: { name: 'sneak' } } : {}),
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: 'WORKSPACE_NOT_FOUND' } });
      });
    });
  }

  /** Mandatory: the channel-scoped pair (D-34). */
  for (const [method, path] of [
    ['GET', ''],
    ['POST', '/join'],
  ] as const) {
    test(`${method} /api/channels/:id${path} answers 404 to somebody who cannot see it`, async () => {
      await withRollback(async (db) => {
        const owner = await signedIn(db, `chn-v-owner-${method}`);
        const stranger = await signedIn(db, `chn-v-stranger-${method}`);
        const workspaceId = await aWorkspace(db, owner.cookie, `chn-v-${method.toLowerCase()}`);
        const channelId = await aChannel(db, owner.cookie, workspaceId, 'general');

        const response = await call(db, method, `/api/channels/${channelId}${path}`, {
          cookie: stranger.cookie,
        });
        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body).toMatchObject({ error: { code: 'CHANNEL_NOT_FOUND' } });

        // Identical to a channel that does not exist at all.
        const missing = await call(
          db,
          method,
          `/api/channels/00000000-0000-4000-8000-000000000000${path}`,
          { cookie: stranger.cookie },
        );
        expect(await missing.json()).toEqual(body);
      });
    });
  }

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
