/**
 * Replies, resolution and read counters, heard on real sockets (D-99 §2, §5).
 *
 * `threads.integration.test.ts` proves the rules and `sockets.integration.test.ts`
 * proves the transport; this proves what only both together decide: that a reply sent
 * over one socket reaches the room and the right *person* in the right order, that an
 * HTTP resolution is heard on a socket (two doors into one service), and that a
 * person's own numbers travel on their own topic and nobody else's.
 *
 * The database is a clone of its own and writes commit (D-46).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { messageId, ServerFrame } from '@purlay/types';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { testConfig, testDependencies } from '../testing/doubles';
import { fixedClock } from '../platform/clock';
import { aSignedInUser } from '../testing/signed-in';
import { aUniqueSlug } from '../testing/users';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const origin = 'https://purlay.test';
let cloned: ClonedDatabase;
let db: Executor;
let app: HttpApplication;
let server = '';

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
  app = createApp(
    testDependencies({ database: db, clock, config: testConfig({ APP_URL: origin }) }),
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
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const aUser = async (name: string): Promise<{ id: string; cookie: string }> => {
  const user = await aSignedInUser(db, clock, name);
  return { id: user.userId, cookie: user.cookie };
};

/** Alice owns a workspace with a channel; Bob and Carol are members who have joined it. */
const aRoom = async (): Promise<{
  alice: { id: string; cookie: string };
  bob: { id: string; cookie: string };
  carol: { id: string; cookie: string };
  workspaceId: string;
  channelId: string;
}> => {
  const alice = await aUser('wa');
  const bob = await aUser('wb');
  const carol = await aUser('wc');
  const slug = aUniqueSlug('wd');
  const workspace = await http('POST', '/api/workspaces', alice.cookie, { name: slug, slug });
  const workspaceId = ((await workspace.json()) as { id: string }).id;
  await db
    .insertInto('workspace_members')
    .values(
      [bob, carol].map((user) => ({
        workspace_id: workspaceId,
        user_id: user.id,
        role: 'member' as const,
        joined_at: NOW,
      })),
    )
    .execute();
  const channel = await http('POST', `/api/workspaces/${workspaceId}/channels`, alice.cookie, {
    name: 'general',
  });
  const channelId = ((await channel.json()) as { id: string }).id;
  for (const user of [bob, carol]) {
    expect((await http('POST', `/api/channels/${channelId}/join`, user.cookie)).ok).toBe(true);
  }
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
}

