/**
 * Phase 0's exit criterion, the server's half: a message sent in real time is
 * still there after the API restarts (`PRD.md` §4).
 *
 * A restart, as near as a test gets to one: the first application has a pool of
 * its own, takes the message over a real socket, drains and closes its pool; a
 * second application starts with a new pool on the same database. The message
 * must be in history, and in the replay a reconnecting client asks for.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, createDatabase, type ClonedDatabase } from '@purlay/db';
import { CLOSE_CODES, messageId, type ServerFrame } from '@purlay/types';
import { createApp } from '../ingress/http/app';
import { aSignedInUser } from '../testing/signed-in';
import { testConfig, testDependencies } from '../testing/doubles';
import { fixedClock } from '../platform/clock';
import { aUniqueSlug } from '../testing/users';

const origin = 'https://purlay.test';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});

afterAll(async () => {
  await cloned.drop();
});

/** An API process: its own pool, its own listener. */
const aProcess = (): {
  app: ReturnType<typeof createApp>;
  server: string;
  stop: () => Promise<void>;
} => {
  const database = createDatabase({ connectionString: cloned.connectionString, poolSize: 2 });
  const app = createApp(
    testDependencies({ database, clock, config: testConfig({ APP_URL: origin }) }),
  );
  const server = `http://localhost:${String(app.listen(0))}`;
  return {
    app,
    server,
    stop: async (): Promise<void> => {
      await app.drain();
      await database.destroy();
    },
  };
};

/** Opens a socket, sends frames, and collects what comes back until `done`. */
const converse = async (
  server: string,
  cookie: string,
  frames: readonly unknown[],
  done: (received: readonly ServerFrame[]) => boolean,
): Promise<{ received: ServerFrame[]; closed: Promise<number> }> => {
  const socket = new WebSocket(`${server.replace('http', 'ws')}/ws`, {
    headers: { cookie, origin },
  } as unknown as string[]);
  const received: ServerFrame[] = [];
  socket.addEventListener('message', (event) => {
    received.push(JSON.parse(String(event.data)) as ServerFrame);
  });
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => {
      resolve(event.code);
    });
  });
  await new Promise<void>((resolve) => {
    socket.addEventListener('open', () => {
      resolve();
    });
  });
  for (const frame of frames) socket.send(JSON.stringify(frame));
  const deadline = performance.now() + 5_000;
  while (!done(received)) {
    if (performance.now() > deadline) throw new Error(`no answer; saw ${JSON.stringify(received)}`);
    await Bun.sleep(10);
  }
  return { received, closed };
};

describe('integration: a restart', () => {
  test('a message sent in real time is still there after the API restarts', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'restart');
    const slug = aUniqueSlug('restart');
    const workspace = await cloned.db
      .insertInto('workspaces')
      .values({ name: slug, slug })
      .returning('id')
      .executeTakeFirstOrThrow();
    await cloned.db
      .insertInto('workspace_members')
      .values({ workspace_id: workspace.id, user_id: alice.userId, role: 'owner', joined_at: NOW })
      .execute();
    const channel = await cloned.db
      .insertInto('channels')
      .values({
        workspace_id: workspace.id,
        name: 'general',
        type: 'public',
        created_by: alice.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await cloned.db
      .insertInto('channel_members')
      .values({ channel_id: channel.id, user_id: alice.userId })
      .execute();

    // The first process takes the message over a socket.
    const first = aProcess();
    const sent = messageId(NOW);
    const { closed } = await converse(
      first.server,
      alice.cookie,
      [{ id: sent, op: 'MESSAGE_SEND', payload: { channelId: channel.id, content: 'survives' } }],
      (received) => received.some((frame) => frame.event === 'ACK' && frame.refId === sent),
    );
    await first.stop();
    expect(await closed).toBe(CLOSE_CODES.RESTARTING);

    // A second process, with a pool that has never seen it.
    const second = aProcess();
    const history = await fetch(`${second.server}/api/channels/${channel.id}/messages`, {
      headers: { cookie: alice.cookie },
    });
    expect(history.status).toBe(200);
    expect(((await history.json()) as { data: { id: string; content: string }[] }).data).toEqual([
      expect.objectContaining({ id: sent, content: 'survives' }),
    ] as unknown as { id: string; content: string }[]);

    // And the client that reconnects is replayed it.
    const subscribe = messageId(NOW);
    const replay = await converse(
      second.server,
      alice.cookie,
      [
        {
          id: subscribe,
          op: 'SUBSCRIBE',
          payload: {
            channels: [
              { channelId: channel.id, afterMessageId: messageId(new Date(NOW.getTime() - 1)) },
            ],
          },
        },
      ],
      (received) =>
        received.some(
          (frame) =>
            frame.event === 'MESSAGE_CREATED' && (frame.data as { id: string }).id === sent,
        ),
    );
    expect(replay.received.some((frame) => frame.refId === subscribe)).toBe(true);
    await second.stop();
  });
});
