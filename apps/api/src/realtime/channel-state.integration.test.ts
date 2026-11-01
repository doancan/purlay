/**
 * What the wedge tells the sockets, through real ones on two nodes (D-98, D-99).
 *
 * The change is made over HTTP on node A and heard on node B, which is what two
 * nodes behind a balancer are. Two things are asserted for each: that the people it
 * is for hear it, and that the people it is not for do not — what is true for one
 * person (their read position, a conversation opened with them) is published on
 * their own topic and must not be audible to the room.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { ServerFrame as ServerFrameSchema } from '@purlay/types';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { aSignedInUser, type SignedInUser } from '../testing/signed-in';
import { testConfig, testDependencies } from '../testing/doubles';
import { fixedClock } from '../platform/clock';
import { aUniqueSlug } from '../testing/users';
import { inProcessBackplane } from './bus';

const origin = 'https://purlay.test';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

let cloned: ClonedDatabase;
let nodeA: HttpApplication;
let nodeB: HttpApplication;
let portB = 0;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  const backplane = inProcessBackplane();
  const config = testConfig({ APP_URL: origin });
  nodeA = createApp(testDependencies({ database: cloned.db, clock, config, backplane }));
  nodeB = createApp(testDependencies({ database: cloned.db, clock, config, backplane }));
  portB = nodeB.listen(0);
}, CLONE_HOOK_MS);

afterAll(async () => {
  await nodeB.stop(true);
  await cloned.drop();
}, DROP_HOOK_MS);

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
  readonly carol: SignedInUser;
  readonly workspaceId: string;
  readonly channelId: string;
}

/** Alice owns a workspace and a channel; Bob and Carol are members of both. */
const aRoom = async (): Promise<Room> => {
  const alice = await aSignedInUser(cloned.db, clock, 'alice');
  const bob = await aSignedInUser(cloned.db, clock, 'bob');
  const carol = await aSignedInUser(cloned.db, clock, 'carol');
  const slug = aUniqueSlug('rev');
  const workspaceId = (
    (await (await http('POST', '/api/workspaces', alice.cookie, { name: slug, slug })).json()) as {
      id: string;
    }
  ).id;
  await cloned.db
    .insertInto('workspace_members')
    .values([
      { workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW },
      { workspace_id: workspaceId, user_id: carol.userId, role: 'member', joined_at: NOW },
    ])
    .execute();
  const channelId = (
    (await (
      await http('POST', `/api/workspaces/${workspaceId}/channels`, alice.cookie, {
        name: 'ops',
      })
    ).json()) as { id: string }
  ).id;
  expect((await http('POST', `/api/channels/${channelId}/join`, bob.cookie)).ok).toBe(true);
  return { alice, bob, carol, workspaceId, channelId };
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

/** The states that say the person has read up to `id` — not the ones a send produced on the way. */
const readStates = (client: Client, id: string): ServerFrame[] =>
  frames(client, 'CHANNEL_STATE').filter((f) => f.data.state.lastReadMessageId === id);

const frames = <E extends ServerFrame['event']>(
  client: Client,
  event: E,
): Extract<ServerFrame, { event: E }>[] =>
  client.frames.filter((f): f is Extract<ServerFrame, { event: E }> => f.event === event);

describe('integration: read state follows the person across their devices', () => {
  test('reading on one device tells every socket the person holds, and nobody else', async () => {
    const room = await aRoom();
    const laptop = await connect(room.alice.cookie);
    const phone = await connect(room.alice.cookie);
    const bob = await connect(room.bob.cookie);
    const sent = await post(room.bob.cookie, room.channelId, 1);

    const read = await http('PUT', `/api/channels/${room.channelId}/read`, room.alice.cookie, {
      lastReadMessageId: sent,
    });
    expect(read.status).toBe(200);

    for (const device of [laptop, phone]) {
      await device.until(
        (all) =>
          all.some((f) => f.event === 'CHANNEL_STATE' && f.data.state.lastReadMessageId === sent),
        'the new state',
      );
      // Bob's send already told Alice's devices her unread count rose (D-99 §2); the read is the next.
      expect(readStates(device, sent)[0]?.data).toEqual({
        channelId: room.channelId,
        state: { lastReadMessageId: sent, unreadCount: 0, unreadMentionCount: 0 },
      });
    }
    await settle(bob);
    expect(frames(bob, 'CHANNEL_STATE')).toHaveLength(0);
    for (const client of [laptop, phone, bob]) await client.close();
  });

  /**
   * A repeated read is usually a retry of one whose answer — or whose frame — was lost, so it
   * tells the caller's devices where they stand, from the row. The same position, the same
   * numbers, on the caller's own topic: nobody else hears it (H-API 4).
   */
  test('a position that did not move tells the caller again, and nobody else', async () => {
    const room = await aRoom();
    const laptop = await connect(room.alice.cookie);
    const sent = await post(room.bob.cookie, room.channelId, 2);
    const path = `/api/channels/${room.channelId}/read`;
    await http('PUT', path, room.alice.cookie, { lastReadMessageId: sent });
    await laptop.until(
      (all) =>
        all.some((f) => f.event === 'CHANNEL_STATE' && f.data.state.lastReadMessageId === sent),
      'the first state',
    );

    const again = await http('PUT', path, room.alice.cookie, { lastReadMessageId: sent });
    expect(again.status).toBe(200);
    await settle(laptop);
    const states = readStates(laptop, sent);
    expect(states).toHaveLength(2);
    expect(states[1]?.data).toEqual(states[0]?.data);
    await laptop.close();
  });
});

describe('integration: a direct message appears for the other person', () => {
  test('only they are told, once, and it is deliverable and closed to everyone else', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice.cookie);
    const bob = await connect(room.bob.cookie);
    const carol = await connect(room.carol.cookie);

    const open = await http('POST', `/api/workspaces/${room.workspaceId}/dms`, room.alice.cookie, {
      userId: room.bob.userId,
    });
    expect(open.status).toBe(201);
    const dm = (await open.json()) as { id: string };

    await bob.until((all) => all.some((f) => f.event === 'CHANNEL_ADDED'), 'the new conversation');
    const added = frames(bob, 'CHANNEL_ADDED')[0]?.data;
    expect(added).toMatchObject({ id: dm.id, type: 'direct_message', name: null });
    expect(added?.peer?.id).toBe(room.alice.userId);
    expect(added?.state).toEqual({
      lastReadMessageId: null,
      unreadCount: 0,
      unreadMentionCount: 0,
    });

    // Opening it again is the same channel, answered 200, and is not announced again.
    const again = await http('POST', `/api/workspaces/${room.workspaceId}/dms`, room.alice.cookie, {
      userId: room.bob.userId,
    });
    expect([again.status, ((await again.json()) as { id: string }).id]).toEqual([200, dm.id]);
    for (const client of [alice, bob, carol]) await settle(client);
    expect(frames(bob, 'CHANNEL_ADDED')).toHaveLength(1);
    expect(frames(alice, 'CHANNEL_ADDED')).toHaveLength(0);
    expect(frames(carol, 'CHANNEL_ADDED')).toHaveLength(0);

    // Bob can subscribe to it and hears what Alice says there; Carol, who is in the
    // workspace and not in the conversation, is refused as for a channel that is not there.
    await subscribe(bob, dm.id);
    const sent = await post(room.alice.cookie, dm.id, 3);
    await bob.until((all) => created(all).includes(sent), 'the message in the conversation');

    const asked = messageId(new Date(NOW.getTime() + 4));
    carol.send({
      id: asked,
      op: 'SUBSCRIBE',
      payload: { channels: [{ channelId: dm.id, afterMessageId: null }] },
    });
    await carol.until((all) => all.some((f) => f.refId === asked), 'Carol to be answered');
    const refusal = carol.frames.find((f) => f.refId === asked);
    expect(refusal).toMatchObject({ event: 'ERROR', data: { code: 'CHANNEL_NOT_FOUND' } });
    await settle(carol);
    expect(created(carol.frames)).toEqual([]);
    for (const client of [alice, bob, carol]) await client.close();
  });
});

