/**
 * Two whole nodes, each with its own hub, sockets and Redis connection, sharing one database and one Redis
 * (D-201, #114): what the self-hosted path never does and the cloud always does. A frame, a sign-out, a
 * person's presence and a user's write quota must each be right across the two, and a node that lost its
 * Redis must send its sockets back to replay.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import {
  CLOSE_CODES,
  messageId,
  PRESENCE_GRACE_MS,
  ServerFrame as ServerFrameSchema,
  type PresenceChange,
  type ServerFrame,
} from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { fixedClock } from '../platform/clock';
import { createLogger } from '../platform/logging';
import type { RedisLink } from '../platform/redis';
import { connectRedis, bunRedisClient } from '../platform/redis';
import { testConfig, testDependencies } from '../testing/doubles';
import {
  aDroppableProxy,
  aRealLink,
  redisUrlForTests,
  type DroppableProxy,
} from '../testing/redis';
import { aSignedInUser, type SignedInUser } from '../testing/signed-in';
import { aUniqueSlug } from '../testing/users';
import type { Timers } from './hub';
import { onlinePresence, type OnlinePresence } from './online';
import { ONLINE_PREFIX, redisPresenceDirectory } from './redis-presence';
import { sharedRealtime } from './shared';

const origin = 'https://purlay.test';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const silent = createLogger({ level: 'silent' });
/** The write budget: a few at once and next to no refill, so a test counts what a node let through. */
const WRITES = { perSecond: 0.001, burst: 12 };

/** Presence's grace and renewals, shortened: a person who left is told within a blink. */
const quick: Timers = {
  set: (callback, ms) => setTimeout(callback, Math.min(ms, ms >= PRESENCE_GRACE_MS ? 40 : ms)),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

interface Node {
  readonly app: HttpApplication;
  readonly port: number;
  readonly link: RedisLink;
}

let cloned: ClonedDatabase;
let proxy: DroppableProxy;
let a: Node;
let b: Node;

const roomy = testDependencies().rateBudgets;
if (roomy === undefined) throw new Error('the test dependencies carry budgets');

const startNode = (link: RedisLink): Node => {
  const { backplane, shared } = sharedRealtime(link, clock, silent);
  const app = createApp(
    testDependencies({
      database: cloned.db,
      clock,
      config: testConfig({ APP_URL: origin }),
      backplane,
      shared,
      timers: quick,
      rateBudgets: { ...roomy, writes: WRITES },
    }),
  );
  return { app, port: app.listen(0), link };
};

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  proxy = await aDroppableProxy(redisUrlForTests());
  const linkA = await aRealLink();
  // Node B reaches Redis through a proxy that can cut it, as a restart of Redis would.
  const linkB = connectRedis({ create: () => bunRedisClient(proxy.url), log: silent });
  while (!linkB.connected()) await Bun.sleep(10);
  a = startNode(linkA);
  b = startNode(linkB);
}, CLONE_HOOK_MS);

afterAll(async () => {
  await a.app.stop(true);
  await b.app.stop(true);
  a.link.close();
  b.link.close();
  proxy.stop();
  await cloned.drop();
}, DROP_HOOK_MS);

