/**
 * Away by choice (D-257) through real requests and real sockets: `PUT /api/me/away` is stored, then told to the
 * people who share a workspace with the person, at a new version, as every presence change is. The choice wins
 * over activity — a word from the page, a second tab — and offline wins over the choice: chosen while offline it
 * is kept and tells nobody, and the arrival after it is already away, so nobody sees active-then-away.
 *
 * **A database of its own**, cloned and dropped at the end, as `sockets.integration.test.ts` has: the sockets
 * read what the requests wrote, on other connections, so the writes commit (D-46).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import {
  AWAY_AFTER_MS,
  messageId,
  type MeResponse,
  PresenceSnapshot,
  ServerFrame,
  SetAwayResponse,
  type PresenceChange,
} from '@purlay/types';
import { createApp } from './app';
import { aManualTimers, testConfig, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { aSignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const clock = fixedClock(NOW);
const origin = 'https://purlay.test';
let cloned: ClonedDatabase;
let db: Executor;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

/** A node of its own per test, with timers the test runs, so five quiet minutes pass without a wait. */
const aNode = (): {
  readonly node: ReturnType<typeof createApp>;
  readonly timers: ReturnType<typeof aManualTimers>;
  readonly listening: string;
} => {
  const timers = aManualTimers();
  const node = createApp(
    testDependencies({ database: db, clock, config: testConfig({ APP_URL: origin }), timers }),
  );
  return { node, timers, listening: `http://localhost:${String(node.listen(0))}` };
};

const call = async (
  node: ReturnType<typeof createApp>,
  method: string,
  path: string,
  cookie: string | undefined,
  body?: unknown,
): Promise<Response> =>
  await node.handle(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

interface Person {
  readonly id: string;
  readonly cookie: string;
}

const aPerson = async (name: string): Promise<Person> => {
  const user = await aSignedInUser(db, clock, name);
  return { id: user.userId, cookie: user.cookie };
};

/** Alice owns a workspace that Bob, and whoever else is named, are members of. */
const aRoom = async (
  node: ReturnType<typeof createApp>,
  others: readonly string[] = [],
): Promise<{
  readonly workspaceId: string;
  readonly alice: Person;
  readonly bob: Person;
  readonly others: readonly Person[];
}> => {
  const alice = await aPerson('alice');
  const bob = await aPerson('bob');
  const slug = aUniqueSlug('away');
  const made = await call(node, 'POST', '/api/workspaces', alice.cookie, { name: slug, slug });
  const workspaceId = ((await made.json()) as { id: string }).id;
  const rest = await Promise.all(others.map(aPerson));
  for (const member of [bob, ...rest]) {
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: member.id, role: 'member', joined_at: NOW })
      .execute();
  }
  return { workspaceId, alice, bob, others: rest };
};

interface Client {
  readonly frames: ServerFrame[];
  readonly send: (frame: unknown) => void;
  readonly until: (
    done: (frames: readonly ServerFrame[]) => boolean,
    what: string,
  ) => Promise<void>;
  /** Sends a ping and waits for its answer: every frame sent before it has been handled. */
  readonly handled: () => Promise<void>;
  readonly close: () => Promise<void>;
}

