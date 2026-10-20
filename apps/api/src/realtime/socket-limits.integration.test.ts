/**
 * What one user, and one node, may hold open and write through the socket door.
 *
 * The frame budget is per connection, so before these a user with a hundred
 * sockets had a hundred budgets (100 sockets × 20 sends were all acknowledged in
 * about eight seconds, against HTTP's ten a second for the same person), and each
 * socket that stopped reading cost 4 MB before it was closed (D-84, amended).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase } from '@purlay/db';
import { CLOSE_CODES, messageId, type ServerFrame } from '@purlay/types';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { aSignedInUser, type SignedInUser } from '../testing/signed-in';
import { testConfig, testDependencies } from '../testing/doubles';
import { fixedClock } from '../platform/clock';
import { AUTH_BUDGET, COSTLY_READ_BUDGET, WRITE_BUDGET } from '../ingress/http/rate-limit';
import { aUniqueSlug } from '../testing/users';

const origin = 'https://purlay.test';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const PER_USER = 4;
const TOTAL = 6;

let cloned: ClonedDatabase;
let app: HttpApplication;
let server = '';

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  app = createApp(
    testDependencies({
      database: cloned.db,
      clock,
      config: testConfig({ APP_URL: origin }),
      // The provisional budgets, which the test doubles loosen by default.
      rateBudgets: { auth: AUTH_BUDGET, writes: WRITE_BUDGET, costlyReads: COSTLY_READ_BUDGET },
      connectionLimits: { perUser: PER_USER, total: TOTAL },
    }),
  );
  server = `http://localhost:${String(app.listen(0))}`;
});

afterAll(async () => {
  await app.stop(true);
  await cloned.drop();
});

interface Client {
  readonly frames: ServerFrame[];
  readonly send: (frame: unknown) => void;
  readonly ended: Promise<number>;
  readonly close: () => Promise<void>;
}

const connect = async (cookie: string): Promise<Client> => {
  const socket = new WebSocket(`${server.replace('http', 'ws')}/ws`, {
    headers: { cookie, origin },
  } as unknown as string[]);
  const ended = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => {
      resolve(event.code);
    });
  });
  const frames: ServerFrame[] = [];
  socket.addEventListener('message', (event) => {
    frames.push(JSON.parse(String(event.data)) as ServerFrame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the socket did not open'));
    });
  });
  const client: Client = {
    frames,
    send: (frame) => {
      socket.send(JSON.stringify(frame));
    },
    ended,
    close: async () => {
      socket.close();
      await ended;
    },
  };
  return client;
};

const until = async (what: string, done: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

/** Resolves once the server has the connection's identity: it answers a ping. */
const ready = async (client: Client, n: number): Promise<void> => {
  const id = messageId(new Date(NOW.getTime() + 100_000 + n));
  client.send({ id, op: 'PING', payload: {} });
  await until('a PONG', () => client.frames.some((f) => f.refId === id));
};

const upgrade = async (cookie: string): Promise<Response> =>
  await fetch(`${server}/ws`, {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      origin,
      cookie,
    },
  });

/** Closing is the server's to finish; the next test starts from nothing held. */
const nothingHeld = async (): Promise<void> => {
  await until('every socket to be forgotten', () => app.held().connections === 0);
};

