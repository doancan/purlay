/**
 * Two real sockets, real frames, a real listener (`ARCHITECTURE.md` §10, Realtime).
 *
 * `realtime.integration.test.ts` drives the router directly, inside a rolled-back
 * transaction. That proves the protocol and cannot prove what only the transport
 * and a real database together decide: two connections writing at once, each in
 * its own transaction, with delivery racing the commit.
 *
 * **So this file has a database of its own**, cloned from the migrated template
 * and dropped at the end, and writes in it commit (D-46). One rolled-back
 * transaction would put every query on one connection and serialise the very
 * concurrency being tested.
 *
 * Ordering means **id order** (D-8). Delivery across two senders is not ordered
 * and is not promised to be; what is promised is that a client keeping messages
 * by id ends up with the same sequence as history, and that a reconnect fills in
 * exactly what it missed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import {
  CLOSE_CODES,
  MAX_FRAME_BYTES,
  MESSAGE_CONTENT_MAX,
  MESSAGE_ID_SKEW,
  messageId,
  PresenceSnapshot,
  ServerFrame,
  TYPING_TTL_MS,
} from '@purlay/types';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { SOCKET_FRAME_BUDGET } from './rate-limiter';
import { REPLAY_BYTES_MAX } from '../modules/messages/replay';
import { createConnection } from 'node:net';
import { aManualTimers, aRecordingLogger, testConfig, testDependencies } from '../testing/doubles';
import { issueSession } from '../modules/auth/sessions';
import { fixedClock } from '../platform/clock';
import { requireWorkspaceMembership } from '../platform/tenancy';
import { atomicallyOn } from '../platform/transactions';
import { storeUpload } from '../modules/attachments/uploads';
import { aMemoryStore } from '../testing/storage';
import { SESSION_COOKIE } from '../platform/cookies';
import { aSignedInUser } from '../testing/signed-in';
import { aUniqueSlug } from '../testing/users';
import type { PushSender } from '../modules/push/sender';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let cloned: ClonedDatabase;
let db: Executor;

let app: HttpApplication;
/**
 * The application's public origin, which the socket's `Origin` check compares
 * against — not the address the server happens to listen on. Kept apart, the
 * server can bind port 0 and take whatever the OS gives it, with no window in
 * which another process takes a port this test probed and released (#202).
 */
const origin = 'https://purlay.test';
let server = '';
/** What the server wrote, for the tests that assert it was written (#127). */
const recorded = aRecordingLogger();
/** Whose devices each write asked to have told (D-126): a push sender that keeps the asks. */
const toldOf: { messageId: string; userIds: readonly string[] }[] = [];
const push: PushSender = {
  told: (messageId, userIds): void => {
    toldOf.push({ messageId, userIds });
  },
  flush: () => Promise.resolve(),
};

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
  app = createApp(
    testDependencies({
      database: db,
      clock,
      config: testConfig({ APP_URL: origin }),
      log: recorded.log,
      push,
    }),
  );
  server = `http://localhost:${String(app.listen(0))}`;
});

afterAll(async () => {
  await app.stop(true);
  await cloned.drop();
});

const http = async (
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> =>
  await app.handle(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const aUser = async (name: string): Promise<{ id: string; cookie: string }> => {
  const user = await aSignedInUser(db, clock, name);
  return { id: user.userId, cookie: user.cookie };
};

/** Alice owns a workspace with one channel; Bob is a member who has joined it. */
const aRoom = async (): Promise<{
  alice: string;
  aliceId: string;
  bob: string;
  channelId: string;
}> => {
  const alice = await aUser('alice');
  const bob = await aUser('bob');
  const slug = aUniqueSlug('rt');
  const workspace = await http('POST', '/api/workspaces', alice.cookie, { name: slug, slug });
  const workspaceId = ((await workspace.json()) as { id: string }).id;
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: bob.id, role: 'member', joined_at: NOW })
    .execute();
  const channel = await http('POST', `/api/workspaces/${workspaceId}/channels`, alice.cookie, {
    name: 'general',
  });
  const channelId = ((await channel.json()) as { id: string }).id;
  expect((await http('POST', `/api/channels/${channelId}/join`, bob.cookie)).ok).toBe(true);
  return { alice: alice.cookie, aliceId: alice.id, bob: bob.cookie, channelId };
};

