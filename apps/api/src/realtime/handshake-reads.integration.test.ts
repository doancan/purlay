/**
 * How many times a handshake asks the library who is calling.
 *
 * Every read is a pooled connection and a turn of the one event loop that also accepts the next
 * upgrade, so the number is the price of a reconnect storm: a node that is let back in by two
 * thousand sockets at once pays it two thousand times over. The admission is one read, the hub's
 * opening is two (the second is the confirmation after the end-of-session topics are subscribed,
 * `hub.opened`), and the refusals say how little they cost.
 *
 * The framework runs a socket route's `beforeHandle` hook in the route and then again inside the
 * upgrade handler it builds, ignoring the second answer. Left alone that is a fourth read for every
 * admitted socket, whose answer nobody reads.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { aSignedInUser } from '../testing/signed-in';
import { testConfig, testDependencies } from '../testing/doubles';
import { fixedClock } from '../platform/clock';
import type { Auth } from '../modules/auth/better-auth';

const origin = 'https://purlay.test';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const TOTAL = 2;

let cloned: ClonedDatabase;
let app: HttpApplication;
let server = '';
let sessionReads = 0;
const held: WebSocket[] = [];

/** The library as the application holds it, counting each time it is asked who a request is. */
const counting = (auth: Auth): Auth =>
  new Proxy(auth, {
    get: (target, property): unknown => {
      const value: unknown = Reflect.get(target, property);
      if (property !== 'api') return value;
      return new Proxy(value as object, {
        get: (api, method): unknown => {
          const read: unknown = Reflect.get(api, method);
          if (method !== 'getSession' || typeof read !== 'function') return read;
          return (...args: unknown[]): unknown => {
            sessionReads += 1;
            return (read as (...given: unknown[]) => unknown).apply(api, args);
          };
        },
      });
    },
  });

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  const dependencies = testDependencies({
    database: cloned.db,
    clock,
    config: testConfig({ APP_URL: origin }),
    connectionLimits: { perUser: 10, total: TOTAL },
  });
  app = createApp({ ...dependencies, auth: counting(dependencies.auth) });
  server = `http://localhost:${String(app.listen(0))}`;
}, CLONE_HOOK_MS);

afterEach(async () => {
  for (const socket of held.splice(0)) socket.close();
  await until('every socket to be forgotten', () => app.held().connections === 0);
}, DROP_HOOK_MS);

afterAll(async () => {
  await app.stop(true);
  await cloned.drop();
}, DROP_HOOK_MS);

const until = async (what: string, done: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

const upgradeHeaders = (extra: Record<string, string>): Record<string, string> => ({
  upgrade: 'websocket',
  connection: 'Upgrade',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'sec-websocket-version': '13',
  ...extra,
});

/** A socket that has its identity: it opened and answered a ping, which waits for the hub's reads. */
const opened = async (cookie: string, n: number): Promise<WebSocket> => {
  const socket = new WebSocket(`${server.replace('http', 'ws')}/ws`, {
    headers: { cookie, origin },
  } as unknown as string[]);
  held.push(socket);
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
  const id = messageId(new Date(NOW.getTime() + 100_000 + n));
  socket.send(JSON.stringify({ id, op: 'PING', payload: {} }));
  await until('a PONG', () => frames.some((frame) => frame.refId === id));
  return socket;
};

describe('integration: what a handshake costs in session reads', () => {
  test('an admitted socket is read three times: once to admit it, twice to open it', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'reads-admitted');
    sessionReads = 0;
    await opened(alice.cookie, 1);
    expect(sessionReads).toBe(3);
  });

  test('a socket refused for the cap costs the one read that said who was asking', async () => {
    const bob = await aSignedInUser(cloned.db, clock, 'reads-cap');
    const carol = await aSignedInUser(cloned.db, clock, 'reads-cap-other');
    await opened(bob.cookie, 2);
    await opened(carol.cookie, 3);
    expect(app.held().connections).toBe(TOTAL);

    sessionReads = 0;
    const refused = await fetch(`${server}/ws`, {
      headers: upgradeHeaders({ origin, cookie: bob.cookie }),
    });
    expect(refused.status).toBe(503);
    expect(sessionReads).toBe(1);
  });

  test('a foreign origin and a request with no cookie cost the database nothing', async () => {
    const dave = await aSignedInUser(cloned.db, clock, 'reads-refused');
    sessionReads = 0;
    const foreign = await fetch(`${server}/ws`, {
      headers: upgradeHeaders({ origin: 'https://evil.test', cookie: dave.cookie }),
    });
    const anonymous = await fetch(`${server}/ws`, { headers: upgradeHeaders({ origin }) });
    expect(foreign.status).toBe(403);
    expect(anonymous.status).toBe(401);
    expect(sessionReads).toBe(0);
  });
});

describe('integration: what a handshake is refused with, in what order', () => {
  /** Recorded from the structure before admission became a guard: status and body, byte for byte. */
  const refusal = (code: string, message: string): string =>
    JSON.stringify({ error: { code, message } });
  const FORBIDDEN = refusal('FORBIDDEN', 'That origin may not open a socket here.');
  const UNAUTHENTICATED = refusal('UNAUTHENTICATED', 'Sign in first.');
  const BUSY = refusal('DATABASE_UNAVAILABLE', 'The service is busy. Try again shortly.');

  const answer = async (headers: Record<string, string>): Promise<[number, string]> => {
    const response = await fetch(`${server}/ws`, { headers: upgradeHeaders(headers) });
    return [response.status, await response.text()];
  };

  test('origin first, then who is asking, and the cap only for a caller who is known', async () => {
    const erin = await aSignedInUser(cloned.db, clock, 'order-a');
    const frank = await aSignedInUser(cloned.db, clock, 'order-b');
    expect(await answer({ origin: 'https://evil.test', cookie: erin.cookie })).toEqual([
      403,
      FORBIDDEN,
    ]);
    expect(await answer({ cookie: erin.cookie })).toEqual([403, FORBIDDEN]);
    expect(await answer({ origin })).toEqual([401, UNAUTHENTICATED]);
    expect(await answer({ origin, cookie: '__Host-purlay_session=garbage' })).toEqual([
      401,
      UNAUTHENTICATED,
    ]);

    await opened(erin.cookie, 4);
    await opened(frank.cookie, 5);
    expect(app.held().connections).toBe(TOTAL);
    expect(await answer({ origin, cookie: erin.cookie })).toEqual([503, BUSY]);
    // The node is full, and a caller nobody can vouch for is still told who they are not, not that it is busy.
    expect(await answer({ origin })).toEqual([401, UNAUTHENTICATED]);
    expect(await answer({ origin: 'https://evil.test', cookie: erin.cookie })).toEqual([
      403,
      FORBIDDEN,
    ]);
  });
});
