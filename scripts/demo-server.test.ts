/**
 * The demo's front server: routing, static files with a client-route fallback, the demo
 * login, and the proxy to an API — a fake one, so nothing here needs a database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileFor, routeOf, startFront, type Route } from './demo-server';

const dist = mkdtempSync(join(tmpdir(), 'demo-dist-'));
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>shell</title>');
writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
writeFileSync(join(dist, 'robots.txt'), 'User-agent: *');

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
      sockets.at(-1)?.got.push(String(message));
      socket.send(`echo:${String(message)}`);
    },
  },
});

const front = startFront({
  dist,
  api: `http://localhost:${String(fakeApi.port)}`,
  sessions: { dogancan: 'tok-1' },
  port: 0,
});
const base = `http://localhost:${String(front.port)}`;

afterAll(async () => {
  await front.stop(true);
  await fakeApi.stop(true);
  rmSync(dist, { recursive: true, force: true });
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
    ['/api', 'api'],
    ['/auth/github', 'api'],
    ['/health/ready', 'api'],
    ['/', 'static'],
    ['/w/acme/c/1', 'static'],
    ['/apiary', 'static'],
    ['/assets/app.js', 'static'],
  ])('%s is %s', (path, route) => {
    expect(routeOf(path)).toBe(route);
  });
});

describe('static files', () => {
  test('a file is served, and a hashed asset is cached for good', async () => {
    const response = await fetch(`${base}/assets/app-abc123.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(await response.text()).toBe('console.log(1)');
    expect((await fetch(`${base}/robots.txt`)).headers.get('cache-control')).toBe('no-cache');
  });

  test('a client route gets the shell; a file that is not there is a 404, not the shell', async () => {
    const route = await fetch(`${base}/w/acme/c/xyz`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('shell');
    expect(route.headers.get('content-type')).toContain('text/html');
    expect((await fetch(`${base}/assets/gone.js`)).status).toBe(404);
  });

  test('a path cannot climb out of the build', () => {
    expect(fileFor(dist, '/../etc/passwd')).toBeNull();
    expect(fileFor(dist, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(fileFor(dist, '/%E0%A4%A')).toBeNull();
    expect(fileFor(dist, '/')?.startsWith(dist)).toBe(true);
    expect(fileFor(dist, '/assets/x.js')).toBe(join(dist, 'assets', 'x.js'));
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
    const lonely = startFront({ dist, api: 'http://localhost:1', sessions: {}, port: 0 });
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

  test('a plain request to /ws is told it needs an upgrade', async () => {
    expect((await fetch(`${base}/ws`)).status).toBe(426);
  });
});