const connect = async (cookie: string, listening: string): Promise<Client> => {
  const socket = new WebSocket(`${listening.replace('http', 'ws')}/ws`, {
    headers: { cookie, origin },
  } as unknown as string[]);
  const ended = new Promise<void>((resolve) => {
    socket.addEventListener('close', () => {
      resolve();
    });
  });
  const frames: ServerFrame[] = [];
  const outsideContract: string[] = [];
  socket.addEventListener('message', (event) => {
    const received: unknown = JSON.parse(String(event.data));
    if (Value.Check(ServerFrame, received)) frames.push(received);
    else outsideContract.push(String(event.data));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the socket did not open'));
    });
  });
  const until = async (
    done: (frames: readonly ServerFrame[]) => boolean,
    what: string,
  ): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!done(frames)) {
      expect(outsideContract).toEqual([]);
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; saw ${JSON.stringify(frames)}`);
      }
      await Bun.sleep(10);
    }
  };
  return {
    frames,
    send: (frame): void => {
      socket.send(JSON.stringify(frame));
    },
    until,
    handled: async (): Promise<void> => {
      const id = messageId(NOW);
      socket.send(JSON.stringify({ id, op: 'PING', payload: {} }));
      await until((seen) => seen.some((f) => f.refId === id), 'the ping to be answered');
    },
    close: async (): Promise<void> => {
      expect(outsideContract).toEqual([]);
      socket.close();
      await ended;
    },
  };
};

const waitFor = async (done: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

/** What a socket heard of one person, in order. */
const heardOf = (frames: readonly ServerFrame[], userId: string): PresenceChange[] =>
  frames.flatMap((frame) =>
    frame.event === 'PRESENCE' ? frame.data.changes.filter((c) => c.userId === userId) : [],
  );

const choose = async (
  node: ReturnType<typeof createApp>,
  person: Person,
  away: boolean,
): Promise<void> => {
  const answer = await call(node, 'PUT', '/api/me/away', person.cookie, { away });
  expect(answer.status).toBe(200);
  const body: unknown = await answer.json();
  expect(Value.Check(SetAwayResponse, body)).toBe(true);
  expect(body).toEqual({ away });
};

const snapshot = async (
  listening: string,
  workspaceId: string,
  reader: Person,
): Promise<PresenceSnapshot> => {
  const answer = await fetch(`${listening}/api/workspaces/${workspaceId}/presence`, {
    headers: { cookie: reader.cookie, origin },
  });
  expect(answer.status).toBe(200);
  const body: unknown = await answer.json();
  expect(Value.Check(PresenceSnapshot, body)).toBe(true);
  return body as PresenceSnapshot;
};

describe('integration: away by choice (D-257)', () => {
  test('choosing away tells co-members away at a larger version, and choosing active tells active', async () => {
    const { node, listening } = aNode();
    try {
      const room = await aRoom(node);
      const bob = await connect(room.bob.cookie, listening);
      await waitFor(() => node.held().online === 1, 'bob counted');
      const alice = await connect(room.alice.cookie, listening);
      await bob.until((f) => heardOf(f, room.alice.id).length === 1, 'alice online');
      await choose(node, room.alice, true);
      await bob.until((f) => heardOf(f, room.alice.id).length === 2, 'alice away');
      await choose(node, room.alice, false);
      await bob.until((f) => heardOf(f, room.alice.id).length === 3, 'alice active');
      const heard = heardOf(bob.frames, room.alice.id);
      expect(heard.map(({ online, away }) => ({ online, away }))).toEqual([
        { online: true, away: false },
        { online: true, away: true },
        { online: true, away: false },
      ]);
      const versions = heard.map((change) => change.version);
      expect(versions[1]).toBeGreaterThan(versions[0] ?? Infinity);
      expect(versions[2]).toBeGreaterThan(versions[1] ?? Infinity);
      await Promise.all([alice.close(), bob.close()]);
    } finally {
      await node.stop(true);
    }
  });

  test('the choice holds through activity and a new socket', async () => {
    const { node, timers, listening } = aNode();
    try {
      const room = await aRoom(node);
      const bob = await connect(room.bob.cookie, listening);
      await waitFor(() => node.held().online === 1, 'bob counted');
      const alice = await connect(room.alice.cookie, listening);
      await bob.until((f) => heardOf(f, room.alice.id).length === 1, 'alice online');
      await choose(node, room.alice, true);
      await bob.until((f) => heardOf(f, room.alice.id).length === 2, 'alice away');
      // Idle as well, so her next word ends a told idle: the one word that is told, and it must stay away.
      timers.runUpTo(AWAY_AFTER_MS);
      await node.settled();
      alice.send({ id: messageId(NOW), op: 'ACTIVE', payload: { workspaceId: room.workspaceId } });
      await alice.handled();
      const second = await connect(room.alice.cookie, listening);
      await second.handled();
      await node.settled();
      const heard = heardOf(bob.frames, room.alice.id);
      // Online, chosen, idle, and the word that ended the idle: the control that her word was heard, and told.
      expect(heard).toHaveLength(4);
      expect(heard.slice(1).filter((change) => !change.away)).toEqual([]);
      const read = await snapshot(listening, room.workspaceId, room.bob);
      expect(read.online.find((change) => change.userId === room.alice.id)?.away).toBe(true);
      await Promise.all([alice.close(), second.close(), bob.close()]);
    } finally {
      await node.stop(true);
    }
  });

  test('the choice is kept while offline and tells nobody; the next arrival is told away first', async () => {
    const { node, listening } = aNode();
    try {
      const room = await aRoom(node);
      const bob = await connect(room.bob.cookie, listening);
      await waitFor(() => node.held().online === 1, 'bob counted');
      await choose(node, room.alice, true);
      await node.settled();
      expect(heardOf(bob.frames, room.alice.id)).toEqual([]);
      const alice = await connect(room.alice.cookie, listening);
      await bob.until((f) => heardOf(f, room.alice.id).length === 1, 'alice online');
      await node.settled();
      expect(
        heardOf(bob.frames, room.alice.id).map(({ online, away }) => ({ online, away })),
      ).toEqual([{ online: true, away: true }]);
      await Promise.all([alice.close(), bob.close()]);
    } finally {
      await node.stop(true);
    }
  });

  test('the snapshot carries away for an idle or choosing member, and lists nobody offline', async () => {
    const { node, timers, listening } = aNode();
    try {
      const room = await aRoom(node, ['carol']);
      const carol = room.others[0];
      if (carol === undefined) throw new Error('no carol');
      // Carol chose away, and is offline: offline wins, and she is not listed.
      await choose(node, carol, true);
      await choose(node, room.alice, true);
      const alice = await connect(room.alice.cookie, listening);
      const bob = await connect(room.bob.cookie, listening);
      await waitFor(() => node.held().online === 2, 'both counted');
      await node.settled();
      const awayOf = (read: PresenceSnapshot): Record<string, boolean> =>
        Object.fromEntries(read.online.map((change) => [change.userId, change.away]));
      expect(awayOf(await snapshot(listening, room.workspaceId, room.bob))).toEqual({
        [room.alice.id]: true,
        [room.bob.id]: false,
      });
      // Five quiet minutes: Bob is idle, and the snapshot says so.
      timers.runUpTo(AWAY_AFTER_MS);
      await node.settled();
      expect(awayOf(await snapshot(listening, room.workspaceId, room.bob))).toEqual({
        [room.alice.id]: true,
        [room.bob.id]: true,
      });
      await Promise.all([alice.close(), bob.close()]);
    } finally {
      await node.stop(true);
    }
  });

  test('away is told only to co-members', async () => {
    const { node, listening } = aNode();
    try {
      const room = await aRoom(node, ['erin']);
      const removed = room.others[0];
      if (removed === undefined) throw new Error('no erin');
      const stranger = await aPerson('stranger');
      const theirs = aUniqueSlug('away');
      expect(
        (
          await call(node, 'POST', '/api/workspaces', stranger.cookie, {
            name: theirs,
            slug: theirs,
          })
        ).ok,
      ).toBe(true);
      const bob = await connect(room.bob.cookie, listening);
      const outsider = await connect(stranger.cookie, listening);
      const erin = await connect(removed.cookie, listening);
      await waitFor(() => node.held().online === 3, 'all three counted');
      const alice = await connect(room.alice.cookie, listening);
      // Erin was a member when Alice came: she heard that, which is the control for what follows.
      await erin.until((f) => heardOf(f, room.alice.id).length === 1, 'erin hears alice online');
      await bob.until((f) => heardOf(f, room.alice.id).length === 1, 'bob hears alice online');
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', removed.id)
        .execute();
      await choose(node, room.alice, true);
      await bob.until((f) => heardOf(f, room.alice.id).length === 2, 'bob hears alice away');
      await node.settled();
      expect(heardOf(erin.frames, room.alice.id)).toHaveLength(1);
      expect(outsider.frames.filter((f) => f.event === 'PRESENCE')).toEqual([]);
      await Promise.all([alice.close(), bob.close(), outsider.close(), erin.close()]);
    } finally {
      await node.stop(true);
    }
  });

  test('`GET /api/me` carries awayChosen', async () => {
    const { node } = aNode();
    try {
      const alice = await aPerson('alice');
      const me = async (): Promise<MeResponse> => {
        const answer = await call(node, 'GET', '/api/me', alice.cookie);
        expect(answer.status).toBe(200);
        return (await answer.json()) as MeResponse;
      };
      expect((await me()).awayChosen).toBe(false);
      await choose(node, alice, true);
      expect((await me()).awayChosen).toBe(true);
      await choose(node, alice, false);
      expect((await me()).awayChosen).toBe(false);
    } finally {
      await node.stop(true);
    }
  });

  test('400 on `{away:"yes"}`, and 401 without a session', async () => {
    const { node } = aNode();
    try {
      const alice = await aPerson('alice');
      const refused = await call(node, 'PUT', '/api/me/away', alice.cookie, { away: 'yes' });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      expect((await call(node, 'PUT', '/api/me/away', undefined, { away: true })).status).toBe(401);
      const stored = await db
        .selectFrom('users')
        .select('away_chosen')
        .where('id', '=', alice.id)
        .executeTakeFirstOrThrow();
      expect(stored.away_chosen).toBe(false);
    } finally {
      await node.stop(true);
    }
  });
});
