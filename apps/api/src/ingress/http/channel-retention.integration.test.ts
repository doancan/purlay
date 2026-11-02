/**
 * How long a channel keeps its history, over HTTP (D-225): the workspace's window until an owner says
 * otherwise; forever, or a floor at least the workspace's, and never shorter — `409 RETENTION_TOO_SHORT`,
 * forever being longer than any number; what is kept said as the longer of the two whichever changed
 * last; every change on the trail with what it was and what it became, the same setting again nothing,
 * and a retry of one that succeeded answered as set even after the workspace moved. An owner's only: an
 * admin and a member are told `403`; a direct message and an archived channel are the stranger's `404`.
 * The workspace's own setting counts the channels that keep longer. Which workspace and which channel
 * are `cross-tenant.ts`'s; who may, `permissions.ts`'s too.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { RETENTION_DAYS_MAX, RETENTION_DAYS_MIN, type UserRole } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { NOW, testDependencies } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aSession } from '../../testing/signed-in';
import { createApp } from './app';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
const ORIGIN = 'https://purlay.test';

interface World {
  readonly room: Room;
  readonly app: ReturnType<typeof createApp>;
  /** Ada's cookie: the workspace's owner, in the channel. */
  readonly owner: string;
  readonly as: (name: string, role: UserRole) => Promise<string>;
}

const aWorld = async (
  db: Transaction,
  options: Parameters<typeof aRoom>[2] = {},
): Promise<World> => {
  const room = await aRoom(db, ['ada', 'bob'], options);
  const as = async (name: string, role: UserRole): Promise<string> => {
    const person = room.members[name];
    if (person === undefined) throw new Error(`no member ${name}`);
    await db
      .updateTable('workspace_members')
      .set({ role })
      .where('workspace_id', '=', room.workspaceId)
      .where('user_id', '=', person.userId)
      .execute();
    const { token } = await aSession(db, clock, person.userId, 30);
    return `${SESSION_COOKIE}=${token}`;
  };
  return {
    room,
    app: createApp(testDependencies({ database: db, clock })),
    owner: await as('ada', 'owner'),
    as,
  };
};

const call = async (
  world: World,
  method: 'GET' | 'PUT',
  path: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> => {
  const response = await world.app.handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, json: await response.json() };
};

const read = async (
  world: World,
  cookie = world.owner,
): Promise<{ status: number; json: unknown }> =>
  await call(world, 'GET', `/api/channels/${world.room.channelId}/retention`, cookie);

const set = async (
  world: World,
  keepsAtLeast: unknown,
  cookie = world.owner,
): Promise<{ status: number; json: unknown }> =>
  await call(world, 'PUT', `/api/channels/${world.room.channelId}/retention`, cookie, {
    keepsAtLeast,
  });

const workspaceKeeps = async (
  db: Transaction,
  world: World,
  days: number | null,
): Promise<void> => {
  await db
    .updateTable('workspaces')
    .set({ retention_days: days })
    .where('id', '=', world.room.workspaceId)
    .execute();
};

/** The trail's changes of this channel's setting, as `from -> to`, sorted: one instant orders none. */
const changes = async (db: Transaction, world: World): Promise<string[]> =>
  (
    await db
      .selectFrom('audit_log')
      .select(['metadata', 'actor_user_id', 'target_type', 'target_id'])
      .where('workspace_id', '=', world.room.workspaceId)
      .where('action', '=', 'channel.retention_changed')
      .execute()
  )
    .map((row) => {
      const { from, to } = row.metadata as { from?: unknown; to?: unknown };
      expect({ type: row.target_type, id: row.target_id, actor: row.actor_user_id }).toEqual({
        type: 'channel',
        id: world.room.channelId,
        actor: world.room.members['ada']?.userId ?? '',
      });
      return `${String(from)} -> ${String(to)}`;
    })
    .sort();