const http = async (
  node: Node,
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> =>
  await node.app.handle(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

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

const connect = async (node: Node, cookie: string): Promise<Client> => {
  const socket = new WebSocket(`ws://localhost:${String(node.port)}/ws`, {
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
      const deadline = Date.now() + 8_000;
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
  await client.until((frames) => frames.some((f) => f.refId === id), 'the subscription');
};

interface Room {
  readonly alice: SignedInUser;
  readonly bob: SignedInUser;
  readonly workspaceId: string;
  readonly channelId: string;
}

const aRoom = async (): Promise<Room> => {
  const alice = await aSignedInUser(cloned.db, clock, 'alice');
  const bob = await aSignedInUser(cloned.db, clock, 'bob');
  const slug = aUniqueSlug('shared');
  const workspaceId = (
    (await (
      await http(a, 'POST', '/api/workspaces', alice.cookie, { name: slug, slug })
    ).json()) as {
      id: string;
    }
  ).id;
  await cloned.db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW })
    .execute();
  const channelId = (
    (await (
      await http(a, 'POST', `/api/workspaces/${workspaceId}/channels`, alice.cookie, {
        name: 'ops',
      })
    ).json()) as { id: string }
  ).id;
  expect((await http(a, 'POST', `/api/channels/${channelId}/join`, bob.cookie)).ok).toBe(true);
  return { alice, bob, workspaceId, channelId };
};

const created = (frames: readonly ServerFrame[]): string[] =>
  frames.flatMap((f) => (f.event === 'MESSAGE_CREATED' ? [f.data.id] : []));

describe('integration: a frame crosses nodes', () => {
  test('a message sent through node A reaches the subscribers of both nodes, each once, in order', async () => {
    const room = await aRoom();
    const onA = await connect(a, room.bob.cookie);
    const onB = await connect(b, room.bob.cookie);
    await subscribe(onA, room.channelId);
    await subscribe(onB, room.channelId);

    const sent: string[] = [];
    for (let n = 1; n <= 5; n += 1) {
      const id = messageId(new Date(NOW.getTime() + n));
      sent.push(id);
      expect(
        (
          await http(a, 'POST', `/api/channels/${room.channelId}/messages`, room.alice.cookie, {
            id,
            content: `m${String(n)}`,
          })
        ).status,
      ).toBe(201);
    }
    await onB.until((frames) => created(frames).length >= 5, 'five messages on node B');
    await onA.until((frames) => created(frames).length >= 5, 'five messages on node A');
    await Bun.sleep(150);

    expect(created(onB.frames)).toEqual(sent);
    expect(created(onA.frames)).toEqual(sent);
    await onA.close();
    await onB.close();
  });

  test('signing out on node A closes the socket node B holds, after saying why', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'signout');
    const socket = await connect(b, alice.cookie);
    expect((await http(a, 'POST', '/auth/logout', alice.cookie)).status).toBe(204);
    expect(await socket.ended).toBe(CLOSE_CODES.SESSION_ENDED);
    // A person hears their own presence (D-257); the only other word is why the socket closes.
    expect(socket.frames.filter((f) => f.event !== 'PRESENCE')).toMatchObject([
      { event: 'SESSION_ENDED', data: { reason: 'signed-out' } },
    ]);
  });
});

describe('integration: typing across nodes', () => {
  test('a person typing through both nodes is announced to the room once, not once per node', async () => {
    const room = await aRoom();
    const listener = await connect(a, room.alice.cookie);
    await subscribe(listener, room.channelId);
    const onA = await connect(a, room.bob.cookie);
    const onB = await connect(b, room.bob.cookie);
    const announce = (client: Client): void => {
      client.send({ id: messageId(NOW), op: 'TYPING', payload: { channelId: room.channelId } });
    };
    const heard = (): number => listener.frames.filter((f) => f.event === 'TYPING').length;

    announce(onA);
    await listener.until(() => heard() >= 1, 'the first announcement');
    announce(onB);
    announce(onA);
    announce(onB);
    await Bun.sleep(400);
    expect(heard()).toBe(1);
    await listener.close();
    await onA.close();
    await onB.close();
  });
});

describe('integration: presence across nodes', () => {
  const presenceOf = async (node: Node, cookie: string, workspaceId: string): Promise<string[]> => {
    const answer = (await (
      await http(node, 'GET', `/api/workspaces/${workspaceId}/presence`, cookie)
    ).json()) as { online: { userId: string }[] };
    return answer.online.map((c) => c.userId);
  };
  const changes = (client: Client, userId: string): boolean[] =>
    client.frames.flatMap((f) =>
      f.event === 'PRESENCE'
        ? f.data.changes.filter((c) => c.userId === userId).map((c) => c.online)
        : [],
    );

  test('a person with a socket on node B is online to a read on node A, and to a listener on A', async () => {
    const room = await aRoom();
    const listener = await connect(a, room.alice.cookie);
    expect(await presenceOf(a, room.alice.cookie, room.workspaceId)).not.toContain(room.bob.userId);

    const bob = await connect(b, room.bob.cookie);
    await listener.until(() => changes(listener, room.bob.userId).includes(true), 'Bob online');
    expect(await presenceOf(a, room.alice.cookie, room.workspaceId)).toContain(room.bob.userId);

    await bob.close();
    await listener.until(() => changes(listener, room.bob.userId).includes(false), 'Bob offline');
    expect(await presenceOf(a, room.alice.cookie, room.workspaceId)).not.toContain(room.bob.userId);
    await listener.close();
  });

  test('a person on both nodes is told once, and offline only when the last socket closes', async () => {
    const room = await aRoom();
    const listener = await connect(a, room.alice.cookie);
    const onB = await connect(b, room.bob.cookie);
    await listener.until(() => changes(listener, room.bob.userId).includes(true), 'Bob online');
    const onA = await connect(a, room.bob.cookie);
    await Bun.sleep(200);
    expect(changes(listener, room.bob.userId)).toEqual([true]);

    await onB.close();
    await Bun.sleep(400);
    // Still held on node A: nobody is told he left, and a read agrees.
    expect(changes(listener, room.bob.userId)).toEqual([true]);
    expect(await presenceOf(b, room.alice.cookie, room.workspaceId)).toContain(room.bob.userId);

    await onA.close();
    await listener.until(() => changes(listener, room.bob.userId).includes(false), 'Bob offline');
    expect(changes(listener, room.bob.userId)).toEqual([true, false]);
    await listener.close();
  });
});

