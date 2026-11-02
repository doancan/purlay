/**
 * The demo's front server: routing, the demo login, and the proxy to an API — a fake one,
 * so nothing here needs a database. Serving the client is the API's, and is tested there
 * (`apps/api/src/ingress/http/client.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { forwardableCode, routeOf, startFront, type Route } from './demo-server';

let seen: { url: string; cookie: string | null; method: string; body: string }[] = [];
const sockets: { cookie: string | null; origin: string | null; got: string[] }[] = [];

const fakeApi = Bun.serve<{ cookie: string | null; origin: string | null }>({
  port: 0,
  fetch: async (request, server) => {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      return server.upgrade(request, {
        data: { cookie: request.headers.get('cookie'), origin: request.headers.get('origin') },
      })
        ? undefined
        : new Response('no', { status: 400 });
    }
    seen.push({
      url: `${url.pathname}${url.search}`,
      cookie: request.headers.get('cookie'),
      method: request.method,
      body: await request.text(),
    });
    if (url.pathname === '/api/redirect') {
      return new Response(null, { status: 302, headers: { location: '/somewhere' } });
    }
    return Response.json({ ok: true }, { status: url.pathname === '/api/missing' ? 404 : 200 });
  },
  websocket: {
    open: (socket) => {
      sockets.push({ cookie: socket.data.cookie, origin: socket.data.origin, got: [] });
    },
    message: (socket, message) => {
      // The API ending a socket of its own accord, as it does for a revoked session (4401).
      if (String(message) === 'end-4401') {
        socket.close(4401, 'signed out');
        return;
      }
      sockets.at(-1)?.got.push(String(message));
      socket.send(`echo:${String(message)}`);
    },
  },
});

const front = startFront({
  api: `http://localhost:${String(fakeApi.port)}`,
  sessions: { dogancan: 'tok-1' },
  port: 0,
});
const base = `http://localhost:${String(front.port)}`;

afterAll(async () => {
  await front.stop(true);
  await fakeApi.stop(true);
});

beforeAll(() => {
  seen = [];
});

describe('the demo front', () => {
  test('listens on loopback only: its login door mints sessions for whoever reaches it', () => {
    expect(front.hostname).toBe('127.0.0.1');
  });
});

describe('which paths are whose', () => {
  test.each<[string, Route]>([
    ['/ws', 'socket'],
    ['/__demo/login', 'login'],
    ['/api/me', 'api'],
    ['/auth/github', 'api'],
    ['/', 'api'],
    ['/w/acme/c/1', 'api'],
    ['/assets/app.js', 'api'],
  ])('%s is %s', (path, route) => {
    expect(routeOf(path)).toBe(route);
  });

  test("a client path is the API's to answer too: the demo serves no file of its own", async () => {
    seen = [];
    const response = await fetch(`${base}/w/acme/c/1`);
    expect(response.status).toBe(200);
    expect(seen.at(-1)?.url).toBe('/w/acme/c/1');
  });
});

describe('the demo login', () => {
  test('hands a browser the genuine session and goes home', async () => {
    const response = await fetch(`${base}/__demo/login?as=dogancan`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('__Host-purlay_session=tok-1');
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
      expect(cookie).toContain(attribute);
    }
    expect(cookie).not.toContain('Domain');
  });

  test('names who it knows when asked for somebody it does not', async () => {
    const response = await fetch(`${base}/__demo/login?as=mallory`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('dogancan');
    expect((await fetch(`${base}/__demo/login`)).status).toBe(404);
  });
});

describe('the API proxy', () => {
  test('passes method, path, query, cookie and body through, and the answer back', async () => {
    seen = [];
    const response = await fetch(`${base}/api/channels/c1/messages?limit=5`, {
      method: 'POST',
      headers: { cookie: '__Host-purlay_session=abc', 'content-type': 'application/json' },
      body: JSON.stringify({ id: '1' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen.at(-1)).toEqual({
      url: '/api/channels/c1/messages?limit=5',
      cookie: '__Host-purlay_session=abc',
      method: 'POST',
      body: '{"id":"1"}',
    });
  });

  test('an error status and a redirect are passed on as they are', async () => {
    expect((await fetch(`${base}/api/missing`)).status).toBe(404);
    const redirect = await fetch(`${base}/api/redirect`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/somewhere');
  });

  test('an API that is not there is a 502, said plainly', async () => {
    const lonely = startFront({ api: 'http://localhost:1', sessions: {}, port: 0 });
    const response = await fetch(`http://localhost:${String(lonely.port)}/api/me`);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('not answering');
    await lonely.stop(true);
  });
});

describe('the socket', () => {
  test("is passed through with the browser's own cookie and origin, both ways", async () => {
    const socket = new WebSocket(`ws://localhost:${String(front.port)}/ws`, {
      headers: { cookie: '__Host-purlay_session=abc', origin: 'http://localhost:4173' },
    } as unknown as string[]);
    const answers: string[] = [];
    const done = new Promise<void>((resolve) => {
      socket.addEventListener('open', () => {
        socket.send('hello');
      });
      socket.addEventListener('message', (event) => {
        answers.push(String(event.data));
        resolve();
      });
    });
    await done;
    expect(answers).toEqual(['echo:hello']);
    expect(sockets.at(-1)).toMatchObject({
      cookie: '__Host-purlay_session=abc',
      origin: 'http://localhost:4173',
      got: ['hello'],
    });
    socket.close();
  });

  test('a close from the API reaches the browser with its code', async () => {
    const socket = new WebSocket(`ws://localhost:${String(front.port)}/ws`);
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener('close', (event) => {
        resolve(event.code);
      });
    });
    socket.addEventListener('open', () => {
      socket.send('end-4401');
    });
    expect(await closed).toBe(4401);
  });

  test('a plain request to /ws is told it needs an upgrade', async () => {
    expect((await fetch(`${base}/ws`)).status).toBe(426);
  });
});

describe('a close code that is passed on', () => {
  /** What a socket reports is not always what it may send: 1006 is "the connection was lost". */
  test.each([1004, 1005, 1006, 1015])(
    '%i is a report, not a code, and becomes a normal close',
    (code) => {
      expect(forwardableCode(code)).toBe(1000);
    },
  );

  test.each([1000, 1001, 1011, 1012, 3000, 4401])('%i is passed on as it is', (code) => {
    expect(forwardableCode(code)).toBe(code);
  });
});
