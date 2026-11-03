/**
 * Who is online is chat's (D-250, `MODULES.md` §3): its route is in chat's manifest, and what it tells is the
 * news a person's colleagues read in chat's lists. A process that does not run chat opens a socket for the core's
 * own business only — it counts nobody online, tells nobody, and hears none of chat's news published by a node that
 * does run it — and still carries the core's frames. Over real sockets, with a process that runs chat as the control.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { ServerFrame } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { compose } from '../composition';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { fixedClock } from '../platform/clock';
import { aManualTimers, testConfig, testDependencies } from '../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../testing/signed-in';
import { aUniqueSlug } from '../testing/users';
import { inProcessBackplane } from './bus';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const origin = 'https://purlay.test';
let cloned: ClonedDatabase;
let db: Executor;
const apps: HttpApplication[] = [];

// Each test opens sockets on two nodes and waits for frames that a grace timer and a backplane carry: seconds on a
// loaded runner, so the 5 s default is not its budget.
setDefaultTimeout(60_000);

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
}, CLONE_HOOK_MS);

afterAll(async () => {
  for (const app of apps) await app.stop(true);
  await cloned.drop();
}, DROP_HOOK_MS);

interface Node {
  readonly app: HttpApplication;
  readonly url: string;
  readonly timers: ReturnType<typeof aManualTimers>;
}

/** A process of its own over the shared database, on the backplane it is given (one cluster, or its own). */
const node = (running: 'chat' | 'none', backplane = inProcessBackplane()): Node => {
  const timers = aManualTimers();
  const app = createApp(
    testDependencies({
      database: db,
      clock,
      config: testConfig({ APP_URL: origin }),
      timers,
      backplane,
      ...(running === 'none' ? { composition: compose([]) } : {}),
    }),
  );
  apps.push(app);
  return { app, url: `ws://localhost:${String(app.listen(0))}/ws`, timers };
};

const http = async (
  at: Node,
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> =>
  await at.app.handle(
    new Request(`${origin}${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

/** Alice and Bob, members of one workspace. */
const aRoom = async (): Promise<{ alice: SignedInUser; bob: SignedInUser }> => {
  const alice = await aSignedInUser(db, clock, 'pr-a');
  const bob = await aSignedInUser(db, clock, 'pr-b');
  const slug = aUniqueSlug('pr');
  const created = await http(node('none'), 'POST', '/api/workspaces', alice.cookie, {
    name: slug,
    slug,
  });
  const workspaceId = ((await created.json()) as { id: string }).id;
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW })
    .execute();
  return { alice, bob };
};

interface Client {
  readonly frames: ServerFrame[];
  readonly until: (
    done: (frames: readonly ServerFrame[]) => boolean,
    what: string,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
}

const connect = async (at: Node, cookie: string): Promise<Client> => {
  const socket = new WebSocket(at.url, { headers: { cookie, origin } } as unknown as string[]);
  const ended = new Promise<void>((resolve) => {
    socket.addEventListener('close', () => {
      resolve();
    });
  });
  const frames: ServerFrame[] = [];
  socket.addEventListener('message', (event) => {
    const received: unknown = JSON.parse(String(event.data));
    if (Value.Check(ServerFrame, received)) frames.push(received);
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
  };
};

const presenceOf = (frames: readonly ServerFrame[], userId: string): boolean[] =>
  frames.flatMap((frame) =>
    frame.event === 'PRESENCE'
      ? frame.data.changes.filter((c) => c.userId === userId).map((c) => c.online)
      : [],
  );

/** A window in which anything that was going to be told would have arrived. */
const quiet = async (at: Node): Promise<void> => {
  await at.app.settled();
  await Bun.sleep(150);
};

describe('integration: the socket of a process that does not run chat, and who is online', () => {
  test('counts nobody online and tells nobody, on connect and on close', async () => {
    const { alice, bob } = await aRoom();
    const alone = node('none');
    const watching = await connect(alone, bob.cookie);
    const arriving = await connect(alone, alice.cookie);
    await quiet(alone);
    expect(alone.app.held()).toMatchObject({ connections: 2, online: 0, leaving: 0 });
    expect(watching.frames.filter((frame) => frame.event === 'PRESENCE')).toEqual([]);

    await arriving.close();
    await quiet(alone);
    expect(alone.timers.pending()).toBe(0);
    alone.timers.runAll();
    await quiet(alone);
    expect(watching.frames.filter((frame) => frame.event === 'PRESENCE')).toEqual([]);
    await watching.close();
  });

  test('a process that runs chat counts and tells as before: the control', async () => {
    const { alice, bob } = await aRoom();
    const chatting = node('chat');
    const watching = await connect(chatting, bob.cookie);
    const arriving = await connect(chatting, alice.cookie);
    await watching.until((f) => presenceOf(f, alice.userId).includes(true), 'alice online');
    expect(chatting.app.held()).toMatchObject({ connections: 2, online: 2 });
    await arriving.close();
    await watching.until(() => chatting.app.held().leaving === 1, 'alice inside her grace');
    chatting.timers.runAll();
    await watching.until((f) => presenceOf(f, alice.userId).includes(false), 'alice offline');
    await watching.close();
  });

  test('still carries the core’s own frames: a workspace change and the end of a session', async () => {
    const { alice, bob } = await aRoom();
    const alone = node('none');
    const watching = await connect(alone, bob.cookie);
    const changed = await http(alone, 'PATCH', '/api/me/profile', alice.cookie, {
      title: 'Captain',
    });
    expect(changed.ok).toBe(true);
    await watching.until((f) => f.some((frame) => frame.event === 'WORKSPACE_UPDATED'), 'update');
    const ended = await http(alone, 'DELETE', `/api/me/sessions/${bob.sessionId}`, alice.cookie);
    // Not alice's session to end: the real end is Bob's own.
    expect(ended.ok).toBe(false);
    const own = await http(alone, 'DELETE', `/api/me/sessions/${bob.sessionId}`, bob.cookie);
    expect(own.status).toBe(204);
    await watching.until((f) => f.some((frame) => frame.event === 'SESSION_ENDED'), 'session end');
    await watching.close();
  });

  test('hears none of the news a node that runs chat publishes to a person it holds', async () => {
    const { alice, bob } = await aRoom();
    const cluster = inProcessBackplane();
    const chatting = node('chat', cluster);
    const alone = node('none', cluster);
    const watching = await connect(alone, bob.cookie);
    const arriving = await connect(chatting, alice.cookie);
    await chatting.app.settled();
    await quiet(alone);
    expect(watching.frames.filter((frame) => frame.event === 'PRESENCE')).toEqual([]);
    // The control: the same publication reaches Bob where chat is run.
    const bobWithChat = await connect(chatting, bob.cookie);
    // The client sees the socket open before the node has finished holding it and listening on Bob's own topic: a
    // change published before that is not heard. Wait until the node holds both.
    await bobWithChat.until(() => chatting.app.held().connections === 2, 'both sockets held');
    await arriving.close();
    // The close is handled after the client has seen it end: wait until the node holds her in her grace, or the
    // timers are run before there is one.
    await bobWithChat.until(() => chatting.app.held().leaving === 1, 'alice inside her grace');
    chatting.timers.runAll();
    await bobWithChat.until((f) => presenceOf(f, alice.userId).includes(false), 'alice offline');
    await bobWithChat.close();
    await watching.close();
  });
});
