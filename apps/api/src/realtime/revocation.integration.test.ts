/**
 * Every way visibility ends, through real sockets on two nodes (#238, D-85).
 *
 * Two applications share one database and one backplane in this process, which is
 * what two nodes behind a balancer are. A socket is held by node B; the change is
 * made on node A, or published from a third node that holds no sockets. Phase 0
 * has no endpoint that removes a member or deletes a user, so each test makes the
 * change the way Phase 1's endpoints will — it deletes the rows, then calls the
 * publish function they are required to call.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase, CLONE_HOOK_MS } from '@purlay/db';
import { CLOSE_CODES, messageId, type ServerFrame } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { ServerFrame as ServerFrameSchema } from '@purlay/types';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { aSignedInUser, type SignedInUser } from '../testing/signed-in';
import { testConfig, testDependencies } from '../testing/doubles';
import { fixedClock } from '../platform/clock';
import {
  publishAccessRevoked,
  publishChannelRevoked,
  publishUserDeleted,
} from '../platform/events';
import { createLogger } from '../platform/logging';
import { aUniqueSlug } from '../testing/users';
import { theDefaultChannelOf } from '../testing/channels';
import { inProcessBackplane, type InspectableEventBus } from './bus';

const origin = 'https://purlay.test';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

let cloned: ClonedDatabase;
let nodeA: HttpApplication;
let nodeB: HttpApplication;
let portB = 0;
/** A node that holds no sockets: where a service on a third process would publish. */
let publisher: InspectableEventBus;
/** Set by a test that wants something to happen inside the next database read of node B. */
let duringNextRead: (() => Promise<void>) | undefined;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  const backplane = inProcessBackplane();
  publisher = backplane.node(() => undefined, createLogger({ level: 'silent' }));
  const config = testConfig({ APP_URL: origin });
  nodeA = createApp(testDependencies({ database: cloned.db, clock, config, backplane }));
  // Node B reads through a plugin that can run something inside a read, so a
  // revocation can be published at the exact point a subscription is authorised.
  const database = cloned.db.withPlugin({
    transformQuery: (args) => args.node,
    transformResult: async (args) => {
      const run = duringNextRead;
      duringNextRead = undefined;
      if (run !== undefined) await run();
      return args.result;
    },
  });
  nodeB = createApp(testDependencies({ database, clock, config, backplane }));
  portB = nodeB.listen(0);
}, CLONE_HOOK_MS);

afterAll(async () => {
  await nodeB.stop(true);
  await cloned.drop();
});

const http = async (
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> =>
  await nodeA.handle(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

interface Room {
  readonly alice: SignedInUser;
  readonly bob: SignedInUser;
  readonly workspaceId: string;
  readonly channelId: string;
}

/** Alice owns a workspace and a channel; Bob is a member of both. */
const aRoom = async (): Promise<Room> => {
  const alice = await aSignedInUser(cloned.db, clock, 'alice');
  const bob = await aSignedInUser(cloned.db, clock, 'bob');
  const slug = aUniqueSlug('rev');
  const workspaceId = (
    (await (await http('POST', '/api/workspaces', alice.cookie, { name: slug, slug })).json()) as {
      id: string;
    }
  ).id;
  await cloned.db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW })
    .execute();
  const channelId = (
    (await (
      await http('POST', `/api/workspaces/${workspaceId}/channels`, alice.cookie, {
        name: 'ops',
      })
    ).json()) as { id: string }
  ).id;
  expect((await http('POST', `/api/channels/${channelId}/join`, bob.cookie)).ok).toBe(true);
  return { alice, bob, workspaceId, channelId };
};

