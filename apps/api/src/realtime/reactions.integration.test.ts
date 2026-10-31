/**
 * Reactions heard on real sockets: an action over HTTP reaches the other clients
 * over their sockets identically (`API.md` §5), and reaches nobody who may not see
 * the channel.
 *
 * Its own cloned database and a real listener, as `sockets.integration.test.ts`:
 * the commit and the delivery race each other, which one transaction cannot show.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
} from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { messageId, ServerFrame } from '@purlay/types';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { fixedClock } from '../platform/clock';
import { aRecordingLogger, NOW, testConfig, testDependencies } from '../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../testing/signed-in';
import { aUniqueSlug } from '../testing/users';

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
    testDependencies({
      database: db,
      clock,
      config: testConfig({ APP_URL: origin }),
      log: aRecordingLogger().log,
    }),
  );
  server = `http://localhost:${String(app.listen(0))}`;
}, CLONE_HOOK_MS);

afterAll(async () => {
  await app.stop(true);
  await cloned.drop();
});

const react = async (
  method: 'PUT' | 'DELETE',
  who: SignedInUser,
  message: string,
  emoji: string,
): Promise<Response> =>
  await app.handle(
    new Request(`${origin}/api/messages/${message}/reactions/${encodeURIComponent(emoji)}`, {
      method,
      headers: { cookie: who.cookie },
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
}

const connect = async (who: SignedInUser): Promise<Client> => {
  const socket = new WebSocket(`${server.replace('http', 'ws')}/ws`, {
    headers: { cookie: who.cookie, origin },
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

/** Subscribes, and waits for the answer to *that* frame; returns it. */
const subscribe = async (client: Client, channelId: string): Promise<ServerFrame> => {
  const id = messageId(NOW);
  client.send({
    id,
    op: 'SUBSCRIBE',
    payload: { channels: [{ channelId, afterMessageId: null }] },
  });
  await client.until((frames) => frames.some((f) => f.refId === id), 'the answer to SUBSCRIBE');
  const answer = client.frames.find((f) => f.refId === id);
  if (answer === undefined) throw new Error('no answer');
  return answer;
};

const updates = (frames: readonly ServerFrame[], messageIdOf: string): ServerFrame[] =>
  frames.filter((f) => f.event === 'REACTIONS_UPDATED' && f.data.messageId === messageIdOf);

interface World {
  readonly alice: SignedInUser;
  readonly bob: SignedInUser;
  readonly carol: SignedInUser;
  readonly publicChannel: string;
  readonly privateChannel: string;
  readonly publicMessage: string;
  readonly privateMessage: string;
}

/**
 * Alice and Bob are in a public channel and a private one; Carol is in the same
 * workspace, in the public one only.
 */
const aWorld = async (): Promise<World> => {
  const alice = await aSignedInUser(db, clock, 'rxs-alice');
  const bob = await aSignedInUser(db, clock, 'rxs-bob');
  const carol = await aSignedInUser(db, clock, 'rxs-carol');
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'rxs', slug: aUniqueSlug('rxs') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_members')
    .values(
      [alice, bob, carol].map((who) => ({
        workspace_id: workspace.id,
        user_id: who.userId,
        role: 'member' as const,
      })),
    )
    .execute();
  const channel = async (
    type: 'public' | 'private',
    name: string,
    members: SignedInUser[],
  ): Promise<{ channelId: string; messageId: string }> => {
    const row = await db
      .insertInto('channels')
      .values({ workspace_id: workspace.id, name, type })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('channel_members')
      .values(members.map((who) => ({ channel_id: row.id, user_id: who.userId })))
      .execute();
    const id = messageId(NOW);
    await db
      .insertInto('messages')
      .values({
        id,
        workspace_id: workspace.id,
        channel_id: row.id,
        sender_id: alice.userId,
        content: `a message in ${name}`,
      })
      .execute();
    return { channelId: row.id, messageId: id };
  };
  const open = await channel('public', 'general', [alice, bob, carol]);
  const closed = await channel('private', 'leadership', [alice, bob]);
  return {
    alice,
    bob,
    carol,
    publicChannel: open.channelId,
    privateChannel: closed.channelId,
    publicMessage: open.messageId,
    privateMessage: closed.messageId,
  };
};

