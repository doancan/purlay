/**
 * What a native client meets at the socket upgrade (D-186): a real listener, a real session, a real
 * database — the three things that decide whether a client that is not a browser can connect at all, and
 * whether one that is too old is told so as a status it can act on.
 *
 * The handshake itself is `GET /api/client`'s (`client-handshake.test.ts`); this is what only a transport
 * can prove. A browser sets `Origin` itself; an installed client must set it, to the one address the
 * server was told it answers to (D-39), and says what it is in `X-Purlay-Client`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createConnection } from 'node:net';
import {
  cloneIntegrationDatabase,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { CLOSE_CODES } from '@purlay/types';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { testConfig, testDependencies } from '../testing/doubles';
import { fixedClock } from '../platform/clock';
import { aSignedInUser } from '../testing/signed-in';

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));
const origin = 'https://purlay.test';
let cloned: ClonedDatabase;
let db: Executor;
let app: HttpApplication;
let port = 0;
let cookie = '';

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  db = cloned.db;
  app = createApp(
    testDependencies({
      database: db,
      clock,
      // Contract 1 is the minimum, so `contract/0` is a client too old to be served.
      config: testConfig({
        APP_URL: origin,
        MIN_CLIENT_MACOS_CONTRACT: 1,
        MACOS_DOWNLOAD_URL: 'https://example.test/purlay',
      }),
    }),
  );
  port = app.listen(0);
  cookie = (await aSignedInUser(db, clock, 'native')).cookie;
}, CLONE_HOOK_MS);

afterAll(async () => {
  await app.stop(true);
  await cloned.drop();
}, DROP_HOOK_MS);

interface Answer {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
}

/**
 * One HTTP/1.1 upgrade request written by hand, and its status line and headers read back. A
 * `WebSocket` client reports a refused upgrade as an error with no status, which is exactly what a
 * client that has to act on `426` cannot be given.
 */
const upgrade = async (headers: Readonly<Record<string, string>>): Promise<Answer> =>
  await new Promise<Answer>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      const lines = [
        'GET /ws HTTP/1.1',
        `Host: localhost:${String(port)}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      const end = received.indexOf('\r\n\r\n');
      if (end === -1) return;
      const [statusLine = '', ...rest] = received.slice(0, end).split('\r\n');
      socket.destroy();
      resolve({
        status: Number(statusLine.split(' ')[1]),
        headers: new Map(
          rest.map((line) => {
            const colon = line.indexOf(':');
            return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()] as const;
          }),
        ),
      });
    });
    socket.on('error', reject);
  });

describe('integration: the socket upgrade, for a client that is not a browser', () => {
  test('opens for a client that says what it is, sets its own Origin and carries its session', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`, {
      headers: { cookie, origin, 'x-purlay-client': 'macos/1.0.0 contract/1' },
    } as unknown as string[]);
    const opened = await new Promise<boolean>((resolve) => {
      socket.addEventListener('open', () => {
        resolve(true);
      });
      socket.addEventListener('error', () => {
        resolve(false);
      });
    });
    expect(opened).toBe(true);
    socket.close();
  });

  test('is refused 403 without an Origin, however good its session: the one thing a client must add', async () => {
    const answer = await upgrade({ cookie, 'x-purlay-client': 'macos/1.0.0 contract/1' });
    expect(answer.status).toBe(403);
  });

  test('is refused 403 with an Origin that is not the one address the server answers to', async () => {
    for (const wrong of [`${origin}/`, 'https://purlay.test:8443', 'http://purlay.test', 'null']) {
      const answer = await upgrade({ cookie, origin: wrong });
      expect({ wrong, status: answer.status }).toEqual({ wrong, status: 403 });
    }
  });

  test('is told 426 at the upgrade when it is too old — a status it can act on, not a socket that closes', async () => {
    const answer = await upgrade({ cookie, origin, 'x-purlay-client': 'macos/0.0.1 contract/0' });
    expect(answer.status).toBe(426);
    expect(answer.headers.get('upgrade')).toBe('purlay-client');
  });

  test('is told 426 before its session is looked at: a client with no session at all learns it too', async () => {
    const answer = await upgrade({ origin, 'x-purlay-client': 'macos/0.0.1 contract/0' });
    expect(answer.status).toBe(426);
  });

  test('is told 426 ahead of 403: what it must do first is update, not fix its Origin', async () => {
    const answer = await upgrade({ 'x-purlay-client': 'macos/0.0.1 contract/0' });
    expect(answer.status).toBe(426);
  });

  test('is not refused for a header that is not the shape, so a typo never closes the door', async () => {
    const answer = await upgrade({ cookie, origin, 'x-purlay-client': 'macos 0.0.1' });
    expect(answer.status).toBe(101);
  });

  test('a browser, which sends no header, is let through', async () => {
    const answer = await upgrade({ cookie, origin });
    expect(answer.status).toBe(101);
  });

  test('a session that has ended is told so by the close code it already knew', () => {
    // The refusal above is HTTP; what a connected client hears when its session ends is the existing
    // close code, which a 426 must never be mistaken for.
    expect(CLOSE_CODES.SESSION_ENDED).toBe(4401);
  });
});

describe('integration: a client that is too old, over HTTP, with a session', () => {
  test('is refused 426 on a read and on a write, by a server that would have served it a moment ago', async () => {
    const old = { cookie, origin, 'x-purlay-client': 'macos/0.0.1 contract/0' };
    const read = await fetch(`http://127.0.0.1:${String(port)}/api/me`, { headers: old });
    expect(read.status).toBe(426);
    const write = await fetch(`http://127.0.0.1:${String(port)}/api/workspaces`, {
      method: 'POST',
      headers: { ...old, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', slug: 'x-native-gate' }),
    });
    expect(write.status).toBe(426);
    // And nothing was made: the refusal is before the handler.
    const made = await db
      .selectFrom('workspaces')
      .select('id')
      .where('slug', '=', 'x-native-gate')
      .execute();
    expect(made).toEqual([]);
  });

  test('is served at once when it is updated', async () => {
    const current = {
      cookie,
      origin,
      'x-purlay-client': 'macos/1.0.0 contract/1',
    };
    const read = await fetch(`http://127.0.0.1:${String(port)}/api/me`, { headers: current });
    expect(read.status).toBe(200);
  });
});