/**
 * Idleness across nodes (D-257), on the shared record of a real Redis. A page's word does not reach
 * `online.active` through a socket yet, so each node here is its presence alone — its own link, its own
 * directory, its renewals and sweeps run quickly — speaking for the person as the socket would.
 */
describe('integration: who is away across nodes', () => {
  /** Five quiet minutes, shortened: Redis's own clock decides when they have passed. */
  const AWAY_MS = 400;
  /** Renewals, sweeps, graces and retries, every few milliseconds. */
  const brisk = (): Timers & { readonly freeze: () => void } => {
    let frozen = false;
    return {
      set: (callback, ms): ReturnType<typeof setTimeout> =>
        setTimeout(
          () => {
            if (!frozen) callback();
          },
          Math.min(ms, 25),
        ),
      clear: (handle): void => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
      freeze: (): void => {
        frozen = true;
      },
    };
  };
  interface PresenceNode {
    readonly online: OnlinePresence;
    readonly id: string;
    /** The node dies: no renewal, no sweep, no release. */
    readonly die: () => void;
  }
  const told: PresenceChange[] = [];
  const presenceNode = (): PresenceNode => {
    const id = crypto.randomUUID();
    const timers = brisk();
    const online = onlinePresence({
      clock,
      timers,
      log: silent,
      announce: (change): Promise<void> => {
        told.push(change);
        return Promise.resolve();
      },
      awayAfterMs: AWAY_MS,
      directory: redisPresenceDirectory(a.link, id),
    });
    return { online, id, die: timers.freeze };
  };
  const states = (userId: string): [boolean, boolean][] =>
    told.filter((c) => c.userId === userId).map((c) => [c.online, c.away]);
  /** Speaks for the person on one node every so often, for as long as asked. */
  const speak = async (node: PresenceNode, userId: string, ms: number): Promise<void> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      node.online.active(userId);
      await Bun.sleep(AWAY_MS / 4);
    }
  };

  test('a person idle on one node and speaking on the other is active', async () => {
    const userId = crypto.randomUUID();
    const one = presenceNode();
    const other = presenceNode();
    one.online.arrived(userId);
    other.online.arrived(userId);
    await speak(other, userId, 3 * AWAY_MS);
    expect(states(userId)).toEqual([[true, false]]);
    expect(await one.online.onlineAmong([userId])).toMatchObject([{ online: true, away: false }]);
    one.online.stop();
    other.online.stop();
  });

  test('a node that dies while its socket was idle leaves the person active where they speak', async () => {
    const userId = crypto.randomUUID();
    const dying = presenceNode();
    const living = presenceNode();
    dying.online.arrived(userId);
    living.online.arrived(userId);
    await speak(living, userId, AWAY_MS);
    dying.die();
    // What its claim becomes once it has not been renewed for its lifetime.
    await a.link.send('HSET', [`${ONLINE_PREFIX}${userId}`, `n:${dying.id}`, '1']);
    await speak(living, userId, 3 * AWAY_MS);
    expect(states(userId)).toEqual([[true, false]]);
    expect(await living.online.onlineAmong([userId])).toMatchObject([
      { online: true, away: false },
    ]);
    living.online.stop();
  });

  test('an idle lapse is told once across two nodes', async () => {
    const userId = crypto.randomUUID();
    const one = presenceNode();
    const other = presenceNode();
    one.online.arrived(userId);
    other.online.arrived(userId);
    await until(() => states(userId).length >= 2, 'the person told away');
    await Bun.sleep(AWAY_MS);
    expect(states(userId)).toEqual([
      [true, false],
      [true, true],
    ]);
    expect(await other.online.onlineAmong([userId])).toMatchObject([{ away: true }]);

    one.online.active(userId);
    await until(() => states(userId).length >= 3, 'the person told active');
    other.online.active(userId);
    await Bun.sleep(AWAY_MS / 2);
    expect(states(userId)).toEqual([
      [true, false],
      [true, true],
      [true, false],
    ]);
    const versions = told.filter((c) => c.userId === userId).map((c) => c.version);
    expect(versions).toEqual([...versions].sort((x, y) => x - y));
    one.online.stop();
    other.online.stop();
  });
});