const connect = async (cookie: string): Promise<Client> => {
  const socket = new WebSocket(`${server.replace('http', 'ws')}/ws`, {
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
  return {
    frames,
    send: (frame): void => {
      socket.send(JSON.stringify(frame));
    },
    until: async (done, what): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!done(frames)) {
        expect(outsideContract).toEqual([]);
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${what}; saw ${JSON.stringify(frames.map((f) => f.event))}`,
          );
        }
        await Bun.sleep(10);
      }
    },
    close: async (): Promise<void> => {
      expect(outsideContract).toEqual([]);
      socket.close();
      await ended;
    },
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
    'the subscription to be acknowledged',
  );
};

const sendFrame = (
  client: Client,
  channelId: string,
  content: string,
  parentId?: string,
  id = messageId(NOW),
): string => {
  client.send({
    id,
    op: 'MESSAGE_SEND',
    payload: { channelId, content, ...(parentId === undefined ? {} : { parentId }) },
  });
  return id;
};

const events = (client: Client): string[] => client.frames.map((f) => f.event);

describe('integration: a reply on real sockets', () => {
  test('the room hears the message and the thread, the root’s author hears their own numbers last', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice.cookie);
    const bob = await connect(room.bob.cookie);
    const carol = await connect(room.carol.cookie);
    for (const client of [alice, bob, carol]) await subscribe(client, room.channelId);

    const root = sendFrame(alice, room.channelId, 'why is the backoff 4s?');
    await carol.until(
      (frames) => frames.some((f) => f.event === 'CHANNEL_STATE'),
      'the unread count',
    );
    expect(carol.frames.find((f) => f.event === 'CHANNEL_STATE')?.data).toMatchObject({
      channelId: room.channelId,
      state: { unreadCount: 1, unreadMentionCount: 0 },
    });
    // Nobody else's numbers: Alice sent it, and hears none.
    expect(events(alice)).not.toContain('CHANNEL_STATE');
    // Everything her own send brings her has arrived before the mark: her ACK and her echo. Taken
    // without this, a loaded machine delivered the ACK after it, and the order below began with it.
    await alice.until(
      (frames) =>
        frames.some((f) => f.event === 'ACK' && f.refId === root) &&
        frames.some((f) => f.event === 'MESSAGE_CREATED' && f.data.id === root),
      'Alice’s own send acknowledged and echoed',
    );

    const before = alice.frames.length;
    const reply = sendFrame(bob, room.channelId, 'upstream rate-limits at 15/min', root);
    await alice.until(
      (frames) => frames.slice(before).some((f) => f.event === 'NOTIFICATIONS_UPDATED'),
      'Alice’s inbox',
    );

    // The order D-99 §2 promises: the message, then what moved under it, then the numbers — and
    // then her inbox, which has the reply (D-106).
    const heard = alice.frames.slice(before).map((f) => f.event);
    expect(heard).toEqual([
      'MESSAGE_CREATED',
      'THREAD_UPDATED',
      'CHANNEL_STATE',
      'NOTIFICATIONS_UPDATED',
    ]);
    const [created, updated, state] = alice.frames.slice(before);
    expect(created?.data).toMatchObject({ id: reply, parentId: root, thread: null });
    expect(updated?.data).toMatchObject({
      channelId: room.channelId,
      messageId: root,
      thread: { replyCount: 1, resolvedAt: null },
    });
    // The author of the thread is told it was answered: that is a mention-class event (D-29).
    expect(state?.data).toMatchObject({ state: { unreadCount: 1, unreadMentionCount: 1 } });

    // Carol only joined the channel: she hears the room, and that one more message is unread.
    await carol.until(
      (frames) => frames.filter((f) => f.event === 'CHANNEL_STATE').length === 2,
      'Carol’s second count',
    );
    expect(carol.frames.filter((f) => f.event === 'CHANNEL_STATE').at(-1)?.data).toMatchObject({
      state: { unreadCount: 2, unreadMentionCount: 0 },
    });

    for (const client of [alice, bob, carol]) await client.close();
  });

  test('a resend of the same reply is acknowledged and counts nothing twice', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice.cookie);
    const bob = await connect(room.bob.cookie);
    await subscribe(alice, room.channelId);
    await subscribe(bob, room.channelId);
    const root = sendFrame(alice, room.channelId, 'q');
    await bob.until((frames) => frames.some((f) => f.event === 'MESSAGE_CREATED'), 'the root');

    const id = messageId(NOW);
    sendFrame(bob, room.channelId, 'a', root, id);
    sendFrame(bob, room.channelId, 'a', root, id);
    await bob.until(
      (frames) => frames.filter((f) => f.event === 'ACK' && f.refId === id).length === 2,
      'two ACKs',
    );
    // Let any stray frame arrive before counting.
    await Bun.sleep(100);

    const counted = await db
      .selectFrom('channel_members')
      .select(['unread_count', 'unread_mention_count'])
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', room.alice.id)
      .executeTakeFirstOrThrow();
    expect(counted).toEqual({ unread_count: 1, unread_mention_count: 1 });
    // The retry tells Alice her numbers again, from the row (H-API 4) — the same numbers.
    const states = alice.frames.flatMap((f) => (f.event === 'CHANNEL_STATE' ? [f.data.state] : []));
    expect(states).toHaveLength(2);
    for (const state of states)
      expect(state).toMatchObject({ unreadCount: 1, unreadMentionCount: 1 });

    await alice.close();
    await bob.close();
  });

  test('a reply under a reply, and @here, come back as ERROR frames carrying the request’s id', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice.cookie);
    await subscribe(alice, room.channelId);
    const root = sendFrame(alice, room.channelId, 'q');
    await alice.until((frames) => frames.some((f) => f.event === 'MESSAGE_CREATED'), 'the root');
    const reply = sendFrame(alice, room.channelId, 'a', root);
    await alice.until(
      (frames) => frames.some((f) => f.event === 'ACK' && f.refId === reply),
      'the reply ACK',
    );

    const deeper = sendFrame(alice, room.channelId, 'deeper', reply);
    const broadcast = sendFrame(alice, room.channelId, 'hey @here');
    const orphan = sendFrame(alice, room.channelId, 'x', messageId(NOW));
    await alice.until(
      (frames) =>
        [deeper, broadcast, orphan].every((id) =>
          frames.some((f) => f.event === 'ERROR' && f.refId === id),
        ),
      'three refusals',
    );
    const codeOf = (id: string): unknown =>
      alice.frames.find((f) => f.event === 'ERROR' && f.refId === id)?.data;
    expect(codeOf(deeper)).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(codeOf(broadcast)).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(codeOf(orphan)).toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
    await alice.close();
  });
});

describe('integration: a resolution over HTTP, heard on a socket', () => {
  test('the room hears the thread close and reopen, and nothing when it was already so', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice.cookie);
    const bob = await connect(room.bob.cookie);
    await subscribe(alice, room.channelId);
    await subscribe(bob, room.channelId);
    const root = sendFrame(alice, room.channelId, 'q');
    // The root has to be committed before anybody can answer it: two sockets are two
    // transactions, and a reply sent on the sight of nothing is a reply to nothing.
    await bob.until((frames) => frames.some((f) => f.event === 'MESSAGE_CREATED'), 'the root');
    sendFrame(bob, room.channelId, 'a', root);
    await alice.until(
      (frames) => frames.filter((f) => f.event === 'MESSAGE_CREATED').length === 2,
      'both messages',
    );
    await alice.until(
      (frames) =>
        frames.some((f) => f.event === 'THREAD_UPDATED') &&
        frames.some((f) => f.event === 'NOTIFICATIONS_UPDATED'),
      'the reply’s summary, and the reply in her inbox',
    );
    const settled = alice.frames.length;

    expect((await http('POST', `/api/messages/${root}/resolve`, room.bob.cookie)).status).toBe(200);
    await alice.until((frames) => frames.length > settled, 'the resolution');
    expect(alice.frames[settled]).toMatchObject({
      event: 'THREAD_UPDATED',
      data: { messageId: root, thread: { resolvedBy: { id: room.bob.id } } },
    });
    // She asked it and Bob closed it: her inbox has it, after the room heard it (D-106).
    await alice.until((frames) => frames.length > settled + 1, 'her inbox');
    expect(alice.frames[settled + 1]).toMatchObject({
      event: 'NOTIFICATIONS_UPDATED',
      data: { workspaceId: room.workspaceId },
    });

    // Closing it again changes nothing, so nothing is said.
    expect((await http('POST', `/api/messages/${root}/resolve`, room.alice.cookie)).status).toBe(
      200,
    );
    expect((await http('DELETE', `/api/messages/${root}/resolve`, room.alice.cookie)).status).toBe(
      200,
    );
    await alice.until((frames) => frames.length > settled + 2, 'the reopening');
    expect(alice.frames[settled + 2]).toMatchObject({
      event: 'THREAD_UPDATED',
      data: { thread: { resolvedAt: null, resolvedBy: null } },
    });
    expect(alice.frames).toHaveLength(settled + 3);

    await alice.close();
    await bob.close();
  });
});