const aChannel = async (user: SignedInUser): Promise<string> => {
  const post = async (path: string, body: unknown): Promise<{ id: string }> =>
    (await (
      await app.handle(
        new Request(`${origin}${path}`, {
          method: 'POST',
          headers: { cookie: user.cookie, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
    ).json()) as { id: string };
  const slug = aUniqueSlug('lim');
  const workspace = await post('/api/workspaces', { name: slug, slug });
  return (await post(`/api/workspaces/${workspace.id}/channels`, { name: 'ops' })).id;
};

describe('integration: one user’s sockets share one write budget', () => {
  test('many sockets do not multiply the budget: the user is limited as one', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'budget');
    const channelId = await aChannel(alice);
    const sockets = await Promise.all(
      Array.from({ length: PER_USER }, () => connect(alice.cookie)),
    );
    await Promise.all(
      sockets.map(async (socket, n) => {
        await ready(socket, n);
      }),
    );

    // Each socket stays well inside its own budget; together they are 3 × the user's.
    const each = Math.floor((WRITE_BUDGET.burst * 3) / PER_USER);
    let at = 0;
    for (const socket of sockets) {
      for (let i = 0; i < each; i += 1) {
        at += 1;
        socket.send({
          id: messageId(new Date(NOW.getTime() + at)),
          op: 'MESSAGE_SEND',
          payload: { channelId, content: `m${String(at)}` },
        });
      }
    }
    const answered = (): ServerFrame[] =>
      sockets.flatMap((s) => s.frames.filter((f) => f.event === 'ACK' || f.event === 'ERROR'));
    await until('every send to be answered', () => answered().length >= at);

    const sends = answered();
    const refused = sends.filter(
      (f) => f.event === 'ERROR' && 'code' in f.data && f.data.code === 'RATE_LIMITED',
    );
    const acked = sends.filter((f) => f.event === 'ACK' && 'id' in f.data);
    // The clock is fixed, so the bucket does not refill: exactly the user's burst,
    // less the two HTTP writes that set the channel up — one bucket for both doors.
    const left = WRITE_BUDGET.burst - 2;
    expect(acked).toHaveLength(left);
    expect(refused).toHaveLength(at - left);
    await Promise.all(
      sockets.map(async (s) => {
        await s.close();
      }),
    );
  });
});

describe('integration: how many sockets may be open', () => {
  test('a user past the cap is refused at the upgrade, before a socket is bound', async () => {
    await nothingHeld();
    const bob = await aSignedInUser(cloned.db, clock, 'cap-user');
    const held = await Promise.all(Array.from({ length: PER_USER }, () => connect(bob.cookie)));
    await Promise.all(
      held.map(async (socket, n) => {
        await ready(socket, n);
      }),
    );

    const refused = await upgrade(bob.cookie);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });

    // The control: someone else is not affected by Bob's sockets.
    const carol = await aSignedInUser(cloned.db, clock, 'cap-other');
    const fine = await connect(carol.cookie);
    await ready(fine, 99);
    await fine.close();
    await Promise.all(
      held.map(async (s) => {
        await s.close();
      }),
    );
  });

  test('a burst of upgrades that all pass the check is held to the cap when they bind', async () => {
    await nothingHeld();
    const dave = await aSignedInUser(cloned.db, clock, 'cap-burst');
    const burst = await Promise.all(
      Array.from({ length: PER_USER + 3 }, async () => await connect(dave.cookie)),
    );
    // Wait for the server to have decided about every one of them.
    await until('the extra sockets to be closed', () => app.held().connections <= PER_USER);
    const codes = await Promise.all(
      burst.map(async (s) => await Promise.race([s.ended, Bun.sleep(300).then(() => undefined)])),
    );
    expect(codes.filter((code) => code === CLOSE_CODES.TOO_BUSY)).toHaveLength(3);
    expect(codes.filter((code) => code === undefined)).toHaveLength(PER_USER);
    await Promise.all(
      burst
        .filter((_, i) => codes[i] === undefined)
        .map(async (s) => {
          await s.close();
        }),
    );
  });

  test('the node refuses past its total with a busy status, whoever asks', async () => {
    await nothingHeld();
    const users = await Promise.all(
      Array.from(
        { length: TOTAL },
        async (_, i) => await aSignedInUser(cloned.db, clock, `tot${String(i)}`),
      ),
    );
    const held = await Promise.all(users.map(async (u) => await connect(u.cookie)));
    await Promise.all(
      held.map(async (socket, n) => {
        await ready(socket, n);
      }),
    );

    const late = await aSignedInUser(cloned.db, clock, 'tot-late');
    const refused = await upgrade(late.cookie);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' } });
    await Promise.all(
      held.map(async (s) => {
        await s.close();
      }),
    );
  });
});
