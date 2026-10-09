/**
 * The edge of the HTTP surface: what is bounded before a handler runs.
 *
 * Every case drives a real `Request` through the real application. The database
 * double throws on any access, so a request refused here is proven to have been
 * refused *before* anything that could cost something ran (#234).
 */
import { describe, expect, test } from 'bun:test';
import { MAX_FRAME_BYTES } from '@purlay/types';
import { createApp } from './app';
import { JSON_BODY_MAX_BYTES, inboundRequestId } from './edge';
import { testConfig, testDependencies } from '../../testing/doubles';

const APP = 'https://purlay.test';

const app = (appUrl = APP): ReturnType<typeof createApp> =>
  createApp(testDependencies({ config: testConfig({ APP_URL: appUrl }) }));

const send = async (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  appUrl = APP,
): Promise<Response> =>
  await app(appUrl).handle(new Request(`${appUrl}${path}`, { method, headers }));

const code = async (response: Response): Promise<unknown> => {
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null && 'error' in body
    ? (body.error as { code: unknown }).code
    : undefined;
};

describe('the body limit', () => {
  test('is one frame, so a message over HTTP is bounded exactly as over the socket', () => {
    expect(JSON_BODY_MAX_BYTES).toBe(MAX_FRAME_BYTES);
  });

  /**
   * The limit has to be the *server's*: a handler-level check runs after the body
   * was buffered, which is the bug. A real listener, a real oversized body, and a
   * database that throws if it is reached.
   */
  test('a body over the limit is refused with 413 by the server, before any handler', async () => {
    const server = app();
    const port = server.listen(0);
    try {
      const url = `http://localhost:${String(port)}/api/workspaces`;
      const headers = { 'content-type': 'application/json', origin: APP };
      const over = JSON.stringify({ name: 'x'.repeat(JSON_BODY_MAX_BYTES + 1) });
      const refused = await fetch(url, { method: 'POST', headers, body: over });
      expect(refused.status).toBe(413);

      // The same size without a Content-Length: a chunked body cannot dodge it.
      const chunks = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode(over));
          controller.close();
        },
      });
      const streamed = await fetch(url, {
        method: 'POST',
        headers,
        body: chunks,
        duplex: 'half',
      });
      expect(streamed.status).toBe(413);

      // Under the limit it reaches the application, which here refuses it for the
      // (unauthenticated) reason the database double would otherwise throw on.
      const within = await fetch(url, { method: 'POST', headers, body: '{}' });
      expect(within.status).not.toBe(413);
    } finally {
      await server.stop(true);
    }
  });
});

describe('the Origin check on state-changing requests', () => {
  const mutations: readonly [string, string][] = [
    ['POST', '/api/workspaces'],
    ['PUT', '/api/workspaces/x'],
    ['PATCH', '/api/workspaces/x'],
    ['DELETE', '/api/workspaces/x'],
    ['POST', '/auth/logout'],
    ['POST', '/auth/logout-all'],
  ];

  test('a mutation from another origin is FORBIDDEN, logout included', async () => {
    for (const [method, path] of mutations) {
      const response = await send(method, path, { origin: 'https://evil.example' });
      expect({ method, path, status: response.status, code: await code(response) }).toEqual({
        method,
        path,
        status: 403,
        code: 'FORBIDDEN',
      });
    }
  });

  test('a sibling subdomain and the opaque origin are other origins too', async () => {
    for (const origin of ['https://evil.purlay.test', 'null', 'http://purlay.test']) {
      expect((await send('POST', '/auth/logout-all', { origin })).status).toBe(403);
    }
  });

  test('the application origin passes the check', async () => {
    // No session, so the handler answers 401: past the edge, into the application.
    const response = await send('POST', '/auth/logout-all', { origin: APP });
    expect(response.status).not.toBe(403);
  });

  test('with no Origin, the browser must say the request is its own', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const response = await send('POST', '/auth/logout-all', { 'sec-fetch-site': site });
      expect({ site, status: response.status }).toEqual({ site, status: 403 });
    }
    for (const site of ['same-origin', 'none']) {
      const response = await send('POST', '/auth/logout-all', { 'sec-fetch-site': site });
      expect({ site, forbidden: response.status === 403 }).toEqual({ site, forbidden: false });
    }
  });

  /** CSRF needs a browser; a browser sends one of the two. Documented in D-39. */
  test('a client that sends neither header is not a browser, and is not refused here', async () => {
    expect((await send('POST', '/auth/logout-all')).status).not.toBe(403);
  });

  test('reads are never subject to it: the OAuth callback and sign-in are GETs', async () => {
    const response = await send('GET', '/health', { origin: 'https://evil.example' });
    expect(response.status).toBe(200);
  });

  test('a stale Origin does not outrank Sec-Fetch-Site: both must be right when both are sent', async () => {
    const response = await send('POST', '/auth/logout-all', {
      origin: APP,
      'sec-fetch-site': 'cross-site',
    });
    expect(response.status).toBe(403);
  });

  test('the refusal is the error envelope and carries a request id', async () => {
    const response = await send('POST', '/auth/logout', { origin: 'https://evil.example' });
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('response headers', () => {
  test('every response says what a browser should not do with it', async () => {
    for (const response of [
      await send('GET', '/health'),
      await send('GET', '/api/me'),
      await send('GET', '/nope'),
    ]) {
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('content-security-policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('HSTS is sent when the application is served over https, and only then', async () => {
    const secure = await send('GET', '/health');
    expect(secure.headers.get('strict-transport-security')).toBe('max-age=15552000');
    const plain = await send('GET', '/health', {}, 'http://localhost:5173');
    expect(plain.headers.get('strict-transport-security')).toBeNull();
  });

  test('an error response carries them too', async () => {
    const response = await send('GET', '/api/me');
    expect(response.status).toBe(401);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('the inbound request id', () => {
  test('a well-formed one is kept, as a label', () => {
    for (const id of ['a1b2c3d4', 'req_01HZX-9.abc', 'x'.repeat(64)]) {
      expect(inboundRequestId(new Headers({ 'x-request-id': id }))).toBe(id);
    }
  });

  test('anything else is replaced by a fresh one', () => {
    for (const bad of ['', 'x'.repeat(65), 'has space', '<script>', 'a;b', 'ünïcode']) {
      const id = inboundRequestId(new Headers({ 'x-request-id': bad }));
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(inboundRequestId(new Headers())).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('the response carries the id that was sent, and a fresh one when none was', async () => {
    const echoed = await send('GET', '/health', { 'x-request-id': 'edge-trace-0001' });
    expect(echoed.headers.get('x-request-id')).toBe('edge-trace-0001');
    const minted = await send('GET', '/health');
    expect(minted.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const refused = await send('GET', '/health', { 'x-request-id': 'bad id\twith tab' });
    expect(refused.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