describe('integration: one write quota across nodes (D-81, D-198)', () => {
  const sendUntilRefused = async (
    room: Room,
    cookie: string,
    nodes: readonly Node[],
  ): Promise<number> => {
    let allowed = 0;
    for (let n = 0; n < 40; n += 1) {
      const node = nodes[n % nodes.length]!;
      const response = await http(
        node,
        'POST',
        `/api/channels/${room.channelId}/messages`,
        cookie,
        {
          id: messageId(new Date(NOW.getTime() + 1_000 + n)),
          content: 'x',
        },
      );
      if (response.status === 429) return allowed;
      expect(response.status).toBe(201);
      allowed += 1;
    }
    throw new Error('the quota was never reached');
  };

  test('a user alternating between the nodes is refused after exactly as many writes as one node alone allows', async () => {
    const room = await aRoom();
    const second = await aRoom();
    const onOne = await sendUntilRefused(room, room.alice.cookie, [a]);
    const onTwo = await sendUntilRefused(second, second.alice.cookie, [a, b]);
    expect(onOne).toBeGreaterThan(0);
    expect(onTwo).toBe(onOne);
  });
});

describe('integration: readiness with a shared Redis (D-201)', () => {
  const ready = async (problem: string | undefined): Promise<number> => {
    const { backplane, shared } = sharedRealtime(a.link, clock, silent);
    const app = createApp(
      testDependencies({
        database: cloned.db,
        clock,
        config: testConfig({ APP_URL: origin }),
        backplane,
        shared: { ...shared, problem: () => problem },
      }),
    );
    return (await app.handle(new Request(`${origin}/health/ready`))).status;
  };

  test('a node that has never reached Redis is not ready; one that has is, however Redis goes on', async () => {
    expect(await ready('redis has not been reached since start')).toBe(503);
    expect(await ready(undefined)).toBe(200);
    // Node B has lost its Redis (below) and still says ready: degraded is not unready.
    expect((await b.app.handle(new Request(`${origin}/health/ready`))).status).toBe(200);
  });
});

/**
 * What the test is given: more than the 10 s `until` waits for a node to notice, so the wait ends in its own named
 * error, not in the runner's 5 s default — which on a loaded runner cut the test off with no word of what it waited for.
 */
const LOSS_TEST_MS = 20_000;

describe('integration: a node that loses Redis', () => {
  test(
    'keeps serving its sockets, and when Redis is back sends them to replay from their cursors',
    async () => {
      const room = await aRoom();
      const socket = await connect(b, room.bob.cookie);
      await subscribe(socket, room.channelId);

      proxy.drop();
      await until(() => !b.link.subscribed(), 'node B to notice');
      // Redis is away: the socket stays open, and writes through node B itself still reach it.
      const id = messageId(new Date(NOW.getTime() + 500));
      expect(
        (
          await http(b, 'POST', `/api/channels/${room.channelId}/messages`, room.alice.cookie, {
            id,
            content: 'during',
          })
        ).status,
      ).toBe(201);
      await socket.until(
        (frames) => created(frames).includes(id),
        'the write to reach its own node',
      );

      expect(await socket.ended).toBe(CLOSE_CODES.RESTARTING);
    },
    LOSS_TEST_MS,
  );
});

const until = async (done: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};
