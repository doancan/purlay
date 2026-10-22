/**
 * The API answering for the built client (D-61), driven through the real router, hooks
 * and error handler. The database the application is built with throws on any access, so
 * every pass here is also proof that serving a file touches nothing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createApp } from './app';
import { IMMUTABLE, openClient } from './client';
import { testConfig, testDependencies } from '../../testing/doubles';

const dist = mkdtempSync(join(tmpdir(), 'served-dist-'));
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
// Beside the build, so a path that climbs out has something real to find: without the
// guard it would be served, which is what makes the refusal below mean something.
const secret = `${dist}-secret`;
writeFileSync(secret, 'outside the build');
const climb = `/..%2f${basename(secret)}`;

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
  rmSync(secret, { force: true });
});

const served = createApp(testDependencies({ client: openClient(dist) }));
const bare = createApp(testDependencies());

const send = async (path: string, method = 'GET', application = served): Promise<Response> =>
  await application.handle(new Request(`${testConfig().APP_URL}${path}`, { method }));

/** A policy as directive → sources, so a property is asserted rather than a spelling. */
const directives = (policy: string | null): Map<string, string[]> =>
  new Map(
    (policy ?? '')
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter((words) => words[0] !== undefined && words[0] !== '')
      .map(([name = '', ...sources]) => [name, sources]),
  );

describe('the shell', () => {
  test.each(['/', '/w/acme/c/1', '/index.html'])('%s is the document', async (path) => {
    const response = await send(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<div id="root">');
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  test('carries the document policy: nothing inline runs, nothing frames it', async () => {
    const response = await send('/');
    const policy = directives(response.headers.get('content-security-policy'));
    // The whole policy, so a directive added or dropped is a decision and not a slip (D-102).
    expect(Object.fromEntries(policy)).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      // The two exceptions D-102 names, and no third.
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'https://avatars.githubusercontent.com'],
      'font-src': ["'self'"],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
    });
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    // The powerful features the page never uses are off, for anything that ever runs in it (#638);
    // the clipboard (Copy code) and fullscreen (a video's own control) stay this origin's. Whole, so
    // a feature allowed later is a decision.
    expect(response.headers.get('permissions-policy')).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), ' +
        'display-capture=(), browsing-topics=(), clipboard-write=(self), fullscreen=(self)',
    );
  });

  test('and the headers every response carries', async () => {
    const response = await send('/');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('strict-transport-security')).toBe('max-age=15552000');
    expect(response.headers.get('x-request-id')).not.toBeNull();
  });
});

describe('a file of the build', () => {
  test('a hashed asset is served and kept for good, as data and not a document', async () => {
    const response = await send('/assets/app-abc123.js');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('console.log(1)');
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });
});

describe('asking again', () => {
  test('a file asked about every time is not sent again when it has not changed', async () => {
    const first = await send('/');
    const etag = first.headers.get('etag');
    expect(etag).not.toBeNull();
    const again = await served.handle(
      new Request(`${testConfig().APP_URL}/`, { headers: { 'if-none-match': etag ?? '' } }),
    );
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    // Still the document's: a 304 updates the stored response's headers.
    expect(again.headers.get('cache-control')).toBe('no-cache');
    expect(again.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  test('a version that is not the current one is answered with the file', async () => {
    const stale = await served.handle(
      new Request(`${testConfig().APP_URL}/`, { headers: { 'if-none-match': 'W/"0-0"' } }),
    );
    expect(stale.status).toBe(200);
    expect(await stale.text()).toContain('<div id="root">');
  });
});

describe('a file gone between being found and being sent', () => {
  test('is the not-found envelope, through the one error handler', async () => {
    const own = mkdtempSync(join(tmpdir(), 'vanishing-'));
    writeFileSync(join(own, 'index.html'), '<!doctype html>');
    writeFileSync(join(own, 'gone.txt'), 'here, then not');
    const application = createApp(testDependencies({ client: openClient(own) }));
    // Found by the lookup, removed before the handler opens it: the race a mounted build can lose.
    const original = Bun.file;
    let removed = false;
    Bun.file = ((path: string) => {
      if (!removed && path.endsWith('gone.txt')) {
        rmSync(path);
        removed = true;
      }
      return original(path);
    }) as typeof Bun.file;
    try {
      const response = await send('/gone.txt', 'GET', application);
      expect(removed).toBe(true);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: 'ROUTE_NOT_FOUND', message: 'No such route.' },
      });
    } finally {
      Bun.file = original;
      rmSync(own, { recursive: true, force: true });
    }
  });
});

describe('what is never the shell', () => {
  test.each(['/assets/gone.js', '/favicon.ico', climb, '/assets/..%2f..%2fx', '/assets'])(
    '%s is the not-found envelope',
    async (path) => {
      const response = await send(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: 'ROUTE_NOT_FOUND', message: 'No such route.' },
      });
      expect(response.headers.get('cache-control')).toBe('no-store');
    },
  );

  // `/auth/nope` is the sign-in library's to answer, which reads its database first: the same answer
  // is asserted where there is one (`auth.integration.test.ts`).
  test.each(['/api/nope', '/api', '/health/nope', '/%61pi/me', '/api%2Fme', '/ws/x'])(
    '%s is the API answering, never HTML a client would try to parse',
    async (path) => {
      const response = await send(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({
        error: { code: 'ROUTE_NOT_FOUND', message: 'No such route.' },
      });
    },
  );

  test('dots the URL parser resolves never reach the build as dots', async () => {
    // `%2e%2e` is `..` to the parser, so this arrives as `/etc/passwd`: a client route.
    const response = await send('/%2e%2e/%2e%2e/etc/passwd');
    expect(await response.text()).toContain('<div id="root">');
  });

  test('a plain request to /ws is not the shell', async () => {
    const response = await send('/ws');
    expect(response.headers.get('content-type') ?? '').not.toContain('text/html');
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test('HEAD is answered as GET is, without the body', async () => {
    const response = await send('/', 'HEAD');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await response.text()).toBe('');
  });

  test('a write to a client path is not the shell either', async () => {
    const response = await send('/w/acme', 'DELETE');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

describe('without a build', () => {
  test('no client is served, and the API is the same API', async () => {
    const response = await send('/', 'GET', bare);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'ROUTE_NOT_FOUND', message: 'No such route.' },
    });
    expect((await send('/health', 'GET', bare)).status).toBe(200);
  });
});