describe('integration: reactions on the socket', () => {
  test('the other socket hears the whole set; a repeat of the same reaction is not heard at all', async () => {
    const world = await aWorld();
    const alice = await connect(world.alice);
    const bob = await connect(world.bob);
    await subscribe(alice, world.publicChannel);
    await subscribe(bob, world.publicChannel);

    expect((await react('PUT', world.alice, world.publicMessage, '👍')).status).toBe(200);
    // Doing it again changed nothing, so it says nothing: the next thing Bob hears
    // after the first update must be the removal, not a repeat.
    expect((await react('PUT', world.alice, world.publicMessage, '👍')).status).toBe(200);
    expect((await react('DELETE', world.alice, world.publicMessage, '👍')).status).toBe(200);
    await bob.until(
      (frames) => frames.filter((f) => f.event === 'REACTIONS_UPDATED').length >= 2,
      'both changes to reach the other socket',
    );

    const heard = updates(bob.frames, world.publicMessage).map((frame) => frame.data);
    expect(heard).toEqual([
      {
        channelId: world.publicChannel,
        messageId: world.publicMessage,
        reactions: [{ emoji: '👍', userIds: [world.alice.userId] }],
      },
      { channelId: world.publicChannel, messageId: world.publicMessage, reactions: [] },
    ]);
    // The person who reacted is in the room too, and hears what the room hears.
    await alice.until(
      (frames) => frames.filter((f) => f.event === 'REACTIONS_UPDATED').length >= 2,
      'the sender to hear both changes',
    );
    await alice.close();
    await bob.close();
  });

  test('a member of the workspace who cannot see a private channel neither hears it nor can subscribe to it', async () => {
    const world = await aWorld();
    const bob = await connect(world.bob);
    const carol = await connect(world.carol);
    await subscribe(bob, world.privateChannel);
    await subscribe(bob, world.publicChannel);
    await subscribe(carol, world.publicChannel);

    const refused = await subscribe(carol, world.privateChannel);
    expect(refused.event).toBe('ERROR');

    expect((await react('PUT', world.alice, world.privateMessage, '👍')).status).toBe(200);
    await bob.until(
      (frames) => updates(frames, world.privateMessage).length === 1,
      'the private reaction to reach a member',
    );
    // A positive marker for Carol: once she has heard the public one, which was
    // published after the private one, the private one has had every chance to arrive.
    expect((await react('PUT', world.alice, world.publicMessage, '🎉')).status).toBe(200);
    await carol.until(
      (frames) => updates(frames, world.publicMessage).length === 1,
      'the public reaction to reach Carol',
    );

    expect(updates(carol.frames, world.privateMessage)).toEqual([]);
    expect(JSON.stringify(carol.frames)).not.toContain(world.privateMessage);
    await bob.close();
    await carol.close();
  });

  test('somebody who cannot see the message cannot react to it, and the room hears nothing of the attempt', async () => {
    const world = await aWorld();
    const bob = await connect(world.bob);
    await subscribe(bob, world.privateChannel);

    const refusal = await react('PUT', world.carol, world.privateMessage, '👍');
    expect(refusal.status).toBe(404);
    expect(await react('PUT', world.alice, world.privateMessage, '🔥')).toHaveProperty(
      'status',
      200,
    );
    await bob.until(
      (frames) => frames.some((f) => f.event === 'REACTIONS_UPDATED'),
      'the real reaction to arrive',
    );
    // Only the real one: Carol's refused attempt published nothing.
    expect(updates(bob.frames, world.privateMessage)).toHaveLength(1);
    await bob.close();
  });
});
