/**
 * What a refused `SUBSCRIBE` says to somebody who was in the channel (D-264): the notice they would have been
 * sent had their socket been open (`ACCESS_REVOKED` with its reason), and to nobody else anything at all.
 *
 * The second half is the one that matters: D-34 forbids telling a person who is not in a channel why it is
 * unavailable, so the answer to a person who never was must stay *byte for byte* the answer for a channel
 * that does not exist. That is compared, not described.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type RevokedReason, type ServerFrame } from '@purlay/types';
import { createApp } from '../ingress/http/app';
import { fixedClock } from '../platform/clock';
import { createLogger } from '../platform/logging';
import { nobodyActive } from '../platform/attention';
import { atomicallyOn } from '../platform/transactions';
import { NO_SESSION_LIFETIME } from '../modules/auth/session-lifetime';
import { testDependencies, NOW } from '../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../testing/signed-in';
import { aUniqueSlug } from '../testing/users';
import { inProcessEventBus } from './bus';
import { inMemoryPresenceRegistry } from './presence';
import { inProcessRateLimiter, SOCKET_FRAME_BUDGET } from './rate-limiter';
import { routeFrame } from './router';
import { chatFrameHandlers } from '../features/chat/frames';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
const NEVER_EXISTED = '0191a2b3-c4d5-7e6f-8091-a2b3c4d5e6f7';

interface World {
  readonly db: Executor;
  readonly workspaceId: string;
  readonly owner: SignedInUser;
  readonly bob: SignedInUser;
  /** In the workspace, never in the private channel. */
  readonly outsider: SignedInUser;
  readonly privateId: string;
  readonly call: (
    method: string,
    path: string,
    as: SignedInUser,
    body?: unknown,
  ) => Promise<Response>;
  /** What the router answers `as` when they subscribe to these channels. */
  readonly subscribe: (as: SignedInUser, channelIds: readonly string[]) => Promise<ServerFrame[]>;
}

const aWorld = async (db: Executor): Promise<World> => {
  const app = createApp(testDependencies({ database: db, clock }));
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
  const owner = await aSignedInUser(db, clock, 'dep-owner');
  const bob = await aSignedInUser(db, clock, 'dep-bob');
  const outsider = await aSignedInUser(db, clock, 'dep-out');
  const slug = aUniqueSlug('dep');
  const workspaceId = (
    (await (await call('POST', '/api/workspaces', owner, { name: slug, slug })).json()) as {
      id: string;
    }
  ).id;
  await db
    .insertInto('workspace_members')
    .values([
      { workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW },
      { workspace_id: workspaceId, user_id: outsider.userId, role: 'member', joined_at: NOW },
    ])
    .execute();
  const privateId = await aPrivateChannel(call, workspaceId, owner, [bob]);

  const subscribe: World['subscribe'] = async (as, channelIds) => {
    const replies = await routeFrame(
      {
        database: db,
        clock,
        bus: inProcessEventBus(() => undefined, createLogger({ level: 'silent' })),
        limiter: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
        userWrites: inProcessRateLimiter(clock, SOCKET_FRAME_BUDGET),
        frameHandlers: chatFrameHandlers,
        presence: inMemoryPresenceRegistry(clock),
        attention: nobodyActive,
        online: { active: () => undefined },
        sessionLifetime: () => NO_SESSION_LIFETIME,
        log: createLogger({ level: 'silent' }),
        socket: {
          // Router-only fixture: real live delivery uses canonical hubs in the socket tests.
          restrictChannel: () => undefined,
          releaseChannels: () => undefined,
          hold: () => undefined,
          isOpen: () => true,
          drop: () => undefined,
        },
        atomically: atomicallyOn(db),
      },
      { socketId: 's1', userId: as.userId, sessionId: as.sessionId, expiresAt: NOW },
      {
        id: messageId(NOW),
        op: 'SUBSCRIBE',
        payload: { channels: channelIds.map((channelId) => ({ channelId, afterMessageId: null })) },
      },
    );
    return [...replies];
  };
  return { db, workspaceId, owner, bob, outsider, privateId, call, subscribe };
};