describe('integration: a new notification tells the person’s devices, whatever its kind (D-106)', () => {
  const told = (frames: readonly ServerFrame[]): ServerFrame[] =>
    frames.filter((f) => f.event === 'NOTIFICATIONS_UPDATED');

  const say = async (
    cookie: string,
    channelId: string,
    at: number,
    content: string,
    parentId?: string,
  ): Promise<string> => {
    const id = messageId(new Date(NOW.getTime() + at));
    const answer = await http('POST', `/api/channels/${channelId}/messages`, cookie, {
      id,
      content,
      ...(parentId === undefined ? {} : { parentId }),
    });
    expect(answer.status).toBe(201);
    return id;
  };

  test('a mention tells the person named, member of the channel or not, and nobody else', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice.cookie);
    const bob = await connect(room.bob.cookie);
    const carol = await connect(room.carol.cookie);

    // Bob is in the channel; Carol is in the workspace only, so no counter of hers moves for it.
    await say(
      room.alice.cookie,
      room.channelId,
      10,
      `@${room.bob.username} @${room.carol.username}`,
    );
    for (const person of [bob, carol]) {
      await person.until((all) => told(all).length > 0, 'the inbox to be told');
      await settle(person);
      // Once, for the one message, whoever else it named.
      expect(told(person.frames).map((frame) => frame.data)).toEqual([
        { workspaceId: room.workspaceId },
      ]);
    }
    expect(frames(carol, 'CHANNEL_STATE')).toEqual([]);
    await settle(alice);
    expect(told(alice.frames)).toEqual([]);
    for (const client of [alice, bob, carol]) await client.close();
  });

  test('a resolution tells the person who asked, though no counter moves for it', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice.cookie);
    const bob = await connect(room.bob.cookie);
    const root = await say(room.alice.cookie, room.channelId, 20, 'a question');
    // Bob's answer is a `thread_reply` for Alice: the first time she is told.
    await say(room.bob.cookie, room.channelId, 21, 'an answer', root);
    await alice.until((all) => told(all).length === 1, 'the reply');
    const states = frames(alice, 'CHANNEL_STATE').length;

    const resolved = await http('POST', `/api/messages/${root}/resolve`, room.bob.cookie);
    expect(resolved.status).toBe(200);
    await alice.until((all) => told(all).length === 2, 'the resolution');
    expect(told(alice.frames)[1]).toMatchObject({ data: { workspaceId: room.workspaceId } });
    // Nothing else told her: a resolution is not a message and moves none of her numbers (D-99 §1).
    await settle(alice);
    expect(frames(alice, 'CHANNEL_STATE')).toHaveLength(states);
    // The one who resolved it is told nothing of it.
    await settle(bob);
    expect(told(bob.frames)).toEqual([]);
    for (const client of [alice, bob]) await client.close();
  });
});