interface Client {
  readonly frames: ServerFrame[];
  readonly send: (frame: unknown) => void;
  readonly until: (
    done: (frames: readonly ServerFrame[]) => boolean,
    what: string,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly ended: Promise<number>;
}

/** A socket held by node B. */
const connect = async (cookie: string): Promise<Client> => {
  const socket = new WebSocket(`ws://localhost:${String(portB)}/ws`, {
    headers: { cookie, origin },
  } as unknown as string[]);
  const ended = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => {
      resolve(event.code);
    });
  });
  const frames: ServerFrame[] = [];
  socket.addEventListener('message', (event) => {
    const received: unknown = JSON.parse(String(event.data));
    if (Value.Check(ServerFrameSchema, received)) frames.push(received);
    else throw new Error(`a frame outside the contract: ${String(event.data)}`);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the socket did not open'));
    });
  });
  return {
    frames,
    send: (frame): void => {
      socket.send(JSON.stringify(frame));
    },
    until: async (done, what): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!done(frames)) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${what}; saw ${JSON.stringify(frames.map((f) => f.event))}`,
          );
        }
        await Bun.sleep(10);
      }
    },
    close: async (): Promise<void> => {
      socket.close();
      await ended;
    },
    ended,
  };
};

const subscribe = async (client: Client, channelId: string): Promise<void> => {
  const id = messageId(NOW);
  client.send({
    id,
    op: 'SUBSCRIBE',
    payload: { channels: [{ channelId, afterMessageId: null }] },
  });
  await client.until(
    (frames) => frames.some((f) => f.refId === id),
    'the subscription to be answered',
  );
};

/** Waits for an answer to a PING: anything delivered to the socket before it has arrived. */
const settle = async (client: Client): Promise<void> => {
  const id = messageId(new Date(NOW.getTime() + 500));
  client.send({ id, op: 'PING', payload: {} });
  await client.until((frames) => frames.some((f) => f.refId === id), 'the PONG');
};

const post = async (cookie: string, channelId: string, at: number): Promise<string> => {
  const id = messageId(new Date(NOW.getTime() + at));
  expect(
    (
      await http('POST', `/api/channels/${channelId}/messages`, cookie, {
        id,
        content: `m${String(at)}`,
      })
    ).status,
  ).toBe(201);
  return id;
};

const created = (frames: readonly ServerFrame[]): string[] =>
  frames.flatMap((f) => (f.event === 'MESSAGE_CREATED' ? [f.data.id] : []));

describe('integration: a session that ends on another node', () => {
  test('signing out on node A closes the socket node B holds, after saying why', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'signout');
    const socket = await connect(alice.cookie);

    expect((await http('POST', '/auth/logout', alice.cookie)).status).toBe(204);

    expect(await socket.ended).toBe(CLOSE_CODES.SESSION_ENDED);
    expect(socket.frames).toMatchObject([
      { event: 'SESSION_ENDED', data: { reason: 'signed-out' } },
    ]);
  });

  test('a deleted user’s sockets close, whichever node holds them', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'deleted');
    const bystander = await aSignedInUser(cloned.db, clock, 'bystander');
    const socket = await connect(alice.cookie);
    const other = await connect(bystander.cookie);

    await publishUserDeleted(publisher, clock, alice.userId);

    expect(await socket.ended).toBe(CLOSE_CODES.SESSION_ENDED);
    expect(socket.frames).toMatchObject([
      { event: 'SESSION_ENDED', data: { reason: 'account-deleted' } },
    ]);
    // The control: the same publish left someone else's socket open and usable.
    await settle(other);
    expect(other.frames.some((f) => f.event === 'SESSION_ENDED')).toBe(false);
    await other.close();
  });
});

describe('integration: a workspace renamed (D-124)', () => {
  test('renamed on one node, each member’s socket on another is told; a stranger’s and a removed member’s are not', async () => {
    const room = await aRoom();
    const carol = await aSignedInUser(cloned.db, clock, 'carol');
    const dave = await aSignedInUser(cloned.db, clock, 'dave');
    await cloned.db
      .insertInto('workspace_members')
      .values({
        workspace_id: room.workspaceId,
        user_id: dave.userId,
        role: 'member',
        joined_at: NOW,
      })
      .execute();
    const bob = await connect(room.bob.cookie);
    const stranger = await connect(carol.cookie);
    const removed = await connect(dave.cookie);
    await settle(bob);
    await settle(stranger);
    await settle(removed);
    expect(
      (
        await http(
          'DELETE',
          `/api/workspaces/${room.workspaceId}/members/${dave.userId}`,
          room.alice.cookie,
        )
      ).status,
    ).toBe(204);

    const renamed = await http('PATCH', `/api/workspaces/${room.workspaceId}`, room.alice.cookie, {
      name: 'renamed across nodes',
    });
    expect(renamed.status).toBe(200);
    await bob.until(
      (frames) => frames.some((f) => f.event === 'WORKSPACE_UPDATED'),
      'the notice of the rename',
    );
    expect(bob.frames.find((f) => f.event === 'WORKSPACE_UPDATED')?.data).toEqual({
      workspaceId: room.workspaceId,
    });
    await settle(stranger);
    await settle(removed);
    expect(stranger.frames.some((f) => f.event === 'WORKSPACE_UPDATED')).toBe(false);
    expect(removed.frames.some((f) => f.event === 'WORKSPACE_UPDATED')).toBe(false);
    await bob.close();
    await stranger.close();
    await removed.close();
  });
});

describe('integration: a membership that ends', () => {
  test('removing a member stops the channel on the socket, which stays open', async () => {
    const room = await aRoom();
    const bob = await connect(room.bob.cookie);
    await subscribe(bob, room.channelId);

    // The control: subscribed, Bob receives what Alice posts.
    const before = await post(room.alice.cookie, room.channelId, 1);
    await bob.until((frames) => created(frames).includes(before), 'the message before removal');

    // Removed the way Phase 1's endpoint will: the rows go, then the event is published.
    await cloned.db
      .deleteFrom('channel_members')
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', room.bob.userId)
      .execute();
    await cloned.db
      .deleteFrom('workspace_members')
      .where('workspace_id', '=', room.workspaceId)
      .where('user_id', '=', room.bob.userId)
      .execute();
    expect((await http('GET', `/api/channels/${room.channelId}`, room.bob.cookie)).status).toBe(
      404,
    );
    await publishAccessRevoked(publisher, clock, room.bob.userId, [room.channelId]);
    await bob.until(
      (frames) => frames.some((f) => f.event === 'ACCESS_REVOKED'),
      'the notice of the removal',
    );

    await post(room.alice.cookie, room.channelId, 2);
    await settle(bob);
    expect(created(bob.frames)).toEqual([before]);
    expect(bob.frames.find((f) => f.event === 'ACCESS_REVOKED')?.data).toEqual({
      channelIds: [room.channelId],
    });
    await bob.close();
  });

  test('removed through the endpoint on one node, the member’s socket on another is told and stops (#51)', async () => {
    const room = await aRoom();
    const bob = await connect(room.bob.cookie);
    await subscribe(bob, room.channelId);
    const before = await post(room.alice.cookie, room.channelId, 1);
    await bob.until((frames) => created(frames).includes(before), 'the message before');

    const removed = await http(
      'DELETE',
      `/api/workspaces/${room.workspaceId}/members/${room.bob.userId}`,
      room.alice.cookie,
    );
    expect(removed.status).toBe(204);
    await bob.until(
      (frames) => frames.some((f) => f.event === 'ACCESS_REVOKED'),
      'the notice of the removal',
    );
    // Every channel the workspace showed him: his, and the public one it started with (D-174).
    const revoked = bob.frames.find((f) => f.event === 'ACCESS_REVOKED');
    expect(
      revoked?.event === 'ACCESS_REVOKED' ? [...revoked.data.channelIds].sort() : null,
    ).toEqual([room.channelId, await theDefaultChannelOf(cloned.db, room.workspaceId)].sort());
    await post(room.alice.cookie, room.channelId, 2);
    await settle(bob);
    expect(created(bob.frames)).toEqual([before]);
    expect((await http('GET', `/api/workspaces/${room.workspaceId}`, room.bob.cookie)).status).toBe(
      404,
    );
    await bob.close();
  });

  test('leaving one channel stops that channel and keeps the others on the same socket', async () => {
    const room = await aRoom();
    const second = (await (
      await http('POST', `/api/workspaces/${room.workspaceId}/channels`, room.alice.cookie, {
        name: 'random',
      })
    ).json()) as { id: string };
    expect((await http('POST', `/api/channels/${second.id}/join`, room.bob.cookie)).ok).toBe(true);
    const bob = await connect(room.bob.cookie);
    await subscribe(bob, room.channelId);
    await subscribe(bob, second.id);

    await cloned.db
      .deleteFrom('channel_members')
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', room.bob.userId)
      .execute();
    await publishAccessRevoked(publisher, clock, room.bob.userId, [room.channelId]);
    await bob.until((frames) => frames.some((f) => f.event === 'ACCESS_REVOKED'), 'the notice');

    await post(room.alice.cookie, room.channelId, 5);
    const kept = await post(room.alice.cookie, second.id, 6);
    await settle(bob);
    // Only the channel Bob kept; the same socket, still open.
    expect(created(bob.frames)).toEqual([kept]);
    await bob.close();
  });

  test('deleting a channel stops it for everyone watching it', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice.cookie);
    const bob = await connect(room.bob.cookie);
    await subscribe(alice, room.channelId);
    await subscribe(bob, room.channelId);

    await publishChannelRevoked(publisher, clock, room.channelId);
    await alice.until((frames) => frames.some((f) => f.event === 'ACCESS_REVOKED'), 'the notice');
    await bob.until((frames) => frames.some((f) => f.event === 'ACCESS_REVOKED'), 'the notice');

    await post(room.alice.cookie, room.channelId, 3);
    await settle(alice);
    await settle(bob);
    expect(created(alice.frames)).toEqual([]);
    expect(created(bob.frames)).toEqual([]);
    await alice.close();
    await bob.close();
  });

  /**
   * The race the subscribe-first order exists for: the removal is published while
   * the subscription's authorisation is being read, which happened before the rows
   * went. Subscribed only after that read, the socket would find the revocation
   * already past and keep the channel for good.
   */
  test('a removal published while a subscription is being authorised still ends it', async () => {
    const room = await aRoom();
    const bob = await connect(room.bob.cookie);
    // Its identity is resolved by a read of its own; let that finish, or the hook
    // below would be spent on it.
    await settle(bob);

    duringNextRead = async (): Promise<void> => {
      await publishAccessRevoked(publisher, clock, room.bob.userId, [room.channelId]);
    };
    await subscribe(bob, room.channelId);
    expect(duringNextRead).toBeUndefined();

    await post(room.alice.cookie, room.channelId, 4);
    await settle(bob);
    expect(created(bob.frames)).toEqual([]);
    expect(bob.frames.some((f) => f.event === 'ACCESS_REVOKED')).toBe(true);
    await bob.close();
  });
});