/** A private channel the owner made, with these people brought in. */
const aPrivateChannel = async (
  call: World['call'],
  workspaceId: string,
  owner: SignedInUser,
  members: readonly SignedInUser[],
): Promise<string> => {
  const made = await call('POST', `/api/workspaces/${workspaceId}/channels`, owner, {
    name: `room-${crypto.randomUUID().slice(0, 6)}`,
    type: 'private',
  });
  expect(made.status).toBe(201);
  const id = ((await made.json()) as { id: string }).id;
  for (const person of members) {
    const added = await call('POST', `/api/channels/${id}/members`, owner, {
      userId: person.userId,
    });
    expect(added.status).toBe(204);
  }
  return id;
};

/** A reply with what is different every time (the clock's stamp and the id it answers) taken out. */
const bytes = (frames: readonly ServerFrame[]): string =>
  JSON.stringify(
    frames.map((frame) =>
      Object.fromEntries(Object.entries(frame).filter(([key]) => key !== 'ts' && key !== 'refId')),
    ),
  );

const revoked = (id: string, reason: RevokedReason): unknown => ({
  event: 'ACCESS_REVOKED',
  data: { channelIds: [id], reason },
});

describe('integration: a refused subscription and who is told why', () => {
  test('somebody whose channel was archived while they were away is told so, after the refusal', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(
        (await world.call('DELETE', `/api/channels/${world.privateId}`, world.owner)).status,
      ).toBe(204);
      const replies = await world.subscribe(world.bob, [world.privateId]);
      expect(replies).toHaveLength(2);
      expect(replies[0]).toMatchObject({ event: 'ERROR', data: { code: 'CHANNEL_NOT_FOUND' } });
      expect(replies[1]).toMatchObject(revoked(world.privateId, 'archived') as object);
      expect(replies[0]?.refId).toBeDefined();
      expect(replies[1]?.refId).toBe(replies[0]?.refId);
    });
  });

  test('somebody who left a private channel is told they left', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(
        (await world.call('POST', `/api/channels/${world.privateId}/leave`, world.bob)).status,
      ).toBe(204);
      const replies = await world.subscribe(world.bob, [world.privateId]);
      expect(replies[0]).toMatchObject({ event: 'ERROR', data: { code: 'CHANNEL_NOT_FOUND' } });
      expect(replies[1]).toMatchObject(revoked(world.privateId, 'left') as object);
      expect(replies).toHaveLength(2);
    });
  });

  test('somebody taken out of a private channel is told they were removed', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const removed = await world.call(
        'DELETE',
        `/api/channels/${world.privateId}/members/${world.bob.userId}`,
        world.owner,
      );
      expect(removed.status).toBe(204);
      const replies = await world.subscribe(world.bob, [world.privateId]);
      expect(replies[0]).toMatchObject({ event: 'ERROR', data: { code: 'CHANNEL_NOT_FOUND' } });
      expect(replies[1]).toMatchObject(revoked(world.privateId, 'removed') as object);
      expect(replies).toHaveLength(2);
    });
  });

  test('somebody who was never in the channel gets exactly the answer for a channel that does not exist', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      // Everything that could be told is in the database: it was archived, with one person having left
      // and one taken out. The outsider is none of them.
      const second = await world.call(
        'POST',
        `/api/channels/${world.privateId}/members`,
        world.owner,
        {
          userId: world.outsider.userId,
        },
      );
      expect(second.status).toBe(204);
      expect(
        (await world.call('POST', `/api/channels/${world.privateId}/leave`, world.outsider)).status,
      ).toBe(204);
      const stranger = await aSignedInUser(db, clock, 'dep-stranger');
      expect(
        (await world.call('DELETE', `/api/channels/${world.privateId}`, world.owner)).status,
      ).toBe(204);

      const never = await world.subscribe(stranger, [NEVER_EXISTED]);
      const ofStranger = await world.subscribe(stranger, [world.privateId]);
      expect(bytes(ofStranger)).toBe(bytes(never));
      expect(ofStranger).toHaveLength(1);
      expect(ofStranger[0]).toMatchObject({ event: 'ERROR', data: { code: 'CHANNEL_NOT_FOUND' } });

      // The control: the same channel, asked by the person who left it, is not the same answer.
      const ofLeaver = await world.subscribe(world.outsider, [world.privateId]);
      expect(bytes(ofLeaver)).not.toBe(bytes(never));
    });
  });

  test('a person in the workspace who is not in a private channel is not told why it is gone', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(
        (await world.call('DELETE', `/api/channels/${world.privateId}`, world.owner)).status,
      ).toBe(204);
      const never = await world.subscribe(world.outsider, [NEVER_EXISTED]);
      expect(bytes(await world.subscribe(world.outsider, [world.privateId]))).toBe(bytes(never));
    });
  });

  test('somebody who left and was then taken out of the workspace is told nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(
        (await world.call('POST', `/api/channels/${world.privateId}/leave`, world.bob)).status,
      ).toBe(204);
      const out = await world.call(
        'DELETE',
        `/api/workspaces/${world.workspaceId}/members/${world.bob.userId}`,
        world.owner,
      );
      expect(out.status).toBe(204);
      const never = await world.subscribe(world.bob, [NEVER_EXISTED]);
      expect(bytes(await world.subscribe(world.bob, [world.privateId]))).toBe(bytes(never));
    });
  });

  test('a row left behind by somebody who is no longer in the workspace is not read', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(
        (await world.call('POST', `/api/channels/${world.privateId}/leave`, world.bob)).status,
      ).toBe(204);
      // Out of the workspace by a road that does not clear the row, as the guard must hold without it.
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', world.workspaceId)
        .where('user_id', '=', world.bob.userId)
        .execute();
      const never = await world.subscribe(world.bob, [NEVER_EXISTED]);
      expect(bytes(await world.subscribe(world.bob, [world.privateId]))).toBe(bytes(never));
    });
  });

  test('leaving the workspace forgets how they left a channel of it, even if they are brought back', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(
        (await world.call('POST', `/api/channels/${world.privateId}/leave`, world.bob)).status,
      ).toBe(204);
      expect(
        (
          await world.call(
            'DELETE',
            `/api/workspaces/${world.workspaceId}/members/${world.bob.userId}`,
            world.owner,
          )
        ).status,
      ).toBe(204);
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: world.workspaceId,
          user_id: world.bob.userId,
          role: 'member',
          joined_at: NOW,
        })
        .execute();
      const never = await world.subscribe(world.bob, [NEVER_EXISTED]);
      expect(bytes(await world.subscribe(world.bob, [world.privateId]))).toBe(bytes(never));
    });
  });

  test('somebody who left, came back and was then in it when it was archived is told archived, not left', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(
        (await world.call('POST', `/api/channels/${world.privateId}/leave`, world.bob)).status,
      ).toBe(204);
      const back = await world.call(
        'POST',
        `/api/channels/${world.privateId}/members`,
        world.owner,
        {
          userId: world.bob.userId,
        },
      );
      expect(back.status).toBe(204);
      expect(
        (await world.call('DELETE', `/api/channels/${world.privateId}`, world.owner)).status,
      ).toBe(204);
      const replies = await world.subscribe(world.bob, [world.privateId]);
      expect(replies).toHaveLength(2);
      expect(replies[1]).toMatchObject(revoked(world.privateId, 'archived') as object);
    });
  });

  test('a channel left, then joined again and removed with the workspace, is not told as left', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(
        (await world.call('POST', `/api/channels/${world.privateId}/leave`, world.bob)).status,
      ).toBe(204);
      const back = await world.call(
        'POST',
        `/api/channels/${world.privateId}/members`,
        world.owner,
        {
          userId: world.bob.userId,
        },
      );
      expect(back.status).toBe(204);
      // In it again: the channel is there, nothing is refused.
      expect((await world.subscribe(world.bob, [world.privateId]))[0]?.event).toBe('ACK');
      expect(
        (
          await world.call(
            'DELETE',
            `/api/workspaces/${world.workspaceId}/members/${world.bob.userId}`,
            world.owner,
          )
        ).status,
      ).toBe(204);
      const never = await world.subscribe(world.bob, [NEVER_EXISTED]);
      expect(bytes(await world.subscribe(world.bob, [world.privateId]))).toBe(bytes(never));
    });
  });

  test('one channel they were in and one they never could see: only the first is named', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(
        (await world.call('DELETE', `/api/channels/${world.privateId}`, world.owner)).status,
      ).toBe(204);
      const replies = await world.subscribe(world.bob, [NEVER_EXISTED, world.privateId]);
      expect(replies).toHaveLength(2);
      expect(replies[1]).toMatchObject(revoked(world.privateId, 'archived') as object);
      expect(JSON.stringify(replies)).not.toContain(NEVER_EXISTED);
    });
  });

  test('a subscription that is allowed is answered as before', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const replies = await world.subscribe(world.bob, [world.privateId]);
      expect(replies.map((frame) => frame.event)).toEqual(['ACK']);
    });
  });
});
