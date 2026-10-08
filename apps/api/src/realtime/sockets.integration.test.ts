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
  ServerFrame,
} from '@purlay/types';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { SOCKET_FRAME_BUDGET } from './rate-limiter';
import { testConfig, testDependencies } from '../ingress/http/testing';
import { issueSession } from '../modules/auth/sessions';
import { fixedClock } from '../platform/clock';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let cloned: ClonedDatabase;
let db: Executor;

let app: HttpApplication;
let origin = '';

/** A port nothing is listening on. Asked of the OS, not guessed. */
const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  void probe.stop(true);
  if (port === undefined) throw new Error('the OS did not hand out a port');
  return port;
};

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
  const port = freePort();
  origin = `http://localhost:${String(port)}`;
  app = createApp(
    testDependencies({ database: db, clock, config: testConfig({ APP_URL: origin, PORT: port }) }),
  );
  app.listen(port);
});

afterAll(async () => {
  await app.stop(true);
  await cloned.drop();
});

const unique = (): string => crypto.randomUUID().slice(0, 8);

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
  const handle = `${name}-${unique()}`;
  const row = await db
    .insertInto('users')
    .values({ email: `${handle}@example.test`, username: handle, display_name: name })
    .returning('id')
    .executeTakeFirstOrThrow();
  const { token } = await issueSession(db, clock, row.id, 30);
  return { id: row.id, cookie: `purlay_session=${token}` };
};

/** Alice owns a workspace with one channel; Bob is a member who has joined it. */
const aRoom = async (): Promise<{ alice: string; bob: string; channelId: string }> => {
  const alice = await aUser('alice');
  const bob = await aUser('bob');
  const slug = `rt-${unique()}`;
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
  return { alice: alice.cookie, bob: bob.cookie, channelId };
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

const connect = async (cookie: string): Promise<Client> => {
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws`, {
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
      const there = await connect(`purlay_session=${otherDevice.token}`);
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
      const laptop = await connect(`purlay_session=${second.token}`);
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
      const socket = await connect(`purlay_session=${token}`);
      expect(await endedWith(socket, 'expired')).toMatchObject({ code: CLOSE_CODES.SESSION_ENDED });
    });
  });
});