interface Client {
  readonly frames: ServerFrame[];
  readonly send: (frame: unknown) => void;
  /**
   * Waits for the frames to satisfy `done`, or fails naming what it saw.
   *
   * The positive condition, never "nothing more arrived": quiet is what a
   * socket looks like before anything has happened (`CONTRIBUTING.md` §6.3).
   */
  readonly until: (
    done: (frames: readonly ServerFrame[]) => boolean,
    what: string,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
  /** Settles with the close code when the connection ends, whoever ended it. */
  readonly ended: Promise<number>;
}

const connect = async (cookie: string, listening = server): Promise<Client> => {
  const socket = new WebSocket(`${listening.replace('http', 'ws')}/ws`, {
    headers: { cookie, origin },
  } as unknown as string[]);
  const ended = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => {
      resolve(event.code);
    });
  });
  const frames: ServerFrame[] = [];
  // Every frame on the wire must be one the contract declares. The router builds
  // frames behind a cast, so the compiler cannot see a wrong one; this can. Kept
  // rather than thrown: an exception in a listener does not fail the test.
  const outsideContract: string[] = [];
  const conforms = (): void => {
    expect(outsideContract).toEqual([]);
  };
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

  return {
    frames,
    send: (frame: unknown): void => {
      socket.send(JSON.stringify(frame));
    },
    until: async (done, what): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!done(frames)) {
        conforms();
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${what}; saw ${JSON.stringify(frames.map((f) => f.event))}`,
          );
        }
        await Bun.sleep(10);
      }
    },
    close: async (): Promise<void> => {
      conforms();
      socket.close();
      await ended;
    },
    ended,
  };
};

/** Sends a frame and returns its id, which for `MESSAGE_SEND` is the message id. */
const sendMessage = (client: Client, channelId: string, content: string, at = NOW): string => {
  const id = messageId(at);
  client.send({ id, op: 'MESSAGE_SEND', payload: { channelId, content } });
  return id;
};

/** Subscribes, and returns where the replay stopped (`null`: it reached the present). */
const subscribe = async (
  client: Client,
  channelId: string,
  afterMessageId: string | null = null,
): Promise<string | null> => {
  const id = messageId(NOW);
  client.send({ id, op: 'SUBSCRIBE', payload: { channels: [{ channelId, afterMessageId }] } });
  await client.until(
    (frames) => frames.some((f) => f.refId === id),
    'the subscription to be acknowledged',
  );
  const answer = client.frames.find((f) => f.refId === id);
  if (answer?.event !== 'ACK' || !('channels' in answer.data)) {
    throw new Error(`the subscription was answered with ${JSON.stringify(answer)}`);
  }
  return answer.data.channels[0]?.nextCursor ?? null;
};

const ack = (frames: readonly ServerFrame[], id: string): ServerFrame | undefined =>
  frames.find((f) => f.event === 'ACK' && f.refId === id);

const createdIds = (frames: readonly ServerFrame[]): string[] =>
  frames.filter((f) => f.event === 'MESSAGE_CREATED').map((f) => (f.data as { id: string }).id);

/** The channel as history reads it, oldest first. */
const history = async (cookie: string, channelId: string): Promise<string[]> => {
  const response = await http('GET', `/api/channels/${channelId}/messages?limit=100`, cookie);
  const page = (await response.json()) as { data: { id: string }[] };
  return page.data.map((m) => m.id).reverse();
};

const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

describe('integration: a send asks for the devices of who it told, through either door (D-126)', () => {
  test('over the socket and over HTTP, once each, naming who was told for the first time', async () => {
    const room = await aRoom();
    const bob = await db
      .selectFrom('users')
      .innerJoin('workspace_members', 'workspace_members.user_id', 'users.id')
      .innerJoin('channels', 'channels.workspace_id', 'workspace_members.workspace_id')
      .select(['users.id', 'users.username'])
      .where('channels.id', '=', room.channelId)
      .where('users.id', '<>', room.aliceId)
      .executeTakeFirstOrThrow();
    const alice = await connect(room.alice);
    const overSocket = sendMessage(alice, room.channelId, `@${bob.username} over the socket`);
    await alice.until((frames) => ack(frames, overSocket) !== undefined, 'the ACK');
    const overHttp = messageId(new Date(NOW.getTime() + 1));
    const response = await http('POST', `/api/channels/${room.channelId}/messages`, room.alice, {
      id: overHttp,
      content: `@${bob.username} over HTTP`,
    });
    expect(response.status).toBe(201);
    expect(toldOf.filter((ask) => [overSocket, overHttp].includes(ask.messageId))).toEqual([
      { messageId: overSocket, userIds: [bob.id] },
      { messageId: overHttp, userIds: [bob.id] },
    ]);
    await alice.close();
  });
});

describe('integration: two real sockets', () => {
  test('the ACK carries the sender’s own id, and the other socket receives the message', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice);
    const bob = await connect(room.bob);
    await subscribe(alice, room.channelId);
    await subscribe(bob, room.channelId);

    const id = sendMessage(alice, room.channelId, 'hello');
    await alice.until((frames) => ack(frames, id) !== undefined, 'the ACK');
    await bob.until((frames) => createdIds(frames).includes(id), 'the message on the other socket');

    expect(ack(alice.frames, id)?.data).toEqual({ id });
    expect(bob.frames.find((f) => f.event === 'MESSAGE_CREATED')?.data).toMatchObject({
      id,
      content: 'hello',
    });
    await alice.close();
    await bob.close();
  });

  test('typing on one socket reaches the other over the wire, within the contract (#411)', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice);
    const bob = await connect(room.bob);
    await subscribe(alice, room.channelId);
    await subscribe(bob, room.channelId);

    alice.send({ id: messageId(NOW), op: 'TYPING', payload: { channelId: room.channelId } });
    await bob.until((frames) => frames.some((f) => f.event === 'TYPING'), 'the announcement');
    expect(bob.frames.find((f) => f.event === 'TYPING')?.data).toEqual({
      channelId: room.channelId,
      userId: room.aliceId,
      ttlMs: TYPING_TTL_MS,
    });
    await alice.close();
    await bob.close();
  });

  test('a send over the socket carries its attachments to the room, words or none (D-109 §7)', async () => {
    const room = await aRoom();
    const { workspace_id: workspaceId } = await db
      .selectFrom('channels')
      .select('workspace_id')
      .where('id', '=', room.channelId)
      .executeTakeFirstOrThrow();
    const { user_id: aliceId } = await db
      .selectFrom('workspace_members')
      .select('user_id')
      .where('workspace_id', '=', workspaceId)
      .where('role', '=', 'owner')
      .executeTakeFirstOrThrow();
    const upload = messageId(new Date(NOW.getTime() - 1_000));
    await storeUpload(
      { atomically: atomicallyOn(db), storage: aMemoryStore(), log: aRecordingLogger().log },
      await requireWorkspaceMembership(db, aliceId, workspaceId),
      { id: upload, name: 'shot.txt', bytes: new Uint8Array([1, 2, 3]) },
    );
    const alice = await connect(room.alice);
    const bob = await connect(room.bob);
    await subscribe(bob, room.channelId);

    const id = messageId(NOW);
    alice.send({
      id,
      op: 'MESSAGE_SEND',
      payload: { channelId: room.channelId, content: '', attachmentIds: [upload] },
    });
    await bob.until((frames) => createdIds(frames).includes(id), 'the message on the other socket');
    expect(bob.frames.find((f) => f.event === 'MESSAGE_CREATED')?.data).toMatchObject({
      id,
      content: '',
      attachments: [{ id: upload, fileName: 'shot.txt' }],
    });
    await alice.close();
    await bob.close();
  });

  test('concurrent sends from both sockets converge on history’s order', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice);
    const bob = await connect(room.bob);
    await subscribe(alice, room.channelId);
    await subscribe(bob, room.channelId);

    // Interleaved ids, sent without waiting for a single ACK.
    const sent: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      sent.push(sendMessage(alice, room.channelId, `a${String(i)}`, at(2 * i)));
      sent.push(sendMessage(bob, room.channelId, `b${String(i)}`, at(2 * i + 1)));
    }

    const everything = (frames: readonly ServerFrame[]): boolean =>
      sent.every((id) => createdIds(frames).includes(id));
    await alice.until(everything, 'all twenty messages on alice’s socket');
    await bob.until(everything, 'all twenty messages on bob’s socket');

    const ordered = [...sent].sort();
    expect(await history(room.alice, room.channelId)).toEqual(ordered);
    // A client that keeps messages by id holds exactly history, whatever order they arrived in.
    expect([...new Set(createdIds(alice.frames))].sort()).toEqual(ordered);
    expect([...new Set(createdIds(bob.frames))].sort()).toEqual(ordered);
    // And every send was acknowledged, to its own sender, by its own id.
    for (const [index, id] of sent.entries()) {
      const sender = index % 2 === 0 ? alice : bob;
      expect({ id, acked: ack(sender.frames, id)?.data }).toEqual({ id, acked: { id } });
    }
    await alice.close();
    await bob.close();
  });

  test('the same id sent twice at once is one message, acknowledged twice', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice);
    const bob = await connect(room.bob);
    await subscribe(bob, room.channelId);

    const id = messageId(NOW);
    const frame = {
      id,
      op: 'MESSAGE_SEND',
      payload: { channelId: room.channelId, content: 'once' },
    };
    alice.send(frame);
    alice.send(frame);

    await alice.until(
      (frames) => frames.filter((f) => f.event === 'ACK' && f.refId === id).length === 2,
      'both ACKs',
    );
    expect(alice.frames.filter((f) => f.event === 'ERROR')).toEqual([]);
    expect(await history(room.alice, room.channelId)).toEqual([id]);
    await bob.until((frames) => createdIds(frames).includes(id), 'the message on the other socket');
    expect(new Set(createdIds(bob.frames))).toEqual(new Set([id]));
    await alice.close();
    await bob.close();
  });

  /**
   * The replay starts below the cursor (D-65), so it may repeat what the client
   * holds. What it must do is contain everything missed, in order, and nothing
   * the client could not have held.
   */
  const missedOnly = (replayed: readonly string[], held: readonly string[]): string[] =>
    replayed.filter((id) => !held.includes(id));

  test('a reconnect replays everything that was missed, oldest first', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice);
    let bob = await connect(room.bob);
    await subscribe(bob, room.channelId);

    const seen = sendMessage(alice, room.channelId, 'before', at(0));
    await bob.until((frames) => createdIds(frames).includes(seen), 'the first message');
    await bob.close();

    const missed = [1, 2, 3].map((i) =>
      sendMessage(alice, room.channelId, `while away ${String(i)}`, at(i)),
    );
    await alice.until((frames) => missed.every((id) => ack(frames, id) !== undefined), 'the ACKs');

    bob = await connect(room.bob);
    expect(await subscribe(bob, room.channelId, seen)).toBeNull();
    await bob.until(
      (frames) => missed.every((id) => createdIds(frames).includes(id)),
      'the replay',
    );
    const replayed = createdIds(bob.frames);
    expect(missedOnly(replayed, [seen])).toEqual(missed);
    expect(replayed).toEqual([...replayed].sort());
    await alice.close();
    await bob.close();
  });

  /** Regression: a send that waited out a dropped connection sorts below the cursor. */
  test('a message whose id sorts below the cursor is still replayed', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice);
    const latest = sendMessage(alice, room.channelId, 'the newest the reader saw', at(4_000));
    await alice.until((frames) => ack(frames, latest) !== undefined, 'the ACK');

    // Generated half a minute ago, inside the window the server accepts.
    const late = sendMessage(alice, room.channelId, 'sent before the drop', at(-30_000));
    await alice.until((frames) => ack(frames, late) !== undefined, 'the late ACK');
    expect(late < latest).toBe(true);
    expect(30_000).toBeLessThan(MESSAGE_ID_SKEW.behindMs);

    const bob = await connect(room.bob);
    expect(await subscribe(bob, room.channelId, latest)).toBeNull();
    await bob.until((frames) => createdIds(frames).includes(late), 'the late message');
    await alice.close();
    await bob.close();
  });

  /** Regression: a replay longer than a page used to end without saying so. */
  test('a reconnect that missed more than a page is told where to continue', async () => {
    const room = await aRoom();
    // Written over HTTP: a hundred and fifty frames from one socket would be
    // refused by the rate limiter, which is a different test.
    const post = async (content: string, offset: number): Promise<string> => {
      const id = messageId(at(offset));
      const response = await http('POST', `/api/channels/${room.channelId}/messages`, room.alice, {
        id,
        content,
      });
      expect(response.status).toBe(201);
      return id;
    };
    const seen = await post('before', 0);
    const missed: string[] = [];
    for (let i = 0; i < 150; i += 1) missed.push(await post(`m${String(i)}`, i + 1));

    const bob = await connect(room.bob);
    const nextCursor = await subscribe(bob, room.channelId, seen);
    expect(nextCursor).not.toBeNull();
    await bob.until((frames) => createdIds(frames).includes(nextCursor ?? ''), 'the first page');

    // The rest, the way the client is told to fetch it: HTTP, from that cursor.
    const recovered = [...createdIds(bob.frames)];
    let cursor = nextCursor;
    while (cursor !== null) {
      const response = await http(
        'GET',
        `/api/channels/${room.channelId}/messages?after=${cursor}&limit=100`,
        room.bob,
      );
      const page = (await response.json()) as { data: { id: string }[]; nextCursor: string | null };
      recovered.push(...page.data.map((m) => m.id));
      cursor = page.nextCursor;
    }
    expect(missedOnly(recovered, [seen])).toEqual(missed);
    await bob.close();
  });

  /**
   * §5.5's cap, refused by the running server rather than read from a config.
   * The framework's per-route option of the same name is ignored; this is the
   * test that would have noticed (`docs/spikes/elysia.md`).
   */
  test('a frame over 64 KB ends that connection, writes nothing, and nobody else notices', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice);
    const bob = await connect(room.bob);
    await subscribe(bob, room.channelId);

    const id = messageId(NOW);
    alice.send({
      id,
      op: 'MESSAGE_SEND',
      payload: { channelId: room.channelId, content: 'x'.repeat(MAX_FRAME_BYTES) },
    });
    const outcome = await Promise.race([alice.ended, Bun.sleep(5_000).then(() => 'still open')]);
    expect(typeof outcome).toBe('number');
    expect(ack(alice.frames, id)).toBeUndefined();
    expect(await history(room.alice, room.channelId)).toEqual([]);

    // The server is still serving everyone else.
    const after = sendMessage(bob, room.channelId, 'still here');
    await bob.until((frames) => ack(frames, after) !== undefined, 'the other socket to be served');

    // The largest frame a valid message makes is accepted: see the length test below (D-67).
    await bob.close();
  });

  test('a connection that sends past its budget is refused frame by frame, by id', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice);
    const sent = Array.from({ length: SOCKET_FRAME_BUDGET.burst + 5 }, (_, i) => {
      const id = messageId(at(i));
      alice.send({ id, op: 'PING', payload: {} });
      return id;
    });
    await alice.until(
      (frames) => sent.every((id) => frames.some((f) => f.refId === id)),
      'an answer to every ping',
    );
    const answers = sent.map((id) => alice.frames.find((f) => f.refId === id));
    expect(answers.filter((f) => f?.event === 'PONG')).toHaveLength(SOCKET_FRAME_BUDGET.burst);
    const refused = answers.filter((f) => f?.event === 'ERROR');
    expect(new Set(refused.map((f) => f.data.code))).toEqual(new Set(['RATE_LIMITED' as const]));
    expect(refused).toHaveLength(5);
    // Each refusal is counted in the log: the measurement O-4 waits for.
    expect(
      recorded.lines.filter((line) => line['msg'] === 'frame refused: over the rate budget').length,
    ).toBeGreaterThanOrEqual(5);

    // The budget is the connection's: another connection of the same user starts full.
    const again = await connect(room.alice);
    const fresh = messageId(NOW);
    again.send({ id: fresh, op: 'PING', payload: {} });
    await again.until(
      (frames) => frames.some((f) => f.refId === fresh && f.event === 'PONG'),
      'a pong',
    );
    await alice.close();
    await again.close();
  });

  /**
   * The length limit meets the frame cap here (D-67). The longest message in its
   * most expensive form must be written, not end the connection; one unit more is
   * an error the composer can show, on a connection that stays open.
   */
  test('the longest message is accepted over the socket, and a longer one is refused without a disconnect', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice);

    const longest = messageId(NOW);
    alice.send({
      id: longest,
      op: 'MESSAGE_SEND',
      payload: { channelId: room.channelId, content: '\u0800'.repeat(MESSAGE_CONTENT_MAX) },
    });
    await alice.until(
      (frames) => ack(frames, longest) !== undefined,
      'the longest message to be ACKed',
    );

    const tooLong = messageId(at(1));
    alice.send({
      id: tooLong,
      op: 'MESSAGE_SEND',
      payload: { channelId: room.channelId, content: 'x'.repeat(MESSAGE_CONTENT_MAX + 1) },
    });
    await alice.until((frames) => frames.some((f) => f.refId === tooLong), 'an answer');
    const refusal = alice.frames.find((f) => f.refId === tooLong);
    if (refusal?.event !== 'ERROR' || refusal.data.code !== 'VALIDATION_FAILED') {
      throw new Error(`expected a validation refusal, got ${JSON.stringify(refusal)}`);
    }
    expect(Object.keys(refusal.data.details.fields)).toEqual(['payload/content']);

    // Still connected: the next frame on the same socket is served.
    const after = messageId(at(2));
    alice.send({ id: after, op: 'PING', payload: {} });
    await alice.until(
      (frames) => frames.some((f) => f.refId === after && f.event === 'PONG'),
      'a pong',
    );
    expect(await history(room.alice, room.channelId)).toEqual([longest]);
    await alice.close();
  });

  /**
   * A connection lives as long as its session (#194). Each way a session ends must
   * reach the sockets it holds: announced with `SESSION_ENDED`, then closed with
   * the code that says why — and nothing else is closed with it.
   */
  describe('a session’s end reaches its sockets', () => {
    const endedWith = async (
      client: Client,
      reason: 'signed-out' | 'expired',
    ): Promise<{ code: number | string; reason: unknown }> => {
      const code = await Promise.race([client.ended, Bun.sleep(5_000).then(() => 'still open')]);
      const announced = client.frames.find((f) => f.event === 'SESSION_ENDED');
      expect(announced?.data).toEqual({ reason });
      return { code, reason: announced?.data };
    };

    const stillServed = async (client: Client): Promise<void> => {
      const id = messageId(NOW);
      client.send({ id, op: 'PING', payload: {} });
      await client.until((frames) => frames.some((f) => f.refId === id), 'a pong');
    };

    test('signing out closes this device’s socket, and only this device’s', async () => {
      const alice = await aUser('alice');
      const otherDevice = await issueSession(db, clock, alice.id, 30);
      const here = await connect(alice.cookie);
      const there = await connect(`${SESSION_COOKIE}=${otherDevice.token}`);
      await stillServed(here);

      expect((await http('POST', '/auth/logout', alice.cookie)).status).toBe(204);
      expect(await endedWith(here, 'signed-out')).toMatchObject({
        code: CLOSE_CODES.SESSION_ENDED,
      });
      await stillServed(there);
      await there.close();
    });

    test('signing out everywhere closes every socket of that user, and nobody else’s', async () => {
      const alice = await aUser('alice');
      const bob = await aUser('bob');
      const second = await issueSession(db, clock, alice.id, 30);
      const phone = await connect(alice.cookie);
      const laptop = await connect(`${SESSION_COOKIE}=${second.token}`);
      const bystander = await connect(bob.cookie);
      await stillServed(phone);

      expect((await http('POST', '/auth/logout-all', alice.cookie)).status).toBe(204);
      for (const client of [phone, laptop]) {
        expect(await endedWith(client, 'signed-out')).toMatchObject({
          code: CLOSE_CODES.SESSION_ENDED,
        });
      }
      await stillServed(bystander);
      await bystander.close();
    });

    test('a session that expires closes its socket on time, without a frame to prompt it', async () => {
      const alice = await aUser('alice');
      const { token } = await issueSession(db, clock, alice.id, 30);
      // Three hundred milliseconds left on the server's clock.
      await db
        .updateTable('sessions')
        .set({ expires_at: new Date(NOW.getTime() + 300) })
        .where('user_id', '=', alice.id)
        .execute();
      const socket = await connect(`${SESSION_COOKIE}=${token}`);
      expect(await endedWith(socket, 'expired')).toMatchObject({ code: CLOSE_CODES.SESSION_ENDED });
    });
  });

  /**
   * HTTP is the fallback when the socket is down, and the same service (§5.1).
   * Before #195 it wrote outside a transaction and published nothing, so this
   * message reached nobody until they reloaded.
   */
  test('a message sent over HTTP reaches a subscribed socket', async () => {
    const room = await aRoom();
    const bob = await connect(room.bob);
    await subscribe(bob, room.channelId);

    const id = messageId(NOW);
    const response = await http('POST', `/api/channels/${room.channelId}/messages`, room.alice, {
      id,
      content: 'sent while my socket was down',
    });
    expect(response.status).toBe(201);
    await bob.until((frames) => createdIds(frames).includes(id), 'the message on the socket');
    expect(bob.frames.find((f) => f.event === 'MESSAGE_CREATED')?.data).toMatchObject({
      id,
      content: 'sent while my socket was down',
    });
    await bob.close();
  });

  /**
   * §5.5's high-water mark, against a reader that really stops reading (#197).
   * Measured before this existed: the transport queued 16 MB for such a socket
   * and then dropped frames while it stayed open, so the client missed messages
   * and, never disconnected, never replayed them.
   */
  describe('a connection that falls behind', () => {
    /** A WebSocket client frame: text, masked, as RFC 6455 requires of a client. */
    const maskedText = (text: string): Buffer => {
      const payload = Buffer.from(text, 'utf8');
      const header =
        payload.length < 126
          ? Buffer.from([0x81, 0x80 | payload.length])
          : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
      const mask = Buffer.from(crypto.getRandomValues(new Uint8Array(4)));
      const masked = Buffer.from(payload.map((byte, i) => byte ^ (mask[i % 4] ?? 0)));
      return Buffer.concat([header, mask, masked]);
    };

    /** The code of the close frame at the end of what the server sent, if any. */
    const closeCodeIn = (received: Buffer): number | undefined => {
      for (let i = received.length - 4; i >= 0; i -= 1) {
        if (received[i] === 0x88 && (received[i + 1] ?? 0) >= 2) {
          return ((received[i + 2] ?? 0) << 8) | (received[i + 3] ?? 0);
        }
      }
      return undefined;
    };

    test('is closed to resync, rather than left open with frames dropped', async () => {
      const room = await aRoom();
      const { port } = new URL(server);
      const received: Buffer[] = [];
      const socket = createConnection({ host: '127.0.0.1', port: Number(port) });
      const closed = new Promise<void>((resolve) =>
        socket.on('close', () => {
          resolve();
        }),
      );
      socket.on('data', (chunk: Buffer) => received.push(chunk));
      await new Promise<void>((resolve) =>
        socket.on('connect', () => {
          resolve();
        }),
      );
      socket.write(
        [
          'GET /ws HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          `Origin: ${origin}`,
          `Cookie: ${room.bob}`,
          '',
          '',
        ].join('\r\n'),
      );
      const subscribeId = messageId(NOW);
      const seen = async (needle: string): Promise<void> => {
        const deadline = Date.now() + 5_000;
        while (!Buffer.concat(received).includes(needle)) {
          if (Date.now() > deadline) throw new Error(`never saw ${needle}`);
          await Bun.sleep(10);
        }
      };
      await seen('101 Switching Protocols');
      socket.write(
        maskedText(
          JSON.stringify({
            id: subscribeId,
            op: 'SUBSCRIBE',
            payload: { channels: [{ channelId: room.channelId, afterMessageId: null }] },
          }),
        ),
      );
      await seen(subscribeId);

      // Stop reading, then send until the server gives up on the socket. How many
      // messages that takes is the machine's business — the kernel's buffers on
      // loopback are not a constant — so the loop watches for the event itself,
      // instead of sending a fixed number that is slow where the buffers are
      // large and too few where they are larger still. Posted in batches: the
      // sequence is not what is under test, the buffer filling is.
      socket.pause();
      const long = 'x'.repeat(MESSAGE_CONTENT_MAX);
      const logged = (): number =>
        recorded.lines.filter(
          (line) => line['msg'] === 'socket fell behind and was closed to resync',
        ).length;
      const alreadyLogged = logged();
      const fellBehind = (): boolean => logged() > alreadyLogged;
      const BATCH = 20;
      const MOST_BATCHES = 100;
      let sent = 0;
      while (!fellBehind()) {
        if (sent >= BATCH * MOST_BATCHES) {
          throw new Error(
            `${String(sent)} messages of ${String(long.length)} bytes and the socket never fell behind`,
          );
        }
        const responses = await Promise.all(
          Array.from(
            { length: BATCH },
            async (_, i) =>
              await http('POST', `/api/channels/${room.channelId}/messages`, room.alice, {
                id: messageId(at(sent + i)),
                content: long,
              }),
          ),
        );
        for (const response of responses) expect(response.status).toBe(201);
        sent += BATCH;
      }

      // Read again: what was queued drains, and then the server's close arrives.
      socket.resume();
      const outcome = await Promise.race([
        closed.then(() => 'closed'),
        Bun.sleep(3_000).then(() => 'still open'),
      ]);
      expect(outcome).toBe('closed');
      expect(closeCodeIn(Buffer.concat(received))).toBe(CLOSE_CODES.RESYNC);
      expect(fellBehind()).toBe(true);
    });

    /**
     * What a loopback reader can show: the replay stays inside its byte budget and
     * the connection is served after it. That the mark exceeds the budget — the
     * property that keeps a slow but healthy reader out of a resync loop — cannot
     * be shown over loopback, which drains too fast; `hub.test.ts` binds it.
     */
    test('the largest replay stays inside its budget, and the reader is served after it', async () => {
      const room = await aRoom();
      const seenFirst = messageId(at(0));
      expect(
        (
          await http('POST', `/api/channels/${room.channelId}/messages`, room.alice, {
            id: seenFirst,
            content: 'before',
          })
        ).status,
      ).toBe(201);
      // More than the replay's byte budget, so the replay is as large as it gets.
      const long = 'y'.repeat(MESSAGE_CONTENT_MAX);
      for (let i = 1; i <= 120; i += 1) {
        await http('POST', `/api/channels/${room.channelId}/messages`, room.alice, {
          id: messageId(at(i)),
          content: long,
        });
      }
      const bob = await connect(room.bob);
      const nextCursor = await subscribe(bob, room.channelId, seenFirst);
      expect(nextCursor).not.toBeNull();
      // It stays open and served after the burst.
      const after = messageId(at(500));
      bob.send({ id: after, op: 'PING', payload: {} });
      await bob.until((frames) => frames.some((f) => f.refId === after), 'a pong after the replay');
      const replayedBytes = bob.frames
        .filter((f) => f.event === 'MESSAGE_CREATED')
        .reduce((sum, f) => sum + Buffer.byteLength(JSON.stringify(f), 'utf8'), 0);
      expect(replayedBytes).toBeLessThanOrEqual(REPLAY_BYTES_MAX);
      expect(replayedBytes).toBeGreaterThan(REPLAY_BYTES_MAX / 2);
      await bob.close();
    });
  });

  /**
   * The handshake's refusals, through the running server rather than the function
   * behind them (#202). If the wiring swallowed the error, the socket would open
   * and every test that calls `admitSocket` directly would still pass.
   */
  describe('an upgrade the server refuses', () => {
    const upgrade = async (headers: Record<string, string>): Promise<Response> =>
      await fetch(`${server}/ws`, {
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
          ...headers,
        },
      });

    test('from another origin is 403, with a session that is otherwise valid', async () => {
      const alice = await aUser('alice');
      const response = await upgrade({ origin: 'https://evil.test', cookie: alice.cookie });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    });

    test('without a session is 401, from the right origin', async () => {
      const response = await upgrade({ origin });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    });

    test('the same request with both is switched, so the refusals above are the checks', async () => {
      const alice = await aUser('alice');
      const response = await upgrade({ origin, cookie: alice.cookie });
      expect(response.status).toBe(101);
    });
  });

  /**
   * What is held for a socket is released when it closes, at every place that
   * holds some — asserted on the sizes, through the running server, so the close
   * handler's wiring is what is tested rather than the functions it calls.
   */
  describe('a socket that closes', () => {
    test('leaves nothing in the hub, the bus or the limiter', async () => {
      const room = await aRoom();
      // A server of its own. The shared one still holds whatever the previous test's
      // sockets have not finished closing — the client's `close()` resolves when the
      // client's side is done, the server's cleanup lands later, and how much later
      // depends on the load — so a `before` read from it is a count that can change
      // between two reads. Nothing else connects here, so every number is this test's.
      const timers = aManualTimers();
      const own = createApp(
        testDependencies({
          database: db,
          clock,
          config: testConfig({ APP_URL: origin }),
          log: recorded.log,
          timers,
        }),
      );
      const listening = `http://localhost:${String(own.listen(0))}`;
      try {
        const before = own.held();
        expect(before).toEqual({
          connections: 0,
          busSockets: 0,
          busTopics: 0,
          rateBuckets: 0,
          online: 0,
          leaving: 0,
        });

        const alice = await connect(room.alice, listening);
        await subscribe(alice, room.channelId);
        const open = own.held();
        // The controls: each place did hold something while the socket was open.
        expect(open.connections).toBe(1);
        expect(open.busSockets).toBe(1);
        expect(open.busTopics).toBeGreaterThan(0);
        expect(open.rateBuckets).toBe(1);
        expect(open.online).toBe(1);

        await alice.close();
        // Online until the grace has passed (D-136), and then nothing held for her.
        const graced = Date.now() + 5_000;
        while (own.held().leaving !== 1 && Date.now() < graced) await Bun.sleep(10);
        expect(own.held()).toMatchObject({ online: 1, leaving: 1 });
        timers.runAll();
        await own.settled();
        // All four, not the first to reach its old value: the bus and the limiter are
        // released by the same handler, but nothing orders them for the reader.
        const deadline = Date.now() + 5_000;
        while (JSON.stringify(own.held()) !== JSON.stringify(before) && Date.now() < deadline) {
          await Bun.sleep(10);
        }
        expect(own.held()).toEqual(before);
      } finally {
        await own.stop(true);
      }
    });
  });

  describe('who is online (D-136)', () => {
    const ownNode = (): {
      readonly own: ReturnType<typeof createApp>;
      readonly timers: ReturnType<typeof aManualTimers>;
    } => {
      const timers = aManualTimers();
      const own = createApp(
        testDependencies({
          database: db,
          clock,
          config: testConfig({ APP_URL: origin }),
          timers,
        }),
      );
      return { own, timers };
    };
    const until = async (done: () => boolean, what: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!done()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(10);
      }
    };
    const presenceOf = (frames: readonly ServerFrame[], userId: string): boolean[] =>
      frames.flatMap((frame) =>
        frame.event === 'PRESENCE'
          ? frame.data.changes.filter((c) => c.userId === userId).map((c) => c.online)
          : [],
      );

    test('a co-member hears her come online, and offline only once the grace has passed', async () => {
      const room = await aRoom();
      const { own, timers } = ownNode();
      const listening = `http://localhost:${String(own.listen(0))}`;
      try {
        const bob = await connect(room.bob, listening);
        await until(() => own.held().online === 1, 'bob counted');
        const alice = await connect(room.alice, listening);
        await bob.until((f) => presenceOf(f, room.aliceId).includes(true), 'alice online');
        await alice.close();
        await until(() => own.held().leaving === 1, 'alice inside her grace');
        // Inside the grace nothing is said.
        expect(presenceOf(bob.frames, room.aliceId)).toEqual([true]);
        timers.runAll();
        await bob.until((f) => presenceOf(f, room.aliceId).includes(false), 'alice offline');
        expect(presenceOf(bob.frames, room.aliceId)).toEqual([true, false]);
        await bob.close();
      } finally {
        await own.stop(true);
      }
    });

    test('a second socket of hers, or one back inside the grace, never shows her offline', async () => {
      const room = await aRoom();
      const { own, timers } = ownNode();
      const listening = `http://localhost:${String(own.listen(0))}`;
      try {
        const bob = await connect(room.bob, listening);
        await until(() => own.held().online === 1, 'bob counted');
        const first = await connect(room.alice, listening);
        const second = await connect(room.alice, listening);
        await bob.until((f) => presenceOf(f, room.aliceId).includes(true), 'alice online');
        await until(() => own.held().connections === 3, 'all three counted');
        await first.close();
        await until(() => own.held().connections === 2, 'her first socket gone');
        expect(own.held().leaving).toBe(0);
        await second.close();
        await until(() => own.held().leaving === 1, 'alice inside her grace');
        const back = await connect(room.alice, listening);
        await until(() => own.held().leaving === 0, 'alice back');
        timers.runAll();
        await own.settled();
        expect(presenceOf(bob.frames, room.aliceId)).toEqual([true]);
        await back.close();
        await bob.close();
      } finally {
        await own.stop(true);
      }
    });

    test('her workspace’s presence lists her for a member, and is not found for anybody else', async () => {
      const room = await aRoom();
      const { own } = ownNode();
      const listening = `http://localhost:${String(own.listen(0))}`;
      try {
        const alice = await connect(room.alice, listening);
        await until(() => own.held().online === 1, 'alice counted');
        const workspaceId = (
          await db
            .selectFrom('channels')
            .select('workspace_id')
            .where('id', '=', room.channelId)
            .executeTakeFirstOrThrow()
        ).workspace_id;
        const read = async (cookie: string): Promise<Response> =>
          await fetch(`${listening}/api/workspaces/${workspaceId}/presence`, {
            headers: { cookie, origin },
          });
        const answer = await read(room.bob);
        expect(answer.status).toBe(200);
        const body: unknown = await answer.json();
        expect(Value.Check(PresenceSnapshot, body)).toBe(true);
        expect((body as { online: { userId: string }[] }).online.map((o) => o.userId)).toEqual([
          room.aliceId,
        ]);
        const stranger = await aUser('stranger');
        expect((await read(stranger.cookie)).status).toBe(404);
        await alice.close();
      } finally {
        await own.stop(true);
      }
    });
  });

  /**
   * The framework starts a handler per frame and does not wait for the last. A
   * `SUBSCRIBE` that waits on the database used to be overtaken by the
   * `UNSUBSCRIBE` sent right after it, and then subscribed anyway: the client had
   * asked to stop and kept receiving.
   */
  describe('the frames of one socket', () => {
    test('are handled in the order they were sent, so a fast UNSUBSCRIBE is not overtaken', async () => {
      const room = await aRoom();
      const alice = await connect(room.alice);
      const subscribeId = messageId(NOW);
      const unsubscribeId = messageId(at(1));
      alice.send({
        id: subscribeId,
        op: 'SUBSCRIBE',
        payload: { channels: [{ channelId: room.channelId, afterMessageId: null }] },
      });
      alice.send({
        id: unsubscribeId,
        op: 'UNSUBSCRIBE',
        payload: { channelIds: [room.channelId] },
      });
      await alice.until((frames) => ack(frames, unsubscribeId) !== undefined, 'both answers');
      expect(alice.frames.filter((f) => f.event === 'ACK').map((f) => f.refId)).toEqual([
        subscribeId,
        unsubscribeId,
      ]);

      // Bob's post is delivered before it returns; alice's later PING is answered
      // after anything delivered to her, so quiet by then is real.
      expect(
        (
          await http('POST', `/api/channels/${room.channelId}/messages`, room.bob, {
            id: messageId(at(2)),
            content: 'after you left',
          })
        ).status,
      ).toBe(201);
      const pingId = messageId(at(3));
      alice.send({ id: pingId, op: 'PING', payload: {} });
      await alice.until((frames) => frames.some((f) => f.refId === pingId), 'the PONG');
      expect(createdIds(alice.frames)).toEqual([]);
      await alice.close();
    });
  });
});
