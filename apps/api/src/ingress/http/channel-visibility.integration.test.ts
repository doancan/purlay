/**
 * The second axis, crossed for real: a member of the workspace who cannot see
 * the channel (D-34).
 *
 * The cross-tenant crossing is the first refusal of §7.5's four; this file is the
 * other three — private and not yours, a DM you are not in, deleted — and each
 * must be indistinguishable from a channel that never existed.
 *
 * **Phase 0 creates only public channels**, so the hidden ones are seeded
 * directly. The rule is written whole and tested whole now (`ARCHITECTURE.md`
 * §7.5); waiting for the endpoint that creates them would mean testing the guard
 * after the first private conversation already exists.
 *
 * **The control is the same caller on a channel they can see.** Owner and
 * outsider would differ in more than visibility; here the only thing that changes
 * between the refused request and the one that succeeds is which channel it
 * names. Which endpoints appear is decided by `CROSS_TENANT` (D-64).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { createApp } from './app';
import { CROSS_TENANT, pathFor } from '../../testing/cross-tenant';
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
  cookie: string,
  body?: unknown,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`https://purlay.test${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const aUser = async (db: Executor, name: string): Promise<{ id: string; cookie: string }> => {
  const user = await aSignedInUser(db, clock, name);
  return { id: user.userId, cookie: user.cookie };
};

const created = async (response: Response): Promise<string> => {
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

interface World {
  readonly owner: string;
  readonly outsider: string;
  readonly workspaceId: string;
  /** Public, and the outsider has joined it. The control. */
  readonly visible: string;
  /** Each one hidden from the outsider for a different reason. */
  readonly hidden: Readonly<Record<'private' | 'direct message' | 'deleted', string>>;
}

/**
 * One workspace, two members of it, and a channel of every kind.
 *
 * The outsider is a full member of the workspace — that is what makes this the
 * intra-workspace axis rather than the cross-tenant one.
 */
const aWorld = async (db: Executor): Promise<World> => {
  const owner = await aUser(db, 'vis-owner');
  const outsider = await aUser(db, 'vis-outsider');
  const third = await aUser(db, 'vis-third');

  const workspaceId = await created(
    await call(db, 'POST', '/api/workspaces', owner.cookie, {
      name: 'vis',
      slug: aUniqueSlug('vis'),
    }),
  );
  await db
    .insertInto('workspace_members')
    .values([
      { workspace_id: workspaceId, user_id: outsider.id, role: 'member', joined_at: NOW },
      { workspace_id: workspaceId, user_id: third.id, role: 'member', joined_at: NOW },
    ])
    .execute();

  const visible = await created(
    await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, owner.cookie, {
      name: 'general',
    }),
  );
  expect((await call(db, 'POST', `/api/channels/${visible}/join`, outsider.cookie)).ok).toBe(true);

  const seed = async (
    values: { type: 'public' | 'private' | 'direct_message' } & Record<string, unknown>,
    members: readonly string[],
  ): Promise<string> => {
    const row = await db
      .insertInto('channels')
      .values({ workspace_id: workspaceId, created_by: owner.id, ...values })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const user of members) {
      await db
        .insertInto('channel_members')
        .values({ channel_id: row.id, user_id: user, joined_at: NOW })
        .execute();
    }
    return row.id;
  };

  const pair = [owner.id, third.id].sort().join(':');
  const world: World = {
    owner: owner.cookie,
    outsider: outsider.cookie,
    workspaceId,
    visible,
    hidden: {
      private: await seed({ type: 'private', name: 'leadership' }, [owner.id]),
      'direct message': await seed({ type: 'direct_message', name: null, dm_key: pair }, [
        owner.id,
        third.id,
      ]),
      deleted: await seed({ type: 'public', name: 'gone', deleted_at: NOW }, [owner.id]),
    },
  };

  // The seeding is real: the owner, who is in the private channel and the DM,
  // can see both. Otherwise the outsider's 404 could be a broken fixture's.
  for (const channelId of [world.hidden.private, world.hidden['direct message']]) {
    expect((await call(db, 'GET', `/api/channels/${channelId}`, owner.cookie)).status).toBe(200);
  }
  return world;
};

const NEVER_EXISTED = '00000000-0000-4000-8000-000000000000';

describe('integration: channel visibility', () => {
  for (const [key, crossing] of Object.entries(CROSS_TENANT)) {
    const [method = '', path = ''] = key.split(' ');
    const { visibility } = crossing;

    if (visibility.kind === 'channel') {
      test(`${key} answers 404 to a workspace member who cannot see the channel`, async () => {
        await withRollback(async (db) => {
          const world = await aWorld(db);
          const body = crossing.body?.(NOW);
          const at = (channelId: string): string =>
            pathFor(path, { workspaceId: world.workspaceId, channelId });

          const absent = await call(db, method, at(NEVER_EXISTED), world.outsider, body);
          expect(absent.status).toBe(404);
          const refusal: unknown = await absent.json();
          expect(refusal).toMatchObject({ error: { code: crossing.refusal } });

          for (const [why, channelId] of Object.entries(world.hidden)) {
            const response = await call(db, method, at(channelId), world.outsider, body);
            expect({ why, status: response.status, body: await response.json() }).toEqual({
              why,
              status: 404,
              body: refusal,
            });
          }

          const control = await call(db, method, at(world.visible), world.outsider, body);
          expect({ status: control.status, ok: control.ok }).toEqual({
            status: control.status,
            ok: true,
          });
        });
      });
    }

    if (visibility.kind === 'workspace-wide') {
      test(`${key} returns nothing from a channel the caller cannot see`, async () => {
        await withRollback(async (db) => {
          const world = await aWorld(db);
          const query = visibility.query === undefined ? '' : `?${visibility.query}`;
          const read = async (cookie: string): Promise<string> => {
            const response = await call(
              db,
              method,
              `${pathFor(path, { workspaceId: world.workspaceId, channelId: NEVER_EXISTED })}${query}`,
              cookie,
            );
            expect(response.status).toBe(200);
            return await response.text();
          };

          const seen = await read(world.outsider);
          expect(seen).toContain(world.visible);
          for (const [why, channelId] of Object.entries(world.hidden)) {
            expect({ why, leaked: seen.includes(channelId) }).toEqual({ why, leaked: false });
          }

          // The same read *can* return them: the owner's does. An absence the read
          // could never have produced the other way would prove nothing.
          const owners = await read(world.owner);
          expect(owners).toContain(world.hidden.private);
          expect(owners).toContain(world.hidden['direct message']);
        });
      });
    }
  }
});
