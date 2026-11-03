/**
 * The socket is a way in like any route (D-250, `MODULES.md` §3): a process that does not run chat answers chat's
 * operations as it answers an operation nobody has, writes nothing and tells nobody, and still answers the core's
 * (a ping). Over real sockets, with the same database behind a process that runs chat as the control.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { compose } from '../composition';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { fixedClock } from '../platform/clock';
import { testConfig, testDependencies } from '../testing/doubles';
import { aSignedInUser } from '../testing/signed-in';
import { aUniqueSlug } from '../testing/users';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const origin = 'https://purlay.test';
let cloned: ClonedDatabase;
let db: Executor;
let running: HttpApplication;
let notRunning: HttpApplication;
const urls = { running: '', notRunning: '' };

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
  const config = testConfig({ APP_URL: origin });
  running = createApp(testDependencies({ database: db, clock, config }));
  notRunning = createApp(
    testDependencies({ database: db, clock, config, composition: compose([]) }),
  );
  urls.running = `ws://localhost:${String(running.listen(0))}/ws`;
  urls.notRunning = `ws://localhost:${String(notRunning.listen(0))}/ws`;
}, CLONE_HOOK_MS);

afterAll(async () => {
  await running.stop(true);
  await notRunning.stop(true);
  await cloned.drop();
}, DROP_HOOK_MS);

const room = async (): Promise<{ cookie: string; channelId: string }> => {
  const alice = await aSignedInUser(db, clock, 'sock-off');
  const slug = aUniqueSlug('so');
  const workspace = await running.handle(
    new Request(`${origin}/api/workspaces`, {
      method: 'POST',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: slug, slug }),
    }),
  );
  const workspaceId = ((await workspace.json()) as { id: string }).id;
  const channel = await running.handle(
    new Request(`${origin}/api/workspaces/${workspaceId}/channels`, {
      method: 'POST',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ops' }),
    }),
  );
  return { cookie: alice.cookie, channelId: ((await channel.json()) as { id: string }).id };
};

/** Sends each frame on a fresh socket and answers what came back for each, by its id. */
const answers = async (
  url: string,
  cookie: string,
  frames: readonly { id: string; op: string; payload?: unknown }[],
): Promise<ServerFrame[]> => {
  const socket = new WebSocket(url, { headers: { cookie, origin } } as unknown as string[]);
  const seen: ServerFrame[] = [];
  socket.addEventListener('message', (event) => {
    seen.push(JSON.parse(String(event.data)) as ServerFrame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the socket did not open'));
    });
  });
  for (const frame of frames) socket.send(JSON.stringify(frame));
  const deadline = Date.now() + 5_000;
  while (
    !frames.every((frame) => seen.some((answer) => answer.refId === frame.id)) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  socket.close();
  return seen.filter((answer) => frames.some((frame) => frame.id === answer.refId));
};

const messagesIn = async (channelId: string): Promise<number> =>
  (await db.selectFrom('messages').select('id').where('channel_id', '=', channelId).execute())
    .length;

describe('integration: the socket of a process that does not run chat', () => {
  test('answers chat’s operations as an operation nobody has, writes nothing, and still answers a ping', async () => {
    const { cookie, channelId } = await room();
    const [subscribe, send, typing, ping] = [1, 2, 3, 4].map(() => messageId(NOW));
    const replies = await answers(urls.notRunning, cookie, [
      {
        id: subscribe!,
        op: 'SUBSCRIBE',
        payload: { channels: [{ channelId, afterMessageId: null }] },
      },
      { id: send!, op: 'MESSAGE_SEND', payload: { channelId, content: 'written with chat off' } },
      { id: typing!, op: 'TYPING', payload: { channelId } },
      { id: ping!, op: 'PING', payload: {} },
    ]);
    const by = (id: string | undefined): ServerFrame | undefined =>
      replies.find((reply) => reply.refId === id);
    for (const id of [subscribe, send, typing]) {
      expect(by(id)).toMatchObject({
        event: 'ERROR',
        data: {
          code: 'VALIDATION_FAILED',
          details: { fields: { op: 'is not an operation this server accepts' } },
        },
      });
    }
    expect(by(ping)?.event).toBe('PONG');
    expect(await messagesIn(channelId)).toBe(0);
  });

  test('a process that runs chat takes the same frames: the control that makes the test above mean something', async () => {
    const { cookie, channelId } = await room();
    const send = messageId(NOW);
    const replies = await answers(urls.running, cookie, [
      { id: send, op: 'MESSAGE_SEND', payload: { channelId, content: 'written with chat on' } },
    ]);
    expect(replies.some((reply) => reply.event === 'ERROR')).toBe(false);
    expect(await messagesIn(channelId)).toBe(1);
  });
});