describe('integration: how long a channel keeps its history', () => {
  test('the workspace’s window until set; forever and a floor each said with what is kept, and on the trail', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(await read(world)).toEqual({
        status: 200,
        json: { keepsAtLeast: null, workspaceDays: null, effectiveDays: null },
      });
      await workspaceKeeps(db, world, 30);

      expect(await set(world, 'forever')).toEqual({
        status: 200,
        json: { keepsAtLeast: 'forever', workspaceDays: 30, effectiveDays: null },
      });
      // The same again writes nothing.
      expect((await set(world, 'forever')).status).toBe(200);
      expect(await set(world, 90)).toEqual({
        status: 200,
        json: { keepsAtLeast: 90, workspaceDays: 30, effectiveDays: 90 },
      });
      // As long as the workspace is not shorter: a floor of the same window pins it.
      expect((await set(world, 30)).status).toBe(200);
      expect(await set(world, null)).toEqual({
        status: 200,
        json: { keepsAtLeast: null, workspaceDays: 30, effectiveDays: 30 },
      });
      expect(await read(world)).toEqual({
        status: 200,
        json: { keepsAtLeast: null, workspaceDays: 30, effectiveDays: 30 },
      });
      expect(await changes(db, world)).toEqual(
        ['workspace -> forever', 'forever -> 90', '90 -> 30', '30 -> workspace'].sort(),
      );
    });
  });

  test('never shorter than the workspace keeps: fewer days, or any number while it keeps everything', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await workspaceKeeps(db, world, 365);
      const refused = await set(world, 90);
      expect(refused).toMatchObject({
        status: 409,
        json: { error: { code: 'RETENTION_TOO_SHORT' } },
      });
      expect(await read(world)).toMatchObject({ json: { keepsAtLeast: null, effectiveDays: 365 } });

      await workspaceKeeps(db, world, null);
      expect(await set(world, RETENTION_DAYS_MAX)).toMatchObject({
        status: 409,
        json: { error: { code: 'RETENTION_TOO_SHORT' } },
      });
      // Forever is never shorter, and following the workspace is what the channel did.
      expect((await set(world, 'forever')).status).toBe(200);
      expect((await set(world, null)).status).toBe(200);
      expect(await changes(db, world)).toEqual(
        ['workspace -> forever', 'forever -> workspace'].sort(),
      );
    });
  });

  test('the longer window is said whichever changed last; a retry of a floor that was set is answered as set', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await workspaceKeeps(db, world, 30);
      expect((await set(world, 90)).status).toBe(200);

      // The workspace lengthened past the floor afterwards: it wins, and the floor stays as set.
      await workspaceKeeps(db, world, 365);
      expect(await read(world)).toEqual({
        status: 200,
        json: { keepsAtLeast: 90, workspaceDays: 365, effectiveDays: 365 },
      });
      // The request that set it, sent again: what is there already, so it succeeds and writes nothing.
      expect(await set(world, 90)).toEqual({
        status: 200,
        json: { keepsAtLeast: 90, workspaceDays: 365, effectiveDays: 365 },
      });
      expect(await changes(db, world)).toEqual(['workspace -> 90']);
    });
  });

  test('whole days from the floor to a hundred years, `forever` or null, and nothing else', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await workspaceKeeps(db, world, RETENTION_DAYS_MIN);
      for (const keepsAtLeast of [RETENTION_DAYS_MIN, RETENTION_DAYS_MAX]) {
        expect((await set(world, keepsAtLeast)).status).toBe(200);
      }
      for (const keepsAtLeast of [
        RETENTION_DAYS_MIN - 1,
        RETENTION_DAYS_MAX + 1,
        RETENTION_DAYS_MIN + 0.5,
        String(RETENTION_DAYS_MIN),
        0,
        -30,
        'Forever',
        'sonsuza dek',
        true,
      ]) {
        const refused = await set(world, keepsAtLeast);
        expect({ keepsAtLeast, status: refused.status }).toEqual({ keepsAtLeast, status: 400 });
        expect(refused.json).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      }
      const missing = await call(
        world,
        'PUT',
        `/api/channels/${world.room.channelId}/retention`,
        world.owner,
        {},
      );
      expect(missing.status).toBe(400);
      const extra = await call(
        world,
        'PUT',
        `/api/channels/${world.room.channelId}/retention`,
        world.owner,
        {
          keepsAtLeast: 'forever',
          workspaceDays: null,
        },
      );
      expect(extra.status).toBe(400);
    });
  });

  test('an owner’s only: an admin and a member are refused, and nothing is written', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await workspaceKeeps(db, world, 30);
      for (const role of ['admin', 'member'] as const) {
        const cookie = await world.as('bob', role);
        for (const answer of [await read(world, cookie), await set(world, 'forever', cookie)]) {
          expect({ role, ...answer }).toMatchObject({
            role,
            status: 403,
            json: { error: { code: 'FORBIDDEN' } },
          });
        }
      }
      expect(await read(world)).toMatchObject({ json: { keepsAtLeast: null } });
      expect(await changes(db, world)).toEqual([]);
    });
  });

  test('a direct message has none, and an archived channel is gone: each the stranger’s 404', async () => {
    await withRollback(async (db) => {
      const direct = await aWorld(db, { type: 'direct_message' });
      for (const answer of [await read(direct), await set(direct, 'forever')]) {
        expect(answer).toMatchObject({
          status: 404,
          json: { error: { code: 'CHANNEL_NOT_FOUND' } },
        });
      }

      const archived = await aWorld(db);
      await db
        .updateTable('channels')
        .set({ deleted_at: NOW })
        .where('id', '=', archived.room.channelId)
        .execute();
      for (const answer of [await read(archived), await set(archived, 'forever')]) {
        expect(answer).toMatchObject({
          status: 404,
          json: { error: { code: 'CHANNEL_NOT_FOUND' } },
        });
      }
    });
  });

  test('the workspace’s setting counts the channels that keep longer than it, and only those', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const counted = async (): Promise<unknown> =>
        (
          await call(
            world,
            'GET',
            `/api/workspaces/${world.room.workspaceId}/retention`,
            world.owner,
          )
        ).json;
      const another = async (name: string, values: object): Promise<void> => {
        await db
          .insertInto('channels')
          .values({ workspace_id: world.room.workspaceId, name, type: 'private', ...values })
          .execute();
      };
      await workspaceKeeps(db, world, 30);
      expect((await set(world, 'forever')).status).toBe(200);
      // Private and archived, the owner in neither: counted, since the purge keeps theirs too.
      await another('kept', { min_retention_days: 400, deleted_at: NOW });
      await another('pinned', { min_retention_days: 30 });
      expect(await counted()).toEqual({ retentionDays: 30, channelsKeptLonger: 2 });

      // A workspace window past a channel's floor: that channel keeps no longer than the rest.
      await workspaceKeeps(db, world, 400);
      expect(await counted()).toEqual({ retentionDays: 400, channelsKeptLonger: 1 });
      // Keeping everything: nothing is longer.
      expect(
        (
          await call(
            world,
            'PUT',
            `/api/workspaces/${world.room.workspaceId}/retention`,
            world.owner,
            {
              retentionDays: null,
            },
          )
        ).json,
      ).toEqual({ retentionDays: null, channelsKeptLonger: 0 });
    });
  });
});
