/**
 * The one place a response is believed: what it accepts, what it refuses, and the
 * shape of every failure. A fake `fetch` answers; nothing here touches a network.
 */
import { describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { ApiError, isApiError, isTransient } from './errors';
import { createHttp, type Http } from './http';

const answer = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

const Thing = Type.Object({ id: Type.String() });

interface Seen {
  url: string;
  init: RequestInit;
}

const http = (respond: () => Response | Promise<Response>): { client: Http; seen: Seen[] } => {
  const seen: Seen[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(respond());
  }) as unknown as typeof fetch;
  return { client: createHttp(fetchFn), seen };
};

describe('a request', () => {
  test('is same-origin with cookies, asks for JSON, and leaves out what is undefined', async () => {
    const { client, seen } = http(() => answer(200, { id: 'a' }));
    await client.request('GET', '/api/things', Thing, {
      query: { before: 'x', after: undefined, limit: 5 },
    });
    expect(seen[0]?.url).toBe('/api/things?before=x&limit=5');
    expect(seen[0]?.init.credentials).toBe('same-origin');
    expect(seen[0]?.init.headers).toEqual({ accept: 'application/json' });
    expect(seen[0]?.init.body).toBeUndefined();
  });

  test('with no query at all, or only undefined ones, has no question mark', async () => {
    const { client, seen } = http(() => answer(200, { id: 'a' }));
    await client.request('GET', '/api/things', Thing);
    await client.request('GET', '/api/things', Thing, { query: { a: undefined } });
    expect(seen.map((s) => s.url)).toEqual(['/api/things', '/api/things']);
  });

  test('a body is JSON, and says so', async () => {
    const { client, seen } = http(() => answer(200, { id: 'a' }));
    await client.request('POST', '/api/things', Thing, { body: { name: 'x' } });
    expect(seen[0]?.init.body).toBe('{"name":"x"}');
    expect(seen[0]?.init.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    });
  });

  test('carries the abort signal it was given', async () => {
    const { client, seen } = http(() => answer(200, { id: 'a' }));
    const controller = new AbortController();
    await client.request('GET', '/x', Thing, { signal: controller.signal });
    expect(seen[0]?.init.signal).toBe(controller.signal);
  });
});

describe('a response', () => {
  test('that satisfies the schema is returned', async () => {
    const { client } = http(() => answer(200, { id: 'a' }));
    expect(await client.request('GET', '/x', Thing)).toEqual({ id: 'a' });
  });

  test('that does not is MALFORMED, not partly used', async () => {
    const { client } = http(() => answer(200, { id: 7 }));
    const error = await client.request('GET', '/x', Thing).catch((e: unknown) => e);
    expect(isApiError(error) && error.code).toBe('MALFORMED');
  });

  test('that is not JSON is MALFORMED', async () => {
    const { client } = http(() => answer(200, '<html>'));
    const error = await client.request('GET', '/x', Thing).catch((e: unknown) => e);
    expect(isApiError(error) && error.code).toBe('MALFORMED');
  });
});

describe('a failure', () => {
  test('carries the server code, status and message', async () => {
    const { client } = http(() =>
      answer(404, { error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found.' } }),
    );
    const error = await client.request('GET', '/x', Thing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      code: 'CHANNEL_NOT_FOUND',
      message: 'Channel not found.',
      fields: {},
    });
  });

  test('a validation failure names its fields', async () => {
    const { client } = http(() =>
      answer(400, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'bad',
          details: { fields: { name: 'too long' } },
        },
      }),
    );
    const error = await client.send('POST', '/x', { body: {} }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', fields: { name: 'too long' } });
  });

  test.each([
    ['not JSON', '<html>'],
    ['JSON without an error', { oops: true }],
    [
      'an error with a code the contract does not have',
      { error: { code: 'MADE_UP', message: 'x' } },
    ],
    ['a null error', { error: null }],
    ['a non-object', 'null'],
  ])('with a body that is %s is MALFORMED and keeps the status', async (_why, body) => {
    const { client } = http(() => answer(502, body));
    const error = await client.request('GET', '/x', Thing).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 502, code: 'MALFORMED' });
  });

  test('no response at all is NETWORK, with the cause kept', async () => {
    const cause = new TypeError('Failed to fetch');
    const client = createHttp(() => Promise.reject(cause));
    const error = await client.request('GET', '/x', Thing).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: 'NETWORK' });
    expect((error as Error).cause).toBe(cause);
  });

  test('which of them a retry may fix', () => {
    const of = (code: ConstructorParameters<typeof ApiError>[1]): boolean =>
      isTransient(new ApiError(500, code, 'x'));
    expect(
      ['NETWORK', 'DATABASE_UNAVAILABLE', 'RATE_LIMITED', 'INTERNAL'].map((c) =>
        of(c as 'NETWORK'),
      ),
    ).toEqual([true, true, true, true]);
    expect(of('CHANNEL_NOT_FOUND')).toBe(false);
    expect(of('MALFORMED')).toBe(false);
    expect(isTransient(new Error('x'))).toBe(false);
  });
});

describe('send', () => {
  test('does not read the answer, but still reports a failure', async () => {
    const ok = http(() => new Response(null, { status: 204 }));
    await ok.client.send('POST', '/auth/logout');
    expect(ok.seen).toHaveLength(1);
    const bad = http(() => answer(401, { error: { code: 'UNAUTHENTICATED', message: 'no' } }));
    const error = await bad.client.send('POST', '/auth/logout').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
